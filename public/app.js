/* Discipline Desk: UI and storage. All maths lives in core.js.
 *
 * Storage is behind one small interface (subscribeTrades, saveTrade, subscribeSettings,
 * saveSettings), so the hosted version can add a server-backed store without touching the UI.
 *   - Artifact: the `db` capability (data kept across republishes, readable by Claude).
 *   - Anywhere else, or if db is unavailable: this browser's localStorage.
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SVGNS = "http://www.w3.org/2000/svg";
  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "style") el.style.cssText = v; // set through the style object so a strict content-security policy cannot block it
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const sv = (tag, attrs = {}, ...kids) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid) el.append(kid);
    return el;
  };

  const SETUPS = ["breakout", "pullback", "reversal", "range", "trend_follow", "news"];
  const clone = (x) => JSON.parse(JSON.stringify(x));

  const S = {
    rules: clone(Core.DEFAULT_RULES),
    settings: { equity: "", dayStart: "", dayStartDate: "" },
    trades: [], store: null, plan: null,
    saving: false, calendar: null, calendarError: "",
    chartMetric: "money", chartRange: "all", shotFile: null,
    jRange: "all", jMetric: "money", cal: null, dayFilter: null, tf: "all", expandedId: null,
  };

  // ---------- storage ------------------------------------------------------------------
  function localStore() {
    const mem = {};
    const read = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : (mem[k] ?? null); } catch (e) { return mem[k] ?? null; } };
    const write = (k, v) => { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* in-memory only */ } };
    const tradeListeners = new Set();
    return {
      mode: "local",
      subscribeTrades(cb) { tradeListeners.add(cb); cb(read("dd.trades") || [], { fromCache: false }); return () => tradeListeners.delete(cb); },
      async saveTrade(t) {
        const all = read("dd.trades") || [];
        const i = all.findIndex((x) => x.id === t.id);
        if (i >= 0) all[i] = t; else all.push(t);
        write("dd.trades", all);
        tradeListeners.forEach((cb) => cb(all, { fromCache: false }));
      },
      async deleteTrade(t) {
        const all = (read("dd.trades") || []).filter((x) => x.id !== t.id);
        write("dd.trades", all);
        for (const p of new Set([t.screenshot_path, ...Core.imagePaths(t.notes)].filter(Boolean))) { try { localStorage.removeItem("dd.img." + p); } catch (e) { /* ignore */ } }
        tradeListeners.forEach((cb) => cb(all, { fromCache: false }));
      },
      // Images in the browser-only mode are kept in this browser's storage (about 5 MB in total).
      async uploadScreenshot(tradeId, file) {
        const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("Could not read the image")); r.readAsDataURL(file); });
        const path = `local/${tradeId}/${Date.now()}.jpg`;
        try { localStorage.setItem("dd.img." + path, url); } catch (e) { throw new Error("This browser's storage is full. Use the hosted app for images."); }
        return path;
      },
      async screenshotUrl(path) {
        const u = (() => { try { return localStorage.getItem("dd.img." + path); } catch (e) { return null; } })();
        if (!u) throw new Error("Image not found in this browser");
        return u;
      },
      subscribeSettings(cb) { cb(read("dd.settings"), { hasPendingWrites: false }); return () => {}; },
      async saveSettings(o) { write("dd.settings", o); },
    };
  }

  function dbStore(db, onError) {
    const chains = new Map();
    const queue = (key, fn) => { // one write at a time per document
      const next = (chains.get(key) || Promise.resolve()).catch(() => {}).then(fn);
      chains.set(key, next);
      return next;
    };
    return {
      mode: "db",
      subscribeTrades(cb) {
        return db.collection("trades").onSnapshot((snap) => cb(snap.docs.map((d) => ({ ...d.data() })), snap.metadata), onError);
      },
      saveTrade(t) { return queue("trades/" + t.id, () => db.doc("trades/" + t.id).set(t)); },
      deleteTrade(t) { return queue("trades/" + t.id, () => db.doc("trades/" + t.id).delete()); },
      subscribeSettings(cb) {
        return db.doc("settings/main").onSnapshot((s) => cb(s.exists ? { ...s.data() } : null, s.metadata), onError);
      },
      saveSettings(o) { return queue("settings/main", () => db.doc("settings/main").set(o)); },
    };
  }

  // Hosted app: Supabase Postgres + private screenshot bucket, behind a login. Row-level security
  // (supabase/schema.sql) means the public key can read nothing until you are signed in.
  function supabaseStore(cfg, onError) {
    const sb = window.supabase.createClient(cfg.url, cfg.anonKey);
    let uid = null, tradeCb = null;
    const urlCache = new Map();
    const iso = (x) => (x ? new Date(x).toISOString() : null);
    const clean = (r) => { const t = { ...r }; delete t.user_id; delete t.updated_at; t.opened_at = iso(t.opened_at); t.closed_at = iso(t.closed_at); return t; };
    const fail = (error) => { const e = new Error(error.message || "Supabase error"); e.code = error.code || error.status; throw e; };
    async function refresh() {
      const { data, error } = await sb.from("trades").select("*").order("opened_at", { ascending: false });
      if (error) { onError(error); return; }
      if (tradeCb) tradeCb(data.map(clean), { fromCache: false });
    }
    return {
      mode: "supabase",
      async hasSession() {
        const { data } = await sb.auth.getSession();
        if (data.session) { uid = data.session.user.id; return true; }
        return false;
      },
      async signIn(email, password) {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) fail(error);
        uid = data.user.id;
      },
      async signOut() { await sb.auth.signOut(); location.reload(); },
      subscribeTrades(cb) {
        tradeCb = cb; refresh();
        const ch = sb.channel("trades-live").on("postgres_changes", { event: "*", schema: "public", table: "trades" }, refresh).subscribe();
        return () => sb.removeChannel(ch);
      },
      async saveTrade(t) {
        // Entries without notes are sent without the notes columns, so older databases keep working until schema.sql is re-run.
        const row = { ...t };
        if (!row.notes) delete row.notes;
        if (!row.notes_text) delete row.notes_text;
        const { error } = await sb.from("trades").upsert(row, { onConflict: "id" });
        if (error) {
          if (error.code === "PGRST204" || /notes/.test(error.message || "")) {
            const e = new Error("The database has no notes columns yet. In Supabase, open the SQL Editor and run supabase/schema.sql again, then retry.");
            e.code = "schema_outdated"; throw e;
          }
          fail(error);
        }
        await refresh();
      },
      async deleteTrade(t) {
        const paths = [...new Set([t.screenshot_path, ...Core.imagePaths(t.notes)].filter(Boolean))];
        const { error } = await sb.from("trades").delete().eq("id", t.id);
        if (error) fail(error);
        if (paths.length) await sb.storage.from("screenshots").remove(paths); // best effort: the entry is already gone
        await refresh();
      },
      subscribeSettings(cb) {
        sb.from("settings").select("data").maybeSingle().then(({ data, error }) => {
          if (error) { onError(error); return; }
          cb(data ? data.data : null, { hasPendingWrites: false });
        });
        return () => {};
      },
      async saveSettings(o) {
        const { error } = await sb.from("settings").upsert({ user_id: uid, data: o });
        if (error) fail(error);
      },
      async uploadScreenshot(tradeId, file) {
        const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
        const path = `${uid}/${tradeId}/${Date.now()}.${ext}`;
        const { error } = await sb.storage.from("screenshots").upload(path, file, { contentType: file.type, upsert: false });
        if (error) fail(error);
        return path;
      },
      async screenshotUrl(path) {
        const hit = urlCache.get(path);
        if (hit && hit.exp > Date.now()) return hit.url;
        const { data, error } = await sb.storage.from("screenshots").createSignedUrl(path, 3600);
        if (error) fail(error);
        urlCache.set(path, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
        return data.signedUrl;
      },
    };
  }

  /** Shrinks a screenshot to at most 2000 px on its long side and re-encodes it as JPEG (keeps uploads small). */
  async function prepareImage(file) {
    if (!/^image\//.test(file.type)) throw new Error("That file is not an image.");
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (e) { throw new Error("Could not read that image."); }
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.88));
    if (!blob) throw new Error("Could not process the image.");
    return new File([blob], "chart.jpg", { type: "image/jpeg" });
  }

  function promptLogin(store) {
    return new Promise((resolve) => {
      $("auth").hidden = false;
      $("loginForm").onsubmit = async (e) => {
        e.preventDefault();
        const msg = $("loginMsg"); msg.hidden = true; $("loginBtn").disabled = true;
        try {
          await store.signIn($("loginEmail").value.trim(), $("loginPassword").value);
          $("loginPassword").value = ""; $("auth").hidden = true; resolve();
        } catch (err) { msg.textContent = err && err.message ? err.message : "Sign-in failed."; msg.hidden = false; }
        $("loginBtn").disabled = false;
      };
    });
  }

  async function initStore(onError) {
    const cfg = window.DD_CONFIG && window.DD_CONFIG.supabase;
    const forceLocal = /[?&]local=1\b/.test(location.search); // dev aid: test the layout without signing in
    if (!forceLocal && cfg && cfg.url && cfg.anonKey && window.supabase && window.supabase.createClient) {
      const st = supabaseStore(cfg, onError);
      if (!(await st.hasSession())) await promptLogin(st);
      $("signOut").hidden = false;
      return st;
    }
    let db = null;
    try {
      if (window.claude && typeof window.claude.use === "function") db = await window.claude.use("db");
    } catch (e) { db = null; }
    return db ? dbStore(db, onError) : localStore();
  }

  // ---------- small helpers --------------------------------------------------------------
  const ccy = () => S.rules.account.currency;
  const money = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtMoney = (n) => {
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: ccy() }).format(n); } catch (e) { return money(n) + " " + ccy(); }
  };
  const compact = (n) => {
    const a = Math.abs(n);
    const s = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M" : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k" : String(Math.round(a * 100) / 100);
    return (n < 0 ? "−" : "") + s.replace(/\.0(?=[kM]|$)/, "");
  };
  const hasR = (t) => typeof t.result_r === "number";
  const signed = (n, d = 2) => (Number(Math.abs(n).toFixed(d)) === 0 ? (0).toFixed(d) : (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(d));
  const grouped = (n, d = 2) => Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const signedGrouped = (n, d = 2) => (Number(Math.abs(n).toFixed(d)) === 0 ? grouped(0, d) : (n >= 0 ? "+" : "−") + grouped(n, d));
  const tz = () => S.rules.limits.day_timezone;
  const today = () => { try { return Core.localDay(new Date().toISOString(), tz()); } catch (e) { return new Date().toISOString().slice(0, 10); } };
  const fmtTime = (iso) => {
    try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz(), day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); }
    catch (e) { return iso.slice(0, 16).replace("T", " "); }
  };
  const fmtDay = (iso) => {
    try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz(), day: "numeric", month: "short" }).format(new Date(iso)); } catch (e) { return iso.slice(5, 10); }
  };
  let toastTimer;
  function toast(msg) {
    const el = $("toast"); el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }
  const mergeRules = (saved) => {
    const out = clone(Core.DEFAULT_RULES);
    if (saved) for (const sec of Object.keys(out)) if (saved[sec]) Object.assign(out[sec], saved[sec]);
    return out;
  };
  const focused = (...ids) => ids.some((id) => document.activeElement === $(id));
  const delta = (pct, text) => h("span", { class: "delta " + (pct > 0.005 ? "" : pct < -0.005 ? "down" : "flat"), text: (pct > 0.005 ? "↑ " : pct < -0.005 ? "↓ " : "") + (text || Math.abs(pct).toFixed(1) + "%") });

  // ---------- settings ---------------------------------------------------------------------
  let saveTimer;
  function saveSettingsSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!S.store) return;
      S.store.saveSettings({ rules: S.rules, equity: S.settings.equity, dayStart: S.settings.dayStart, dayStartDate: S.settings.dayStartDate })
        .catch((e) => toast("Could not save settings: " + (e && e.message ? e.message : "unknown error")));
    }, 500);
  }

  function applySettings(d, meta) {
    if (meta && meta.hasPendingWrites) return; // our own write echoing back
    S.rules = mergeRules(d && d.rules);
    S.settings = { equity: (d && d.equity) || "", dayStart: (d && d.dayStart) || "", dayStartDate: (d && d.dayStartDate) || "" };
    if (S.settings.dayStartDate !== today()) S.settings.dayStart = ""; // day-start equity only holds for its own day
    if (!focused("equity")) $("equity").value = S.settings.equity;
    if (!focused("dayStart")) $("dayStart").value = S.settings.dayStart;
    $("equityLabel").textContent = `Equity (${ccy()})`;
    if (!document.querySelector("#view-rules input:focus")) fillRulesForm();
    renderAll();
  }

  // ---------- form reading -------------------------------------------------------------------
  const dirValue = () => (document.querySelector('input[name="dir"]:checked') || {}).value || "buy";
  const val = (id) => $(id).value.trim();

  function readForm() {
    const eq = parseFloat(val("equity"));
    const allowed = isFinite(eq) && eq > 0 ? Core.allowedRiskPct(S.rules, eq, S.rules.account.starting_balance) : S.rules.risk.risk_per_trade_pct;
    return {
      pair: val("pair"), direction: dirValue(), timeframe: val("tf"), entry: val("entry"), stop: val("stop"),
      target: val("target"), equity: val("equity"), dayStart: val("dayStart"), riskPct: val("risk") || String(allowed),
      quoteToAccount: val("conv") || null, atr: val("atr"), atrMult: val("atrMult") || "1.5",
      setup: val("setup"), reason: val("reason"), allowed,
    };
  }

  // ---------- dashboard: status, meters, hero ---------------------------------------------------
  function dailyLossPct(eq, ds, dayStart) {
    if (isFinite(dayStart) && dayStart > 0) return { pct: ((dayStart - eq) / dayStart) * 100, basis: "equity" };
    const base = eq - ds.realized;
    return { pct: base > 0 ? (-ds.realized / base) * 100 : 0, basis: "closed trades only" };
  }

  function meter(label, valueText, ratio, sub) {
    const cls = ratio >= 1 ? "over" : ratio >= 0.6 ? "warn" : "";
    return h("div", { class: "meter" },
      h("div", { class: "meter-top" }, h("span", { text: label }), h("b", { text: valueText })),
      h("div", { class: "bar " + cls }, h("i", { style: `width:${Math.max(0, Math.min(1, ratio)) * 100}%` })),
      sub ? h("small", { text: sub }) : null);
  }

  function renderStatus(f) {
    const L = S.rules.limits, start = S.rules.account.starting_balance;
    const eq = parseFloat(f.equity), eqOk = isFinite(eq) && eq > 0;
    const ds = Core.dayStats(S.trades, tz());
    const dayStart = parseFloat(f.dayStart);
    $("acctSub").textContent = `IC Markets cTrader · ${ccy()}`;

    // hero
    $("heroValue").textContent = eqOk ? fmtMoney(eq) : "—";
    const hp = $("heroPct");
    if (eqOk) {
      const pct = ((eq - start) / start) * 100;
      hp.hidden = false; hp.textContent = (pct > 0.005 ? "↑ " : pct < -0.005 ? "↓ " : "") + Math.abs(pct).toFixed(1) + "% vs start";
      hp.className = "delta " + (pct > 0.005 ? "" : pct < -0.005 ? "down" : "flat");
    } else hp.hidden = true;
    $("heroSub").textContent = eqOk ? `Starting balance ${fmtMoney(start)}. The curve shows closed-trade results.` : "Enter your equity in the calculator.";

    // header chips
    const dd = eqOk ? Core.drawdownPct(eq, start) : 0;
    const todayPct = eqOk ? (ds.realized / (eq - ds.realized)) * 100 : 0;
    const chip = (label, value, d) => h("div", { class: "stat" }, h("div", {}, h("small", { text: label }), h("b", { text: value })), d);
    $("hdrStats").replaceChildren(
      chip("Today", `${signed(ds.realized)} ${ccy()}`, eqOk ? delta(todayPct, Math.abs(todayPct).toFixed(2) + "%") : null),
      chip("Drawdown", eqOk ? `${Math.max(0, dd).toFixed(1)}%` : "—", eqOk ? delta(-Math.max(0, dd), dd > 0.005 ? "of " + L.max_total_drawdown_pct + "%" : "none") : null),
      chip("Trades today", `${ds.opened} / ${L.max_trades_per_day}`, null));

    // rule meters
    const box = $("ruleMeters"); box.replaceChildren();
    box.append(meter("Trades today", `${ds.opened} of ${L.max_trades_per_day}`, ds.opened / L.max_trades_per_day, ds.opened >= L.max_trades_per_day ? "Limit reached. The next trade breaks your rule." : null));
    if (eqOk) {
      const dl = dailyLossPct(eq, ds, dayStart);
      box.append(meter("Daily loss", `${Math.max(0, dl.pct).toFixed(2)}% of ${L.daily_loss_warn_pct}%`, Math.max(0, dl.pct) / L.daily_loss_warn_pct, dl.basis === "equity" ? "Measured on equity." : "Closed trades only. Enter equity at start of today for the real check."));
      box.append(meter("Drawdown from start", `${Math.max(0, dd).toFixed(2)}% of ${L.max_total_drawdown_pct}%`, Math.max(0, dd) / L.max_total_drawdown_pct, `Risk drops to ${S.rules.risk.reduced_risk_per_trade_pct}% after ${L.drawdown_reduce_risk_pct}%.`));
      box.append(h("div", { class: "meter" }, h("div", { class: "meter-top" }, h("span", { text: "Risk allowed per trade" }), h("b", { text: f.allowed + "%" }))));
    } else box.append(h("p", { class: "hint", text: "Enter your equity to see daily loss and drawdown." }));
  }

  // ---------- equity curve ---------------------------------------------------------------------
  function niceTicks(min, max, n = 4) {
    if (min === max) max = min + 1;
    const raw = (max - min) / n, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) out.push(+v.toFixed(10));
    return out;
  }

  function smoothPath(p) {
    if (p.length < 3) return p.map((q, i) => (i ? "L" : "M") + q[0] + " " + q[1]).join(" ");
    let d = `M${p[0][0]} ${p[0][1]}`;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2;
      const lo = Math.min(p1[1], p2[1]), hi = Math.max(p1[1], p2[1]); // keep the curve from overshooting real values
      const clampY = (y) => Math.min(hi, Math.max(lo, y));
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clampY(p1[1] + (p2[1] - p0[1]) / 6)], c2 = [p2[0] - (p3[0] - p1[0]) / 6, clampY(p2[1] - (p3[1] - p1[1]) / 6)];
      d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  }

  /** Draws the cumulative result of `closed` trades (oldest first) into `host`. shade: tint the gap below the running peak (drawdown). */
  function drawEquity(host, tip, closed, isR, shade, emptyText) {
    host.replaceChildren(); tip.hidden = true;
    if (!closed.length) { host.append(h("p", { class: "empty center", text: emptyText })); return; }

    let run = 0, peak = 0;
    const pts = [{ v: 0, peak: 0, t: null, label: "Start" }];
    for (const t of closed) { run += isR ? t.result_r : t.net_money; peak = Math.max(peak, run); pts.push({ v: run, peak, t, label: fmtDay(t.closed_at) }); }

    const W = host.clientWidth || 560, H = host.clientHeight || 270, m = { l: 48, r: 14, t: 14, b: 28 };
    const lo = Math.min(...pts.map((p) => p.v), 0), hi = Math.max(...pts.map((p) => p.peak), 0);
    const ticks = niceTicks(lo, hi), y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const X = (i) => m.l + (pts.length === 1 ? 0 : (i * (W - m.l - m.r)) / (pts.length - 1));
    const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
    const xy = pts.map((p, i) => [+X(i).toFixed(1), +Y(p.v).toFixed(1)]);
    const fmtTick = (v) => (isR ? (v > 0 ? "+" : "") + v + "R" : compact(v));
    const gid = "area-" + host.id;

    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Cumulative result of closed trades" });
    svg.append(sv("defs", {}, sv("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 },
      sv("stop", { offset: "0%", "stop-color": "#C6F23A", "stop-opacity": ".30" }), sv("stop", { offset: "100%", "stop-color": "#C6F23A", "stop-opacity": "0" }))));
    for (const tk of ticks) {
      const y = Y(tk);
      svg.append(sv("line", { x1: m.l, x2: W - m.r, y1: y, y2: y, stroke: "rgba(255,255,255,.07)", "stroke-dasharray": tk === 0 ? "0" : "3 5", "stroke-width": tk === 0 ? 1.2 : 1 }));
      const lab = sv("text", { x: m.l - 10, y: y + 4, "text-anchor": "end", class: "ax" }); lab.textContent = fmtTick(tk); svg.append(lab);
    }
    const idx = pts.length <= 6 ? pts.map((_, i) => i) : [0, 1, 2, 3, 4, 5].map((k) => Math.round((k * (pts.length - 1)) / 5));
    for (const i of idx) {
      const lab = sv("text", { x: X(i), y: H - 6, "text-anchor": i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle", class: "ax" }); lab.textContent = pts[i].label; svg.append(lab);
    }
    const line = smoothPath(xy);
    if (shade) { // red band between the running peak and the curve
      const peakXY = pts.map((p, i) => [+X(i).toFixed(1), +Y(p.peak).toFixed(1)]);
      svg.append(sv("path", { d: `${smoothPath(peakXY)} ${smoothPath([...xy].reverse()).replace(/^M/, "L")} Z`, fill: "rgba(255,107,100,.16)" }));
    }
    svg.append(sv("path", { d: `${line} L${xy[xy.length - 1][0]} ${Y(Math.max(0, y0))} L${xy[0][0]} ${Y(Math.max(0, y0))} Z`, fill: `url(#${gid})` }));
    svg.append(sv("path", { d: line, fill: "none", stroke: "#C6F23A", "stroke-width": 2.5, "stroke-linecap": "round", "stroke-linejoin": "round", class: "glowline" }));
    const cross = sv("line", { y1: m.t, y2: H - m.b, stroke: "rgba(198,242,58,.55)", "stroke-dasharray": "4 4", visibility: "hidden" });
    const dot = sv("circle", { r: 6, fill: "#0A1705", stroke: "#C6F23A", "stroke-width": 3, visibility: "hidden" });
    svg.append(cross, dot);
    host.append(svg);

    const show = (clientX) => {
      const r = svg.getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * W;
      let best = 0, bd = Infinity;
      xy.forEach((p, i) => { const d = Math.abs(p[0] - px); if (d < bd) { bd = d; best = i; } });
      const [x, y] = xy[best], p = pts[best];
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("visibility", "visible");
      const up = best === 0 ? true : p.v >= pts[best - 1].v;
      tip.replaceChildren(h("i", { class: up ? "" : "down", text: up ? "↑" : "↓" }),
        h("div", {}, h("b", { text: isR ? signed(p.v) + "R" : fmtMoney(p.v) }),
          h("small", { text: p.t ? `${p.t.pair} ${p.t.direction === "buy" ? "long" : "short"} · ${hasR(p.t) ? signed(p.t.result_r) + "R" : signedMoney(p.t.net_money, 0)}` : "Start" })));
      tip.hidden = false;
      const hostBox = host.getBoundingClientRect(), cardBox = tip.offsetParent ? tip.offsetParent.getBoundingClientRect() : hostBox;
      const half = tip.offsetWidth / 2 + 10; // keep the whole tooltip inside the card, whatever its width
      tip.style.left = Math.min(Math.max(hostBox.left - cardBox.left + (x / W) * hostBox.width, half), cardBox.width - half) + "px";
      tip.style.top = hostBox.top - cardBox.top + (y / H) * hostBox.height + "px";
      tip.style.transform = (y / H) * hostBox.height < 70 ? "translate(-50%, 18px)" : ""; // near the top: show the tooltip below the point
    };
    const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
    svg.addEventListener("pointermove", (e) => show(e.clientX));
    svg.addEventListener("pointerdown", (e) => show(e.clientX));
    svg.addEventListener("pointerleave", hide);
    const box = svg.getBoundingClientRect();
    show(box.left + (xy[xy.length - 1][0] / W) * box.width); // rest state: latest point
  }

  const byClosed = (a, b) => (a.closed_at < b.closed_at ? -1 : 1);
  const closedSince = (trades, daysBack) => {
    const cutoff = daysBack === "all" ? -Infinity : Date.now() - Number(daysBack) * 86400000;
    return trades.filter((t) => t.status === "closed" && new Date(t.closed_at).getTime() >= cutoff).sort(byClosed);
  };

  function renderChart() { // dashboard on the Plan tab
    const isR = S.chartMetric === "r";
    const closed = closedSince(S.trades, S.chartRange).filter((t) => !isR || hasR(t));
    drawEquity($("chart"), $("chartTip"), closed, isR, false,
      S.trades.length ? "No closed trades in this range." : "Close a trade to start your curve.");
  }

  function renderJChart(scoped) { // Journal tab, with drawdown shading
    const isR = S.jMetric === "r";
    const closed = closedSince(scoped || S.trades, "all").filter((t) => !isR || hasR(t));
    drawEquity($("jChart"), $("jTip"), closed, isR, true, S.trades.length ? "No closed trades in this period." : "Close a trade to start your curve.");
    const st = Core.journalStats(closed);
    const meta = $("jChartMeta"); meta.replaceChildren();
    if (st.n) {
      meta.className = "sub dd";
      meta.append("Max drawdown ", h("b", { text: isR ? signed(-st.maxDrawdownR) + "R" : signedMoney(-st.maxDrawdown) }),
        ` · ${st.losingStreak} ${st.losingStreak === 1 ? "loss" : "losses"} running`);
    }
  }

  // ---------- recent trades and market hours ---------------------------------------------------------
  function renderRecent() {
    const box = $("recent"); box.replaceChildren();
    const list = [...S.trades].sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1)).slice(0, 5);
    if (!list.length) { box.append(h("p", { class: "empty", text: "No trades yet. Log your first plan." })); return; }
    for (const t of list) {
      const open = t.status === "open";
      box.append(h("div", { class: "rrow" },
        h("div", { class: "badge " + (t.direction === "buy" ? "up" : "dn"), text: t.direction === "buy" ? "▲" : "▼" }),
        h("div", { class: "rmain" }, h("b", { text: t.pair }), h("small", { text: [t.setup_tag, t.emotion_tag].filter(Boolean).join(" · ") })),
        h("div", { class: "rval" },
          h("b", { class: open ? "" : t.net_money >= 0 ? "pos" : "neg", text: open ? "open" : hasR(t) ? signed(t.result_r) + "R" : signedMoney(t.net_money, 0) }),
          h("small", { text: fmtDay(t.opened_at) }))));
    }
  }

  const SESSIONS = [
    { name: "Sydney", tz: "Australia/Sydney", open: 8 * 60, close: 17 * 60 },
    { name: "Tokyo", tz: "Asia/Tokyo", open: 9 * 60, close: 18 * 60 },
    { name: "London", tz: "Europe/London", open: 8 * 60, close: 17 * 60 },
    { name: "New York", tz: "America/New_York", open: 8 * 60, close: 17 * 60 },
  ];
  function sessionState(s, now) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: s.tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const g = (t) => p.find((x) => x.type === t).value;
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday"));
    const min = Number(g("hour")) * 60 + Number(g("minute"));
    if (wd >= 1 && wd <= 5 && min >= s.open && min < s.close) return { open: true, mins: s.close - min };
    for (let d = 0; d <= 7; d++) {
      const dw = (wd + d) % 7;
      if (dw < 1 || dw > 5) continue;
      const diff = d * 1440 + s.open - min;
      if (diff > 0) return { open: false, mins: diff };
    }
    return { open: false, mins: 0 };
  }
  const dur = (m) => { const d = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60), mm = m % 60; return d ? `${d}d ${hh}h` : hh ? `${hh}h ${mm}m` : `${mm}m`; };
  const ICON_SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>';
  const ICON_MOON = '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>';
  function renderSessions() {
    const now = new Date();
    $("hoursNote").textContent = "Approximate, 08:00–17:00 local";
    $("sessions").replaceChildren(...SESSIONS.map((s) => {
      const st = sessionState(s, now);
      const icon = h("span"); icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${st.open ? ICON_SUN : ICON_MOON}</svg>`;
      return h("div", { class: "sess" + (st.open ? " open" : "") }, icon.firstChild, h("b", { text: s.name }), h("small", { text: st.open ? `open · ${dur(st.mins)} left` : `opens in ${dur(st.mins)}` }));
    }));
  }

  // ---------- calculator ---------------------------------------------------------------------------------
  const tile = (label, value, sub) => h("div", { class: "tile" }, h("small", { text: label }), h("b", { text: value }), h("span", { text: sub }));
  const row = (label, value) => [h("dt", { text: label }), h("dd", { text: value })];

  // ---------- pair brief: typical range, news, your record, currency exposure ----------------------------------------------------
  const evTime = (iso) => {
    try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz(), weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); } catch (e) { return iso.slice(11, 16); }
  };
  const inText = (m) => (m >= 0 ? `in ${dur(m)}` : `${dur(-m)} ago`);

  async function loadCalendar() {
    try {
      const r = await fetch("data/calendar.json?ts=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (!j || !Array.isArray(j.events)) throw new Error("bad file");
      S.calendar = j; S.calendarError = "";
    } catch (e) {
      S.calendarError = window.claude ? "News needs the hosted app. It cannot load inside the Artifact." : "News is not available right now.";
    }
    if (!$("view-pair").hidden) compute();
  }

  function pipsBetween(pair, a, b) {
    try { return Math.abs(Core.toNum(Core.num(a)) - Core.toNum(Core.num(b))) / Core.toNum(Core.pipSize(pair)); } catch (e) { return 0; }
  }

  /** Fills the "Pair brief" card for the pair chosen in the calculator. Also called every minute so countdowns stay right. */
  function renderPairBrief(f) {
    f = f || readForm();
    const box = $("pairBrief"); box.replaceChildren();
    let cur;
    try { cur = Core.pairCurrencies(f.pair); } catch (e) { $("pairTitle").textContent = "Pair brief"; $("pairSub").textContent = ""; box.append(h("p", { class: "empty", text: "Choose a pair like EURUSD to see its brief." })); return; }
    $("pairTitle").textContent = `${cur[0]} / ${cur[1]}`;
    $("pairSub").textContent = "approximate ranges, live news";
    const sec = (title, ...kids) => h("div", { class: "pb-sec" }, h("h3", { text: title }), ...kids);
    const now = new Date();
    const out = [];

    // 1. typical daily range, and how your stop and target compare
    const stopPips = f.entry && f.stop ? pipsBetween(f.pair, f.entry, f.stop) : 0;
    const targetPips = f.entry && f.target ? pipsBetween(f.pair, f.entry, f.target) : 0;
    const chk = Core.stopCheck(f.pair, stopPips, targetPips);
    if (!chk) out.push(sec("Typical daily range", h("p", { class: "pb-line", text: `No typical range is saved for ${cur[0]}${cur[1]} yet.` })));
    else {
      const r = chk.range, max = Math.max(r.hi * 1.25, stopPips * 1.1, targetPips * 1.1);
      const at = (v) => `${Math.min(100, (v / max) * 100)}%`;
      const bar = h("div", { class: "rbar", role: "img", "aria-label": `Typical daily range ${r.lo} to ${r.hi} pips` },
        h("div", { class: "band", style: `left:${at(r.lo)};width:${((r.hi - r.lo) / max) * 100}%` }),
        stopPips ? h("div", { class: "mk stop", style: `left:${at(stopPips)}`, title: "Your stop" }) : null,
        targetPips ? h("div", { class: "mk tgt", style: `left:${at(targetPips)}`, title: "Your target" }) : null,
        h("span", { class: "tick", style: `left:${at(r.lo)}`, text: String(r.lo) }), h("span", { class: "tick", style: `left:${at(r.hi)}`, text: String(r.hi) }));
      out.push(sec("Typical daily range",
        h("div", { class: "pb-big" }, `${r.lo}–${r.hi} pips`, h("small", { text: r.source === "brief" ? "approximate" : "rough estimate" })), bar,
        chk.stopPct !== null ? h("p", { class: "pb-line" + (chk.flag ? " flag" : "") }, "Your stop ", h("b", { text: `${stopPips.toFixed(1)} pips` }), ` is ${chk.stopPct.toFixed(0)}% of a normal day. ${chk.stopNote}`) : null,
        chk.targetPct !== null ? h("p", { class: "pb-line" }, "Your target ", h("b", { text: `${targetPips.toFixed(1)} pips` }), ` is ${chk.targetPct.toFixed(0)}% of a normal day. ${chk.targetNote}`) : null,
        chk.stopPct === null ? h("p", { class: "hint", text: "Enter entry and stop to see where they sit on this range. Stop marker is red, target is green." }) : null));
    }

    // 2. news for either currency
    const newsKids = [];
    if (!S.calendar) newsKids.push(h("p", { class: "pb-line", text: S.calendarError || "Loading the news calendar…" }));
    else {
      const warn = Core.newsWarnings(S.calendar, f.pair, now);
      if (warn.length) newsKids.push(h("div", { class: "heads" }, `Heads up: ${warn.map((w) => `${w.currency} ${w.title} ${inText(w.inMinutes)}`).join("; ")}. Spreads widen and fills slip around releases.`));
      const list = Core.upcomingEvents(S.calendar, f.pair, now, 3);
      if (!list.length) newsKids.push(h("p", { class: "pb-line", text: "No more high or medium impact events this week for these currencies. Next week's calendar is published later in the week." }));
      for (const e of list) {
        newsKids.push(h("a", { class: "evt", href: Core.forexFactoryDayUrl(e.time, tz()), target: "_blank", rel: "noopener noreferrer", title: "Open this day on Forex Factory" },
          h("span", { class: "imp " + e.impact, text: e.impact === "Medium" ? "Med" : e.impact }),
          h("div", {}, h("b", {}, `${e.currency} ${e.title} `, h("span", { class: "go", text: "↗" })), h("small", { text: [e.forecast && `forecast ${e.forecast}`, e.previous && `previous ${e.previous}`].filter(Boolean).join(" · ") || "no forecast listed" })),
          h("div", { class: "when" }, h("b", { text: inText(e.inMinutes) }), evTime(e.time))));
      }
      const age = Core.calendarAgeMin(S.calendar, now);
      newsKids.push(h("p", { class: "hint", text: `The next 3 High-impact events for these currencies, soonest first (Medium ones fill the gaps). Click one to open that day on Forex Factory. Forex Factory calendar${age === null ? "" : `, updated ${dur(Math.max(0, age))} ago`}. Times in ${tz()}.` + (age !== null && age > 240 ? " This is old: the hourly refresh may have stopped." : "") }));
    }
    out.push(sec(`Next news for ${cur[0]} and ${cur[1]}`, ...newsKids));

    // 3. your own record on this pair
    const rec = Core.pairRecord(S.trades, f.pair);
    const last3 = Core.lastTradesOnPair(S.trades, f.pair, 3);
    out.push(sec(`Your record on ${cur[0]}${cur[1]}`, rec.n
      ? h("p", { class: "pb-line" }, h("b", { text: `${rec.n} closed trade${rec.n === 1 ? "" : "s"}` }), ` · ${Math.round(rec.winRate * 100)}% won · net `, h("b", { class: cls(rec.net), text: signedMoney(rec.net, 0) }),
          rec.avgR === null ? "" : ` · average ${signed(rec.avgR)}R`, rec.open ? ` · ${rec.open} open` : "", rec.n < 10 ? ". Only a few trades, so this is weak evidence." : ".")
      : h("p", { class: "pb-line", text: rec.open ? `No closed trades yet, ${rec.open} open.` : "No trades on this pair yet." }),
      last3.length ? h("h3", { text: `Last ${last3.length} trade${last3.length === 1 ? "" : "s"} on ${cur[0]}${cur[1]}`, style: "margin-top:6px" }) : null,
      last3.length ? h("div", { class: "recent" }, last3.map((t) => {
        const open = t.status === "open";
        return h("div", { class: "rrow click", role: "button", tabindex: "0", title: "Open this entry", onclick: () => openEntry(t),
          onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEntry(t); } } },
          h("div", { class: "badge " + (t.direction === "buy" ? "up" : "dn"), text: t.direction === "buy" ? "▲" : "▼" }),
          h("div", { class: "rmain" }, h("b", { text: t.direction === "buy" ? "Long" : "Short" }), h("small", { text: [t.setup_tag, t.reason].filter(Boolean).join(" · ").slice(0, 70) || fmtDay(t.opened_at) })),
          h("div", { class: "rval" },
            h("b", { class: open ? "" : cls(t.net_money), text: open ? "open" : hasR(t) ? signed(t.result_r) + "R" : signedMoney(t.net_money, 0) }),
            h("small", { text: fmtDay(t.opened_at) })));
      })) : null));

    // 4. overlap with your open trades
    const ex = Core.exposureCheck(f.pair, f.direction, S.trades);
    const exKids = [];
    for (const r of ex.same) exKids.push(h("p", { class: "pb-line flag" }, "Same side: ", h("b", { text: `${r.trade.pair} ${r.trade.direction}` }), ` is already ${r.side} ${r.currency}. This adds to the same bet.`));
    for (const r of ex.opposite) exKids.push(h("p", { class: "pb-line" }, "Pulls the other way: ", h("b", { text: `${r.trade.pair} ${r.trade.direction}` }), ` is ${r.side === "long" ? "short" : "long"} ${r.currency}.`));
    if (!exKids.length) exKids.push(h("p", { class: "pb-line", text: S.trades.some((t) => t.status === "open") ? "No overlap with your open trades." : "You have no open trades." }));
    out.push(sec("Your open trades", ...exKids));

    box.append(h("div", { class: "pb" }, out));
  }

  function compute() {
    const f = readForm();
    renderStatus(f);
    renderPairBrief(f);
    $("entryLabel").textContent = f.direction === "buy" ? "Entry (ask)" : "Entry (bid)";
    const eq = parseFloat(f.equity), eqOk = isFinite(eq) && eq > 0;
    $("risk").placeholder = String(f.allowed);
    const reduced = f.allowed === S.rules.risk.reduced_risk_per_trade_pct && f.allowed !== S.rules.risk.risk_per_trade_pct;
    $("riskHint").textContent = `Allowed now: ${f.allowed}% of equity.` + (reduced ? ` Reduced because drawdown is past ${S.rules.limits.drawdown_reduce_risk_pct}%.` : "");

    // Cross pairs (EUR/GBP on a USD account) need a conversion rate.
    let needConv = false, convQuote = "";
    try { Core.pipValuePerLot(f.pair, f.entry || "1", ccy(), null); } catch (e) { if (e.code === "need_conversion_rate") { needConv = true; convQuote = e.quote; } }
    $("convRow").hidden = !needConv;
    if (needConv) $("convLabel").textContent = `${convQuote}/${ccy()} price (${ccy()} per 1 ${convQuote})`;

    const box = $("result");
    box.replaceChildren();
    S.plan = null;
    if (!eqOk) { box.append(h("p", { class: "empty", text: "Enter your equity to start." })); updateLogBtn(); return; }
    if (!f.entry || !f.stop) { box.append(h("p", { class: "empty", text: "Enter entry and stop to see your lot size and rule check." })); updateLogBtn(); return; }

    const calc = (stop) => Core.calculatePosition({
      balance: f.equity, riskPct: f.riskPct, pair: f.pair, direction: f.direction, entry: f.entry, stop,
      account: ccy(), quoteToAccount: f.quoteToAccount, volumeStep: S.rules.broker.volume_step, minLots: S.rules.broker.min_lots,
    });
    let plan;
    try { plan = calc(f.stop); } catch (e) { box.append(h("p", { class: "err", text: e.message })); updateLogBtn(); return; }
    S.plan = plan;

    box.append(h("div", { class: "tiles" },
      tile("Lot size", plan.tradable ? plan.lots : "0", plan.tradable ? `${plan.units.toLocaleString("en-US")} units` : "no trade at this risk"),
      tile("Amount at risk", fmtMoney(plan.actualRiskMoney), `${plan.actualRiskPct.toFixed(2)}% of equity`)));
    const rows = [row("Stop distance", `${plan.stopPips.toFixed(1)} pips`), row("Pip value per lot", `${plan.pipValuePerLot.toFixed(4)} ${ccy()}`)];
    if (f.target) {
      const e = Number(f.entry), s = Number(f.stop), t = Number(f.target);
      const okSide = f.direction === "buy" ? t > e : t < e;
      if (isFinite(t) && okSide) rows.push(row("Planned reward : risk", `1 : ${(Math.abs(t - e) / Math.abs(e - s)).toFixed(2)}`));
      else if (isFinite(t)) rows.push(row("Planned reward : risk", "target is on the wrong side"));
    }
    box.append(h("dl", { class: "rows" }, rows.flat()));

    if (f.atr) {
      try {
        const sug = Core.suggestStop(f.direction, f.entry, f.atr, f.atrMult, f.pair);
        const alt = calc(sug);
        box.append(h("div", { class: "atr-line" },
          h("span", { text: `ATR stop ${sug}: ${alt.stopPips.toFixed(1)} pips, ${alt.tradable ? alt.lots + " lots" : "no trade"}` }),
          h("button", { type: "button", class: "small", text: "Use as stop", onclick: () => { $("stop").value = sug; compute(); } })));
      } catch (e) { box.append(h("p", { class: "err", text: "ATR: " + e.message })); }
    }

    // Rule check (warn only)
    const ds = Core.dayStats(S.trades, tz());
    const dsEq = parseFloat(f.dayStart);
    const warnings = plan.warnings.map((m) => ({ rule: "size", message: m })).concat(
      Core.checkRules(S.rules, {
        equity: eq, startingBalance: S.rules.account.starting_balance, tradesToday: ds.opened,
        realizedToday: ds.realized, dayStartEquity: isFinite(dsEq) && dsEq > 0 ? dsEq : null,
      }, plan.tradable ? plan.actualRiskPct : parseFloat(f.riskPct)));
    for (const w of Core.newsWarnings(S.calendar, f.pair, new Date()).slice(0, 2)) warnings.push({ rule: "news", message: `${w.currency} ${w.title} ${inText(w.inMinutes)}. Spreads widen and fills slip around releases.` });
    for (const r of Core.exposureCheck(f.pair, f.direction, S.trades).same) warnings.push({ rule: "currency_overlap", message: `You already hold ${r.trade.pair} ${r.trade.direction} (${r.side} ${r.currency}). This adds to the same bet.` });
    if (warnings.length) {
      box.append(h("ul", { class: "warns" }, warnings.map((w) => h("li", {}, h("strong", { text: w.rule.replace(/_/g, " ") + ": " }), w.message))));
      box.append(h("p", { class: "hint", style: "margin-top:8px", text: "Warn-only. Nothing is blocked. The decision is yours." }));
    } else {
      box.append(h("div", { class: "clear", text: "No rule warnings. That says nothing about whether the trade is any good." }));
    }
    updateLogBtn();
  }

  function updateLogBtn() {
    $("logBtn").disabled = !(S.store && S.plan && S.plan.tradable) || S.saving;
  }

  function refreshSetupList() {
    const seen = new Set(SETUPS);
    S.trades.forEach((t) => seen.add(t.setup_tag));
    $("setups").replaceChildren(...[...seen].sort().map((s) => h("option", { value: s })));
  }

  // ---------- screenshots ---------------------------------------------------------------------------------
  async function setShot(file) {
    try {
      S.shotFile = await prepareImage(file);
      $("shotPreview").src = URL.createObjectURL(S.shotFile);
      $("shotPreview").hidden = false; $("shotClear").hidden = false;
    } catch (e) { toast(e.message); }
  }
  function clearShot() {
    S.shotFile = null; $("shotInput").value = "";
    $("shotPreview").hidden = true; $("shotClear").hidden = true;
  }
  function openLightbox(src) { if (!src) return; $("lightboxImg").src = src; $("lightbox").hidden = false; }
  function thumb(path) {
    const img = h("img", { class: "thumb", alt: "Chart screenshot", loading: "lazy" });
    S.store.screenshotUrl(path).then((u) => { img.src = u; })
      .catch(() => img.replaceWith(h("p", { class: "hint", text: "Screenshot could not be loaded." })));
    img.addEventListener("click", () => openLightbox(img.src));
    return img;
  }
  function attachShot(t) {
    const input = h("input", { type: "file", accept: "image/*" });
    input.addEventListener("change", async () => {
      if (!input.files[0]) return;
      try {
        const file = await prepareImage(input.files[0]);
        const path = await S.store.uploadScreenshot(t.id, file);
        await S.store.saveTrade({ ...t, screenshot_path: path });
        toast("Screenshot added");
      } catch (e) { toast("Screenshot failed: " + (e && e.message ? e.message : "unknown error")); }
    });
    input.click();
  }

  async function logTrade() {
    const f = readForm();
    const msg = $("logMsg"); msg.hidden = true;
    try {
      const trade = Core.buildTrade({
        pair: f.pair, direction: f.direction, timeframe: f.timeframe, entry: f.entry, stop: f.stop, target: f.target,
        equity: f.equity, riskPct: f.riskPct, setup: f.setup, reason: f.reason, quoteToAccount: f.quoteToAccount,
      }, S.rules);
      S.saving = true; updateLogBtn();
      let shotError = "";
      if (S.shotFile && S.store.uploadScreenshot) {
        try { trade.screenshot_path = await S.store.uploadScreenshot(trade.id, S.shotFile); }
        catch (e) { shotError = e && e.message ? e.message : "upload failed"; }
      }
      await S.store.saveTrade(trade);
      S.saving = false;
      for (const id of ["setup", "reason", "target"]) $(id).value = "";
      clearShot(); compute();
      toast(shotError ? `Logged, but the screenshot failed (${shotError}). Add it from the journal.` : `Logged ${trade.pair} ${trade.direction}, ${trade.lots} lots`);
      location.hash = "#journal";
    } catch (e) {
      S.saving = false; updateLogBtn();
      msg.textContent = e && e.message ? e.message : "Could not log the trade"; msg.hidden = false;
    }
  }

  // ---------- journal ------------------------------------------------------------------------------------------
  const LEAK_EMOTIONS = new Set(["revenge", "fomo", "bored", "impatient", "greedy"]); // rows with these get the amber hatching
  const money0 = (n, dp) => {
    const d = dp === undefined ? (Math.abs(n) >= 1000 ? 0 : 2) : dp;
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: ccy(), minimumFractionDigits: d, maximumFractionDigits: d }).format(Math.abs(n)); }
    catch (e) { return Math.abs(n).toFixed(d); }
  };
  const signedMoney = (n, dp) => (n < 0 ? "−" : "+") + money0(n, dp);
  const plainMoney = (n, dp) => (n < 0 ? "−" : "") + money0(n, dp);
  const cls = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "");
  const rowDate = (iso) => {
    try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz(), day: "2-digit", month: "short", year: "2-digit" }).format(new Date(iso)); } catch (e) { return iso.slice(0, 10); }
  };
  const tradeDay = (t) => Core.localDay(t.status === "closed" ? t.closed_at : t.opened_at, tz());
  const sessionOf = (iso) => { const hr = new Date(iso).getUTCHours(); return hr >= 13 && hr < 21 ? "New York" : hr >= 7 && hr < 13 ? "London" : "Asia"; }; // rough, by UTC hour
  const durText = (a, b) => dur(Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)));
  const px = (t, x) => Number(x).toFixed(t.pair.endsWith("JPY") ? 3 : 5);

  /** SL = stopped out, TP = target reached, WIN / LOSS / BE = by the total after charges. */
  function outcomeOf(t) {
    const tol = (t.pair.endsWith("JPY") ? 0.01 : 0.0001) * 0.5;
    if (typeof t.stop === "number" && Math.abs(t.exit_price - t.stop) <= tol) return "SL";
    if (typeof t.target === "number" && (t.direction === "buy" ? t.exit_price >= t.target - tol : t.exit_price <= t.target + tol)) return "TP";
    return t.net_money > 0.005 ? "WIN" : t.net_money < -0.005 ? "LOSS" : "BE";
  }
  const OUTCOME_HELP = { SL: "Stopped out", TP: "Target reached or passed", WIN: "Profit after charges", LOSS: "Loss after charges", BE: "About break-even", OPEN: "Still open" };

  function renderJournal() {
    refreshSetupList();
    const days = S.jRange === "all" ? Infinity : Number(S.jRange), cutoff = Date.now() - days * 86400000;
    const scoped = S.trades.filter((t) => t.status === "open" || new Date(t.closed_at).getTime() >= cutoff);
    renderKpis(Core.journalStats(scoped));
    if (!$("view-journal").hidden) renderJChart(scoped);
    renderCalendar();
    renderTradeLog(scoped);
  }

  function renderKpis(st) {
    const el = $("kpiBar"); el.replaceChildren();
    const cell = (label, big, sub, c) => h("div", { class: "kcell" }, h("small", { text: label }), h("b", { class: c || "", text: big }), h("span", { text: sub }));
    if (!st.n) {
      el.append(cell("Net after costs", "—", "No closed trades yet"), cell("Win rate", "—", "needs a closed trade"), cell("Profit factor", "—", "wins ÷ losses"),
        cell("Avg win / loss", "—", "average sizes"), cell("Expectancy", "—", "average per trade"));
      return;
    }
    const pf = (v) => (v === null ? "—" : v === Infinity ? "∞" : v.toFixed(2));
    el.append(
      cell("Net after costs", signedMoney(st.net), `${signedMoney(st.gross, 2)} result less ${money0(st.costs, 2)} costs`, cls(st.net)),
      cell("Win rate", `${(st.winRate * 100).toFixed(1)}%`, `${st.wins}W ${st.losses}L ${st.breakeven}BE`),
      cell("Profit factor", pf(st.profitFactor), `${pf(st.profitFactorGross)} before costs`),
      cell("Avg win / loss", st.payoff === null ? "—" : st.payoff.toFixed(2) + "×", `${st.avgWin === null ? "—" : money0(st.avgWin, 2)} / ${st.avgLoss === null ? "—" : "−" + money0(st.avgLoss, 2)}`),
      cell("Expectancy", signedMoney(st.expectancy), st.rCount ? `${signed(st.expectancyR)}R average · ${signed(st.totalR)}R total` : "add stop losses to see R", cls(st.expectancy)));
  }

  // ---- calendar ----
  function renderCalendar() {
    const { y, m } = S.cal;
    const daily = Core.dailyNet(S.trades, tz());
    const prefix = `${y}-${String(m + 1).padStart(2, "0")}`;
    const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
    const weeks = Math.ceil((lead + new Date(Date.UTC(y, m + 1, 0)).getUTCDate()) / 7);
    const todayKey = today();
    $("calPick").value = prefix;

    let n = 0, net = 0, r = 0, maxAbs = 0;
    for (const [k, v] of Object.entries(daily)) { maxAbs = Math.max(maxAbs, Math.abs(v.net)); if (k.startsWith(prefix)) { n += v.n; net += v.net; r += v.r; } }
    const sum = (label, val, c) => h("div", {}, label, h("b", { class: c || "", text: val }));
    $("calSum").replaceChildren(sum("Trades", String(n)), sum("Net", n ? signedMoney(net) : "—", cls(net)), sum("R", n ? signed(r) : "—", cls(r)));

    const grid = $("calGrid"); grid.replaceChildren();
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Week"]) grid.append(h("div", { class: "dow", text: d }));
    for (let w = 0; w < weeks; w++) {
      let wNet = 0, wDays = 0;
      for (let d = 0; d < 7; d++) {
        const date = new Date(Date.UTC(y, m, 1 - lead + w * 7 + d));
        const key = date.toISOString().slice(0, 10), v = daily[key], inMonth = key.startsWith(prefix);
        const traded = v && (v.n || v.open);
        if (inMonth && v && v.n) { wNet += v.net; wDays += 1; }
        const c = ["day"];
        if (!inMonth) c.push("off");
        if (v && v.n) c.push(v.net > 0 ? "win" : v.net < 0 ? "loss" : "");
        if (key === todayKey) c.push("today");
        if (S.dayFilter === key) c.push("sel");
        if (traded) c.push("click");
        const parts = [h("span", { class: "dn", text: String(date.getUTCDate()) })];
        const dayMoney = (n) => (Math.abs(n) >= 1000 ? (n < 0 ? "−" : "+") + money0(Math.abs(n) / 1000, 1).replace(/\.0$/, "") + "k" : signedMoney(n, 2)); // "+$6k", "−$3.1k", "+$5.99"
        if (v && v.n) parts.push(h("span", { class: "dv", text: dayMoney(v.net) }), h("span", { class: "ds", text: `${v.n} trade${v.n === 1 ? "" : "s"}${v.open ? ` · ${v.open} open` : ""}` }));
        else if (v && v.open) parts.push(h("span", { class: "ds", text: `${v.open} open` }));
        const cell = h("div", { class: c.join(" "), role: traded ? "button" : null, tabindex: traded ? "0" : null, title: traded ? "Show these trades" : null }, parts);
        if (v && v.n) cell.style.setProperty("--a", String(Math.min(0.5, 0.14 + 0.36 * (Math.abs(v.net) / (maxAbs || 1)))));
        if (traded) {
          const pick = () => { S.dayFilter = S.dayFilter === key ? null : key; renderCalendar(); renderTradeLog(); };
          cell.addEventListener("click", pick);
          cell.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
        }
        grid.append(cell);
      }
      grid.append(h("div", { class: "wk" }, h("span", { text: `Week ${w + 1}` }), h("b", { class: cls(wNet), text: wDays ? signedMoney(wNet, 0) : "—" }), h("span", { text: `${wDays} day${wDays === 1 ? "" : "s"}` })));
    }
  }

  function shiftMonth(delta) {
    const d = new Date(Date.UTC(S.cal.y, S.cal.m + delta, 1));
    S.cal = { y: d.getUTCFullYear(), m: d.getUTCMonth() }; S.dayFilter = null; renderCalendar(); renderTradeLog();
  }

  // ---- trade list ----
  function renderTradeLog(scopedIn) {
    const scoped = scopedIn || S.trades.filter((t) => t.status === "open" || new Date(t.closed_at).getTime() >= (S.jRange === "all" ? -Infinity : Date.now() - Number(S.jRange) * 86400000));
    const inScope = new Set(scoped.map((t) => t.id));
    const asc = [...S.trades].sort((a, b) => (a.opened_at < b.opened_at ? -1 : 1));
    const no = new Map(asc.map((t, i) => [t.id, i + 1]));
    const filters = [["all", "All"], ["open", "Open"], ["wins", "Wins"], ["losses", "Losses"]];
    const chips = filters.map(([k, label]) => h("button", { type: "button", class: "chip", "aria-pressed": String(S.tf === k), text: label, onclick: () => { S.tf = k; renderTradeLog(); } }));
    if (S.dayFilter) chips.push(h("button", { type: "button", class: "chip", "aria-pressed": "true", text: `${rowDate(S.dayFilter + "T12:00:00Z")} ✕`, title: "Clear the day filter", onclick: () => { S.dayFilter = null; renderCalendar(); renderTradeLog(); } }));
    $("logFilters").replaceChildren(...chips);

    const list = [...asc].reverse().filter((t) => inScope.has(t.id)
      && (S.tf === "all" || (S.tf === "open" && t.status === "open") || (S.tf === "wins" && t.net_money > 0) || (S.tf === "losses" && t.net_money < 0))
      && (!S.dayFilter || tradeDay(t) === S.dayFilter));
    $("logCount").textContent = `${list.length} shown`;
    const box = $("tradeList"); box.replaceChildren();
    if (!list.length) { box.append(h("p", { class: "empty", text: S.trades.length ? "No trades match this filter." : "No trades yet. Plan one on the Plan tab and tap Log trade." })); return; }
    for (const t of list) box.append(tradeRow(t, no.get(t.id)));
  }

  const CAMERA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.2-2h5.6L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.4"/></svg>';

  function tradeRow(t, num) {
    const open = t.status === "open", leak = LEAK_EMOTIONS.has(t.emotion_tag), expanded = S.expandedId === t.id;
    const out = open ? "OPEN" : outcomeOf(t);
    const toggle = () => { S.expandedId = expanded ? null : t.id; renderTradeLog(); };
    const shot = h("span", { class: "c-shot" });
    if (S.store && S.store.screenshotUrl && t.screenshot_path) {
      const b = h("button", { type: "button", class: "camera", "aria-label": "Open screenshot", title: "Open screenshot",
        onclick: (e) => { e.stopPropagation(); S.store.screenshotUrl(t.screenshot_path).then(openLightbox).catch(() => toast("Screenshot could not be loaded")); } });
      b.innerHTML = CAMERA; shot.append(b);
    }
    const row = h("div", { class: "jrow", role: "button", tabindex: "0", "aria-expanded": String(expanded), onclick: toggle,
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } } },
      h("span", { class: "c-no", text: String(num) }),
      h("span", { class: "c-date", text: rowDate(open ? t.opened_at : t.closed_at) }),
      h("span", { class: "c-pair" }, h("b", { text: t.pair }), h("small", { class: t.direction === "buy" ? "long" : "short", text: (t.direction === "buy" ? "Long" : "Short") + (t.timeframe ? " · " + t.timeframe : "") })),
      h("span", { class: "c-out" }, h("span", { class: "out out-" + out, title: OUTCOME_HELP[out], text: out })),
      h("span", { class: "c-size" }, `${t.lots} lots`, h("small", { text: t.risk_money != null ? `risk ${money0(t.risk_money, 0)}` : "no stop set" })),
      h("span", { class: "c-gross " + (open ? "" : cls(t.gross_money)), text: open ? "—" : signedGrouped(t.gross_money) }),
      h("span", { class: "c-cost", text: open ? "—" : "−" + grouped(t.costs) }),
      h("span", { class: "c-net " + (open ? "" : cls(t.net_money)), text: open ? "—" : signedGrouped(t.net_money) }),
      h("span", { class: "c-r " + (open || !hasR(t) ? "" : cls(t.result_r)), text: open || !hasR(t) ? "—" : signed(t.result_r) + "R" }),
      h("span", { class: "c-tags" }, h("span", { class: "tg setup", text: t.setup_tag }), t.emotion_tag ? h("span", { class: "tg" + (leak ? " leak" : ""), text: t.emotion_tag }) : null),
      shot);
    const wrap = h("section", { class: "jtrade" + (leak ? " leak" : "") + (open ? " isopen" : "") }, row);
    if (expanded) wrap.append(tradeDetail(t, open));
    return wrap;
  }

  function tradeDetail(t, open) {
    const fact = (label, value) => h("div", { class: "fact" }, h("small", { text: label }), h("b", { text: value }));
    const facts = [
      fact("Opened", fmtTime(t.opened_at)), fact("Session", sessionOf(t.opened_at)),
      fact("Entry", px(t, t.entry)), fact("Stop", t.stop != null ? `${px(t, t.stop)} · ${t.stop_pips.toFixed(1)} pips` : "not set"),
      fact("Target", t.target != null ? px(t, t.target) : "not set"), fact("Risk : reward", t.planned_rr != null ? `1 : ${Number(t.planned_rr.toFixed(2))}` : "not set"),
      fact("Risk", t.risk_money != null ? `${money0(t.risk_money, 2)}${t.risk_pct != null ? " · " + t.risk_pct.toFixed(2) + "%" : ""}` : "unknown without a stop"),
    ];
    if (!open) facts.push(fact("Closed", fmtTime(t.closed_at)), fact("Held", durText(t.opened_at, t.closed_at)),
      fact("Exit", `${px(t, t.exit_price)} · ${signed(t.exit_pips, 1)} pips`), fact("Costs", money0(t.costs, 2)));
    const box = h("div", { class: "jdetail" }, h("div", { class: "facts" }, facts));
    if (t.reason) box.append(h("div", { class: "fact" }, h("small", { text: "Why this trade" }), h("p", { class: "note", text: t.reason })));
    if (t.notes_text) box.append(h("div", { class: "fact" }, h("small", { text: "Notes" }), h("p", { class: "note", text: t.notes_text.length > 420 ? t.notes_text.slice(0, 420) + "…" : t.notes_text })));
    box.append(h("button", { type: "button", class: "small primary", style: "align-self:flex-start", text: "Open entry", onclick: () => openEntry(t) }));
    if (t.exit_note) box.append(h("div", { class: "fact" }, h("small", { text: "What happened" }), h("p", { class: "note", text: t.exit_note })));
    if (t.screenshot_path && S.store && S.store.screenshotUrl) box.append(thumb(t.screenshot_path));
    else if (S.store && S.store.uploadScreenshot) box.append(h("button", { type: "button", class: "small ghost", style: "align-self:flex-start", text: "Add screenshot", onclick: () => attachShot(t) }));
    return box;
  }

  async function exportCsv() {
    const csv = Core.toCsv([...S.trades].sort((a, b) => (a.opened_at < b.opened_at ? -1 : 1)));
    if (!S.trades.length) { toast("Nothing to export yet"); return; }
    let dl = null;
    try { dl = window.claude && window.claude.use ? await window.claude.use("downloads") : null; } catch (e) { dl = null; }
    if (dl) {
      try { await dl.save({ filename: "discipline-desk-journal.csv", data: csv }); toast("Saved"); return; }
      catch (e) { if (e && e.code === "declined") return; }
    }
    $("csvText").value = csv; $("exportFallback").hidden = false;
  }

  // ---------- entry page: trade fields on top, Notion-style notes below ------------------------------------------------------
  const pad2 = (n) => String(n).padStart(2, "0");
  const dateOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const timeOf = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const joinWhen = (date, time) => { if (!date) return ""; const d = new Date(`${date}T${time || "00:00"}`); return isNaN(d) ? "invalid" : d.toISOString(); };
  const newId = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ev = (id) => $(id).value.trim();

  function entryForm() {
    const e = S.entry;
    return {
      id: e.id, pair: ev("e_pair"), direction: (document.querySelector('input[name="edir"]:checked') || {}).value || "buy",
      why: $("e_why").value, openedAt: joinWhen($("e_entryDate").value, $("e_entryTime").value), closedAt: joinWhen($("e_exitDate").value, $("e_exitTime").value),
      entry: ev("e_entry"), exit: ev("e_exit"), lots: ev("e_lots"), pnl: ev("e_pnl"), charges: ev("e_charges"), rr: ev("e_rr"), stop: ev("e_stop"),
      setup: ev("e_setup"), emotion: "", equity: S.settings.equity || "",
    };
  }

  function setEntryStatus(text, kind) { const s = $("entryStatus"); s.textContent = text; s.className = "entry-status " + (kind || ""); }
  function markDirty() {
    const e = S.entry; if (!e) return;
    e.dirty = true; e.confirm = null; setEntryStatus("Unsaved changes", "dirty");
    $("entryBack").textContent = "← Back"; $("entryDelete").textContent = "Delete";
  }

  /** Flips a money box between a profit and a loss by adding or removing the minus sign. */
  function flipSign(id) {
    const el = $(id), v = el.value.trim();
    el.value = !v ? "-" : /^[-−]/.test(v) ? v.replace(/^[-−]\s*/, "") : "-" + v;
    el.dispatchEvent(new Event("input", { bubbles: true })); el.focus();
  }

  /** Updates the result badge, the automatic total and the hints while you type. */
  function entryPreview() {
    const f = entryForm(), box = $("entryCalc"); box.replaceChildren();
    const total = $("e_total"), badge = $("e_badge"), text = $("e_resultText");
    const setBadge = (kind, label) => { badge.className = "rbadge " + kind; badge.textContent = label; };
    const say = (msg, c) => box.append(h("span", { class: c || "hint", text: msg }));
    // Total = profit or loss minus charges. Charges are always a cost, whether typed with a minus or not.
    let pnl = null, charges = null, moneyError = "";
    try { pnl = Core.parseMoney(f.pnl, "Profit or loss"); charges = Core.parseMoney(f.charges, "Charges"); } catch (err) { moneyError = err.message; }
    if (pnl !== null && !moneyError) {
      const t = pnl - Math.abs(charges || 0);
      total.textContent = signedMoney(t, 2); total.className = "total " + (t > 0.005 ? "pos" : t < -0.005 ? "neg" : "");
    } else { total.textContent = "—"; total.className = "total"; }
    if (moneyError) { setBadge("open", "Check amount"); text.textContent = ""; say(moneyError, "err"); return; }

    try {
      const t = Core.buildSimpleEntry({ ...f, setup: f.setup || "x", notes: null }, S.rules, S.entry.base);
      if (t.status === "closed") {
        setBadge(t.net_money > 0.005 ? "profit" : t.net_money < -0.005 ? "loss" : "be", t.net_money > 0.005 ? "Profit" : t.net_money < -0.005 ? "Loss" : "Break-even");
        text.textContent = `${signed(t.exit_pips, 1)} pips` + (t.result_r !== null ? ` · ${signed(t.result_r)}R` : "") + ` · held ${durText(t.opened_at, t.closed_at)}`;
        if (t.estimated) { total.textContent = signedMoney(t.net_money, 2); total.className = "total " + (t.net_money > 0 ? "pos" : t.net_money < 0 ? "neg" : ""); say("Profit estimated from pips. Type your broker's profit or loss for the exact figure."); }
        if (t.result_r === null) say("Add a stop loss price to get your R multiple.");
      } else {
        setBadge("open", "Open");
        text.textContent = t.risk_money !== null ? `Risking ${fmtMoney(t.risk_money)}${t.risk_pct ? ` · ${t.risk_pct.toFixed(2)}% of equity` : ""}` : "Trade still open";
      }
    } catch (err) {
      setBadge("open", f.exit ? "Incomplete" : "Open"); text.textContent = "";
      if (f.entry && f.lots) say(err.message, "err"); else say("Fill in the trade. The total and result update as you type.");
    }
  }

  /** Gives stored image paths a fresh signed link, so the editor can show them. */
  async function hydrateNotes(doc) {
    if (!doc || !Array.isArray(doc.blocks)) return undefined;
    const copy = JSON.parse(JSON.stringify(doc));
    await Promise.all(copy.blocks.map(async (b) => {
      if (b.type === "image" && b.data && b.data.file && b.data.file.path && S.store.screenshotUrl) {
        try { b.data.file.url = await S.store.screenshotUrl(b.data.file.path); } catch (err) { b.data.file.url = ""; }
      }
    }));
    return copy;
  }

  async function uploadEntryImage(file) {
    if (!S.store || !S.store.uploadScreenshot) { toast("Images need the hosted version (Supabase)."); return { success: 0 }; }
    try {
      const small = await prepareImage(file);
      const path = await S.store.uploadScreenshot(S.entry.id, small);
      return { success: 1, file: { url: await S.store.screenshotUrl(path), path } };
    } catch (err) { toast("Image upload failed: " + (err && err.message ? err.message : "unknown error")); return { success: 0 }; }
  }

  async function mountNotes(doc) {
    const host = $("notesHost"); host.replaceChildren();
    const e = S.entry;
    if (!window.EditorJS) { // plain text fallback (for example in the Artifact)
      $("notesHint").textContent = "Plain text here. The hosted app has the full editor.";
      const ta = h("textarea", { id: "notesFallback", placeholder: "Write your analysis…", oninput: markDirty });
      ta.value = Core.notesToText(doc); host.append(ta); return;
    }
    $("notesHint").textContent = S.store && S.store.uploadScreenshot ? "Type / for blocks. Paste or drop a screenshot to add an image." : "Type / for blocks. Images need the hosted version.";
    const data = await hydrateNotes(doc);
    const tools = {
      header: { class: window.Header, inlineToolbar: true, config: { levels: [1, 2, 3], defaultLevel: 2, placeholder: "Heading" } },
      list: { class: window.EditorjsList, inlineToolbar: true, config: { defaultStyle: "unordered" } },
      checklist: { class: window.Checklist, inlineToolbar: true },
      quote: { class: window.Quote, inlineToolbar: true },
      delimiter: window.Delimiter, code: window.CodeTool, table: { class: window.Table, inlineToolbar: true },
      inlineCode: window.InlineCode, marker: window.Marker,
      image: { class: window.ImageTool, config: { captionPlaceholder: "Caption", buttonContent: "Select or paste an image",
        uploader: { uploadByFile: uploadEntryImage, uploadByUrl: async () => ({ success: 0 }) } } },
    };
    for (const k of Object.keys(tools)) if (!(tools[k].class || tools[k])) delete tools[k]; // skip any tool whose file failed to load
    // Editor.js also fires "change" after it renders or saves, so compare the content with what was last saved before marking dirty.
    const notesHash = (doc) => JSON.stringify(((doc && Core.notesForStorage(doc)) || { blocks: [] }).blocks);
    e.notesHash = notesHash;
    let timer;
    e.editor = new window.EditorJS({
      holder: host, data, tools, placeholder: "Write your analysis. Type / for headings, lists, tables, images…",
      autofocus: false, minHeight: 200,
      onChange: () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          if (S.entry !== e || !e.editor) return;
          try { if (notesHash(await e.editor.save()) !== e.savedHash) markDirty(); } catch (err) { markDirty(); }
        }, 250);
      },
    });
    await e.editor.isReady;
    e.savedHash = notesHash(await e.editor.save());
  }

  async function openEntry(trade) {
    const e = S.entry = { id: trade ? trade.id : newId(), base: trade || null, isNew: !trade, dirty: false, editor: null, confirm: null };
    const set = (id, v) => { $(id).value = v === null || v === undefined ? "" : String(v); };
    const rrText = (r) => (r === null || r === undefined ? "" : "1:" + String(Number(r.toFixed(2))));
    if (trade) {
      const o = new Date(trade.opened_at), c = trade.closed_at ? new Date(trade.closed_at) : null;
      set("e_pair", trade.pair); set("e_why", trade.reason); $(trade.direction === "sell" ? "edir-sell" : "edir-buy").checked = true;
      set("e_lots", trade.lots); set("e_entry", trade.entry); set("e_entryDate", dateOf(o)); set("e_entryTime", timeOf(o));
      set("e_exit", trade.exit_price); set("e_exitDate", c ? dateOf(c) : ""); set("e_exitTime", c ? timeOf(c) : "");
      set("e_pnl", trade.gross_money); set("e_charges", trade.costs ? -trade.costs : ""); set("e_rr", rrText(trade.planned_rr));
      set("e_stop", trade.stop); set("e_setup", trade.setup_tag);
    } else {
      const now = new Date();
      set("e_pair", "EURUSD"); $("edir-buy").checked = true; set("e_entryDate", dateOf(now)); set("e_entryTime", timeOf(now));
      for (const id of ["e_why", "e_lots", "e_entry", "e_exit", "e_exitDate", "e_exitTime", "e_pnl", "e_charges", "e_rr", "e_stop", "e_setup"]) set(id, "");
    }
    $("entryTitle").textContent = trade ? `${trade.pair} ${trade.direction === "buy" ? "long" : "short"}` : "New entry";
    $("entryDelete").hidden = !trade; $("entryDelete").textContent = "Delete"; $("entryBack").textContent = "← Back";
    $("entryMsg").hidden = true;
    setEntryStatus(trade ? "Saved" : "New entry, not saved yet", trade ? "ok" : "");
    entryPreview();
    $("entryPage").hidden = false; $("entryPage").scrollTop = 0; document.body.classList.add("noscroll");
    await mountNotes(trade ? trade.notes : null);
    if (S.entry !== e) return; // closed while loading
    if (!trade) $("e_why").focus();
  }

  async function closeEntry() {
    const e = S.entry; S.entry = null;
    $("entryPage").hidden = true; document.body.classList.remove("noscroll");
    if (e && e.editor && e.editor.destroy) { try { await e.editor.destroy(); } catch (err) { /* already gone */ } }
    $("notesHost").replaceChildren();
  }

  async function saveEntry() {
    const e = S.entry; if (!e) return;
    const msg = $("entryMsg"); msg.hidden = true; $("entrySave").disabled = true;
    try {
      let notes = null;
      if (e.editor) { const out = await e.editor.save(); notes = out.blocks.length ? out : null; }
      else if ($("notesFallback") && $("notesFallback").value.trim()) {
        notes = { blocks: $("notesFallback").value.split("\n").filter((l) => l.trim()).map((l) => ({ type: "paragraph", data: { text: escapeHtml(l) } })) };
      }
      const t = Core.buildSimpleEntry({ ...entryForm(), notes }, S.rules, e.base);
      await S.store.saveTrade(t);
      e.base = t; e.isNew = false; e.dirty = false; e.confirm = null;
      if (e.notesHash) e.savedHash = e.notesHash(notes);
      $("entryTitle").textContent = `${t.pair} ${t.direction === "buy" ? "long" : "short"}`; $("entryDelete").hidden = false;
      setEntryStatus("Saved", "ok"); toast("Entry saved"); entryPreview();
    } catch (err) {
      msg.textContent = err && err.message ? err.message : "Could not save the entry"; msg.hidden = false;
      msg.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    $("entrySave").disabled = false;
  }

  async function deleteEntry() {
    const e = S.entry; if (!e || !e.base) return;
    if (e.confirm !== "delete") { e.confirm = "delete"; $("entryDelete").textContent = "Delete forever?"; setEntryStatus("Click Delete again to remove this entry and its images. This cannot be undone.", "dirty"); return; }
    try { await S.store.deleteTrade(e.base); toast("Entry deleted"); await closeEntry(); }
    catch (err) { toast("Could not delete: " + (err && err.message ? err.message : "unknown error")); }
  }

  function backFromEntry() {
    const e = S.entry; if (!e) return;
    if (e.dirty && e.confirm !== "discard") { e.confirm = "discard"; $("entryBack").textContent = "Discard changes?"; setEntryStatus("You have unsaved changes. Click again to discard them.", "dirty"); return; }
    closeEntry();
  }

  function bindEntry() {
    $("addEntry").addEventListener("click", () => openEntry(null));
    $("entryBack").addEventListener("click", backFromEntry);
    $("entrySave").addEventListener("click", saveEntry);
    $("entryDelete").addEventListener("click", deleteEntry);
    $("e_pnlSign").addEventListener("click", () => flipSign("e_pnl"));
    $("e_chSign").addEventListener("click", () => flipSign("e_charges"));
    for (const id of ["e_pair", "e_why", "e_lots", "e_entryDate", "e_entryTime", "e_entry", "e_exitDate", "e_exitTime", "e_exit", "e_pnl", "e_charges", "e_rr", "e_stop", "e_setup"]) {
      $(id).addEventListener("input", () => {
        if (id === "e_exit" && $("e_exit").value.trim() && !$("e_exitDate").value) { const n = new Date(); $("e_exitDate").value = dateOf(n); $("e_exitTime").value = timeOf(n); }
        markDirty(); entryPreview();
      });
    }
    document.querySelectorAll('input[name="edir"]').forEach((r) => r.addEventListener("change", () => { markDirty(); entryPreview(); }));
    document.addEventListener("keydown", (ke) => {
      if (S.entry && (ke.metaKey || ke.ctrlKey) && ke.key.toLowerCase() === "s") { ke.preventDefault(); saveEntry(); }
    });
    window.addEventListener("beforeunload", (be) => { if (S.entry && S.entry.dirty) { be.preventDefault(); be.returnValue = ""; } });
  }

  // ---------- rules ------------------------------------------------------------------------------------------------
  const RULE_FIELDS = [
    ["r_risk", ["risk", "risk_per_trade_pct"], true], ["r_reduced", ["risk", "reduced_risk_per_trade_pct"], true],
    ["r_trades", ["limits", "max_trades_per_day"], true], ["r_daily", ["limits", "daily_loss_warn_pct"], true],
    ["r_ddreduce", ["limits", "drawdown_reduce_risk_pct"], true], ["r_ddmax", ["limits", "max_total_drawdown_pct"], true],
    ["r_start", ["account", "starting_balance"], true], ["r_step", ["broker", "volume_step"], false], ["r_min", ["broker", "min_lots"], false],
    ["r_ccy", ["account", "currency"], false], ["r_tz", ["limits", "day_timezone"], false],
  ];
  function fillRulesForm() { for (const [id, [sec, key]] of RULE_FIELDS) $(id).value = String(S.rules[sec][key]); }
  function saveRules() {
    const next = clone(S.rules), msg = $("rulesMsg");
    msg.hidden = true;
    try {
      for (const [id, [sec, key], numeric] of RULE_FIELDS) {
        const raw = val(id);
        if (numeric) {
          const n = Number(raw);
          if (raw === "" || !isFinite(n) || n < 0) throw new Error("Every number needs a value of zero or more.");
          next[sec][key] = n;
        } else next[sec][key] = raw;
      }
      next.account.currency = next.account.currency.toUpperCase();
      if (!/^[A-Z]{3}$/.test(next.account.currency)) throw new Error("Currency must be three letters, like USD.");
      if (next.risk.risk_per_trade_pct <= 0 || next.risk.risk_per_trade_pct > 100) throw new Error("Risk per trade must be above 0 and at most 100.");
      if (next.risk.reduced_risk_per_trade_pct > next.risk.risk_per_trade_pct) throw new Error("Reduced risk must not be higher than normal risk.");
      if (next.limits.max_trades_per_day < 1) throw new Error("Max trades per day must be at least 1.");
      if (next.limits.daily_loss_warn_pct <= 0 || next.limits.max_total_drawdown_pct <= 0) throw new Error("Daily loss and drawdown limits must be above 0.");
      if (next.account.starting_balance <= 0) throw new Error("Starting balance must be above 0.");
      Core.num(next.broker.volume_step); Core.num(next.broker.min_lots);
      new Intl.DateTimeFormat("en-CA", { timeZone: next.limits.day_timezone });
    } catch (e) {
      msg.textContent = e instanceof RangeError ? "That time zone name is not recognised. Example: Asia/Dubai." : e.message;
      msg.hidden = false; return;
    }
    S.rules = next; saveSettingsSoon(); $("equityLabel").textContent = `Equity (${ccy()})`; renderAll(); toast("Rules saved");
  }

  // ---------- routing and boot ------------------------------------------------------------------------------------------
  function route() {
    const VIEWS = ["plan", "pair", "journal", "rules"];
    const name = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "plan";
    for (const v of VIEWS) {
      $("view-" + v).hidden = v !== name;
      if (v === name) $("nav-" + v).setAttribute("aria-current", "page"); else $("nav-" + v).removeAttribute("aria-current");
    }
    window.scrollTo(0, 0);
    if (name === "plan") { renderChart(); renderSessions(); renderRecent(); }
    if (name === "pair") compute();
    if (name === "journal") renderJournal();
  }

  function renderAll() { renderJournal(); renderRecent(); compute(); if (!$("view-plan").hidden) renderChart(); }
  function setPill(text, cls) { const p = $("storePill"); p.textContent = text; p.className = "pill " + (cls || ""); }

  async function boot() {
    const [ty, tm] = today().split("-").map(Number);
    S.cal = { y: ty, m: tm - 1 };
    fillRulesForm(); route(); renderAll(); renderSessions();
    window.addEventListener("hashchange", route);
    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (!$("view-plan").hidden) renderChart(); if (!$("view-journal").hidden) renderJournal(); }, 150); });
    $("jRange").addEventListener("change", (e) => { S.jRange = e.target.value; renderJournal(); });
    const setJMetric = (m) => { S.jMetric = m; $("jMoney").setAttribute("aria-pressed", String(m === "money")); $("jR").setAttribute("aria-pressed", String(m === "r")); renderJournal(); };
    $("jMoney").addEventListener("click", () => setJMetric("money"));
    $("jR").addEventListener("click", () => setJMetric("r"));
    $("calPrev").addEventListener("click", () => shiftMonth(-1));
    $("calNext").addEventListener("click", () => shiftMonth(1));
    $("calToday").addEventListener("click", () => { S.cal = { y: ty, m: tm - 1 }; S.dayFilter = null; renderCalendar(); renderTradeLog(); });
    $("calPick").addEventListener("change", (e) => { const [y, m] = e.target.value.split("-").map(Number); if (y && m) { S.cal = { y, m: m - 1 }; S.dayFilter = null; renderCalendar(); renderTradeLog(); } });
    setInterval(() => { if (!$("view-plan").hidden) renderSessions(); if (!$("view-pair").hidden) renderPairBrief(); }, 30000);
    loadCalendar(); setInterval(loadCalendar, 10 * 60 * 1000);
    for (const id of ["pair", "tf", "entry", "stop", "target", "risk", "atr", "atrMult", "conv", "equity", "dayStart"]) $(id).addEventListener("input", compute);
    document.querySelectorAll('input[name="dir"]').forEach((r) => r.addEventListener("change", compute));
    $("equity").addEventListener("change", () => { S.settings.equity = val("equity"); saveSettingsSoon(); });
    $("dayStart").addEventListener("change", () => { S.settings.dayStart = val("dayStart"); S.settings.dayStartDate = today(); saveSettingsSoon(); });
    $("logBtn").addEventListener("click", logTrade);
    $("exportBtn").addEventListener("click", exportCsv);
    $("copyCsv").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("csvText").value); toast("Copied"); } catch (e) { $("csvText").select(); toast("Select the text and copy it"); }
    });
    $("shotInput").addEventListener("change", () => { if ($("shotInput").files[0]) setShot($("shotInput").files[0]); });
    $("shotClear").addEventListener("click", clearShot);
    document.addEventListener("paste", (e) => { // paste a copied screenshot straight into the log form
      if ($("shotField").hidden || $("view-pair").hidden) return;
      const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith("image/"));
      if (item) { e.preventDefault(); setShot(item.getAsFile()); }
    });
    $("lightbox").addEventListener("click", () => { $("lightbox").hidden = true; });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("lightbox").hidden = true; });
    $("signOut").addEventListener("click", () => { if (S.store && S.store.signOut) S.store.signOut(); });
    bindEntry();
    $("saveRules").addEventListener("click", saveRules);
    $("resetRules").addEventListener("click", () => { S.rules = clone(Core.DEFAULT_RULES); fillRulesForm(); saveSettingsSoon(); renderAll(); toast("Rules reset to defaults"); });
    const setMetric = (m) => { S.chartMetric = m; $("mMoney").setAttribute("aria-pressed", String(m === "money")); $("mR").setAttribute("aria-pressed", String(m === "r")); renderChart(); };
    $("mMoney").addEventListener("click", () => setMetric("money"));
    $("mR").addEventListener("click", () => setMetric("r"));
    $("chartRange").addEventListener("change", (e) => { S.chartRange = e.target.value; renderChart(); });

    let loadTimer;
    const onError = (e) => { clearTimeout(loadTimer); setPill("Saving problem", "bad"); toast("Storage error: " + (e && e.code ? e.code : "unknown")); };
    S.store = await initStore(onError);
    const okText = { db: "Saved to your artifact", supabase: "Saved to Supabase" }[S.store.mode] || "Saved in this browser only";
    const okCls = S.store.mode === "local" ? "" : "ok";
    $("shotField").hidden = !S.store.uploadScreenshot;
    setPill(okText, okCls);
    loadTimer = setTimeout(() => setPill("Saved data not reachable yet", "bad"), 10000);
    S.store.subscribeSettings((d, meta) => { applySettings(d, meta); });
    S.store.subscribeTrades((list, meta) => {
      S.trades = list;
      if (!meta || !meta.fromCache) { clearTimeout(loadTimer); setPill(okText, okCls); }
      renderAll();
    });
    updateLogBtn();
  }

  if (/[?&]local=1\b/.test(location.search)) window.DD_DEBUG = { S, Core }; // dev aid for tests only (needs ?local=1)
  boot();
})();

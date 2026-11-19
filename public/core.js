/* Trading Discipline Desk: core logic (no DOM, no storage, no network).
 *
 * A JavaScript port of src/tradetool/calculator.py, limiter.py and the journal maths.
 * The Python code stays the reference. tests/gen_vectors.py writes cases from Python and
 * web/tests/core.test.mjs checks that this file gives the same answers.
 *
 * All price and lot maths uses exact fractions (BigInt), so rounding down to the
 * volume step never trips over floating-point error (0.15 must not become 0.14).
 *
 * Runs in a browser (global `Core`) and in Node (module.exports).
 */
(function (root) {
  "use strict";

  // ---------- exact fractions ----------------------------------------------------
  const gcd = (a, b) => {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b) [a, b] = [b, a % b];
    return a;
  };
  const R = (n, d = 1n) => {
    if (d === 0n) throw new Error("Division by zero");
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    return { n: n / g, d: d / g };
  };
  const isRat = (x) => x !== null && typeof x === "object" && typeof x.n === "bigint";
  const num = (x) => {
    if (isRat(x)) return x;
    let s = String(x).trim();
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) throw new Error("Not a number: " + (s || "(empty)"));
    let sign = 1n;
    if (s[0] === "-") { sign = -1n; s = s.slice(1); } else if (s[0] === "+") s = s.slice(1);
    const [i, f = ""] = s.split(".");
    return R(sign * BigInt((i || "0") + f), 10n ** BigInt(f.length));
  };
  const add = (a, b) => R(a.n * b.d + b.n * a.d, a.d * b.d);
  const sub = (a, b) => R(a.n * b.d - b.n * a.d, a.d * b.d);
  const mul = (a, b) => R(a.n * b.n, a.d * b.d);
  const div = (a, b) => R(a.n * b.d, a.d * b.n);
  const cmp = (a, b) => { const x = a.n * b.d, y = b.n * a.d; return x < y ? -1 : x > y ? 1 : 0; };
  const abs = (a) => (a.n < 0n ? R(-a.n, a.d) : a);
  const floorBig = (a) => { let q = a.n / a.d; if (a.n % a.d !== 0n && a.n < 0n) q -= 1n; return q; };
  const ceilBig = (a) => -floorBig(R(-a.n, a.d));
  const toNum = (a) => Number(a.n) / Number(a.d);
  const ZERO = R(0n), ONE = R(1n);

  /** Fixed-point text of a fraction. mode: "round" | "floor" | "ceil". */
  function fixed(a, digits, mode = "round") {
    const scaled = mul(a, R(10n ** BigInt(digits)));
    const k = mode === "floor" ? floorBig(scaled) : mode === "ceil" ? ceilBig(scaled)
      : floorBig(add(scaled, R(1n, 2n)));
    const neg = k < 0n;
    const s = (neg ? -k : k).toString().padStart(digits + 1, "0");
    const out = digits ? s.slice(0, -digits) + "." + s.slice(-digits) : s;
    return (neg ? "-" : "") + out;
  }
  /** Shortest exact decimal text for a fraction that has a finite decimal form. */
  function plain(a, maxDigits = 8) {
    let t = fixed(a, maxDigits);
    if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
    return t;
  }

  // ---------- calculator -----------------------------------------------------------
  const BUY = "buy", SELL = "sell";
  const STANDARD_LOT_UNITS = 100000;
  // Broker volume rules: IC Markets-style defaults. [unconfirmed] Check on the demo account.
  const DEFAULT_VOLUME_STEP = "0.01", DEFAULT_MIN_LOTS = "0.01";

  function parsePair(pair) {
    const clean = String(pair).replace(/[\s/_]/g, "").toUpperCase();
    if (!/^[A-Z]{6}$/.test(clean)) throw new Error("Pair must look like EURUSD or EUR/USD");
    return [clean.slice(0, 3), clean.slice(3)];
  }
  const pipSize = (pair) => (parsePair(pair)[1] === "JPY" ? R(1n, 100n) : R(1n, 10000n));
  const priceDigits = (pair) => (parsePair(pair)[1] === "JPY" ? 3 : 5);

  function checkDirection(d) {
    const v = String(d).trim().toLowerCase();
    if (v !== BUY && v !== SELL) throw new Error("Direction must be buy or sell");
    return v;
  }

  function pipValuePerLot(pair, entry, account = "USD", quoteToAccount = null, lotUnits = STANDARD_LOT_UNITS) {
    const [base, quote] = parsePair(pair);
    account = account.toUpperCase();
    const valueInQuote = mul(pipSize(pair), R(BigInt(lotUnits)));
    let rate;
    if (quote === account) rate = ONE;
    else if (quoteToAccount !== null && quoteToAccount !== "" && quoteToAccount !== undefined) rate = num(quoteToAccount);
    else if (base === account) rate = div(ONE, num(entry));
    else {
      const e = new Error(`${base}${quote} is quoted in ${quote}, not ${account}. Enter the ${quote}/${account} price (${account} per 1 ${quote}).`);
      e.code = "need_conversion_rate";
      e.quote = quote;
      throw e;
    }
    if (cmp(rate, ZERO) <= 0) throw new Error("Conversion rate must be positive");
    return mul(valueInQuote, rate);
  }

  const roundDownToStep = (lots, step) => mul(R(floorBig(div(lots, step))), step);

  function calculatePosition(o) {
    const balance = num(o.balance), riskPct = num(o.riskPct);
    const entry = num(o.entry), stop = num(o.stop);
    const step = num(o.volumeStep ?? DEFAULT_VOLUME_STEP), minLots = num(o.minLots ?? DEFAULT_MIN_LOTS);
    const account = (o.account || "USD").toUpperCase();
    const lotUnits = o.lotUnits || STANDARD_LOT_UNITS;
    const direction = checkDirection(o.direction);

    if (cmp(balance, ZERO) <= 0) throw new Error("Equity must be positive");
    if (cmp(riskPct, ZERO) <= 0 || cmp(riskPct, R(100n)) > 0) throw new Error("Risk percent must be above 0 and at most 100");
    if (cmp(step, ZERO) <= 0 || cmp(minLots, ZERO) <= 0) throw new Error("Volume step and minimum lots must be positive");
    if (direction === BUY && cmp(stop, entry) >= 0) throw new Error("For a buy, the stop must be BELOW the entry");
    if (direction === SELL && cmp(stop, entry) <= 0) throw new Error("For a sell, the stop must be ABOVE the entry");

    const stopPips = div(abs(sub(entry, stop)), pipSize(o.pair));
    const pv = pipValuePerLot(o.pair, o.entry, account, o.quoteToAccount ?? null, lotUnits);
    const riskMoney = div(mul(balance, riskPct), R(100n));
    const rawLots = div(riskMoney, mul(stopPips, pv));

    let lots = roundDownToStep(rawLots, step);
    const warnings = [];
    if (cmp(lots, minLots) < 0) {
      warnings.push(`Stop is too wide for this risk: the exact size is ${toNum(rawLots).toFixed(4)} lots, below the minimum ${plain(minLots)}. ` +
        "Do not take this trade at this risk. Tighten the stop or skip it. Do not round up.");
      lots = ZERO;
    }
    const actualRisk = mul(mul(lots, stopPips), pv);
    const [b, q] = parsePair(o.pair);
    return {
      pair: b + q, direction,
      entry: plain(entry), stop: plain(stop),
      stopPips: toNum(stopPips), pipValuePerLot: toNum(pv),
      targetRiskMoney: toNum(riskMoney),
      lots: plain(lots), lotsRat: lots,
      units: Number(floorBig(mul(lots, R(BigInt(lotUnits))))),
      actualRiskMoney: toNum(actualRisk),
      actualRiskPct: toNum(div(mul(actualRisk, R(100n)), balance)),
      warnings, tradable: cmp(lots, ZERO) > 0,
    };
  }

  /** Stop `multiplier` x ATR beyond the entry, rounded OUTWARD (wider) to the pair's price digits. */
  function suggestStop(direction, entry, atr, multiplier = "1.5", pair = "EURUSD") {
    direction = checkDirection(direction);
    const dist = mul(num(atr), num(multiplier));
    if (cmp(dist, ZERO) <= 0) throw new Error("ATR times multiplier must be positive");
    const e = num(entry);
    const raw = direction === BUY ? sub(e, dist) : add(e, dist);
    return fixed(raw, priceDigits(pair), direction === BUY ? "floor" : "ceil");
  }

  // ---------- limiter (warn only) --------------------------------------------------
  const drawdownPct = (equity, start) => ((start - equity) / start) * 100;

  function allowedRiskPct(rules, equity, start) {
    return drawdownPct(equity, start) >= rules.limits.drawdown_reduce_risk_pct
      ? rules.risk.reduced_risk_per_trade_pct : rules.risk.risk_per_trade_pct;
  }

  /** state: {equity, startingBalance, tradesToday, realizedToday, dayStartEquity|null} */
  function checkRules(rules, state, plannedRiskPct) {
    const L = rules.limits, out = [];
    if (state.tradesToday + 1 > L.max_trades_per_day) {
      out.push({ rule: "max_trades_per_day", message: `This would be trade #${state.tradesToday + 1} today. Your limit is ${L.max_trades_per_day} per day.` });
    }
    let lossPct, basis;
    if (state.dayStartEquity !== null && state.dayStartEquity !== undefined) {
      lossPct = ((state.dayStartEquity - state.equity) / state.dayStartEquity) * 100;
      basis = "equity, floating losses included";
    } else {
      const base = state.equity - state.realizedToday;
      lossPct = (-state.realizedToday / base) * 100;
      basis = "closed trades only; floating losses NOT counted. Enter day-start equity for the real check";
    }
    if (lossPct >= L.daily_loss_warn_pct) {
      out.push({ rule: "daily_loss", message: `Down ${lossPct.toFixed(2)}% today (${basis}). Your warning level is ${L.daily_loss_warn_pct}%. Stop for the day.` });
    }
    const dd = drawdownPct(state.equity, state.startingBalance);
    if (dd >= L.max_total_drawdown_pct) {
      out.push({ rule: "max_drawdown", message: `Drawdown from the starting balance is ${dd.toFixed(2)}%. Your limit is ${L.max_total_drawdown_pct}%.` });
    }
    const allowed = allowedRiskPct(rules, state.equity, state.startingBalance);
    if (plannedRiskPct > allowed + 1e-9) {
      const reduced = allowed === rules.risk.reduced_risk_per_trade_pct && allowed !== rules.risk.risk_per_trade_pct;
      out.push({ rule: "risk_per_trade", message: `This trade risks ${plannedRiskPct.toFixed(2)}% of equity. Allowed: ${allowed}%${reduced ? ` (reduced because drawdown is ${dd.toFixed(2)}%)` : ""}.` });
    }
    return out;
  }

  /** Calendar day (YYYY-MM-DD) of an ISO time in a time zone. */
  function localDay(iso, tz) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(iso));
  }

  /** {opened, realized}: trades opened today, net money of trades closed today. */
  function dayStats(trades, tz, now = new Date()) {
    const today = localDay(now.toISOString(), tz);
    let opened = 0, realized = 0;
    for (const t of trades) {
      if (localDay(t.opened_at, tz) === today) opened++;
      if (t.closed_at && localDay(t.closed_at, tz) === today) realized += t.net_money;
    }
    return { opened, realized };
  }

  // ---------- journal records --------------------------------------------------------
  // Field names match the SQLite columns used by the Python version.
  const COLUMNS = ["id", "status", "opened_at", "pair", "direction", "timeframe", "setup_tag", "emotion_tag",
    "reason", "notes_text", "screenshot_path", "account_currency", "balance_at_entry", "entry", "stop", "target", "stop_pips", "pip_value_per_lot",
    "lots", "risk_money", "risk_pct", "planned_rr", "closed_at", "exit_price", "exit_pips", "gross_money",
    "costs", "net_money", "result_r", "exit_note"];

  const tag = (v, name) => {
    const t = String(v || "").trim().toLowerCase().replace(/\s+/g, "_");
    if (!t) throw new Error(name + " is required");
    return t;
  };

  /** Build a new open trade record. f: form values (strings). rules: current rules. */
  function buildTrade(f, rules, now = new Date()) {
    const direction = checkDirection(f.direction);
    const setup = tag(f.setup, "Setup tag");
    const emotion = f.emotion !== undefined && f.emotion !== null && String(f.emotion).trim() !== "" ? tag(f.emotion, "Emotion tag") : ""; // optional
    const timeframe = String(f.timeframe || "").trim().toUpperCase();
    if (!timeframe) throw new Error("Timeframe is required");
    const entry = num(f.entry), target = num(f.target), stop = num(f.stop);
    if (direction === BUY && cmp(target, entry) <= 0) throw new Error("For a buy, the target must be ABOVE the entry");
    if (direction === SELL && cmp(target, entry) >= 0) throw new Error("For a sell, the target must be BELOW the entry");

    const plan = calculatePosition({
      balance: f.equity, riskPct: f.riskPct, pair: f.pair, direction, entry: f.entry, stop: f.stop,
      account: rules.account.currency, quoteToAccount: f.quoteToAccount,
      volumeStep: rules.broker.volume_step, minLots: rules.broker.min_lots,
    });
    // Lot size comes from the calculator unless you type it (back-filling a trade you already took, or editing one).
    let lots = toNum(plan.lotsRat), riskMoney = plan.actualRiskMoney, riskPctUsed = plan.actualRiskPct;
    if (f.lots !== undefined && f.lots !== null && String(f.lots).trim() !== "") {
      const typed = num(f.lots);
      if (cmp(typed, ZERO) <= 0) throw new Error("Lots must be above 0");
      lots = toNum(typed);
      riskMoney = lots * plan.stopPips * plan.pipValuePerLot;
      riskPctUsed = (riskMoney / toNum(num(f.equity))) * 100;
    } else if (!plan.tradable) throw new Error(plan.warnings[0]);
    const rr = toNum(div(abs(sub(target, entry)), abs(sub(entry, stop))));
    return {
      id: f.id || "t" + now.getTime().toString(36) + Math.random().toString(36).slice(2, 5),
      status: "open",
      opened_at: now.toISOString(),
      pair: plan.pair, direction, timeframe, setup_tag: setup, emotion_tag: emotion,
      reason: String(f.reason || "").trim(),
      screenshot_path: null, notes: null, notes_text: "",
      account_currency: rules.account.currency,
      balance_at_entry: toNum(num(f.equity)),
      entry: toNum(entry), stop: toNum(stop), target: toNum(target),
      stop_pips: plan.stopPips, pip_value_per_lot: plan.pipValuePerLot,
      lots, risk_money: riskMoney, risk_pct: riskPctUsed,
      planned_rr: rr,
      closed_at: null, exit_price: null, exit_pips: null, gross_money: null, costs: null,
      net_money: null, result_r: null, exit_note: "",
    };
  }

  // ---------- Notion-style notes (Editor.js documents) ----------------------------------------------------------
  // A document is {time, version, blocks:[{type, data}]}. Images are stored as {file:{path}} (a path in the private
  // storage bucket), never as a signed link, because links expire. The app adds a fresh link when it opens an entry.
  const plainText = (html) => String(html || "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

  function listText(items, depth = 0) {
    const out = [];
    for (const it of items || []) {
      const content = typeof it === "string" ? it : it && it.content;
      if (content) out.push("  ".repeat(depth) + "- " + plainText(content));
      if (it && Array.isArray(it.items)) out.push(...listText(it.items, depth + 1));
    }
    return out;
  }

  /** Plain-text copy of a document, so SQL, CSV and AI can search the notes. */
  function notesToText(doc) {
    const lines = [];
    for (const b of (doc && doc.blocks) || []) {
      const d = b.data || {};
      if (b.type === "paragraph" || b.type === "header") lines.push(plainText(d.text));
      else if (b.type === "list") lines.push(...listText(d.items));
      else if (b.type === "checklist") for (const it of d.items || []) lines.push(`${it.checked ? "[x]" : "[ ]"} ${plainText(it.text)}`);
      else if (b.type === "quote") lines.push("> " + plainText(d.text) + (d.caption ? " - " + plainText(d.caption) : ""));
      else if (b.type === "code") lines.push(String(d.code || ""));
      else if (b.type === "table") for (const row of d.content || []) lines.push(row.map(plainText).join(" | "));
      else if (b.type === "image") lines.push(d.caption ? "[image: " + plainText(d.caption) + "]" : "[image]");
    }
    return lines.filter((l) => l !== "").join("\n");
  }

  /** Copy of the document that is safe to store: image blocks keep their storage path only. */
  function notesForStorage(doc) {
    if (!doc || !Array.isArray(doc.blocks)) return null;
    const blocks = doc.blocks.map((b) => {
      if (b.type !== "image") return b;
      const { file = {}, ...rest } = b.data || {};
      return { ...b, data: { ...rest, file: { path: file.path || null } } };
    });
    return blocks.length ? { ...doc, blocks } : null;
  }
  const imagePaths = (doc) => ((doc && doc.blocks) || []).filter((b) => b.type === "image" && b.data && b.data.file && b.data.file.path).map((b) => b.data.file.path);

  /** Parses what you type into a money box: "-120.50", "+85", "$1,234.50", "(40)", "−7". Empty gives null. */
  function parseMoney(text, label = "Amount") {
    let t = String(text === undefined || text === null ? "" : text).trim();
    if (!t) return null;
    let neg = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    t = t.replace(/[−–—]/g, "-").replace(/[\s,$€£]/g, "").replace(/^(usd|aed|eur|gbp)/i, "");
    if (t.startsWith("-")) { neg = !neg; t = t.slice(1); } else if (t.startsWith("+")) t = t.slice(1);
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) throw new Error(`${label} must be a number, like -120.50 for a loss or 85 for a profit`);
    const v = Number(t);
    return neg ? -v : v;
  }

  /** "1:2" or "1 : 2.5" means 1 risk for 2 reward and gives 2; a lone "2" or "2R" gives 2. Empty gives null. */
  function parseRatio(text) {
    const t = String(text === undefined || text === null ? "" : text).trim().replace(/\s+/g, "");
    if (!t) return null;
    let m = /^(\d+(?:\.\d+)?)[:/](\d+(?:\.\d+)?)$/.exec(t);
    if (m) { if (Number(m[1]) <= 0) throw new Error("Risk:reward needs a risk above 0, like 1:2"); return Number(m[2]) / Number(m[1]); }
    m = /^(\d+(?:\.\d+)?)r?$/i.exec(t);
    if (m) return Number(m[1]);
    throw new Error("Risk:reward looks like 1:2");
  }

  const pipOf = (pair) => toNum(pipSize(pair));
  const when = (v, label) => { const d = new Date(v); if (isNaN(d)) throw new Error(`${label} is not a valid date and time`); return d; };

  /**
   * Builds a journal record from the short entry form. Used for new entries and for edits (pass the saved record as `base`).
   * f: id, pair, direction ("buy"|"sell"), why, openedAt, closedAt, entry, exit, lots, pnl, charges, rr, stop, setup, emotion, equity, notes.
   *   - No exit price: the trade is open. With an exit price it is closed.
   *   - pnl is the profit or loss from the broker (a minus sign means a loss); charges are always a cost, typed with or without a minus.
   *   - total (net_money) = pnl - charges. If pnl is empty it is estimated from the pip value, when that is known.
   *   - stop is optional. Without it there is no risk amount and no R multiple (they stay empty, they are not invented).
   */
  function buildSimpleEntry(f, rules, base = null) {
    const direction = checkDirection(f.direction);
    const [b, q] = parsePair(f.pair);
    const pair = b + q;
    const setup = tag(f.setup, "Setup");
    // Emotion is optional on the short form. A saved entry keeps the emotion it already has.
    const emotion = f.emotion !== undefined && f.emotion !== null && String(f.emotion).trim() !== "" ? tag(f.emotion, "Emotion") : (base && base.emotion_tag) || "";
    if (f.entry === undefined || String(f.entry).trim() === "") throw new Error("Add the entry price");
    const entry = num(f.entry);
    if (f.lots === undefined || String(f.lots).trim() === "") throw new Error("Add the size in lots");
    const lotsR = num(f.lots);
    if (cmp(lotsR, ZERO) <= 0) throw new Error("Size must be above 0");
    const lots = toNum(lotsR);
    const opened = when(f.openedAt, "The entry");

    const hasExit = f.exit !== undefined && f.exit !== null && String(f.exit).trim() !== "";
    const gross0 = parseMoney(f.pnl, "Profit or loss");
    const chargesIn = parseMoney(f.charges, "Charges");
    if (!hasExit && (gross0 !== null || (chargesIn !== null && chargesIn !== 0))) throw new Error("Add the exit price, or clear the profit, loss and charges while the trade is open");

    let stop = null, stopPips = null;
    if (f.stop !== undefined && f.stop !== null && String(f.stop).trim() !== "") {
      const s = num(f.stop);
      if (direction === BUY && cmp(s, entry) >= 0) throw new Error("For a long trade, the stop loss must be BELOW the entry");
      if (direction === SELL && cmp(s, entry) <= 0) throw new Error("For a short trade, the stop loss must be ABOVE the entry");
      stop = toNum(s);
      stopPips = toNum(div(abs(sub(entry, s)), pipSize(pair)));
    }

    const pip = pipOf(pair);
    let closedAt = null, exitPrice = null, exitPips = null, gross = null, costs = null, net = null, pv = base && base.pip_value_per_lot ? base.pip_value_per_lot : null, estimated = false;
    if (hasExit) {
      const exit = num(f.exit);
      exitPrice = toNum(exit);
      closedAt = when(f.closedAt, "The exit");
      if (closedAt < opened) throw new Error("The exit cannot be before the entry");
      exitPips = (direction === BUY ? 1 : -1) * toNum(div(sub(exit, entry), pipSize(pair)));
      if (gross0 !== null) {
        gross = gross0;
        // The broker's own profit tells us the real value of a pip for this trade, whatever the currency.
        if (Math.abs(exitPips) > 1e-9 && Math.abs(gross) > 0 && Math.sign(gross) === Math.sign(exitPips)) pv = Math.abs(gross) / (Math.abs(exitPips) * lots);
      } else {
        if (pv === null) { try { pv = toNum(pipValuePerLot(pair, entry, rules.account.currency, null)); } catch (e) { pv = null; } }
        if (pv === null) throw new Error("Add the profit or loss from your broker (it cannot be estimated for this pair)");
        gross = exitPips * pv * lots; estimated = true;
      }
      costs = chargesIn === null ? 0 : Math.abs(chargesIn);
      net = gross - costs;
    }
    if (pv === null) { try { pv = toNum(pipValuePerLot(pair, entry, rules.account.currency, null)); } catch (e) { pv = null; } }

    const riskMoney = stopPips !== null && pv !== null ? lots * stopPips * pv : null;
    const equity = f.equity !== undefined && f.equity !== null && String(f.equity).trim() !== "" ? Number(f.equity) : (base && base.balance_at_entry) || null;
    const rr = parseRatio(f.rr);
    const notes = notesForStorage(f.notes);
    const paths = imagePaths(notes);
    const rec = {
      id: f.id || "t" + opened.getTime().toString(36) + Math.random().toString(36).slice(2, 5),
      status: hasExit ? "closed" : "open",
      opened_at: opened.toISOString(), pair, direction,
      timeframe: base ? base.timeframe || null : null, setup_tag: setup, emotion_tag: emotion,
      reason: String(f.why || "").trim(),
      notes, notes_text: notes ? notesToText(notes) : "", screenshot_path: paths[0] || (base && base.screenshot_path) || null,
      account_currency: rules.account.currency, balance_at_entry: Number.isFinite(equity) ? equity : null,
      entry: toNum(entry), stop, target: base && base.target !== undefined ? base.target : null,
      stop_pips: stopPips, pip_value_per_lot: pv, lots, risk_money: riskMoney,
      risk_pct: riskMoney !== null && equity ? (riskMoney / equity) * 100 : null,
      planned_rr: rr !== null ? rr : base && base.planned_rr !== undefined ? base.planned_rr : null,
      closed_at: closedAt ? closedAt.toISOString() : null, exit_price: exitPrice, exit_pips: exitPips,
      gross_money: gross, costs, net_money: net, result_r: net !== null && riskMoney ? net / riskMoney : null,
      exit_note: base && base.exit_note ? base.exit_note : "",
    };
    Object.defineProperty(rec, "estimated", { value: estimated, enumerable: false }); // not saved, only shown in the form
    return rec;
  }

  /** Returns the closed version of an open trade. */
  function closeTrade(t, f, now = new Date()) {
    if (t.status === "closed") throw new Error("This trade is already closed");
    const costs = num(f.costs === "" || f.costs === undefined ? "0" : f.costs);
    if (cmp(costs, ZERO) < 0) throw new Error("Costs are a positive number (money you paid)");
    const exit = num(f.exitPrice);
    const sign = t.direction === BUY ? ONE : R(-1n);
    const pips = toNum(div(mul(sign, sub(exit, num(t.entry))), pipSize(t.pair)));
    const gross = f.grossMoney !== "" && f.grossMoney !== undefined && f.grossMoney !== null
      ? toNum(num(f.grossMoney)) : pips * t.pip_value_per_lot * t.lots;
    const net = gross - toNum(costs);
    return {
      ...t, status: "closed", closed_at: now.toISOString(), exit_price: toNum(exit), exit_pips: pips,
      gross_money: gross, costs: toNum(costs), net_money: net, result_r: net / t.risk_money,
      exit_note: String(f.note || "").trim(),
    };
  }

  /** Per-tag results for closed trades. field: "setup_tag" | "emotion_tag" | "pair". */
  function summarize(trades, field) {
    const groups = new Map();
    for (const t of trades) {
      if (t.status !== "closed") continue;
      const g = groups.get(t[field]) || { key: t[field], n: 0, wins: 0, totalR: 0, rN: 0, netMoney: 0 };
      g.n++; g.wins += t.net_money > 0 ? 1 : 0; g.netMoney += t.net_money;
      if (typeof t.result_r === "number") { g.totalR += t.result_r; g.rN++; }
      groups.set(t[field], g);
    }
    return [...groups.values()]
      .map((g) => ({ ...g, winRate: g.wins / g.n, avgR: g.rN ? g.totalR / g.rN : null }))
      .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  }

  const sumOf = (arr, f) => arr.reduce((a, t) => a + f(t), 0);

  /** Headline numbers for the journal's top bar. Closed trades only. Money is net of costs unless it says gross. */
  function journalStats(trades) {
    const closed = trades.filter((t) => t.status === "closed").sort((a, b) => (a.closed_at < b.closed_at ? -1 : 1));
    const n = closed.length;
    const wins = closed.filter((t) => t.net_money > 0), losses = closed.filter((t) => t.net_money < 0);
    const winSum = sumOf(wins, (t) => t.net_money), lossSum = -sumOf(losses, (t) => t.net_money);
    const gWin = sumOf(closed.filter((t) => t.gross_money > 0), (t) => t.gross_money);
    const gLoss = -sumOf(closed.filter((t) => t.gross_money < 0), (t) => t.gross_money);
    const ratio = (a, b) => (b > 0 ? a / b : a > 0 ? Infinity : null);
    const drawdown = (vals) => { let run = 0, peak = 0, max = 0; for (const v of vals) { run += v; peak = Math.max(peak, run); max = Math.max(max, peak - run); } return max; };
    let streak = 0;
    for (let i = closed.length - 1; i >= 0 && closed[i].net_money < 0; i--) streak++;
    const avgWin = wins.length ? winSum / wins.length : null, avgLoss = losses.length ? lossSum / losses.length : null;
    const withR = closed.filter((t) => typeof t.result_r === "number");
    const totalR = sumOf(withR, (t) => t.result_r), net = sumOf(closed, (t) => t.net_money);
    return {
      n, wins: wins.length, losses: losses.length, breakeven: n - wins.length - losses.length,
      net, gross: sumOf(closed, (t) => t.gross_money), costs: sumOf(closed, (t) => t.costs),
      winRate: n ? wins.length / n : null,
      profitFactor: ratio(winSum, lossSum), profitFactorGross: ratio(gWin, gLoss),
      avgWin, avgLoss, payoff: avgWin !== null && avgLoss ? avgWin / avgLoss : null,
      expectancy: n ? net / n : null, expectancyR: withR.length ? totalR / withR.length : null, totalR, rCount: withR.length,
      maxDrawdown: drawdown(closed.map((t) => t.net_money)), maxDrawdownR: drawdown(withR.map((t) => t.result_r)),
      losingStreak: streak,
    };
  }

  /** Per calendar day (in tz): net money and R of trades CLOSED that day, trade count, and trades still open that were opened that day. */
  function dailyNet(trades, tzName) {
    const out = {};
    const slot = (k) => (out[k] = out[k] || { net: 0, r: 0, n: 0, open: 0 });
    for (const t of trades) {
      if (t.status === "closed") { const d = slot(localDay(t.closed_at, tzName)); d.net += t.net_money; d.r += typeof t.result_r === "number" ? t.result_r : 0; d.n += 1; }
      else slot(localDay(t.opened_at, tzName)).open += 1;
    }
    return out;
  }

  // ---------- pair brief: typical range, news, your record, currency exposure ---------------------------------------------------
  // Typical daily range in pips. APPROXIMATE on purpose: the first five come from the project brief (a rough broker-blog
  // figure), the rest are rough estimates [unconfirmed]. Use them for scale, not precision.
  const TYPICAL_RANGES = {
    EURUSD: { lo: 70, hi: 100, source: "brief" }, GBPUSD: { lo: 80, hi: 120, source: "brief" }, AUDUSD: { lo: 70, hi: 100, source: "brief" },
    USDJPY: { lo: 50, hi: 100, source: "brief" }, USDCAD: { lo: 60, hi: 90, source: "brief" },
    USDCHF: { lo: 60, hi: 90, source: "estimate" }, NZDUSD: { lo: 60, hi: 90, source: "estimate" }, EURJPY: { lo: 90, hi: 130, source: "estimate" },
    GBPJPY: { lo: 110, hi: 160, source: "estimate" }, EURGBP: { lo: 45, hi: 70, source: "estimate" },
  };
  function typicalRange(pair) {
    let key; try { const [b, q] = parsePair(pair); key = b + q; } catch (e) { return null; }
    const r = TYPICAL_RANGES[key];
    return r ? { ...r, mid: (r.lo + r.hi) / 2 } : null;
  }

  // Rule-of-thumb limits [unconfirmed]: a stop under 8% of a normal day sits inside ordinary noise; over 40% is wide.
  const STOP_TIGHT_PCT = 8, STOP_WIDE_PCT = 40, TARGET_BIG_PCT = 90;
  /** Compares your stop and target (in pips) with the typical daily range. Returns null when the pair has no saved range. */
  function stopCheck(pair, stopPips, targetPips) {
    const r = typicalRange(pair);
    if (!r) return null;
    const out = { range: r, stopPct: null, targetPct: null, stopNote: "", targetNote: "", flag: false };
    if (stopPips > 0) {
      out.stopPct = (stopPips / r.mid) * 100;
      if (out.stopPct < STOP_TIGHT_PCT) { out.stopNote = "Very tight: ordinary price noise can hit it."; out.flag = true; }
      else if (out.stopPct > STOP_WIDE_PCT) { out.stopNote = "Wide: it uses a big share of a normal day."; out.flag = true; }
      else out.stopNote = "Reasonable against a normal day.";
    }
    if (targetPips > 0) {
      out.targetPct = (targetPips / r.mid) * 100;
      out.targetNote = out.targetPct > TARGET_BIG_PCT ? "Needs most of a typical day's movement." : "Within a normal day's movement.";
    }
    return out;
  }

  /** The two currencies of a pair, for example "EURUSD" gives ["EUR", "USD"]. */
  const pairCurrencies = (pair) => { const [b, q] = parsePair(pair); return [b, q]; };

  /**
   * News for either currency of the pair. cal = {generated_at, events:[{currency, title, time (ISO), impact, forecast, previous}]}.
   * Returns the next `n` events, High impact first and Medium to fill, ordered by time, each with `inMinutes`.
   */
  function upcomingEvents(cal, pair, now = new Date(), n = 3) {
    if (!cal || !Array.isArray(cal.events)) return [];
    let cur; try { cur = pairCurrencies(pair); } catch (e) { return []; }
    const future = cal.events
      .filter((e) => cur.includes(e.currency) && (e.impact === "High" || e.impact === "Medium") && new Date(e.time) >= now)
      .sort((a, b) => new Date(a.time) - new Date(b.time));
    const high = future.filter((e) => e.impact === "High").slice(0, n);
    const fill = future.filter((e) => e.impact === "Medium").slice(0, Math.max(0, n - high.length));
    return [...high, ...fill].sort((a, b) => new Date(a.time) - new Date(b.time))
      .map((e) => ({ ...e, inMinutes: Math.round((new Date(e.time) - now) / 60000) }));
  }

  /** High-impact events for the pair starting within `beforeMin` minutes, or started less than `afterMin` minutes ago. */
  function newsWarnings(cal, pair, now = new Date(), beforeMin = 60, afterMin = 15) {
    if (!cal || !Array.isArray(cal.events)) return [];
    let cur; try { cur = pairCurrencies(pair); } catch (e) { return []; }
    return cal.events
      .filter((e) => cur.includes(e.currency) && e.impact === "High")
      .map((e) => ({ ...e, inMinutes: Math.round((new Date(e.time) - now) / 60000) }))
      .filter((e) => e.inMinutes <= beforeMin && e.inMinutes >= -afterMin)
      .sort((a, b) => a.inMinutes - b.inMinutes);
  }

  /** Forex Factory's calendar page for the day an event falls on, in the given time zone. (The feed has no per-event link.) */
  function forexFactoryDayUrl(iso, tzName = "UTC") {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tzName, month: "short", day: "numeric", year: "numeric" }).formatToParts(new Date(iso));
    const g = (t) => parts.find((x) => x.type === t).value;
    return `https://www.forexfactory.com/calendar?day=${g("month").toLowerCase()}${g("day")}.${g("year")}`;
  }

  /** Minutes since the calendar data was written, or null when unknown. */
  const calendarAgeMin = (cal, now = new Date()) => (cal && cal.generated_at ? Math.round((now - new Date(cal.generated_at)) / 60000) : null);

  /** Your own results on one pair, from the journal. */
  function pairRecord(trades, pair) {
    let key; try { const [b, q] = parsePair(pair); key = b + q; } catch (e) { return { n: 0, open: 0 }; }
    const mine = trades.filter((t) => t.pair === key);
    const closed = mine.filter((t) => t.status === "closed");
    const wins = closed.filter((t) => t.net_money > 0).length;
    const withR = closed.filter((t) => typeof t.result_r === "number");
    return {
      n: closed.length, open: mine.length - closed.length, wins, losses: closed.filter((t) => t.net_money < 0).length,
      winRate: closed.length ? wins / closed.length : null, net: sumOf(closed, (t) => t.net_money),
      avgR: withR.length ? sumOf(withR, (t) => t.result_r) / withR.length : null,
    };
  }

  /** What a trade does to each currency: buying EURUSD is long EUR and short USD. */
  function currencyLegs(pair, direction) {
    const [b, q] = pairCurrencies(pair), up = checkDirection(direction) === BUY;
    return [{ currency: b, side: up ? "long" : "short" }, { currency: q, side: up ? "short" : "long" }];
  }

  /**
   * Compares a planned trade with your open trades. `same`: you already hold the same side of a currency (doubling the bet).
   * `opposite`: an open trade pulls the other way on that currency (partly cancels).
   */
  function exposureCheck(pair, direction, trades) {
    const plan = currencyLegs(pair, direction), same = [], opposite = [];
    for (const t of trades.filter((x) => x.status === "open")) {
      let legs; try { legs = currencyLegs(t.pair, t.direction); } catch (e) { continue; }
      for (const leg of plan) {
        const hit = legs.find((l) => l.currency === leg.currency);
        if (!hit) continue;
        const row = { currency: leg.currency, side: leg.side, trade: t };
        (hit.side === leg.side ? same : opposite).push(row);
      }
    }
    return { plan, same, opposite };
  }

  function toCsv(trades) {
    const cell = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [COLUMNS.join(",")];
    for (const t of trades) rows.push(COLUMNS.map((c) => cell(t[c])).join(","));
    return rows.join("\n") + "\n";
  }

  const DEFAULT_RULES = {
    account: { currency: "USD", starting_balance: 300000 },
    risk: { risk_per_trade_pct: 1.0, reduced_risk_per_trade_pct: 0.5 },
    limits: {
      day_timezone: "Asia/Dubai", max_trades_per_day: 1, daily_loss_warn_pct: 2.0,
      drawdown_reduce_risk_pct: 5.0, max_total_drawdown_pct: 8.0,
    },
    broker: { volume_step: "0.01", min_lots: "0.01" },
  };

  root.Core = {
    num, plain, fixed, toNum, parsePair, pipSize, pipValuePerLot, calculatePosition, suggestStop,
    drawdownPct, allowedRiskPct, checkRules, localDay, dayStats, buildTrade, buildSimpleEntry, parseMoney, parseRatio, closeTrade, summarize, journalStats, dailyNet, notesToText, notesForStorage, imagePaths,
    typicalRange, stopCheck, pairCurrencies, forexFactoryDayUrl, upcomingEvents, newsWarnings, calendarAgeMin, pairRecord, currencyLegs, exposureCheck, TYPICAL_RANGES,
    toCsv, COLUMNS, DEFAULT_RULES, BUY, SELL,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.Core;
})(typeof window !== "undefined" ? window : globalThis);

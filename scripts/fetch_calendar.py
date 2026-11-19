"""Downloads this week's economic calendar and writes web/data/calendar.json for the app.

Source: the free JSON feed from Fair Economy, the company behind Forex Factory
(https://nfs.faireconomy.media/ff_calendar_thisweek.json). It is UNOFFICIAL: it has no documentation or guarantee,
it only holds the current week, and it has no "actual" result field. Keep polling gentle (once an hour is plenty).

Uses `curl` so it works with the system certificates on a Mac and on GitHub's Linux runners alike.
If anything goes wrong the existing file is left untouched and the script exits with an error.

    python3 scripts/fetch_calendar.py [output-path]
"""

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "web" / "data" / "calendar.json"
IMPACTS = {"High", "Medium", "Low"}


def fetch() -> list:
    proc = subprocess.run(
        ["curl", "-sS", "--fail", "--max-time", "30", "--retry", "2", "-A", "discipline-desk/1.0 (personal journal)", URL],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"download failed: {proc.stderr.strip() or proc.returncode}")
    data = json.loads(proc.stdout)
    if not isinstance(data, list) or not data:
        raise RuntimeError("the feed returned no events")
    return data


def normalise(raw: list) -> list:
    """Keeps what the app needs. Times become UTC ISO strings (the feed gives a clock time with an offset)."""
    events = []
    for e in raw:
        try:
            when = datetime.fromisoformat(e["date"]).astimezone(timezone.utc)
            impact = e.get("impact")
            if impact not in IMPACTS:
                continue  # holidays and other non-market rows
            events.append({
                "currency": e["country"],
                "title": e["title"],
                "time": when.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "impact": impact,
                "forecast": e.get("forecast") or "",
                "previous": e.get("previous") or "",
            })
        except (KeyError, ValueError):
            continue
    events.sort(key=lambda x: (x["time"], x["currency"]))
    if not events:
        raise RuntimeError("no usable events after cleaning")
    return events


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    try:
        events = normalise(fetch())
    except Exception as err:  # noqa: BLE001 - report any failure, keep the old file
        print(f"Calendar not updated: {err}", file=sys.stderr)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "Fair Economy / Forex Factory free feed (unofficial)",
        "events": events,
    }
    out.write_text(json.dumps(payload, indent=1))
    high = sum(1 for e in events if e["impact"] == "High")
    print(f"Wrote {len(events)} events ({high} high impact) to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

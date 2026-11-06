#!/usr/bin/env python3
"""Generates schedule_vectors.json (PLAN_V3_SYNC §5.5).

The expected values come from Python's `zoneinfo` (system tzdata) with an
independent implementation of the reminder rules, so the fixture is a third
opinion next to chrono-tz (Rust) and Intl/ICU (TypeScript). A few DST cases are
additionally pinned by hand in HAND_CHECKED and asserted here.

Rules (identical to buddy-core::schedule / src/lib/schedule.ts):
- wall → instant: gap → first valid wall minute after it; fold → earlier instant.
- next occurrence: `at` itself if after `now`; else candidates keep at's wall time
  in the reminder zone: daily +1 day, weekdays Mon–Fri, weekly +7 days, monthly
  same day as at (clamped to month end); the first candidate strictly after now.
- ack: one-off → done (at unchanged); repeating → next occurrence after max(at, now).

Run:  python3 -I crates/buddy-core/tests/fixtures/gen_schedule_vectors.py
"""
import calendar
import json
import os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

UTC = timezone.utc


def fmt(dt):
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def wall_to_instant(zone, wall):
    z = ZoneInfo(zone)
    cand = wall
    for _ in range(24 * 60 + 1):
        valid = []
        for fold in (0, 1):
            dt = cand.replace(tzinfo=z, fold=fold)
            back = dt.astimezone(UTC).astimezone(z).replace(tzinfo=None)
            if back == cand:
                valid.append(dt.astimezone(UTC))
        if valid:
            return min(valid)
        nxt = cand + timedelta(minutes=1)
        cand = nxt.replace(second=0, microsecond=0)
    raise ValueError("no valid time")


def to_wall(zone, instant):
    return instant.astimezone(ZoneInfo(zone)).replace(tzinfo=None)


def add_months(d, anchor, k):
    idx = d.year * 12 + d.month - 1 + k
    y, m = divmod(idx, 12)
    m += 1
    return d.replace(year=y, month=m, day=min(anchor, calendar.monthrange(y, m)[1]))


def next_occurrence(zone, at, repeat, now):
    if repeat == "none":
        return None
    if at > now:
        return at
    local = to_wall(zone, at)
    d0, t = local.date(), local.time()
    for k in range(1, 5000):
        if repeat in ("daily", "weekdays"):
            d = d0 + timedelta(days=k)
            if repeat == "weekdays" and d.weekday() >= 5:
                continue
        elif repeat == "weekly":
            d = d0 + timedelta(days=7 * k)
        elif repeat == "monthly":
            d = add_months(d0, d0.day, k)
        cand = wall_to_instant(zone, datetime.combine(d, t))
        if cand > now:
            return cand
    raise ValueError("no occurrence")


ZONES = ["Europe/Berlin", "America/New_York", "Asia/Tokyo", "Australia/Lord_Howe", "Asia/Kolkata"]

# (zone, wall) pinned by hand: expected UTC instants
HAND_CHECKED = {
    ("Europe/Berlin", "2026-03-29T02:30"): "2026-03-29T01:00:00.000Z",  # gap → 03:00 CEST
    ("Europe/Berlin", "2026-10-25T02:30"): "2026-10-25T00:30:00.000Z",  # fold → CEST copy
    ("America/New_York", "2026-03-08T02:30"): "2026-03-08T07:00:00.000Z",  # gap → 03:00 EDT
    ("America/New_York", "2026-11-01T01:30"): "2026-11-01T05:30:00.000Z",  # fold → EDT copy
    ("Australia/Lord_Howe", "2026-10-04T02:15"): "2026-10-03T15:30:00.000Z",  # gap 02:00→02:30 (+11)
    ("Australia/Lord_Howe", "2026-04-05T01:45"): "2026-04-04T14:45:00.000Z",  # fold → +11 copy
    ("Asia/Kolkata", "2026-11-06T09:00"): "2026-11-06T03:30:00.000Z",
    ("Asia/Tokyo", "2026-11-06T09:00"): "2026-11-06T00:00:00.000Z",
    ("Europe/Berlin", "2026-11-06T09:00"): "2026-11-06T08:00:00.000Z",
}


def main():
    walls = []
    for (zone, wall), expected in HAND_CHECKED.items():
        got = fmt(wall_to_instant(zone, datetime.fromisoformat(wall)))
        assert got == expected, (zone, wall, got, expected)
        walls.append({"name": f"{zone} {wall} (hand-checked)", "zone": zone, "wall": wall, "expected": expected})
    for zone in ZONES:
        for wall in ["2026-01-15T09:00", "2026-07-15T09:00", "2026-12-31T23:59"]:
            walls.append({"name": f"{zone} {wall}", "zone": zone, "wall": wall,
                          "expected": fmt(wall_to_instant(zone, datetime.fromisoformat(wall)))})

    displays = []
    for zone in ZONES:
        for inst in ["2026-03-29T01:30:00.000Z", "2026-11-01T06:30:00.000Z", "2026-10-03T15:45:00.000Z",
                     "2026-04-04T15:15:00.000Z", "2026-11-06T08:00:00.000Z"]:
            displays.append({"name": f"{zone} {inst}", "zone": zone, "instant": inst,
                             "wall": to_wall(zone, parse(inst)).strftime("%Y-%m-%dT%H:%M")})

    nexts = []

    def add_next(name, zone, wall_at, repeat, now_wall, now_zone=None):
        at = wall_to_instant(zone, datetime.fromisoformat(wall_at))
        now = wall_to_instant(now_zone or zone, datetime.fromisoformat(now_wall))
        n = next_occurrence(zone, at, repeat, now)
        nexts.append({"name": name, "zone": zone, "at": fmt(at), "repeat": repeat, "now": fmt(now),
                      "expected": fmt(n) if n else None})

    for zone in ZONES:
        add_next(f"{zone} none", zone, "2026-11-05T09:00", "none", "2026-11-05T09:05")
        add_next(f"{zone} future at is its own next", zone, "2026-11-10T09:00", "daily", "2026-11-05T09:05")
        add_next(f"{zone} daily", zone, "2026-11-05T09:00", "daily", "2026-11-05T09:05")
        add_next(f"{zone} daily after a long pause", zone, "2026-01-05T09:00", "daily", "2026-11-05T08:59")
        add_next(f"{zone} weekdays fri→mon", zone, "2026-11-06T09:00", "weekdays", "2026-11-06T09:01")
        add_next(f"{zone} weekdays from saturday", zone, "2026-11-06T09:00", "weekdays", "2026-11-07T12:00")
        add_next(f"{zone} weekly", zone, "2026-11-05T09:00", "weekly", "2026-11-05T09:00")
        add_next(f"{zone} monthly clamps to month end", zone, "2026-01-31T09:00", "monthly", "2026-02-01T00:00")
        add_next(f"{zone} monthly skips past clamped", zone, "2026-01-31T09:00", "monthly", "2026-02-28T10:00")
        add_next(f"{zone} monthly leap year", zone, "2028-01-31T09:00", "monthly", "2028-02-01T00:00")
        # DST transitions of every zone (spring and autumn, both hemispheres)
        for d0, label in [("2026-03-07", "march EU/US week start"), ("2026-03-27", "march EU switch"),
                          ("2026-10-23", "october EU switch"), ("2026-10-30", "US switch week"),
                          ("2026-04-03", "lord howe april"), ("2026-10-02", "lord howe october")]:
            add_next(f"{zone} daily 09:00 {label}", zone, f"{d0}T09:00", "daily", f"{d0}T09:30")
            add_next(f"{zone} weekly 09:00 {label}", zone, f"{d0}T09:00", "weekly", f"{d0}T09:30")
        # gap/fold wall times
        add_next(f"{zone} daily 02:30 across spring", zone, "2026-03-28T02:30", "daily", "2026-03-28T03:00")
        add_next(f"{zone} daily 02:30 across autumn", zone, "2026-10-24T02:30", "daily", "2026-10-24T03:00")
        add_next(f"{zone} daily 01:30 US fold", zone, "2026-10-31T01:30", "daily", "2026-10-31T02:00")
        add_next(f"{zone} daily 02:15 lord howe gap", zone, "2026-10-03T02:15", "daily", "2026-10-03T03:00")
        add_next(f"{zone} daily 01:45 lord howe fold", zone, "2026-04-04T01:45", "daily", "2026-04-04T02:00")
    # the device zone never matters: a Berlin reminder evaluated around New York's switch
    add_next("Berlin 09:00 daily, now given around NY switch", "Europe/Berlin", "2026-03-07T09:00", "daily",
             "2026-03-08T03:30", now_zone="America/New_York")

    acks = []

    def add_ack(name, zone, wall_at, repeat, now_wall, now_zone=None):
        at = wall_to_instant(zone, datetime.fromisoformat(wall_at))
        now = wall_to_instant(now_zone or zone, datetime.fromisoformat(now_wall))
        if repeat == "none":
            exp_at, state = at, "done"
        else:
            after = at if at > now else now
            exp_at, state = next_occurrence(zone, at, repeat, after), "scheduled"
        acks.append({"name": name, "zone": zone, "at": fmt(at), "repeat": repeat, "now": fmt(now),
                     "expectedAt": fmt(exp_at), "expectedState": state})

    for zone in ZONES:
        add_ack(f"{zone} one-off done", zone, "2026-11-05T09:00", "none", "2026-11-05T09:05")
        add_ack(f"{zone} daily", zone, "2026-11-05T09:00", "daily", "2026-11-05T09:05")
        add_ack(f"{zone} early ack skips upcoming", zone, "2026-11-06T09:00", "weekdays", "2026-11-06T08:00")
        add_ack(f"{zone} weekly across own DST", zone, "2026-10-29T09:00", "weekly", "2026-10-29T09:01")
    # scenario 24/25: Berlin 09:00 acknowledged on a device in New York
    for d0 in ["2026-03-09", "2026-03-20", "2026-03-28", "2026-10-24", "2026-10-26", "2026-10-31", "2026-11-01"]:
        add_ack(f"Berlin daily 09:00 acked from New York {d0}", "Europe/Berlin", f"{d0}T09:00", "daily",
                f"{d0}T05:00", now_zone="America/New_York")

    snoozes = []
    for at, minutes, now in [("2026-11-05T08:00:00.000Z", 10, "2026-11-05T08:05:00.000Z"),
                             ("2026-11-05T08:00:00.000Z", 1440, "2026-11-05T08:05:00.000Z"),
                             ("2026-03-29T00:55:00.000Z", 10, "2026-03-29T00:55:00.000Z")]:
        snoozes.append({"name": f"snooze {minutes} min at {now}", "at": at, "minutes": minutes, "now": now,
                        "expectedAt": fmt(parse(now) + timedelta(minutes=minutes))})

    out = {
        "$comment": "Shared reminder-math vectors (buddy-core::schedule/zoned + src/lib/{zoned,schedule}.ts). "
                    "Generated by gen_schedule_vectors.py with Python zoneinfo; do not edit by hand.",
        "wallToInstant": walls,
        "instantToWall": displays,
        "next": nexts,
        "ack": acks,
        "snooze": snoozes,
    }
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schedule_vectors.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {path}: {len(walls)} wall, {len(displays)} display, {len(nexts)} next, {len(acks)} ack")


if __name__ == "__main__":
    main()

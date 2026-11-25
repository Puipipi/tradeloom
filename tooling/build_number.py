#!/usr/bin/env python3
"""Android versionCode for dsh-go builds: the build minute, readable.

    code = (year - 2026) * 10^8 + MMDDhhmm        clock at UTC+8

    2026-10-25 12:34  ->      10251234
    2027-01-02 03:04  ->     101020304
    2046-12-31 23:59  ->  2,012,312,359   (last one under Android's 2,100,000,000)

A later minute is always a larger number, across months and years, so dev and
release builds share one sequence: whatever is built later installs over
whatever was built earlier. The clock is a fixed UTC+8, not the machine's zone,
so a timezone or DST change can't make it go backwards.

    python3 tooling/build_number.py                              # now
    python3 tooling/build_number.py --at 2026-10-25T12:34+08:00
    python3 tooling/build_number.py --decode 10251234
    python3 tooling/build_number.py --check 10251234             # exit 1 if not a valid versionCode
"""

import argparse
import datetime
import sys

EPOCH_YEAR = 2026
UTC_OFFSET = datetime.timezone(datetime.timedelta(hours=8), "UTC+8")
MAX_VERSION_CODE = 2_100_000_000
YEAR_SPAN = 100_000_000


def build_number(at: datetime.datetime | None = None) -> int:
    """The versionCode for a build at [at] (timezone-aware; default now)."""
    if at is None:
        at = datetime.datetime.now(datetime.timezone.utc)
    if at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("build time needs a timezone")
    t = at.astimezone(UTC_OFFSET)
    if t.year < EPOCH_YEAR:
        raise ValueError(f"{t:%Y-%m-%d %H:%M} is before {EPOCH_YEAR}")
    code = (t.year - EPOCH_YEAR) * YEAR_SPAN + int(t.strftime("%m%d%H%M"))
    if code > MAX_VERSION_CODE:
        raise ValueError(f"{code} is over Android's versionCode limit {MAX_VERSION_CODE}")
    return code


def decode(code: int) -> datetime.datetime:
    """The build minute [code] stands for (UTC+8). ValueError when it isn't one."""
    if not 0 < code <= MAX_VERSION_CODE:
        raise ValueError(f"{code} is not a versionCode")
    years, stamp = divmod(code, YEAR_SPAN)
    month, rest = divmod(stamp, 1_000_000)
    day, rest = divmod(rest, 10_000)
    hour, minute = divmod(rest, 100)
    try:
        return datetime.datetime(EPOCH_YEAR + years, month, day, hour, minute, tzinfo=UTC_OFFSET)
    except ValueError:
        raise ValueError(f"{code} is not a build time") from None


def check(code: int) -> None:
    """ValueError unless [code] can be an Android versionCode."""
    if not 1 <= code <= MAX_VERSION_CODE:
        raise ValueError(f"versionCode must be 1..{MAX_VERSION_CODE}: {code}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--at", help="ISO time with offset, e.g. 2026-10-25T12:34+08:00")
    group.add_argument("--decode", type=int, metavar="CODE", help="print the build time a versionCode stands for")
    group.add_argument("--check", type=int, metavar="CODE", help="exit 1 unless CODE is a valid versionCode")
    args = parser.parse_args()
    try:
        if args.decode is not None:
            print(f"{decode(args.decode):%Y-%m-%d %H:%M} UTC+8")
        elif args.check is not None:
            check(args.check)
        else:
            print(build_number(datetime.datetime.fromisoformat(args.at) if args.at else None))
    except ValueError as e:
        sys.exit(f"build_number: {e}")


if __name__ == "__main__":
    main()

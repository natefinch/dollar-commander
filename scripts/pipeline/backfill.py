"""Backfill the SQLite history by walking a date range.

Run via the GitHub Actions ``backfill.yml`` workflow, or locally::

    python -m scripts.pipeline.backfill \\
        --start 2024-02-08 \\
        --end   2026-05-23 \\
        --db    data/history.sqlite \\
        --map   data/scryfall-oracle-map.json \\
        --products data/products.json

Inclusive on both ends. Defaults to today-549 .. today (UTC). Each day calls
``ingest_one_day``; results are aggregated into a summary JSON line on stdout.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import sys
from collections import Counter
from pathlib import Path

import requests

from scripts.pipeline.ingest_day import (
    RETENTION_DAYS,
    _make_session,
    emit_status,
    ingest_one_day,
)

LOG = logging.getLogger("backfill")


def _iter_dates(start: dt.date, end: dt.date):
    if end < start:
        return
    cursor = start
    one = dt.timedelta(days=1)
    while cursor <= end:
        yield cursor
        cursor = cursor + one


def run_backfill(
    *,
    start: dt.date,
    end: dt.date,
    db_path: Path,
    map_path: Path,
    products_path: Path,
    work_dir: Path | None = None,
    session: requests.Session | None = None,
    on_progress=None,
) -> dict:
    """Walk every date in ``[start, end]`` and call ``ingest_one_day``.

    Returns a summary dict with per-status counts and per-day results.
    """
    session = session or _make_session()

    statuses: Counter[str] = Counter()
    results: list[dict] = []
    total_days = (end - start).days + 1

    for index, date in enumerate(_iter_dates(start, end), start=1):
        date_str = date.isoformat()
        LOG.info("Backfilling %s (%d/%d)", date_str, index, total_days)
        try:
            result = ingest_one_day(
                date_str=date_str,
                db_path=db_path,
                map_path=map_path,
                products_path=products_path,
                session=session,
                work_dir=work_dir,
            )
        except Exception as exc:  # noqa: BLE001 — surface, don't crash the loop
            LOG.exception("Unhandled error on %s", date_str)
            result = {
                "date": date_str,
                "status": "error",
                "error_type": type(exc).__name__,
                "error": str(exc),
            }
        status = result.get("status", "error")
        statuses[status] += 1
        results.append(result)
        if on_progress is not None:
            on_progress(index, total_days, result)

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "total_days": total_days,
        "statuses": dict(statuses),
        "results": results,
    }


def _default_start(today: dt.date) -> dt.date:
    return today - dt.timedelta(days=RETENTION_DAYS)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", help="Start date YYYY-MM-DD (default: today-549)")
    parser.add_argument("--end", help="End date YYYY-MM-DD (default: today)")
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--map", type=Path, dest="map_path", required=True)
    parser.add_argument("--products", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help="Exit 0 even if some days errored. By default, the script exits non-zero "
             "if any day's ingestion errored, so the workflow does not publish a "
             "release built from a partial backfill.",
    )
    parser.add_argument(
        "--log-level", default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    today = dt.datetime.now(dt.timezone.utc).date()

    try:
        start = dt.date.fromisoformat(args.start) if args.start else _default_start(today)
        end = dt.date.fromisoformat(args.end) if args.end else today
    except ValueError as exc:
        LOG.error("Invalid date: %s", exc)
        return 1

    if end < start:
        LOG.error("--end (%s) cannot precede --start (%s)", end, start)
        return 1

    summary = run_backfill(
        start=start,
        end=end,
        db_path=args.db,
        map_path=args.map_path,
        products_path=args.products,
        work_dir=args.work_dir,
    )

    LOG.info(
        "Backfill complete: %s days, statuses=%s",
        summary["total_days"],
        summary["statuses"],
    )
    summary_line = {
        "type": "backfill_summary",
        "start": summary["start"],
        "end": summary["end"],
        "total_days": summary["total_days"],
        "statuses": summary["statuses"],
    }
    print(f"BACKFILL_SUMMARY={json.dumps(summary_line, separators=(',', ':'))}")

    error_count = summary["statuses"].get("error", 0)
    final_status = "ok" if error_count == 0 else "partial"
    emit_status({
        "date": end.isoformat(),
        "status": final_status,
        "rows_written": sum(
            r.get("rows_written", 0) for r in summary["results"] if r.get("status") == "ok"
        ),
        "stats": summary["statuses"],
    })

    if error_count and not args.allow_partial:
        LOG.error("%d day(s) errored; exiting non-zero (use --allow-partial to override)",
                  error_count)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Build the published price-index, card-index, and manifest from history.sqlite.

Run from the repo root::

    python -m scripts.pipeline.publish \\
        --db data/history.sqlite \\
        --map data/scryfall-oracle-map.json \\
        --out-dir dist/

Writes three files into ``--out-dir``:

* ``price-index-YYYY-MM-DD.json`` — per-oracle sparse price-floor curve plus
  ``today`` / ``min_549`` / ``first_seen`` summary fields. Floor entries are
  the Pareto frontier of (price, date): a sequence of ``[price, date]`` pairs
  where each entry has a price strictly less than the next, and a date that
  is the most recent observation at-or-below that price.

* ``card-index-YYYY-MM-DD.json`` — mapping of Scryfall printing UUIDs to
  oracle UUIDs, sourced directly from the oracle map. Used by content scripts
  that only see printing IDs.

* ``manifest.json`` — uploaded LAST in the workflow so clients fetching the
  manifest first and then assets see a consistent snapshot. Contains versions,
  SHA-256 hashes, byte sizes, and asset filenames.

Schema versioning::

    schema_version: { "major": 1, "minor": 0 }

Producers may add fields; consumers tolerate higher ``minor`` and reject
higher ``major``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import logging
import sqlite3
import sys
from pathlib import Path
from typing import Final

LOG = logging.getLogger("publish")

SCHEMA_VERSION_MAJOR: Final = 1
SCHEMA_VERSION_MINOR: Final = 0

# These mirror constants in ingest_day.py. We intentionally duplicate the small
# constants instead of importing to keep publish.py independent of network
# code (it's just a SQL → JSON transformer).
EPOCH_BASE: Final = dt.date(2020, 1, 1)
LOOKBACK_DAYS: Final = 365
ROTATION_GRACE_DAYS: Final = 184
WINDOW_DAYS: Final = LOOKBACK_DAYS + ROTATION_GRACE_DAYS  # 549


def epoch_to_iso(date_epoch: int) -> str:
    return (EPOCH_BASE + dt.timedelta(days=date_epoch)).isoformat()


# ---------------------------------------------------------------------------
# Pareto floor-curve computation
# ---------------------------------------------------------------------------

def build_floor_curves(
    conn: sqlite3.Connection,
    today_epoch: int,
    window_days: int = WINDOW_DAYS,
) -> dict[str, list[tuple[int, int]]]:
    """Return ``{oracle_uuid: [(price_mils, date_epoch), ...]}``.

    The floor curve is the Pareto frontier of (price, date) pairs: for each
    oracle, an observation ``(p, d)`` is on the frontier iff *no strictly
    later date* has a price ``<= p``. Equivalently, walking from the most
    recent observation backwards, a row is on the frontier iff its price is
    strictly less than the running minimum of *strictly later* rows (or it is
    the most recent row, where no later rows exist).

    The result is sorted ascending by price within each oracle.
    """
    cutoff = today_epoch - window_days
    rows = conn.execute(
        """
        WITH ranked AS (
            SELECT
                oracle_key,
                price_mils,
                date_epoch,
                -- Minimum price over rows STRICTLY later than the current
                -- row. Returns NULL for the most-recent row of each oracle.
                MIN(price_mils) OVER (
                    PARTITION BY oracle_key
                    ORDER BY date_epoch DESC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ) AS min_strictly_later
            FROM price_history
            WHERE date_epoch >= ?
        ),
        frontier AS (
            SELECT oracle_key, price_mils, date_epoch
            FROM ranked
            WHERE min_strictly_later IS NULL
               OR price_mils < min_strictly_later
        )
        SELECT o.oracle_uuid, f.price_mils, f.date_epoch
        FROM frontier f
        JOIN oracle o ON o.id = f.oracle_key
        ORDER BY o.oracle_uuid, f.price_mils ASC
        """,
        (cutoff,),
    ).fetchall()

    out: dict[str, list[tuple[int, int]]] = {}
    for uuid, price_mils, date_epoch in rows:
        out.setdefault(uuid, []).append((price_mils, date_epoch))
    return out


def fetch_today_and_first_seen(
    conn: sqlite3.Connection,
    today_epoch: int,
    window_days: int = WINDOW_DAYS,
) -> dict[str, dict]:
    """For each oracle present in the window, return today's price (if any)
    and the earliest date the oracle is seen in the window."""
    cutoff = today_epoch - window_days
    rows = conn.execute(
        """
        SELECT
            o.oracle_uuid,
            MIN(p.date_epoch) AS first_seen_epoch,
            MAX(CASE WHEN p.date_epoch = ? THEN p.price_mils END) AS today_mils
        FROM price_history p
        JOIN oracle o ON o.id = p.oracle_key
        WHERE p.date_epoch >= ?
        GROUP BY o.oracle_uuid
        """,
        (today_epoch, cutoff),
    ).fetchall()
    return {
        uuid: {
            "first_seen_epoch": first_seen,
            "today_mils": today_mils,  # may be None
        }
        for (uuid, first_seen, today_mils) in rows
    }


# ---------------------------------------------------------------------------
# Output assembly
# ---------------------------------------------------------------------------

def _mils_to_usd(mils: int) -> float:
    return round(mils / 1000.0, 3)


def assemble_price_index(
    floor_curves: dict[str, list[tuple[int, int]]],
    summaries: dict[str, dict],
    *,
    data_version: str,
    as_of_date: dt.date,
    history_start_date: dt.date,
    window_start_date: dt.date,
) -> dict:
    cards: dict[str, dict] = {}
    for uuid, curve in floor_curves.items():
        summary = summaries.get(uuid, {})
        today_mils = summary.get("today_mils")
        first_seen_epoch = summary.get("first_seen_epoch")

        record = {
            "floor": [[_mils_to_usd(p), epoch_to_iso(d)] for (p, d) in curve],
        }
        record["min_549"] = record["floor"][0][0] if record["floor"] else None

        if today_mils is None:
            record["today"] = None
            record["today_stale"] = True
        else:
            record["today"] = _mils_to_usd(today_mils)

        if first_seen_epoch is not None:
            record["first_seen"] = epoch_to_iso(first_seen_epoch)

        cards[uuid] = record

    return {
        "data_version": data_version,
        "schema_version": {"major": SCHEMA_VERSION_MAJOR, "minor": SCHEMA_VERSION_MINOR},
        # Deterministic timestamp pinned to the as_of_date so reruns produce
        # byte-identical output (and matching SHA-256 hashes). The actual
        # wall-clock build time, if useful, is recoverable from the GitHub
        # Actions run log.
        "generated_at": f"{as_of_date.isoformat()}T00:00:00Z",
        "as_of_date": as_of_date.isoformat(),
        "history_coverage_start_date": history_start_date.isoformat(),
        "window_start_date": window_start_date.isoformat(),
        "metric": "marketPrice",
        "lookback_days": LOOKBACK_DAYS,
        "rotation_grace_days": ROTATION_GRACE_DAYS,
        "card_count": len(cards),
        "cards": cards,
        "data_sources": ["TCGCSV (tcgcsv.com)", "Scryfall (scryfall.com)"],
    }


def assemble_card_index(oracle_map: dict, *, data_version: str, as_of_date: dt.date) -> dict:
    return {
        "data_version": data_version,
        "schema_version": {"major": SCHEMA_VERSION_MAJOR, "minor": SCHEMA_VERSION_MINOR},
        "generated_at": f"{as_of_date.isoformat()}T00:00:00Z",
        "as_of_date": as_of_date.isoformat(),
        "scryfall_id_to_oracle": oracle_map.get("scryfall_id_to_oracle", {}),
        "oracle_names": oracle_map.get("oracle_names", {}),
    }


def assemble_manifest(
    *,
    data_version: str,
    as_of_date: dt.date,
    history_start_date: dt.date,
    window_start_date: dt.date,
    card_count: int,
    assets: dict[str, dict],
) -> dict:
    return {
        "data_version": data_version,
        "schema_version": {"major": SCHEMA_VERSION_MAJOR, "minor": SCHEMA_VERSION_MINOR},
        "generated_at": f"{as_of_date.isoformat()}T00:00:00Z",
        "as_of_date": as_of_date.isoformat(),
        "history_coverage_start_date": history_start_date.isoformat(),
        "window_start_date": window_start_date.isoformat(),
        "metric": "marketPrice",
        "lookback_days": LOOKBACK_DAYS,
        "rotation_grace_days": ROTATION_GRACE_DAYS,
        "card_count": card_count,
        "assets": assets,
        "data_sources": ["TCGCSV (tcgcsv.com)", "Scryfall (scryfall.com)"],
    }


# ---------------------------------------------------------------------------
# IO
# ---------------------------------------------------------------------------

def write_json_with_hash(path: Path, payload: dict) -> tuple[str, int]:
    """Write JSON to ``path`` and return (sha256_hex, byte_size)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    path.write_bytes(encoded)
    return hashlib.sha256(encoded).hexdigest(), len(encoded)


def latest_history_date(conn: sqlite3.Connection) -> dt.date | None:
    row = conn.execute(
        "SELECT MIN(date_epoch), MAX(date_epoch) FROM price_history"
    ).fetchone()
    if row is None or row[1] is None:
        return None
    return EPOCH_BASE + dt.timedelta(days=row[1])


def earliest_history_date(conn: sqlite3.Connection) -> dt.date | None:
    row = conn.execute("SELECT MIN(date_epoch) FROM price_history").fetchone()
    if row is None or row[0] is None:
        return None
    return EPOCH_BASE + dt.timedelta(days=row[0])


# ---------------------------------------------------------------------------
# Top-level orchestration
# ---------------------------------------------------------------------------

def publish(
    *,
    db_path: Path,
    map_path: Path,
    out_dir: Path,
    as_of_date: dt.date | None = None,
) -> dict:
    """Build all three artifacts in ``out_dir``. Returns the manifest dict."""
    conn = sqlite3.connect(db_path)
    try:
        most_recent = latest_history_date(conn)
        first_seen = earliest_history_date(conn)
        if most_recent is None or first_seen is None:
            raise RuntimeError("history.sqlite is empty; cannot publish")
        # Default to the most recent date present in the DB so a backfill that
        # ends before "today" still produces sensible artifacts.
        effective_date = as_of_date or most_recent
        today_epoch = (effective_date - EPOCH_BASE).days

        with map_path.open("r", encoding="utf-8") as fh:
            oracle_map = json.load(fh)

        curves = build_floor_curves(conn, today_epoch)
        summaries = fetch_today_and_first_seen(conn, today_epoch)
    finally:
        conn.close()

    data_version = effective_date.isoformat()
    window_start_date = effective_date - dt.timedelta(days=WINDOW_DAYS)

    price_index = assemble_price_index(
        curves, summaries,
        data_version=data_version,
        as_of_date=effective_date,
        history_start_date=first_seen,
        window_start_date=window_start_date,
    )
    card_index = assemble_card_index(oracle_map, data_version=data_version, as_of_date=effective_date)

    price_index_path = out_dir / f"price-index-{data_version}.json"
    card_index_path = out_dir / f"card-index-{data_version}.json"

    price_sha, price_size = write_json_with_hash(price_index_path, price_index)
    card_sha,  card_size  = write_json_with_hash(card_index_path,  card_index)

    manifest = assemble_manifest(
        data_version=data_version,
        as_of_date=effective_date,
        history_start_date=first_seen,
        window_start_date=window_start_date,
        card_count=len(price_index["cards"]),
        assets={
            "price_index": {
                "filename": price_index_path.name,
                "sha256":   price_sha,
                "size":     price_size,
            },
            "card_index": {
                "filename": card_index_path.name,
                "sha256":   card_sha,
                "size":     card_size,
            },
        },
    )
    write_json_with_hash(out_dir / "manifest.json", manifest)

    LOG.info(
        "Published data_version=%s cards=%d price_index=%d bytes card_index=%d bytes",
        data_version, len(price_index["cards"]), price_size, card_size,
    )
    return manifest


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--map", type=Path, dest="map_path", required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument(
        "--as-of",
        help="Override as-of date YYYY-MM-DD (default: most recent date in DB)",
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

    try:
        as_of = dt.date.fromisoformat(args.as_of) if args.as_of else None
    except ValueError as exc:
        LOG.error("Invalid --as-of: %s", exc)
        return 1

    try:
        publish(
            db_path=args.db,
            map_path=args.map_path,
            out_dir=args.out_dir,
            as_of_date=as_of,
        )
    except (sqlite3.DatabaseError, OSError, RuntimeError, json.JSONDecodeError, KeyError) as exc:
        LOG.error("Publish failed: %s: %s", type(exc).__name__, exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

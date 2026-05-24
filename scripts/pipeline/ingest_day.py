"""Ingest one day of TCGCSV Magic price data into the rolling SQLite history.

Two modes:

1. ``python -m scripts.pipeline.ingest_day --fetch-products-only --out PATH``
   Fetches the current Magic groups and product metadata once and writes them
   to PATH as JSON. Reused across many historical days in a backfill run.

2. ``python -m scripts.pipeline.ingest_day --date YYYY-MM-DD --db PATH \
       --map PATH --products PATH``
   Downloads the daily price archive for the given date, joins through the
   oracle map and products dict, and appends one row per oracle_id to the
   history database. Emits a single structured status line to stdout::

       INGEST_RESULT={"date":"...","status":"ok|skipped|missing|error", ...}

   Exit code is 0 in every operational status; non-zero only for unexpected
   bugs (raised exceptions).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import re
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from typing import Final

import py7zr  # type: ignore[import-untyped]
import requests

LOG = logging.getLogger("ingest_day")

USER_AGENT: Final = "dollar-commander/0.1 (+https://github.com/natefinch/dollar-commander)"
TCGCSV_BASE: Final = "https://tcgcsv.com"
MAGIC_CATEGORY_ID: Final = 1
EPOCH_BASE: Final = dt.date(2020, 1, 1)
RETENTION_DAYS: Final = 549  # 365-day lookback + 184-day Jan/Jul rotation grace
REQUEST_TIMEOUT_S: Final = 60
TCGCSV_REQUEST_SLEEP_S: Final = 0.1

# Compiled once. These match patterns inside `product.name`.
SERIALIZED_NAME_RE: Final = re.compile(r"\((?:Serial Numbered|Serialized)\)", re.IGNORECASE)
FOIL_ETCHED_NAME_RE: Final = re.compile(r"\(Foil Etched\)", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Date helpers
# ---------------------------------------------------------------------------

def date_to_epoch(d: dt.date) -> int:
    return (d - EPOCH_BASE).days


def parse_iso_date(s: str) -> dt.date:
    return dt.date.fromisoformat(s)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    return session


def _tcgcsv_get(session: requests.Session, path: str, *, stream: bool = False) -> requests.Response:
    """Polite GET to tcgcsv.com with a 100ms inter-request sleep."""
    url = f"{TCGCSV_BASE}{path}"
    time.sleep(TCGCSV_REQUEST_SLEEP_S)
    LOG.debug("GET %s", url)
    response = session.get(url, stream=stream, timeout=REQUEST_TIMEOUT_S)
    response.raise_for_status()
    return response


def _result_rows(payload: object) -> list[dict]:
    """Normalize a TCGCSV JSON response into a list of result rows.

    TCGCSV typically returns ``{"results": [...]}`` but defensive callers should
    not assume any specific wrapper key.
    """
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("results", "data"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
    raise ValueError(f"Unexpected TCGCSV response shape: {type(payload).__name__}")


# ---------------------------------------------------------------------------
# Products fetch
# ---------------------------------------------------------------------------

def fetch_magic_products(session: requests.Session | None = None) -> dict[str, dict]:
    """Walk all Magic groups and return ``{productId: product}`` for every product.

    Note: TCGCSV's daily price archives do not include product metadata, only
    prices. We fetch this once per pipeline run and reuse it for every day in
    a backfill. Product names are stable enough across a year that this is a
    safe approximation.
    """
    session = session or _make_session()
    groups = _result_rows(_tcgcsv_get(session, f"/tcgplayer/{MAGIC_CATEGORY_ID}/groups").json())
    LOG.info("Fetched %d Magic groups", len(groups))

    products: dict[str, dict] = {}
    for idx, group in enumerate(groups, start=1):
        group_id = group["groupId"]
        try:
            rows = _result_rows(
                _tcgcsv_get(session, f"/tcgplayer/{MAGIC_CATEGORY_ID}/{group_id}/products").json()
            )
        except (requests.HTTPError, ValueError) as exc:
            LOG.warning("Skipping group %s (%s): %s", group_id, group.get("name"), exc)
            continue
        for product in rows:
            pid = product.get("productId")
            if pid is None:
                continue
            products[str(pid)] = product
        if idx % 50 == 0:
            LOG.info("Fetched products for %d/%d groups (%d products so far)",
                     idx, len(groups), len(products))
    LOG.info("Total Magic products: %d", len(products))
    return products


def _atomic_write_json(path: Path, payload: object) -> None:
    """Atomic-write JSON to ``path`` via a uniquely-named sibling tmp file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as fh:
        tmp_path = Path(fh.name)
        try:
            json.dump(payload, fh, separators=(",", ":"), sort_keys=True)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise
    os.replace(tmp_path, path)


def write_products_file(path: Path, products: dict[str, dict]) -> None:
    _atomic_write_json(path, products)


def load_products_file(path: Path) -> dict[str, dict]:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------
# Archive fetch + extract
# ---------------------------------------------------------------------------

class ArchiveMissingError(Exception):
    """The requested TCGCSV daily archive does not exist (404)."""


def fetch_archive(session: requests.Session, date_str: str, dest: Path) -> Path:
    """Download a daily TCGCSV price archive. Returns its on-disk path."""
    url = f"/archive/tcgplayer/prices-{date_str}.ppmd.7z"
    try:
        response = _tcgcsv_get(session, url, stream=True)
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            raise ArchiveMissingError(date_str) from exc
        raise

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    try:
        with tmp.open("wb") as fh:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    fh.write(chunk)
        os.replace(tmp, dest)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return dest


def _magic_price_pattern(date_str: str) -> re.Pattern[str]:
    # Files are at YYYY-MM-DD/<categoryId>/<groupId>/prices
    return re.compile(rf"^{re.escape(date_str)}/{MAGIC_CATEGORY_ID}/\d+/prices$")


def extract_magic_prices(archive_path: Path, date_str: str) -> list[dict]:
    """Extract and return all Magic price rows from a 7z archive.

    Uses ``py7zr.SevenZipFile.extract(path=..., targets=[...])`` which writes
    matched files to a temporary directory, then reads each one back as JSON.
    """
    pattern = _magic_price_pattern(date_str)
    rows: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="dc-7z-") as tmpdir:
        tmp_root = Path(tmpdir)
        with py7zr.SevenZipFile(str(archive_path), mode="r") as archive:
            all_names = archive.getnames()
            target_names = [name for name in all_names if pattern.match(name)]
            if not target_names:
                LOG.warning(
                    "No Magic price files matched in %s (saw %d entries)",
                    archive_path.name,
                    len(all_names),
                )
                return []
            # py7zr extracts solid archives most efficiently in archive order.
            archive.extract(path=str(tmp_root), targets=target_names)

        for name in target_names:
            extracted_path = tmp_root / name
            try:
                with extracted_path.open("rb") as fh:
                    payload = json.load(fh)
            except (OSError, json.JSONDecodeError) as exc:
                LOG.warning("Bad JSON in %s: %s", name, exc)
                continue
            try:
                rows.extend(_result_rows(payload))
            except ValueError as exc:
                LOG.warning("Unexpected price file shape in %s: %s", name, exc)
                continue

    LOG.info("Extracted %d Magic price rows from %s", len(rows), archive_path.name)
    return rows


# ---------------------------------------------------------------------------
# Join: prices + products + oracle map → per-oracle minimum
# ---------------------------------------------------------------------------

def load_oracle_map(path: Path) -> tuple[dict[str, str], dict[str, str]]:
    """Return (tcgplayer_id_map, tcgplayer_etched_id_map). Other fields ignored."""
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    return data["tcgplayer_id"], data["tcgplayer_etched_id"]


def aggregate_min_prices(
    price_rows: list[dict],
    products: dict[str, dict],
    tcg_map: dict[str, str],
    etched_map: dict[str, str],
) -> tuple[dict[str, float], dict[str, int]]:
    """Compute ``{oracle_id: min_market_price_usd}`` for the day's price rows.

    Both Normal and Foil subtype rows participate in the minimum, per the
    plan's "any version you could buy" rule. Etched subtype rows route through
    the etched map. Serialized products are excluded.
    """
    mins: dict[str, float] = {}
    stats = {
        "rows": 0,
        "kept": 0,
        "no_market_price": 0,
        "no_product": 0,
        "serialized": 0,
        "unmapped": 0,
    }

    for row in price_rows:
        stats["rows"] += 1

        market = row.get("marketPrice")
        if market is None:
            stats["no_market_price"] += 1
            continue
        if not isinstance(market, (int, float)) or market <= 0:
            stats["no_market_price"] += 1
            continue

        product_id = row.get("productId")
        if product_id is None:
            stats["no_product"] += 1
            continue

        product = products.get(str(product_id))
        if product is None:
            stats["no_product"] += 1
            continue

        name = product.get("name") or ""
        if SERIALIZED_NAME_RE.search(name):
            stats["serialized"] += 1
            continue

        # Etched variants live in their own product / Scryfall field. Prefer
        # map membership over name pattern: if a productId is only in the etched
        # map, route through etched regardless of name. Otherwise we fall back
        # to the name pattern to disambiguate cards that have both regular and
        # etched SKUs with the same product naming.
        pid_str = str(product_id)
        in_tcg = pid_str in tcg_map
        in_etched = pid_str in etched_map

        if in_etched and not in_tcg:
            oracle_id = etched_map[pid_str]
        elif in_tcg and not in_etched:
            oracle_id = tcg_map[pid_str]
        elif in_tcg and in_etched:
            if FOIL_ETCHED_NAME_RE.search(name):
                oracle_id = etched_map[pid_str]
            else:
                oracle_id = tcg_map[pid_str]
        else:
            oracle_id = None

        if not oracle_id:
            stats["unmapped"] += 1
            continue

        price_usd = float(market)
        prev = mins.get(oracle_id)
        if prev is None or price_usd < prev:
            mins[oracle_id] = price_usd
        stats["kept"] += 1

    return mins, stats


# ---------------------------------------------------------------------------
# SQLite history
# ---------------------------------------------------------------------------

_SCHEMA_USER_VERSION: Final = 1

_SCHEMA_SQL: Final = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS oracle (
  id          INTEGER PRIMARY KEY,
  oracle_uuid TEXT    NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS price_history (
  oracle_key  INTEGER NOT NULL REFERENCES oracle(id),
  date_epoch  INTEGER NOT NULL,
  price_mils  INTEGER NOT NULL CHECK (price_mils >= 0),
  PRIMARY KEY (oracle_key, date_epoch)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_phist_date ON price_history(date_epoch);

CREATE TABLE IF NOT EXISTS pipeline_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


class SchemaVersionError(RuntimeError):
    """Raised when an existing DB has an incompatible schema."""


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(_SCHEMA_SQL)
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    if current == 0:
        conn.execute(f"PRAGMA user_version = {_SCHEMA_USER_VERSION}")
        conn.commit()
    elif current != _SCHEMA_USER_VERSION:
        conn.close()
        raise SchemaVersionError(
            f"history.sqlite has user_version={current}, expected {_SCHEMA_USER_VERSION}"
        )
    return conn


def get_pipeline_state(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute(
        "SELECT value FROM pipeline_state WHERE key = ?", (key,)
    ).fetchone()
    return row[0] if row else None


def set_pipeline_state(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO pipeline_state (key, value) VALUES (?, ?)",
        (key, value),
    )
    conn.commit()


def _intern_oracle_keys(conn: sqlite3.Connection, oracle_ids: list[str]) -> dict[str, int]:
    """Insert any new oracle_ids; return ``{oracle_uuid: id}`` for all input ids."""
    if not oracle_ids:
        return {}
    conn.executemany(
        "INSERT OR IGNORE INTO oracle (oracle_uuid) VALUES (?)",
        ((oid,) for oid in oracle_ids),
    )
    placeholders = ",".join("?" * len(oracle_ids))
    rows = conn.execute(
        f"SELECT oracle_uuid, id FROM oracle WHERE oracle_uuid IN ({placeholders})",
        oracle_ids,
    ).fetchall()
    return {uuid: oid for (uuid, oid) in rows}


def write_day(
    conn: sqlite3.Connection,
    date_epoch: int,
    mins: dict[str, float],
) -> int:
    """Persist a day's per-oracle minimums. Idempotent on rerun."""
    if not mins:
        return 0
    keys = _intern_oracle_keys(conn, list(mins.keys()))
    rows = [
        (keys[oid], date_epoch, int(round(price_usd * 1000)))
        for oid, price_usd in mins.items()
        if oid in keys
    ]
    conn.executemany(
        "INSERT OR REPLACE INTO price_history(oracle_key, date_epoch, price_mils)"
        " VALUES (?, ?, ?)",
        rows,
    )
    conn.commit()
    return len(rows)


def evict_old_rows(conn: sqlite3.Connection, today_epoch: int) -> int:
    cutoff = today_epoch - RETENTION_DAYS
    cur = conn.execute("DELETE FROM price_history WHERE date_epoch < ?", (cutoff,))
    conn.commit()
    return cur.rowcount or 0


# ---------------------------------------------------------------------------
# Top-level day orchestration
# ---------------------------------------------------------------------------

def check_last_updated(session: requests.Session) -> str | None:
    try:
        return _tcgcsv_get(session, "/last-updated.txt").text.strip()
    except requests.RequestException as exc:
        LOG.warning("Could not read last-updated.txt: %s", exc)
        return None


def ingest_one_day(
    *,
    date_str: str,
    db_path: Path,
    map_path: Path,
    products_path: Path,
    session: requests.Session | None = None,
    work_dir: Path | None = None,
) -> dict:
    """Ingest a single date's data. Returns a status dict suitable for JSON-encoding."""
    session = session or _make_session()

    try:
        date = parse_iso_date(date_str)
    except ValueError as exc:
        return {"date": date_str, "status": "error",
                "error_type": "ValueError", "error": f"invalid --date: {exc}"}

    date_epoch = date_to_epoch(date)

    # Skip cleanly if TCGCSV hasn't advanced since our last successful run.
    # Note: this only applies when ingesting the *current* date.
    last_updated_remote = check_last_updated(session)
    today_utc = dt.datetime.now(dt.timezone.utc).date()

    conn = open_db(db_path)
    try:
        if last_updated_remote and date == today_utc:
            last_pulled = get_pipeline_state(conn, "tcgcsv_last_pulled")
            if last_pulled == last_updated_remote:
                return {
                    "date": date_str,
                    "status": "skipped",
                    "reason": "tcgcsv_not_updated_since_last_pull",
                    "tcgcsv_last_updated": last_updated_remote,
                }
    finally:
        conn.close()

    products = load_products_file(products_path)
    tcg_map, etched_map = load_oracle_map(map_path)

    work_dir = work_dir or Path(tempfile.mkdtemp(prefix="dc-ingest-"))
    archive_path = work_dir / f"prices-{date_str}.ppmd.7z"

    try:
        fetch_archive(session, date_str, archive_path)
    except ArchiveMissingError:
        return {"date": date_str, "status": "missing"}

    price_rows = extract_magic_prices(archive_path, date_str)
    if not price_rows:
        return {"date": date_str, "status": "empty", "reason": "no price rows in archive"}

    mins, agg_stats = aggregate_min_prices(price_rows, products, tcg_map, etched_map)

    conn = open_db(db_path)
    try:
        rows_written = write_day(conn, date_epoch, mins)
        evicted = evict_old_rows(conn, date_epoch)
        if last_updated_remote and date == today_utc:
            set_pipeline_state(conn, "tcgcsv_last_pulled", last_updated_remote)
    finally:
        conn.close()

    return {
        "date": date_str,
        "status": "ok",
        "rows_written": rows_written,
        "evicted": evicted,
        "tcgcsv_last_updated": last_updated_remote,
        "stats": agg_stats,
    }


def emit_status(result: dict) -> None:
    """Print the machine-readable status line workflow steps gate on."""
    print(f"INGEST_RESULT={json.dumps(result, separators=(',', ':'))}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log-level", default="INFO",
                        choices=["DEBUG", "INFO", "WARNING", "ERROR"])

    sub = parser.add_mutually_exclusive_group()
    sub.add_argument("--fetch-products-only", action="store_true",
                     help="Fetch current Magic products and write them to --out")
    sub.add_argument("--date", help="Date to ingest (YYYY-MM-DD)")

    parser.add_argument("--out", type=Path, help="Output path for --fetch-products-only")
    parser.add_argument("--db", type=Path, help="SQLite history database path")
    parser.add_argument("--map", type=Path, dest="map_path",
                        help="Path to scryfall-oracle-map.json")
    parser.add_argument("--products", type=Path, help="Path to products.json")
    parser.add_argument("--work-dir", type=Path,
                        help="Temp directory for archive downloads (default: mkdtemp)")

    args = parser.parse_args(argv)

    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    if args.fetch_products_only:
        if not args.out:
            parser.error("--out is required with --fetch-products-only")
        products = fetch_magic_products()
        write_products_file(args.out, products)
        LOG.info("Wrote %d products to %s", len(products), args.out)
        return 0

    if not args.date:
        parser.error("--date is required")
    for required in ("db", "map_path", "products"):
        if not getattr(args, required):
            parser.error(f"--{required.replace('_', '-')} is required for ingestion")

    session = _make_session()

    # Optional last-updated freshness check (informational only).
    last_updated = check_last_updated(session)
    if last_updated:
        LOG.info("TCGCSV last-updated.txt: %s", last_updated)

    try:
        result = ingest_one_day(
            date_str=args.date,
            db_path=args.db,
            map_path=args.map_path,
            products_path=args.products,
            session=session,
            work_dir=args.work_dir,
        )
    except (requests.RequestException, OSError, sqlite3.DatabaseError,
            py7zr.exceptions.Bad7zFile, json.JSONDecodeError, KeyError,
            SchemaVersionError, ValueError) as exc:
        result = {
            "date": args.date,
            "status": "error",
            "error_type": type(exc).__name__,
            "error": str(exc),
        }
        emit_status(result)
        LOG.error("Ingestion failed: %s: %s", type(exc).__name__, exc)
        return 1

    emit_status(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())

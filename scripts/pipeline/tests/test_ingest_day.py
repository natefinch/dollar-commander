"""Tests for ingest_day."""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
from pathlib import Path

import pytest

from scripts.pipeline import ingest_day
from scripts.pipeline.ingest_day import (
    EPOCH_BASE,
    RETENTION_DAYS,
    aggregate_min_prices,
    date_to_epoch,
    evict_old_rows,
    open_db,
    write_day,
)


@pytest.fixture
def maps():
    """Minimal oracle maps used across tests."""
    tcg = {
        "452063": "oracle-disenchant",   # BRO Disenchant
        "589334": "oracle-disenchant",   # FDN Disenchant
        "100100": "oracle-other",
    }
    etched = {
        "541280": "oracle-emrakul",      # MH3 Emrakul (Foil Etched)
        "555907": "oracle-brohq",        # ACR Brotherhood Headquarters etched
    }
    return tcg, etched


@pytest.fixture
def products():
    """Minimal TCGCSV-style products dict keyed by stringified productId."""
    return {
        "452063": {"name": "Disenchant"},
        "589334": {"name": "Disenchant"},
        "100100": {"name": "Other Card"},
        "541280": {"name": "Emrakul, the World Anew (Foil Etched)"},
        "555907": {"name": "Brotherhood Headquarters (Foil Etched)"},
        "200200": {"name": "Some Card (Serial Numbered) /500"},
        "300300": {"name": "Phantom Card"},  # in products, but not in either map
    }


# ----------------------------------------------------------------------
# Aggregation
# ----------------------------------------------------------------------

def test_aggregate_takes_min_across_versions_and_finishes(maps, products):
    tcg, etched = maps
    rows = [
        {"productId": 452063, "subTypeName": "Normal", "marketPrice": 0.50},
        {"productId": 452063, "subTypeName": "Foil",   "marketPrice": 0.40},
        {"productId": 589334, "subTypeName": "Normal", "marketPrice": 0.11},
        {"productId": 100100, "subTypeName": "Normal", "marketPrice": 5.55},
    ]
    mins, stats = aggregate_min_prices(rows, products, tcg, etched)

    assert mins["oracle-disenchant"] == pytest.approx(0.11)
    assert mins["oracle-other"] == pytest.approx(5.55)
    assert stats["kept"] == 4
    assert stats["rows"] == 4


def test_aggregate_skips_serialized_outliers(maps, products):
    tcg, etched = maps
    rows = [
        {"productId": 452063, "subTypeName": "Normal", "marketPrice": 0.11},
        {"productId": 200200, "subTypeName": "Foil",   "marketPrice": 3000.00},
    ]
    mins, stats = aggregate_min_prices(rows, products, tcg, etched)

    assert mins == {"oracle-disenchant": pytest.approx(0.11)}
    assert stats["serialized"] == 1
    assert stats["kept"] == 1


def test_aggregate_routes_etched_through_etched_map(maps, products):
    tcg, etched = maps
    rows = [
        {"productId": 541280, "subTypeName": "Foil", "marketPrice": 10.42},
    ]
    mins, _stats = aggregate_min_prices(rows, products, tcg, etched)
    assert mins == {"oracle-emrakul": pytest.approx(10.42)}


def test_aggregate_skips_null_or_nonpositive_market_price(maps, products):
    tcg, etched = maps
    rows = [
        {"productId": 452063, "subTypeName": "Normal", "marketPrice": None},
        {"productId": 452063, "subTypeName": "Foil",   "marketPrice": 0},
        {"productId": 452063, "subTypeName": "Foil",   "marketPrice": -1.0},
        {"productId": 452063, "subTypeName": "Normal", "marketPrice": 0.25},
    ]
    mins, stats = aggregate_min_prices(rows, products, tcg, etched)
    assert mins == {"oracle-disenchant": pytest.approx(0.25)}
    assert stats["no_market_price"] == 3
    assert stats["kept"] == 1


def test_aggregate_skips_rows_with_no_product(maps, products):
    tcg, etched = maps
    rows = [
        {"productId": 999999, "subTypeName": "Normal", "marketPrice": 0.10},
    ]
    mins, stats = aggregate_min_prices(rows, products, tcg, etched)
    assert mins == {}
    assert stats["no_product"] == 1


def test_aggregate_counts_unmapped_products(maps, products):
    tcg, etched = maps
    rows = [
        {"productId": 300300, "subTypeName": "Normal", "marketPrice": 0.10},
    ]
    mins, stats = aggregate_min_prices(rows, products, tcg, etched)
    assert mins == {}
    assert stats["unmapped"] == 1


# ----------------------------------------------------------------------
# Database
# ----------------------------------------------------------------------

def test_write_day_creates_oracle_keys_and_price_rows(tmp_path):
    db_path = tmp_path / "h.sqlite"
    conn = open_db(db_path)
    try:
        written = write_day(conn, 100, {"oracle-disenchant": 0.187, "oracle-other": 5.55})
        assert written == 2
        rows = conn.execute(
            "SELECT o.oracle_uuid, p.date_epoch, p.price_mils "
            "FROM price_history p JOIN oracle o ON o.id = p.oracle_key "
            "ORDER BY o.oracle_uuid"
        ).fetchall()
    finally:
        conn.close()

    assert rows == [
        ("oracle-disenchant", 100, 187),
        ("oracle-other",      100, 5550),
    ]


def test_write_day_is_idempotent(tmp_path):
    db_path = tmp_path / "h.sqlite"
    conn = open_db(db_path)
    try:
        write_day(conn, 100, {"oracle-disenchant": 0.20})
        write_day(conn, 100, {"oracle-disenchant": 0.30})  # rerun overrides
        rows = conn.execute(
            "SELECT date_epoch, price_mils FROM price_history"
        ).fetchall()
    finally:
        conn.close()

    assert rows == [(100, 300)]


def test_evict_old_rows_removes_rows_outside_retention(tmp_path):
    db_path = tmp_path / "h.sqlite"
    conn = open_db(db_path)
    try:
        # Today = epoch 1000. Retention = 549 days. So rows < 1000-549=451 are evicted.
        write_day(conn, 100, {"oracle-disenchant": 0.10})
        write_day(conn, 450, {"oracle-disenchant": 0.20})
        write_day(conn, 451, {"oracle-disenchant": 0.30})
        write_day(conn, 1000, {"oracle-disenchant": 0.40})
        removed = evict_old_rows(conn, today_epoch=1000)
        remaining = conn.execute(
            "SELECT date_epoch FROM price_history ORDER BY date_epoch"
        ).fetchall()
    finally:
        conn.close()

    assert removed == 2
    assert remaining == [(451,), (1000,)]


# ----------------------------------------------------------------------
# Date math sanity
# ----------------------------------------------------------------------

def test_date_to_epoch_matches_definition():
    assert date_to_epoch(EPOCH_BASE) == 0
    assert date_to_epoch(EPOCH_BASE + dt.timedelta(days=1)) == 1


# ----------------------------------------------------------------------
# Status emission (no network, hermetic)
# ----------------------------------------------------------------------

def test_emit_status_prints_machine_readable_line(capsys):
    ingest_day.emit_status({"date": "2026-05-24", "status": "ok"})
    captured = capsys.readouterr()
    line = captured.out.strip()
    assert line.startswith("INGEST_RESULT=")
    payload = json.loads(line.removeprefix("INGEST_RESULT="))
    assert payload == {"date": "2026-05-24", "status": "ok"}

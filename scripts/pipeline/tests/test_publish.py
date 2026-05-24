"""Tests for publish.py — Pareto floor-curve computation and asset assembly."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from scripts.pipeline import ingest_day, publish


@pytest.fixture
def db_with_history(tmp_path: Path) -> Path:
    """Build a SQLite DB and seed it with several oracle-day rows.

    Oracle A — Disenchant-like:
      Cheapest in window was $0.18 90 days ago, then mid prices and a recent
      $0.55 60 days ago. Today is $1.30.
    Oracle B — Steady cheap card:
      Always $0.10. Single distinct price.
    Oracle C — Steady expensive card:
      Always $20.00.
    Oracle D — Card not present today:
      Last observation was 7 days ago at $2.50; missing today.
    Oracle E — New card:
      First seen 5 days ago. Today's price is $0.50.
    """
    db_path = tmp_path / "h.sqlite"
    conn = ingest_day.open_db(db_path)

    today = dt.date(2026, 5, 24)
    today_epoch = ingest_day.date_to_epoch(today)

    def day(offset: int) -> int:
        return today_epoch - offset

    daysmap = {
        # oracle, date_offset_back, price_usd
        "A": [
            (300, 1.30),   # older $1.30
            (90,  0.18),   # cheap blip
            (60,  0.55),
            (10,  1.30),
            (0,   1.30),   # today
        ],
        "B": [
            (200, 0.10),
            (100, 0.10),
            (0,   0.10),
        ],
        "C": [
            (300, 20.00),
            (0,   20.00),
        ],
        "D": [
            (200, 5.00),
            (7,   2.50),   # no today
        ],
        "E": [
            (5,   0.55),
            (3,   0.50),
            (0,   0.50),   # today
        ],
    }

    for uuid, observations in daysmap.items():
        for offset, price in observations:
            ingest_day.write_day(conn, day(offset), {uuid: price})

    conn.close()
    return db_path


@pytest.fixture
def oracle_map_file(tmp_path: Path) -> Path:
    path = tmp_path / "oracle-map.json"
    path.write_text(json.dumps({
        "tcgplayer_id": {},
        "tcgplayer_etched_id": {},
        "scryfall_id_to_oracle": {
            "scryfall-A1": "A", "scryfall-A2": "A",
            "scryfall-B1": "B",
            "scryfall-C1": "C",
            "scryfall-D1": "D",
            "scryfall-E1": "E",
        },
        "oracle_names": {
            "A": "Card A", "B": "Card B", "C": "Card C", "D": "Card D", "E": "Card E",
        },
    }))
    return path


# ----------------------------------------------------------------------
# Pareto floor curves
# ----------------------------------------------------------------------

def test_floor_curve_for_card_with_multiple_local_minima(db_with_history):
    conn = sqlite3.connect(db_with_history)
    try:
        today_epoch = ingest_day.date_to_epoch(dt.date(2026, 5, 24))
        curves = publish.build_floor_curves(conn, today_epoch)
    finally:
        conn.close()

    # Card A's observations sorted DESC by date: today=1.30 (epoch=today),
    # 10-days-ago=1.30, 60-days-ago=0.55, 90-days-ago=0.18, 300-days-ago=1.30.
    # Running MIN from today back: 1.30, 1.30, 0.55, 0.18, 0.18 — so the
    # Pareto frontier picks (1.30, today), (0.55, today-60), (0.18, today-90).
    # Sorted ascending by price:
    a_curve = curves["A"]
    prices_and_offsets = [
        (price_mils, today_epoch - date_epoch) for (price_mils, date_epoch) in a_curve
    ]
    assert prices_and_offsets == [
        (180,  90),
        (550,  60),
        (1300, 0),
    ]


def test_floor_curve_for_steady_card_collapses_to_one_entry(db_with_history):
    conn = sqlite3.connect(db_with_history)
    try:
        today_epoch = ingest_day.date_to_epoch(dt.date(2026, 5, 24))
        curves = publish.build_floor_curves(conn, today_epoch)
    finally:
        conn.close()

    # Card B is always $0.10 — Pareto frontier is the *latest* observation
    # at that single price.
    assert curves["B"] == [(100, today_epoch)]


def test_floor_curve_for_card_not_today_still_has_curve(db_with_history):
    conn = sqlite3.connect(db_with_history)
    try:
        today_epoch = ingest_day.date_to_epoch(dt.date(2026, 5, 24))
        curves = publish.build_floor_curves(conn, today_epoch)
    finally:
        conn.close()

    # Card D's cheapest observation in window was 7 days ago at $2.50 (5.00 was
    # 200 days ago and got dominated). Frontier: (2.50, today-7).
    d_curve = curves["D"]
    assert len(d_curve) == 1
    price_mils, date_epoch = d_curve[0]
    assert price_mils == 2500
    assert today_epoch - date_epoch == 7


def test_floor_curve_window_excludes_older_observations(db_with_history):
    conn = sqlite3.connect(db_with_history)
    try:
        today_epoch = ingest_day.date_to_epoch(dt.date(2026, 5, 24))
        curves = publish.build_floor_curves(conn, today_epoch, window_days=50)
    finally:
        conn.close()

    # With a 50-day window, Card A only sees today's $1.30. Card B sees just
    # today's $0.10. Card C only today's $20. Card D drops to a single point
    # 7 days ago at $2.50.
    assert curves["A"] == [(1300, today_epoch)]
    assert curves["B"] == [(100,  today_epoch)]
    assert curves["D"] == [(2500, today_epoch - 7)]


# ----------------------------------------------------------------------
# Summary fields
# ----------------------------------------------------------------------

def test_today_and_first_seen_summary(db_with_history):
    conn = sqlite3.connect(db_with_history)
    try:
        today_epoch = ingest_day.date_to_epoch(dt.date(2026, 5, 24))
        summary = publish.fetch_today_and_first_seen(conn, today_epoch)
    finally:
        conn.close()

    assert summary["A"]["today_mils"] == 1300
    assert summary["B"]["today_mils"] == 100
    assert summary["D"]["today_mils"] is None    # missing today
    assert summary["E"]["today_mils"] == 500

    # Card E was first seen 5 days ago in the window.
    assert today_epoch - summary["E"]["first_seen_epoch"] == 5


# ----------------------------------------------------------------------
# Output assembly
# ----------------------------------------------------------------------

def test_publish_writes_three_files_with_consistent_hashes(
    db_with_history, oracle_map_file, tmp_path: Path,
):
    out_dir = tmp_path / "dist"
    manifest = publish.publish(
        db_path=db_with_history,
        map_path=oracle_map_file,
        out_dir=out_dir,
        as_of_date=dt.date(2026, 5, 24),
    )

    # Three files exist.
    price_path = out_dir / "price-index-2026-05-24.json"
    card_path  = out_dir / "card-index-2026-05-24.json"
    manifest_path = out_dir / "manifest.json"
    assert price_path.is_file()
    assert card_path.is_file()
    assert manifest_path.is_file()

    # Manifest hashes match the on-disk file bytes.
    for key, expected_path in [("price_index", price_path), ("card_index", card_path)]:
        expected_bytes = expected_path.read_bytes()
        digest = hashlib.sha256(expected_bytes).hexdigest()
        assert manifest["assets"][key]["sha256"] == digest
        assert manifest["assets"][key]["size"] == len(expected_bytes)
        assert manifest["assets"][key]["filename"] == expected_path.name


def test_published_record_shape_for_a_card_with_history(
    db_with_history, oracle_map_file, tmp_path: Path,
):
    out_dir = tmp_path / "dist"
    publish.publish(
        db_path=db_with_history,
        map_path=oracle_map_file,
        out_dir=out_dir,
        as_of_date=dt.date(2026, 5, 24),
    )
    index = json.loads((out_dir / "price-index-2026-05-24.json").read_text())

    assert index["schema_version"] == {"major": 1, "minor": 0}
    assert index["metric"] == "marketPrice"
    assert index["lookback_days"] == 365
    assert index["rotation_grace_days"] == 184
    assert index["window_start_date"] == "2024-11-21"   # 2026-05-24 - 549 days
    assert index["card_count"] == 5  # A, B, C, D, E

    a = index["cards"]["A"]
    assert a["today"] == 1.30
    assert a["min_549"] == 0.18
    assert a["first_seen"] == "2025-07-28"  # 300 days before 2026-05-24
    prices_only = [entry[0] for entry in a["floor"]]
    assert prices_only == sorted(prices_only)
    assert prices_only == [0.18, 0.55, 1.30]

    d = index["cards"]["D"]
    assert d["today"] is None
    assert d["today_stale"] is True
    assert d["min_549"] == 2.50


def test_publish_is_deterministic_for_same_as_of_date(
    db_with_history, oracle_map_file, tmp_path: Path,
):
    """Rerunning publish.py against the same DB state for the same as_of_date
    must produce byte-identical assets so manifest hashes don't drift."""
    out_a = tmp_path / "a"
    out_b = tmp_path / "b"

    publish.publish(
        db_path=db_with_history, map_path=oracle_map_file,
        out_dir=out_a, as_of_date=dt.date(2026, 5, 24),
    )
    publish.publish(
        db_path=db_with_history, map_path=oracle_map_file,
        out_dir=out_b, as_of_date=dt.date(2026, 5, 24),
    )

    for filename in (
        "price-index-2026-05-24.json",
        "card-index-2026-05-24.json",
        "manifest.json",
    ):
        bytes_a = (out_a / filename).read_bytes()
        bytes_b = (out_b / filename).read_bytes()
        assert bytes_a == bytes_b, f"{filename} bytes differ between reruns"


def test_card_index_carries_scryfall_id_map(
    db_with_history, oracle_map_file, tmp_path: Path,
):
    out_dir = tmp_path / "dist"
    publish.publish(
        db_path=db_with_history,
        map_path=oracle_map_file,
        out_dir=out_dir,
        as_of_date=dt.date(2026, 5, 24),
    )
    card_index = json.loads((out_dir / "card-index-2026-05-24.json").read_text())
    assert card_index["scryfall_id_to_oracle"]["scryfall-A2"] == "A"
    assert card_index["oracle_names"]["A"] == "Card A"
    assert card_index["schema_version"] == {"major": 1, "minor": 0}


def test_publish_fails_clean_on_empty_db(oracle_map_file, tmp_path: Path):
    empty_db = tmp_path / "empty.sqlite"
    conn = ingest_day.open_db(empty_db)
    conn.close()

    out_dir = tmp_path / "dist"
    with pytest.raises(RuntimeError, match="history.sqlite is empty"):
        publish.publish(
            db_path=empty_db, map_path=oracle_map_file, out_dir=out_dir,
        )


def test_main_returns_zero_on_success(db_with_history, oracle_map_file, tmp_path: Path):
    rc = publish.main([
        "--db", str(db_with_history),
        "--map", str(oracle_map_file),
        "--out-dir", str(tmp_path / "out"),
        "--as-of", "2026-05-24",
    ])
    assert rc == 0


def test_main_returns_nonzero_on_invalid_as_of(db_with_history, oracle_map_file, tmp_path: Path):
    rc = publish.main([
        "--db", str(db_with_history),
        "--map", str(oracle_map_file),
        "--out-dir", str(tmp_path / "out"),
        "--as-of", "not-a-date",
    ])
    assert rc == 1

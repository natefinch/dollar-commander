"""End-to-end integration smoke test for ingest_one_day.

Builds a real py7zr 7z archive containing a synthetic Magic price file for one
day, then runs the full ingestion pipeline against it via mocked HTTP.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import py7zr  # type: ignore[import-untyped]
import pytest
import requests

from scripts.pipeline import ingest_day


@pytest.fixture
def oracle_map_file(tmp_path: Path) -> Path:
    out = tmp_path / "oracle-map.json"
    out.write_text(json.dumps({
        "tcgplayer_id": {
            "452063": "oracle-disenchant",
            "589334": "oracle-disenchant",
        },
        "tcgplayer_etched_id": {
            "541280": "oracle-emrakul",
        },
        "scryfall_id_to_oracle": {},
        "oracle_names": {},
    }))
    return out


@pytest.fixture
def products_file(tmp_path: Path) -> Path:
    out = tmp_path / "products.json"
    out.write_text(json.dumps({
        "452063": {"name": "Disenchant"},
        "589334": {"name": "Disenchant"},
        "541280": {"name": "Emrakul, the World Anew (Foil Etched)"},
        "200200": {"name": "Some Card (Serial Numbered) /500"},
    }))
    return out


def _build_archive(archive_path: Path, date_str: str, price_payload: list[dict]) -> None:
    """Build a real 7z archive with `YYYY-MM-DD/1/24232/prices` content."""
    inner_dir = archive_path.parent / "_inner"
    inner_dir.mkdir(exist_ok=True)
    inner_file = inner_dir / "prices.json"
    inner_file.write_text(json.dumps({"results": price_payload}))

    with py7zr.SevenZipFile(str(archive_path), mode="w") as archive:
        archive.write(inner_file, arcname=f"{date_str}/1/24232/prices")


@pytest.fixture
def fake_session(tmp_path: Path) -> tuple[MagicMock, dict]:
    """Build a mocked requests.Session that serves the synthetic archive."""
    date_str = "2026-05-23"
    archive_disk = tmp_path / "served-archive.7z"
    _build_archive(
        archive_disk,
        date_str,
        [
            {"productId": 452063, "subTypeName": "Normal", "marketPrice": 0.50},
            {"productId": 452063, "subTypeName": "Foil",   "marketPrice": 0.40},
            {"productId": 589334, "subTypeName": "Normal", "marketPrice": 0.11},
            {"productId": 541280, "subTypeName": "Foil",   "marketPrice": 10.42},
            {"productId": 200200, "subTypeName": "Foil",   "marketPrice": 3000.00},
        ],
    )
    archive_bytes = archive_disk.read_bytes()

    session = MagicMock(spec=requests.Session)

    def fake_get(url, *, stream: bool = False, timeout: float = 0):
        response = MagicMock()
        response.raise_for_status = MagicMock()
        if url.endswith("/last-updated.txt"):
            response.text = "2026-05-23T20:05:34+0000"
            return response
        if "/archive/tcgplayer/prices-2026-05-23.ppmd.7z" in url:
            response.iter_content = lambda chunk_size=0: iter([archive_bytes])
            return response
        raise AssertionError(f"unexpected GET {url}")

    session.get.side_effect = fake_get
    return session, {"date_str": date_str}


def test_full_path_ingest_one_day_ok(
    tmp_path: Path, oracle_map_file: Path, products_file: Path, fake_session
):
    session, ctx = fake_session
    db_path = tmp_path / "history.sqlite"
    work_dir = tmp_path / "work"

    result = ingest_day.ingest_one_day(
        date_str=ctx["date_str"],
        db_path=db_path,
        map_path=oracle_map_file,
        products_path=products_file,
        session=session,
        work_dir=work_dir,
    )

    assert result["status"] == "ok"
    assert result["rows_written"] == 2  # Disenchant + Emrakul; serialized + null skipped
    assert result["stats"]["serialized"] == 1
    assert result["stats"]["kept"] == 4

    # The downloaded archive must be cleaned up so a 549-day backfill cannot
    # exhaust the runner disk.
    assert not (work_dir / f"prices-{ctx['date_str']}.ppmd.7z").exists()
    # But the work directory itself is still around (the caller owns it).
    assert work_dir.is_dir()

    # DB state.
    import sqlite3
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT o.oracle_uuid, p.price_mils FROM price_history p "
            "JOIN oracle o ON o.id = p.oracle_key ORDER BY o.oracle_uuid"
        ).fetchall()
    finally:
        conn.close()
    assert rows == [
        ("oracle-disenchant", 110),   # FDN Normal $0.11 wins
        ("oracle-emrakul",   10420),
    ]


def test_ingest_returns_missing_on_404(
    tmp_path: Path, oracle_map_file: Path, products_file: Path
):
    session = MagicMock(spec=requests.Session)

    def fake_get(url, *, stream: bool = False, timeout: float = 0):
        response = MagicMock()
        if url.endswith("/last-updated.txt"):
            response.raise_for_status = MagicMock()
            response.text = "2026-05-23T20:05:34+0000"
            return response
        if "/archive/tcgplayer/" in url:
            http_exc = requests.HTTPError("404")
            http_exc.response = MagicMock(status_code=404)
            response.raise_for_status = MagicMock(side_effect=http_exc)
            return response
        raise AssertionError(f"unexpected GET {url}")

    session.get.side_effect = fake_get

    result = ingest_day.ingest_one_day(
        date_str="2024-01-01",
        db_path=tmp_path / "history.sqlite",
        map_path=oracle_map_file,
        products_path=products_file,
        session=session,
        work_dir=tmp_path / "work",
    )
    assert result == {"date": "2024-01-01", "status": "missing"}


def test_ingest_returns_skipped_when_tcgcsv_unchanged(
    tmp_path: Path, oracle_map_file: Path, products_file: Path, fake_session
):
    session, ctx = fake_session
    db_path = tmp_path / "history.sqlite"

    # Force the "today" path to match the archive date so the skip check engages.
    fake_today = ingest_day.parse_iso_date(ctx["date_str"])
    with patch("scripts.pipeline.ingest_day.dt.datetime") as mock_dt:
        mock_dt.now.return_value.date.return_value = fake_today
        mock_dt.timezone = __import__("datetime").timezone

        # First run: ingests successfully and records the TCGCSV timestamp.
        first = ingest_day.ingest_one_day(
            date_str=ctx["date_str"],
            db_path=db_path,
            map_path=oracle_map_file,
            products_path=products_file,
            session=session,
            work_dir=tmp_path / "work1",
        )
        assert first["status"] == "ok"

        # Second run on the same date with the same TCGCSV last-updated: skip.
        second = ingest_day.ingest_one_day(
            date_str=ctx["date_str"],
            db_path=db_path,
            map_path=oracle_map_file,
            products_path=products_file,
            session=session,
            work_dir=tmp_path / "work2",
        )
        assert second["status"] == "skipped"


def test_ingest_invalid_date_returns_error(
    tmp_path: Path, oracle_map_file: Path, products_file: Path
):
    result = ingest_day.ingest_one_day(
        date_str="2026-13-99",
        db_path=tmp_path / "h.sqlite",
        map_path=oracle_map_file,
        products_path=products_file,
        session=MagicMock(spec=requests.Session),
        work_dir=tmp_path / "work",
    )
    assert result["status"] == "error"
    assert result["error_type"] == "ValueError"

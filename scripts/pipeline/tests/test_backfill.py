"""Tests for the backfill driver."""

from __future__ import annotations

import datetime as dt
from pathlib import Path
from unittest.mock import patch

import pytest

from scripts.pipeline import backfill


def test_iter_dates_inclusive_on_both_ends():
    start = dt.date(2026, 5, 20)
    end = dt.date(2026, 5, 23)
    dates = list(backfill._iter_dates(start, end))
    assert dates == [
        dt.date(2026, 5, 20),
        dt.date(2026, 5, 21),
        dt.date(2026, 5, 22),
        dt.date(2026, 5, 23),
    ]


def test_iter_dates_empty_when_end_before_start():
    assert list(backfill._iter_dates(dt.date(2026, 5, 23), dt.date(2026, 5, 22))) == []


def test_iter_dates_single_day():
    d = dt.date(2026, 5, 23)
    assert list(backfill._iter_dates(d, d)) == [d]


def test_run_backfill_aggregates_statuses(tmp_path: Path):
    """run_backfill walks dates and tallies the statuses ingest_one_day returns."""
    fake_results = [
        {"date": "2026-05-20", "status": "ok",      "rows_written": 5},
        {"date": "2026-05-21", "status": "missing"},
        {"date": "2026-05-22", "status": "ok",      "rows_written": 7},
        {"date": "2026-05-23", "status": "skipped"},
    ]
    iterator = iter(fake_results)

    def fake_ingest(*, date_str, **_kwargs):
        return next(iterator)

    with patch("scripts.pipeline.backfill.ingest_one_day", side_effect=fake_ingest):
        summary = backfill.run_backfill(
            start=dt.date(2026, 5, 20),
            end=dt.date(2026, 5, 23),
            db_path=tmp_path / "h.sqlite",
            map_path=tmp_path / "m.json",
            products_path=tmp_path / "p.json",
        )

    assert summary["total_days"] == 4
    assert summary["statuses"] == {"ok": 2, "missing": 1, "skipped": 1}
    assert [r["date"] for r in summary["results"]] == [
        "2026-05-20", "2026-05-21", "2026-05-22", "2026-05-23",
    ]


def test_run_backfill_continues_past_unhandled_exceptions(tmp_path: Path):
    """A crashing day shouldn't abort the whole backfill."""
    calls = []

    def flaky_ingest(*, date_str, **_kwargs):
        calls.append(date_str)
        if date_str == "2026-05-21":
            raise RuntimeError("synthetic boom")
        return {"date": date_str, "status": "ok", "rows_written": 1}

    with patch("scripts.pipeline.backfill.ingest_one_day", side_effect=flaky_ingest):
        summary = backfill.run_backfill(
            start=dt.date(2026, 5, 20),
            end=dt.date(2026, 5, 22),
            db_path=tmp_path / "h.sqlite",
            map_path=tmp_path / "m.json",
            products_path=tmp_path / "p.json",
        )

    assert calls == ["2026-05-20", "2026-05-21", "2026-05-22"]
    assert summary["statuses"] == {"ok": 2, "error": 1}
    error_result = summary["results"][1]
    assert error_result["status"] == "error"
    assert error_result["error_type"] == "RuntimeError"


def test_run_backfill_invokes_progress_callback(tmp_path: Path):
    progress_calls = []

    def fake_ingest(*, date_str, **_kwargs):
        return {"date": date_str, "status": "ok", "rows_written": 0}

    def on_progress(index, total, result):
        progress_calls.append((index, total, result["date"]))

    with patch("scripts.pipeline.backfill.ingest_one_day", side_effect=fake_ingest):
        backfill.run_backfill(
            start=dt.date(2026, 5, 20),
            end=dt.date(2026, 5, 21),
            db_path=tmp_path / "h.sqlite",
            map_path=tmp_path / "m.json",
            products_path=tmp_path / "p.json",
            on_progress=on_progress,
        )

    assert progress_calls == [(1, 2, "2026-05-20"), (2, 2, "2026-05-21")]


def test_default_start_is_549_days_back():
    today = dt.date(2026, 5, 24)
    assert backfill._default_start(today) == today - dt.timedelta(days=549)


# ----------------------------------------------------------------------
# CLI entry point
# ----------------------------------------------------------------------

def _stub_args(tmp_path: Path) -> list[str]:
    return [
        "--db", str(tmp_path / "h.sqlite"),
        "--map", str(tmp_path / "m.json"),
        "--products", str(tmp_path / "p.json"),
    ]


def test_main_returns_nonzero_for_invalid_start_date(tmp_path: Path):
    rc = backfill.main(_stub_args(tmp_path) + ["--start", "2026-13-99"])
    assert rc == 1


def test_main_returns_nonzero_for_invalid_end_date(tmp_path: Path):
    rc = backfill.main(_stub_args(tmp_path) + ["--end", "not-a-date"])
    assert rc == 1


def test_main_returns_nonzero_when_end_before_start(tmp_path: Path):
    rc = backfill.main(
        _stub_args(tmp_path) + ["--start", "2026-05-23", "--end", "2026-05-20"]
    )
    assert rc == 1


def test_main_exits_nonzero_on_any_per_day_error(tmp_path: Path):
    def crashing_ingest(*, date_str, **_kwargs):
        return {"date": date_str, "status": "error",
                "error_type": "RuntimeError", "error": "synthetic"}

    with patch("scripts.pipeline.backfill.ingest_one_day", side_effect=crashing_ingest):
        rc = backfill.main(_stub_args(tmp_path) + ["--start", "2026-05-20", "--end", "2026-05-20"])
    assert rc == 2  # distinct from arg-validation failures (1)


def test_main_allow_partial_returns_zero_with_errors(tmp_path: Path):
    def crashing_ingest(*, date_str, **_kwargs):
        return {"date": date_str, "status": "error", "error_type": "X", "error": "x"}

    with patch("scripts.pipeline.backfill.ingest_one_day", side_effect=crashing_ingest):
        rc = backfill.main(
            _stub_args(tmp_path) + ["--start", "2026-05-20", "--end", "2026-05-20",
                                     "--allow-partial"]
        )
    assert rc == 0


def test_main_exits_zero_on_full_success(tmp_path: Path):
    def ok_ingest(*, date_str, **_kwargs):
        return {"date": date_str, "status": "ok", "rows_written": 1}

    with patch("scripts.pipeline.backfill.ingest_one_day", side_effect=ok_ingest):
        rc = backfill.main(_stub_args(tmp_path) + ["--start", "2026-05-20", "--end", "2026-05-21"])
    assert rc == 0

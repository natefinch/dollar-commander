"""Tests for the oracle map builder.

These tests cover the pure map-building function `build_maps` with synthetic
card objects. The network/streaming layer is exercised by an integration test
that calls `build_oracle_map` against a fixture file when present.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.pipeline.oracle_map import build_maps


def _cards(*objs):
    yield from objs


def test_paper_card_appears_in_all_maps():
    cards = _cards({
        "id": "658c5caa-d739-4d30-a512-43ac4de900cb",
        "oracle_id": "a7e97fa9-4b72-4548-b854-5be5f18a6f1a",
        "name": "Disenchant",
        "set_type": "expansion",
        "layout": "normal",
        "type_line": "Instant",
        "tcgplayer_id": 452063,
    })
    tcg, etched, sid, names, stats = build_maps(cards)

    assert tcg == {"452063": "a7e97fa9-4b72-4548-b854-5be5f18a6f1a"}
    assert etched == {}
    assert sid == {"658c5caa-d739-4d30-a512-43ac4de900cb":
                   "a7e97fa9-4b72-4548-b854-5be5f18a6f1a"}
    assert names == {"a7e97fa9-4b72-4548-b854-5be5f18a6f1a": "Disenchant"}
    assert stats["included"] == 1
    assert stats["excluded"] == 0
    assert stats["with_tcgplayer_id"] == 1


def test_foil_etched_only_card_goes_into_etched_map():
    cards = _cards({
        "id": "280e43b4-2208-4df0-a8b2-380cfd22dde5",
        "oracle_id": "0d3a06d5-5bb9-4733-a55b-9e2c75de6b6e",
        "name": "Brotherhood Headquarters",
        "set_type": "expansion",
        "layout": "normal",
        "type_line": "Land",
        "tcgplayer_id": None,
        "tcgplayer_etched_id": 555907,
    })
    tcg, etched, _sid, _names, stats = build_maps(cards)

    assert tcg == {}
    assert etched == {"555907": "0d3a06d5-5bb9-4733-a55b-9e2c75de6b6e"}
    assert stats["with_tcgplayer_etched_id"] == 1
    assert stats["with_tcgplayer_id"] == 0


def test_token_is_excluded():
    cards = _cards({
        "id": "tok-1",
        "oracle_id": "tok-oracle",
        "name": "Soldier Token",
        "layout": "token",
        "type_line": "Token Creature — Soldier",
        "tcgplayer_id": 12345,
    })
    tcg, etched, sid, names, stats = build_maps(cards)

    assert tcg == {}
    assert etched == {}
    assert sid == {}
    assert names == {}
    assert stats["excluded"] == 1


def test_memorabilia_is_excluded_even_with_tcgplayer_id():
    cards = _cards({
        "id": "30a-1",
        "oracle_id": "a7e97fa9-4b72-4548-b854-5be5f18a6f1a",
        "name": "Disenchant",
        "set_type": "memorabilia",
        "layout": "normal",
        "type_line": "Instant",
        "tcgplayer_id": 449209,
    })
    tcg, _etched, _sid, names, stats = build_maps(cards)

    assert "449209" not in tcg
    assert stats["excluded"] == 1
    # If the card's *only* printing is excluded, its name should not appear either.
    assert names == {}


def test_first_seen_name_wins_for_an_oracle_id():
    # Two printings of the same card; we keep whichever appeared first.
    cards = _cards(
        {
            "id": "p1",
            "oracle_id": "oid-x",
            "name": "Card One",
            "set_type": "expansion",
            "layout": "normal",
            "tcgplayer_id": 1,
        },
        {
            "id": "p2",
            "oracle_id": "oid-x",
            "name": "Card One (Alternate)",
            "set_type": "expansion",
            "layout": "normal",
            "tcgplayer_id": 2,
        },
    )
    tcg, _etched, _sid, names, _stats = build_maps(cards)

    assert tcg == {"1": "oid-x", "2": "oid-x"}
    assert names == {"oid-x": "Card One"}


def test_card_without_oracle_id_is_counted_separately():
    cards = _cards({
        "id": "no-oid",
        "name": "Mystery",
        "set_type": "expansion",
        "layout": "normal",
        "tcgplayer_id": 99,
    })
    tcg, _etched, _sid, names, stats = build_maps(cards)

    assert tcg == {}
    assert names == {}
    assert stats["no_oracle"] == 1
    assert stats["included"] == 0


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "default_cards_mini.json"


def test_integration_with_fixture_covers_research_contract():
    """End-to-end test against a curated mini-bulk that exercises every case from
    the plan's Phase 1 exit criteria."""
    import ijson  # type: ignore[import-untyped]

    with FIXTURE_PATH.open("rb") as fh:
        tcg, etched, sid, names, stats = build_maps(ijson.items(fh, "item"))

    # BRO Disenchant — well-known historical productId.
    assert tcg["452063"] == "a7e97fa9-4b72-4548-b854-5be5f18a6f1a"
    # FDN Disenchant — same oracle_id, different productId.
    assert tcg["589334"] == "a7e97fa9-4b72-4548-b854-5be5f18a6f1a"

    # Foil etched lives in the etched map and NOT in the regular map.
    assert etched["555907"] == "0d3a06d5-5bb9-4733-a55b-9e2c75de6b6e"
    assert etched["541280"] == "fixture-emrakul-oracle"
    assert "555907" not in tcg
    assert "541280" not in tcg

    # Excluded categories: memorabilia, digital, token, art series.
    assert "449209" not in tcg                  # 30A Disenchant (memorabilia)
    assert "999999" not in tcg                  # digital-only
    assert "888888" not in tcg                  # token
    assert "777777" not in tcg                  # art series
    assert "fixture-mtgo-only-oracle"   not in names
    assert "fixture-token-oracle"       not in names

    # Reversible cards take the front face's oracle_id.
    assert tcg["666666"] == "fixture-reversible-front-oracle"

    # Oracle name lookup uses the first-encountered included printing.
    assert names["a7e97fa9-4b72-4548-b854-5be5f18a6f1a"] == "Disenchant"

    # Scryfall printing-id → oracle_id covers every included printing.
    assert sid["658c5caa-d739-4d30-a512-43ac4de900cb"] == "a7e97fa9-4b72-4548-b854-5be5f18a6f1a"
    assert sid["7ac43e16-8b14-46f2-877a-600ea918766b"] == "a7e97fa9-4b72-4548-b854-5be5f18a6f1a"

    # Stats invariant: included + excluded + no_oracle == seen.
    assert stats["included"] + stats["excluded"] + stats["no_oracle"] == stats["seen"]


@pytest.mark.skipif(not FIXTURE_PATH.exists(),
                    reason="default_cards_mini.json fixture not present")
def test_integration_legacy_smoke(tmp_path):
    """Keeps the original lightweight smoke test for regression spotting."""
    import ijson  # type: ignore[import-untyped]

    with FIXTURE_PATH.open("rb") as fh:
        result = build_maps(ijson.items(fh, "item"))

    tcg, etched, sid, names, stats = result
    assert isinstance(tcg, dict)
    assert isinstance(names, dict)
    assert stats["seen"] > 0

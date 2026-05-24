"""Tests for exclusions."""

from scripts.pipeline.exclusions import extract_oracle_id, should_exclude


def test_includes_paper_card():
    card = {
        "id": "abc",
        "oracle_id": "oid",
        "name": "Disenchant",
        "digital": False,
        "oversized": False,
        "set_type": "core",
        "layout": "normal",
        "type_line": "Instant",
    }
    assert not should_exclude(card)
    assert extract_oracle_id(card) == "oid"


def test_excludes_digital():
    assert should_exclude({"digital": True, "layout": "normal"})


def test_excludes_oversized():
    assert should_exclude({"oversized": True, "layout": "normal"})


def test_excludes_memorabilia():
    assert should_exclude({"set_type": "memorabilia", "layout": "normal"})


def test_excludes_token():
    assert should_exclude({"layout": "token", "type_line": "Token Creature"})


def test_excludes_art_series():
    assert should_exclude({"layout": "art_series"})


def test_excludes_emblem_by_type_line():
    assert should_exclude({"layout": "emblem", "type_line": "Emblem — Jace"})


def test_reversible_card_uses_first_face_oracle_id():
    card = {
        "layout": "reversible_card",
        "card_faces": [
            {"oracle_id": "face-a"},
            {"oracle_id": "face-b"},
        ],
    }
    assert extract_oracle_id(card) == "face-a"


def test_missing_oracle_id_returns_none():
    assert extract_oracle_id({"layout": "normal"}) is None


def test_reversible_without_faces_returns_none():
    assert extract_oracle_id({"layout": "reversible_card"}) is None

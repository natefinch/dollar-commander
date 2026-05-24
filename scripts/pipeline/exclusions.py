"""Exclusion rules for Scryfall card objects.

A card is *included* in the legality index iff it represents a real, paper,
tournament-grade Magic: The Gathering card. We exclude:

* digital-only printings (MTGO, Arena)
* oversized cards (Planechase / Archenemy / oversized commander)
* memorabilia sets (e.g., 30th Anniversary collector editions whose prices are null)
* non-card game objects: art series, vanguards, schemes, planes, phenomena
* token cards (these have oracle_ids but are not deck-legality cards)
* emblems
"""

from __future__ import annotations

from typing import Final

_EXCLUDED_LAYOUTS: Final[frozenset[str]] = frozenset({
    "art_series",
    "vanguard",
    "scheme",
    "planar",
    "phenomenon",
    "token",
    "double_faced_token",
    "emblem",
})


def should_exclude(card: dict) -> bool:
    """Return True if this Scryfall card should not appear in the legality index."""
    if card.get("digital"):
        return True
    if card.get("oversized"):
        return True
    if card.get("set_type") == "memorabilia":
        return True
    if card.get("layout") in _EXCLUDED_LAYOUTS:
        return True
    type_line = card.get("type_line") or ""
    if type_line.startswith("Emblem"):
        return True
    return False


def extract_oracle_id(card: dict) -> str | None:
    """Get the oracle_id for a card, handling the rare reversible_card layout."""
    oracle_id = card.get("oracle_id")
    if oracle_id:
        return oracle_id
    if card.get("layout") == "reversible_card":
        faces = card.get("card_faces") or []
        if faces and isinstance(faces[0], dict):
            return faces[0].get("oracle_id")
    return None

"""Build the Scryfall oracle/TCGplayer mapping.

Streams the Scryfall `default_cards` bulk file and produces:

    {
      "generated_at": "...",
      "scryfall_bulk_updated_at": "...",
      "tcgplayer_id":          { "<productId>": "<oracle_id>", ... },
      "tcgplayer_etched_id":   { "<productId>": "<oracle_id>", ... },
      "scryfall_id_to_oracle": { "<scryfall_printing_id>": "<oracle_id>", ... },
      "oracle_names":          { "<oracle_id>": "Card Name", ... }
    }

Run from the repo root::

    python -m scripts.pipeline.oracle_map --out data/scryfall-oracle-map.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import sys
from pathlib import Path
from typing import IO, Iterator
from urllib.parse import urlparse

import ijson  # type: ignore[import-untyped]
import requests

from scripts.pipeline.exclusions import extract_oracle_id, should_exclude

LOG = logging.getLogger("oracle_map")

BULK_INDEX_URL = "https://api.scryfall.com/bulk-data"
USER_AGENT = "dollar-commander/0.1 (+https://github.com/natefinch/dollar-commander)"
REQUEST_TIMEOUT_S = 60


class ScryfallError(RuntimeError):
    """Raised when Scryfall returns unexpected data."""


def _fetch_bulk_metadata(session: requests.Session) -> dict:
    response = session.get(BULK_INDEX_URL, timeout=REQUEST_TIMEOUT_S)
    response.raise_for_status()
    payload = response.json()
    for entry in payload.get("data", []):
        if entry.get("type") == "default_cards":
            return entry
    raise ScryfallError("No default_cards entry in Scryfall bulk-data index")


def _open_bulk_stream(session: requests.Session, url: str) -> IO[bytes]:
    """Return a streaming binary file-like for the bulk JSON."""
    if not urlparse(url).scheme.startswith("http"):
        raise ScryfallError(f"Refusing non-HTTP bulk URL: {url!r}")
    response = session.get(url, stream=True, timeout=REQUEST_TIMEOUT_S)
    response.raise_for_status()
    response.raw.decode_content = True
    return response.raw


def _iter_cards(stream: IO[bytes]) -> Iterator[dict]:
    """Stream-parse the Scryfall bulk file as a JSON array of card objects."""
    return ijson.items(stream, "item")


def build_maps(cards: Iterator[dict]) -> tuple[dict, dict, dict, dict, dict]:
    tcg_to_oracle: dict[str, str] = {}
    etched_to_oracle: dict[str, str] = {}
    scryfall_to_oracle: dict[str, str] = {}
    oracle_names: dict[str, str] = {}
    counters = {
        "seen": 0,
        "included": 0,
        "excluded": 0,
        "no_oracle": 0,
        "with_tcgplayer_id": 0,
        "with_tcgplayer_etched_id": 0,
    }

    for card in cards:
        counters["seen"] += 1
        if should_exclude(card):
            counters["excluded"] += 1
            continue

        oracle_id = extract_oracle_id(card)
        if not oracle_id:
            counters["no_oracle"] += 1
            continue

        counters["included"] += 1

        scryfall_id = card.get("id")
        if scryfall_id:
            scryfall_to_oracle[scryfall_id] = oracle_id

        # Card name: prefer the parent `name`; for split/transform the parent name
        # already joins face names with " // " which is what we want for display.
        name = card.get("name")
        if name and oracle_id not in oracle_names:
            oracle_names[oracle_id] = name

        tcg_id = card.get("tcgplayer_id")
        if tcg_id is not None:
            tcg_to_oracle[str(tcg_id)] = oracle_id
            counters["with_tcgplayer_id"] += 1

        etched_id = card.get("tcgplayer_etched_id")
        if etched_id is not None:
            etched_to_oracle[str(etched_id)] = oracle_id
            counters["with_tcgplayer_etched_id"] += 1

    return tcg_to_oracle, etched_to_oracle, scryfall_to_oracle, oracle_names, counters


def build_oracle_map(out_path: Path, session: requests.Session | None = None) -> dict:
    session = session or _make_session()
    meta = _fetch_bulk_metadata(session)
    download_uri = meta["download_uri"]
    bulk_updated_at = meta.get("updated_at")
    LOG.info("Downloading default_cards bulk from %s", download_uri)

    with _open_bulk_stream(session, download_uri) as stream:
        tcg, etched, sid, names, counters = build_maps(_iter_cards(stream))

    output = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "scryfall_bulk_updated_at": bulk_updated_at,
        "tcgplayer_id": tcg,
        "tcgplayer_etched_id": etched,
        "scryfall_id_to_oracle": sid,
        "oracle_names": names,
        "stats": counters,
    }

    # NOTE: serialized / "(Serial Numbered)" / "(Serialized)" exclusion is
    # intentionally NOT done here. Those filters require a TCGCSV `product.name`
    # which lives in the products endpoint, not Scryfall. They are applied in
    # `ingest_day.py` before the join.

    _write_json_atomically(out_path, output)

    LOG.info(
        "Wrote %s — included=%d, excluded=%d, tcgplayer_id=%d, etched=%d",
        out_path,
        counters["included"],
        counters["excluded"],
        counters["with_tcgplayer_id"],
        counters["with_tcgplayer_etched_id"],
    )
    return output


def _write_json_atomically(out_path: Path, output: dict) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    try:
        with tmp_path.open("w", encoding="utf-8") as fh:
            # sort_keys gives byte-stable output modulo `generated_at`, useful for
            # content-hash-based caching and diff inspection of the map file.
            json.dump(output, fh, separators=(",", ":"), sort_keys=True)
        os.replace(tmp_path, out_path)
    except BaseException:
        # Clean up the partial tmp on any error / signal so debugging is easier.
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    })
    return session


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path, help="Output JSON path")
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    try:
        build_oracle_map(args.out)
    except (requests.RequestException, ScryfallError, KeyError, ValueError, OSError) as exc:
        LOG.error("Failed to build oracle map: %s: %s", type(exc).__name__, exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

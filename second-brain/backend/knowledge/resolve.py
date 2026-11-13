"""Entity resolution across apps: the same sponsor shows up as 'TechNova Pvt Ltd' in the
tracker, 'TN' in chat, rohan.mehta@technova.io in email."""
from __future__ import annotations

import re

from rapidfuzz import fuzz, process

from .. import db


def _aliases() -> list[dict]:
    return db.query("SELECT * FROM entity_aliases")


def sponsor_mentions(text: str) -> list[tuple[str, str]]:
    """(alias, entity_id) for every name alias that appears as a whole word in the text."""
    low = text.lower()
    hits = []
    for a in _aliases():
        if a["kind"] != "name":
            continue
        if re.search(rf"(?<![\w.]){re.escape(a['alias'])}(?![\w])", low):
            hits.append((a["alias"], a["entity_id"]))
    return hits


def sender_info(sender: str) -> dict:
    """Who sent this: an external sponsor contact, a known sponsor domain, an internal person, or unknown."""
    s = sender.lower()
    for a in _aliases():
        if a["kind"] == "person" and a["alias"] == s:
            return {"entity_id": a["entity_id"], "method": "person", "role": a["role"], "internal": False}
    domain = s.split("@")[-1] if "@" in s else None
    if domain:
        for a in _aliases():
            if a["kind"] == "domain" and a["alias"] == domain:
                return {"entity_id": a["entity_id"], "method": "domain", "role": None, "internal": False}
    person = db.query_one("SELECT * FROM people WHERE id=? OR email=?", (sender, s))
    if person or (domain == "innovision.in"):
        return {"entity_id": None, "method": "internal", "role": person["role"] if person else None,
                "internal": True, "person_id": person["id"] if person else None}
    return {"entity_id": None, "method": "unknown", "role": None, "internal": False, "domain": domain}


def resolve(mention: str, sender: str) -> tuple[str | None, float, str]:
    """Resolve a sponsor mention: exact alias -> sender identity -> fuzzy (>= 90)."""
    names = {a["alias"]: a["entity_id"] for a in _aliases() if a["kind"] == "name"}
    key = mention.strip().lower()
    if key in names:
        return names[key], 1.0, "alias"
    info = sender_info(sender)
    if info["entity_id"]:
        return info["entity_id"], 0.95, info["method"]
    if key:
        best = process.extractOne(key, list(names), scorer=fuzz.token_set_ratio)
        if best and best[1] >= 90:
            return names[best[0]], best[1] / 100, "fuzzy"
    return None, 0.0, "unresolved"

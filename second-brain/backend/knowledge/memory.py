"""Long-term (semantic) memory: versioned facts. Facts are superseded, never overwritten,
so 'what did we believe on Nov 10?' stays answerable."""
from __future__ import annotations

from .. import db
from ..confidence import find_amounts
from .resolve import sponsor_mentions


def current_fact(entity: str, predicate: str) -> dict | None:
    return db.query_one("SELECT * FROM facts WHERE entity=? AND predicate=? AND valid_to IS NULL",
                        (entity, predicate))


def fact_history(entity: str | None = None) -> list[dict]:
    if entity:
        return db.query("SELECT * FROM facts WHERE entity=? ORDER BY predicate, valid_from", (entity,))
    return db.query("SELECT * FROM facts ORDER BY entity, predicate, valid_from")


def fact_as_of(entity: str, predicate: str, ts: str) -> dict | None:
    return db.query_one(
        "SELECT * FROM facts WHERE entity=? AND predicate=? AND valid_from<=? "
        "AND (valid_to IS NULL OR valid_to>?) ORDER BY valid_from DESC LIMIT 1",
        (entity, predicate, ts, ts))


def contradiction(entity: str, predicate: str, new_value: str, source_ref: str) -> dict | None:
    cur = current_fact(entity, predicate)
    if cur and cur["value"] != new_value:
        return {"predicate": predicate, "old_value": cur["value"], "old_source": cur["source_ref"],
                "old_fact_id": cur["id"], "new_value": new_value, "new_source": source_ref}
    return None


def corroborated(entity: str, amount: int, exclude_message_id: str) -> list[str]:
    """Other messages that mention the same sponsor with the same amount."""
    hits = []
    for m in db.query("SELECT id, body FROM messages WHERE id != ?", (exclude_message_id,)):
        if any(eid == entity for _, eid in sponsor_mentions(m["body"])) and \
                amount in [a for a, _, _ in find_amounts(m["body"])]:
            hits.append(m["id"])
    return hits

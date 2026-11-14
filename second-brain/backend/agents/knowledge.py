"""Knowledge agent: entity resolution, memory check, confidence, impact analysis."""
from __future__ import annotations

from .. import confidence, config, db, trust
from ..knowledge import graph as kg
from ..knowledge import memory
from ..knowledge.resolve import resolve, sender_info
from ..models import ExtractedChange, ImpactNode, ImpactReport, ResolvedChange


class Unresolved(Exception):
    def __init__(self, question: str):
        super().__init__(question)
        self.question = question


def resolve_change(msg: dict, ex: ExtractedChange) -> ResolvedChange:
    sid, _, method = resolve(ex.sponsor_mention, msg["sender"])
    if sid is None:
        raise Unresolved(f"Which sponsor does '{ex.sponsor_mention or msg['sender']}' refer to?")
    if ex.new_amount is None:
        raise Unresolved("The message does not state an amount. What is the new commitment?")
    sponsor = db.query_one("SELECT * FROM sponsors WHERE id=?", (sid,))
    sender = sender_info(msg["sender"])
    corroborating = memory.corroborated(sid, ex.new_amount, msg["id"])
    old = sponsor["committed_amount"]
    certainty, reasons = confidence.score(
        new_amount=ex.new_amount, text=msg["body"], resolution_method=method,
        sender_role=sender["role"] if not sender["internal"] else None,
        internal_relay=sender["internal"], corroborated=bool(corroborating), old_amount=old)
    sender_trust, signals = trust.sender_trust(msg)
    conf = round(min(certainty, sender_trust), 2)        # the gate is the weaker of the two
    contra = memory.contradiction(sid, "committed_amount", str(ex.new_amount), msg["id"])
    return ResolvedChange(
        change_id=msg["id"], sponsor_id=sid, sponsor_name=sponsor["name"], resolution_method=method,
        old_amount=old, new_amount=ex.new_amount, old_tier=sponsor["tier"],
        new_tier=config.tier_for(ex.new_amount), shortfall=old - ex.new_amount,
        confidence=conf, band=confidence.band(conf, **trust.thresholds()), confidence_reasons=reasons,
        contradiction=contra, evidence_refs=[msg["id"]] + corroborating + ([contra["old_source"]] if contra else []),
        certainty=certainty, trust=sender_trust, trust_signals=signals, known_contact=sponsor["contact"])


def analyze(rc: ResolvedChange) -> tuple[ImpactReport, object]:
    G = kg.build()
    nodes = [ImpactNode(**n) for n in kg.impacted(G, rc.sponsor_id)]
    return ImpactReport(root=rc.sponsor_id, nodes=nodes), G

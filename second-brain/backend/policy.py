"""Risk scoring and approval policy (code, never the LLM)."""
from __future__ import annotations

from . import config
from .knowledge import graph as kg
from .models import PlannedAction
from .tools import REGISTRY

ANNOTATION_TOOLS = {"memory.supersede_fact", "docs.append_note", "calendar.add_note", "promo.flag_correction"}


def _targets(a: PlannedAction) -> list[str]:
    args = a.args
    if "changes" in args:
        return [c["line_id"] for c in args["changes"]]
    for k in ("sponsor_id", "deliverable_id", "event_id", "org_approval_id", "target_id"):
        if k in args:
            return [args[k]]
    return []


def score(a: PlannedAction, G, band: str) -> PlannedAction:
    spec = REGISTRY[a.tool]
    r, why = 0, []
    if spec.external:
        r += 3
        why.append("+3 leaves the organisation")
    if not spec.reversible:
        r += 3
        why.append("+3 irreversible")
    amt = abs(a.money_delta or 0)
    if amt >= 1_00_000:
        r += 3
        why.append(f"+3 moves ≥ ₹1L (₹{amt:,})")
    elif amt >= config.APPROVAL_MONEY_THRESHOLD:
        r += 2
        why.append(f"+2 moves ≥ ₹25k (₹{amt:,})")
    elif amt > 0:
        r += 1
        why.append(f"+1 moves money (₹{amt:,})")
    blast = max((len(kg.impacted(G, t)) for t in _targets(a) if t in G), default=0)
    if blast >= 3:
        r += 2
        why.append(f"+2 touches {blast} downstream nodes")
    if band == "supervised" and a.tool not in ANNOTATION_TOOLS:
        r += 3
        why.append("+3 change came from a low-confidence (supervised) source")
    a.risk_score, a.risk_reasons = r, why
    a.requires_approval = (
        r >= config.APPROVAL_RISK_THRESHOLD
        or spec.external
        or amt >= config.APPROVAL_MONEY_THRESHOLD
        or (spec.touches_public and amt > 0)
    )
    return a

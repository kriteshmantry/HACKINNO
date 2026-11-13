"""Plan validator: a plan (template or LLM) must pass every check before anything executes."""
from __future__ import annotations

import networkx as nx
from pydantic import ValidationError

from .. import db
from ..models import ImpactReport, Option, Plan, ResolvedChange
from ..tools import REGISTRY
from ..tools.apps import WRITE_TOOLS


def validate(plan: Plan, rc: ResolvedChange, impact: ImpactReport, option: Option | None) -> list[str]:
    errors: list[str] = []
    ids = {a.id for a in plan.actions}

    g = nx.DiGraph()
    for a in plan.actions:
        g.add_node(a.id)
        for d in a.depends_on:
            if d not in ids:
                errors.append(f"{a.id}: depends on unknown action {d}")
            g.add_edge(d, a.id)
    if not nx.is_directed_acyclic_graph(g):
        errors.append("plan dependencies contain a cycle")

    allowed_targets = {impact.root} | {n.node for n in impact.nodes} | set(option.cuts if option else [])
    lines = {l["id"]: l for l in db.query("SELECT * FROM budget_lines")}
    for a in plan.actions:
        spec = REGISTRY.get(a.tool)
        if spec is None:
            errors.append(f"{a.id}: unknown tool {a.tool}")
            continue
        if a.tool not in WRITE_TOOLS:
            errors.append(f"{a.id}: {a.tool} is not an Execution-agent tool")
        try:
            spec.args_model.model_validate(a.args)
        except ValidationError as e:
            errors.append(f"{a.id}: invalid args for {a.tool}: {e.errors()[0]['msg']}")
            continue
        if not a.evidence_refs:
            errors.append(f"{a.id}: no evidence")
        for t in _targets(a):
            if t not in allowed_targets:
                errors.append(f"{a.id}: target {t} is outside the impact set")
        # numbers must come from code, never from the planner
        if a.tool == "tracker.set_committed" and a.args["new"] != rc.new_amount:
            errors.append(f"{a.id}: committed {a.args['new']} != extracted {rc.new_amount}")
        if a.tool in ("budget.set_lines", "tracker.flag_pending_update"):
            for c in a.args["changes"]:
                if not option or option.cuts.get(c["line_id"]) != c["new"]:
                    errors.append(f"{a.id}: {c['line_id']}={c['new']} is not what the chosen option computed")
                if c["new"] < lines[c["line_id"]]["floor"]:
                    errors.append(f"{a.id}: {c['line_id']} would go below its floor")
        if REGISTRY[a.tool].external and not a.requires_approval:
            errors.append(f"{a.id}: external message without an approval gate")
    return errors


def _targets(a) -> list[str]:
    args = a.args
    if a.tool.startswith("comms.") or a.tool == "memory.supersede_fact":
        return []
    if "changes" in args:
        return [c["line_id"] for c in args["changes"]]
    for k in ("sponsor_id", "deliverable_id", "event_id", "org_approval_id", "target_id"):
        if k in args:
            return [args[k]]
    return []

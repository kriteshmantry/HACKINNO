"""Execution agent (deterministic): runs the validated plan level by level, gating
high-risk actions on human approval and routing every write through the tool registry."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Callable

import networkx as nx

from .. import approvals
from ..events import RunCtx
from ..models import Plan, PlannedAction
from ..tools import PermanentToolError, PreconditionFailed, invoke
from ..tools.apps import WRITE_TOOLS

OK = ("done", "skipped_duplicate")


@dataclass
class ExecResult:
    failed: list[PlannedAction] = field(default_factory=list)
    rejected: list[PlannedAction] = field(default_factory=list)
    blocked: list[PlannedAction] = field(default_factory=list)
    precondition: list[PlannedAction] = field(default_factory=list)
    expired: list[PlannedAction] = field(default_factory=list)
    edited: list[PlannedAction] = field(default_factory=list)     # a person changed the budget amounts

    @property
    def needs_replan(self) -> bool:
        return bool(self.failed or self.rejected or self.blocked or self.edited)


async def execute(plan: Plan, ctx: RunCtx, on_change: Callable[[], None]) -> ExecResult:
    ctx = ctx.as_agent("Execution", WRITE_TOOLS)
    by_id = {a.id: a for a in plan.actions}
    g = nx.DiGraph()
    for a in plan.actions:
        g.add_node(a.id)
        g.add_edges_from((d, a.id) for d in a.depends_on if d in by_id)
    res = ExecResult()

    def set_status(a: PlannedAction, status: str, **extra) -> None:
        a.status = status
        for k, v in extra.items():
            setattr(a, k, v)
        on_change()
        ctx.emit("action.status", f"{a.id} {a.tool}: {status}",
                 {"action_id": a.id, "key": a.key, "status": status, **{k: v for k, v in extra.items()
                                                                       if k in ("error",)}}, a.evidence_refs)

    async def run_one(a: PlannedAction) -> None:
        if a.status in OK:
            return
        if any(by_id[d].status == "replaced" for d in a.depends_on if d in by_id):
            set_status(a, "replaced", error="waits for the plan to be redone from your amounts")
            return
        if any(by_id[d].status not in OK for d in a.depends_on if d in by_id):
            set_status(a, "blocked", error="a dependency did not complete")
            res.blocked.append(a)
            return
        args = dict(a.args)
        if a.requires_approval:
            set_status(a, "awaiting_approval")
            dec = await approvals.request(ctx, a)
            a.approval_id = dec["id"]
            if dec["status"] == "rejected":
                set_status(a, "rejected_by_human", error=dec.get("reason"))
                res.rejected.append(a)
                return
            if dec["status"] not in ("approved", "edited"):
                set_status(a, "failed", error=f"approval {dec['status']}")
                res.failed.append(a)
                res.expired.append(a)
                return
            args = dict(dec["final_args"])
            if "approval_id" in args:
                args["approval_id"] = dec["id"]
            if (dec["status"] == "edited" and a.tool == "budget.set_lines"
                    and args.get("changes") != a.args.get("changes")):
                # new numbers change the gap, approvals and messages that depend on them:
                # do not apply them here, re-plan everything downstream from the person's amounts
                a.args = args
                set_status(a, "replaced", error="you edited the amounts; re-planning from them")
                res.edited.append(a)
                return
            a.args = args
        set_status(a, "running")
        meta: dict = {}
        # a repair re-applies a write already made for this change, so it needs its own key
        actx = ctx if not a.idem_scope else RunCtx(ctx.run_id, f"{ctx.change_id}#{a.idem_scope}", ctx.agent, ctx.allowlist)
        try:
            result = await invoke(a.tool, args, actx, meta=meta)
            set_status(a, "skipped_duplicate" if meta.get("duplicate") else "done", result=result)
        except PreconditionFailed as e:
            set_status(a, "failed", error=f"precondition: {e}")
            res.failed.append(a)
            res.precondition.append(a)
        except PermanentToolError as e:
            set_status(a, "failed", error=str(e))
            res.failed.append(a)

    for level in nx.topological_generations(g):
        await asyncio.gather(*(run_one(by_id[i]) for i in level))
    return res

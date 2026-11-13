"""Planning agent: shortfall options (solver), plan (template planner), risk, validation."""
from __future__ import annotations

from .. import db, policy
from ..models import ImpactReport, Option, Plan, ResolvedChange
from ..planning import solver, template, validator


def options(rc: ResolvedChange) -> list[Option]:
    return solver.solve(rc.shortfall, db.query("SELECT * FROM budget_lines"),
                        db.query("SELECT * FROM org_approvals"))


def make_plan(run_id: str, version: int, rc: ResolvedChange, impact: ImpactReport, G,
              option: Option | None, *, rejected_keys: set[str], degraded_tools: set[str],
              done_keys: set[str]) -> tuple[Plan, list[str]]:
    actions = template.build(run_id, version, rc, option, rejected_keys=rejected_keys,
                             degraded_tools=degraded_tools, done_keys=done_keys)
    for a in actions:
        policy.score(a, G, rc.band)
    plan = Plan(run_id=run_id, version=version, option_id=option.id if option else None,
                actions=actions, planner="template")
    return plan, validator.validate(plan, rc, impact, option)

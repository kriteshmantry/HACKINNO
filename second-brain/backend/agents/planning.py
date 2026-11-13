"""Planning agent: shortfall options (solver), plan (template planner), risk, validation."""
from __future__ import annotations

from .. import db, policy
from ..models import ImpactReport, Option, Plan, ResolvedChange
from ..planning import solver, template, validator


def budget_gap(rc: ResolvedChange) -> int:
    """What the budget sheet lacks once this change is applied, read from the live workspace.

    Usually equal to rc.shortfall (old - new). It differs when an earlier fix never landed,
    e.g. a fallback run left its budget reductions pending: the sheet is still short by the
    earlier amount, whatever this change's own delta is.
    """
    s = db.budget_summary()
    cur = db.query_one("SELECT committed_amount FROM sponsors WHERE id=?", (rc.sponsor_id,))["committed_amount"]
    return s["expense"] - (s["income"] - cur + rc.new_amount)


def options(rc: ResolvedChange) -> list[Option]:
    return solver.solve(budget_gap(rc), db.query("SELECT * FROM budget_lines"),
                        db.query("SELECT * FROM org_approvals"))


def make_plan(run_id: str, version: int, rc: ResolvedChange, impact: ImpactReport, G,
              option: Option | None, *, rejected_keys: set[str], degraded_tools: set[str],
              done_keys: set[str], repair: bool = False) -> tuple[Plan, list[str]]:
    actions = template.build(run_id, version, rc, option, rejected_keys=rejected_keys,
                             degraded_tools=degraded_tools, done_keys=done_keys, repair=repair,
                             gap_now=budget_gap(rc))
    for a in actions:
        policy.score(a, G, rc.band)
    plan = Plan(run_id=run_id, version=version, option_id=option.id if option else None,
                actions=actions, planner="template")
    return plan, validator.validate(plan, rc, impact, option)

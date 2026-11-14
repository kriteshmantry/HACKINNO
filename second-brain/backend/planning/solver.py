"""Shortfall options solver (deterministic). Computes three ways to cover a funding gap
from the budget sheet's floors and priorities. The LLM may recommend one; it never invents numbers."""
from __future__ import annotations

from ..models import Option

STEP = 5_000


def _greedy(gap: int, lines: list[dict]) -> dict[str, int]:
    red, left = {}, gap
    for l in sorted(lines, key=lambda l: l["priority"]):
        if left <= 0:
            break
        take = min(l["amount"] - l["floor"], left)
        if take > 0:
            red[l["id"]] = take
            left -= take
    return red


def _proportional(gap: int, lines: list[dict]) -> dict[str, int]:
    head = {l["id"]: l["amount"] - l["floor"] for l in lines if l["amount"] > l["floor"]}
    total = sum(head.values())
    if total <= gap:
        return dict(head)
    red = {k: (gap * h // total) // STEP * STEP for k, h in head.items()}
    left = gap - sum(red.values())
    for k in sorted(head, key=lambda k: -head[k]):          # hand out the rounding remainder
        while left > 0 and red[k] < head[k]:
            add = min(STEP, left, head[k] - red[k])
            red[k] += add
            left -= add
    return {k: v for k, v in red.items() if v > 0}


def _make(oid: str, name: str, strategy: str, gap: int, red: dict[str, int], lines: dict[str, dict],
          approvals: list[dict]) -> Option:
    covered = sum(red.values())
    cuts = {k: lines[k]["amount"] - v for k, v in red.items()}
    violations = [f"{k} below floor" for k, v in cuts.items() if v < lines[k]["floor"]]
    public = sum(1 for k in red if lines[k]["public"])
    affected = [a["id"] for a in approvals if a["linked_line"] in red and a["status"] in ("pending", "approved")]
    coverage = round(covered / gap, 3) if gap else 1.0
    score = round(100 * coverage - 15 * public - 10 * len(affected) - 100 * len(violations) - 5 * len(red), 1)
    return Option(id=oid, name=name, strategy=strategy, cuts=cuts, reductions=red, coverage=coverage,
                  open_gap=gap - covered, public_changes=public, approvals_affected=affected,
                  violations=violations, score=score)


def from_amounts(gap: int, amounts: dict[str, int], budget_lines: list[dict], org_approvals: list[dict]) -> Option:
    """Option H: the line amounts a person typed while approving the budget step. Coverage and the
    open gap are recomputed in code from their numbers, so everything downstream follows them."""
    lines = {l["id"]: l for l in budget_lines}
    red = {k: lines[k]["amount"] - v for k, v in amounts.items() if lines[k]["amount"] != v}
    o = _make("H", "Your amounts", "Line amounts you set while approving the budget change.", gap, red, lines,
              org_approvals)
    o.cuts = {k: int(v) for k, v in amounts.items() if lines[k]["amount"] != v}
    o.open_gap = max(0, o.open_gap)
    o.coverage = min(1.0, max(0.0, o.coverage))
    return o


def solve(gap: int, budget_lines: list[dict], org_approvals: list[dict]) -> list[Option]:
    if gap <= 0:
        return []
    lines = {l["id"]: l for l in budget_lines}
    cuttable = [l for l in budget_lines if l["cuttable"]]
    contingency = [l for l in cuttable if l["category"].lower() == "contingency"]
    protect = [l for l in cuttable if not l["public"] and l not in contingency]
    opts = [
        _make("A", "Protect prizes", "Cut non-public lines in priority order; never touch prizes or contingency.",
              gap, _greedy(gap, protect), lines, org_approvals),
        _make("B", "Balanced", "Spread the cut across every cuttable line in proportion to its headroom above floor.",
              gap, _proportional(gap, cuttable), lines, org_approvals),
        _make("C", "Contingency + find a sponsor", "Draw contingency down to its floor; record the rest as an "
              "open gap for the sponsorship team to fill.", gap, _greedy(gap, contingency), lines, org_approvals),
    ]
    best = max(opts, key=lambda o: o.score)
    best.recommended = True
    return opts

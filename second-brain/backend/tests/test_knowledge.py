import pytest

from backend import db
from backend.agents import communication, knowledge
from backend.confidence import find_amounts, rule_extract
from backend.events import RunCtx
from backend.knowledge import graph as kg
from backend.planning import solver


@pytest.mark.parametrize("text,value", [
    ("₹3,00,000", 300000), ("3L", 300000), ("3 lakh", 300000), ("300k", 300000),
    ("Rs. 3,00,000/-", 300000), ("3.5L final", 350000), ("₹1.2 crore", 12000000),
])
def test_amount_normaliser(text, value):
    assert find_amounts(text)[0][0] == value


def test_dates_and_counts_are_not_amounts():
    assert find_amounts("Need 10 volunteers on Nov 20 at 4 PM, 400 snack boxes") == []


def test_rule_extract_instead_of():
    new, old, span = rule_extract("TechNova can commit ₹3,00,000 instead of the ₹5L we confirmed earlier.")
    assert (new, old) == (300000, 500000) and "₹3,00,000" in span


def _resolve(mid):
    msg = communication.get_message(mid)
    ex = communication.extract(msg, RunCtx("r", mid, "Communication"))
    return knowledge.resolve_change(msg, ex)


def test_triage():
    labels = {m: communication.triage(communication.get_message(m)).label
              for m in ("e-19", "e-21", "c-11", "e-23", "c-05", "e-06", "e-01")}
    assert labels == {"e-19": "relevant", "e-21": "relevant", "c-11": "relevant", "e-23": "suspicious",
                      "c-05": "noise", "e-06": "noise", "e-01": "noise"}


def test_confidence_bands():
    clear, vague, relay = _resolve("e-19"), _resolve("e-21"), _resolve("c-11")
    assert clear.band == "autonomous" and clear.confidence >= 0.8
    assert clear.contradiction and clear.contradiction["old_source"] == "e-07"
    assert vague.band == "clarify"
    assert relay.band == "supervised" and relay.new_amount == 350000 and relay.resolution_method == "alias"


def test_impact_includes_pending_approval_and_poster():
    rc = _resolve("e-19")
    impact, _ = knowledge.analyze(rc)
    nodes = {n.node: n for n in impact.nodes}
    assert {"oa-prizes", "p-poster", "ev-keynote", "ev-banner-print", "bl-prizes", "d-keynote"} <= nodes.keys()
    assert nodes["oa-prizes"].severity == "high"
    assert "approves" in nodes["oa-prizes"].path
    assert "d-bb-banner" not in nodes          # other sponsors are untouched


def test_solver_options():
    opts = {o.id: o for o in solver.solve(200000, db.query("SELECT * FROM budget_lines"),
                                          db.query("SELECT * FROM org_approvals"))}
    assert opts["A"].coverage == 1.0 and "bl-prizes" not in opts["A"].reductions
    assert opts["B"].coverage == 1.0 and sum(opts["B"].reductions.values()) == 200000
    assert "oa-prizes" in opts["B"].approvals_affected
    assert opts["C"].open_gap == 150000
    assert all(not o.violations for o in opts.values())
    assert sum(o.recommended for o in opts.values()) == 1

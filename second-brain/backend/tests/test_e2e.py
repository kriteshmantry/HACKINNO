"""End-to-end runs of the coordinator with a scripted human approver."""
import asyncio

from backend import approvals, coordinator, db
from backend.tools import set_fault


async def _run(message_id: str, *, decide=lambda ap: ("approve", None, None), option_wait=0.0,
               option=None, clarify=None, timeout=20):
    run = coordinator.create_run(message_id, option_wait)
    task = asyncio.create_task(coordinator.drive(run))
    seen = set()
    while not task.done():
        await asyncio.sleep(0.05)
        for ap in db.query("SELECT * FROM approvals_queue WHERE status='pending' AND run_id=?", (run.id,)):
            if ap["id"] not in seen:
                seen.add(ap["id"])
                d, args, reason = decide(ap)
                approvals.decide(ap["id"], d, args, reason)
        if option:
            approvals.send_signal(f"option:{run.id}", {"option": option})
        if clarify and approvals.send_signal(f"clarify:{run.id}", clarify):
            clarify = None
        if run.state == "AWAIT_CLARIFICATION" and clarify is None and not task.done():
            await asyncio.sleep(0.2)
            if run.state == "AWAIT_CLARIFICATION":
                task.cancel()
                break
    try:
        await asyncio.wait_for(task, timeout)
    except (asyncio.CancelledError, asyncio.TimeoutError):
        pass
    return run


def run(*a, **k):
    return asyncio.run(_run(*a, **k))


def writes() -> int:
    return db.query_one("SELECT COUNT(*) n FROM idempotency")["n"]


def test_s1_happy_path_all_checks_pass():
    r = run("e-19")
    assert r.state == "DONE", (r.outcome, r.error, r.meta)
    assert r.verification.ok, [c for c in r.verification.checks if not c.ok]
    s = db.workspace_state()
    tn = next(x for x in s["sponsors"] if x["id"] == "s-technova")
    assert (tn["committed_amount"], tn["tier"]) == (300000, "Silver")
    assert s["budget_summary"]["shortfall"] == 0          # option A covered it
    keynote = next(d for d in s["deliverables"] if d["id"] == "d-keynote")
    assert keynote["status"] == "removed"
    assert db.query_one("SELECT status FROM calendar_events WHERE id='ev-keynote'")["status"] == "cancelled"
    assert db.query_one("SELECT COUNT(*) n FROM outbox WHERE external=1")["n"] == 1


def test_rerunning_the_same_email_changes_nothing():
    run("e-19")
    before = writes()
    r = run("e-19")
    assert r.state == "DONE" and "no change" in r.outcome
    assert writes() == before
    assert db.query_one("SELECT COUNT(*) n FROM outbox")["n"] == 2   # one email + one team chat, ever


def test_option_b_amends_the_pending_approval():
    r = run("e-19", option_wait=2, option="B")
    assert r.state == "DONE" and r.chosen_option == "B" and r.verification.ok
    oa = db.query_one("SELECT * FROM org_approvals WHERE id='oa-prizes'")
    assert oa["status"] == "on_hold" and oa["amount"] < 300000


def test_persistent_budget_failure_replans_to_degraded_path():
    set_fault("budget.set_lines", "always")
    r = run("e-19")
    assert r.state == "DONE", (r.outcome, r.meta)
    assert r.replans >= 1 and "budget.set_lines" in r.degraded_tools
    assert r.verification.ok
    assert db.query_one("SELECT COUNT(*) n FROM pending_updates")["n"] > 0
    assert any(o["recipient"] == "#finance" for o in db.query("SELECT * FROM outbox"))


def test_rejecting_the_sponsor_email_still_converges():
    r = run("e-19", decide=lambda ap: ("reject", None, "call them instead") if ap["tool"] == "comms.email"
            else ("approve", None, None))
    assert r.state == "DONE" and r.verification.ok
    assert "comms.sponsor_email" in r.rejected_keys
    assert db.query_one("SELECT COUNT(*) n FROM outbox WHERE external=1")["n"] == 0


def test_edited_email_is_sent_with_the_edit():
    r = run("e-19", decide=lambda ap: ("edit", {"cc": ["treasurer@innovision.in"]}, None)
            if ap["tool"] == "comms.email" else ("approve", None, None))
    assert r.state == "DONE"
    mail = db.query_one("SELECT * FROM outbox WHERE external=1")
    assert "treasurer@innovision.in" in mail["cc"]


def test_ambiguous_email_writes_nothing():
    r = run("e-21")
    assert r.state == "AWAIT_CLARIFICATION"
    assert r.resolved.band == "clarify"
    assert writes() == 0


def test_clarification_confirmed_then_runs():
    r = run("e-21", clarify={"decision": "confirm", "amount": 300000})
    assert r.state == "DONE" and r.resolved.human_confirmed and r.verification.ok


def test_injection_is_quarantined():
    r = run("e-23")
    assert r.state == "QUARANTINED" and r.plan is None and writes() == 0


def test_supervised_chat_relay_gates_every_material_write():
    r = run("c-11")
    assert r.resolved.band == "supervised"
    gated = {a.tool for a in r.plan_history[0].actions if a.requires_approval}
    assert {"tracker.set_committed", "tracker.set_tier", "budget.set_lines"} <= gated
    assert r.state == "DONE" and r.verification.ok


def test_verifier_catches_corruption():
    from backend.agents import verification
    r = run("e-19")
    db.execute("UPDATE deliverables SET status='active' WHERE id='d-keynote'")
    rep = verification.verify(r.resolved, r.plan, r.id, r.rejected_keys)
    assert not rep.ok and not next(c for c in rep.checks if c.id == "V3").ok

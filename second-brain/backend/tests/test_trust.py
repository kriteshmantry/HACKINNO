"""Email Trust Score, the verification queue, tier-boundary negotiation and the risk radar."""
import asyncio

from backend import approvals, coordinator, db, negotiation, radar, trust, verifications
from backend.agents import communication

from test_e2e import run as run_scenario


def msg(mid):
    return communication.get_message(mid)


async def _until(pred, timeout=10.0):
    t = 0.0
    while not pred():
        await asyncio.sleep(0.05)
        t += 0.05
        if t > timeout:
            raise TimeoutError("condition not reached")


async def _drive(message_id, steps, approve=True):
    """Start a run, then for each step wait until the run waits on the verification and apply it."""
    run = coordinator.create_run(message_id, 0)
    task = asyncio.create_task(coordinator.drive(run))
    name = f"clarify:{run.id}"
    for step in steps:
        await _until(lambda: approvals.is_waiting(name) or task.done())
        if task.done():
            break
        await step(run)
    while not task.done():
        await asyncio.sleep(0.05)
        if approve:
            for ap in db.query("SELECT id FROM approvals_queue WHERE status='pending' AND run_id=?", (run.id,)):
                approvals.decide(ap["id"], "approve")
    await task
    return run


def item_for(run):
    return verifications.list_items(run_id=run.id)[0]


# --- trust signals ---------------------------------------------------------------------------
def test_lookalike_domains():
    assert trust.lookalike("techn0va-billing.com") == "technova.io"
    assert trust.lookalike("technova-io.com") == "technova.io"
    assert trust.lookalike("innovisi0n.in") == "innovision.in"
    assert trust.lookalike("technova.io") is None
    assert trust.lookalike("hallbookings.in") is None and trust.lookalike("college.edu") is None


def test_trust_scores_separate_impostors_from_hedges():
    real, hedged, relay, impostor = (trust.assess(msg(m)) for m in ("e-19", "e-21", "c-11", "e-25"))
    assert real.trust >= 0.85 and real.band == "autonomous"
    assert hedged.trust >= 0.85 and hedged.band == "clarify"          # genuine sender, unclear change
    assert relay.band == "supervised"
    assert impostor.trust < 0.25 and impostor.band == "clarify"       # precise change, fake sender
    signals = {s.signal for s in impostor.trust_signals}
    assert {"lookalike_domain", "reply_to_mismatch", "secrecy"} <= signals
    assert impostor.known_contact == "rohan.mehta@technova.io"


def test_benign_vendor_mail_is_not_flagged_as_sensitive():
    s = {x.signal for x in trust.sender_trust(msg("e-01"))[1]}   # "Wi-Fi credentials" in the subject
    assert "sensitive_request" not in s and "lookalike_domain" not in s


def test_thresholds_can_be_tightened_at_runtime():
    trust.set_thresholds(0.95, 0.5)
    assert trust.assess(msg("e-19")).band == "supervised"
    r = run_scenario("e-19")
    assert r.resolved.band == "supervised" and r.state == "DONE"


# --- verification queue ----------------------------------------------------------------------
def test_impostor_is_held_and_writes_nothing():
    r = run_scenario("e-25")
    assert r.state == "AWAIT_CLARIFICATION"
    assert r.resolved.trust < 0.25 and r.resolved.certainty >= 0.5
    it = item_for(r)
    assert it["recommended"] == "ask_sender"
    assert it["outreach"]["to"] == "rohan.mehta@technova.io"          # the contact on file, not the reply-to
    assert db.query_one("SELECT COUNT(*) n FROM idempotency")["n"] == 0


def test_contact_on_file_denies_it():
    async def ask(run):
        await verifications.decide(item_for(run)["id"], "ask_sender")

    async def deny(run):
        await _until(lambda: item_for(run)["status"] == "awaiting_reply")
        verifications.sender_reply(item_for(run)["id"], genuine=False)

    r = asyncio.run(_drive("e-25", [ask, deny]))
    assert r.state == "DONE" and "impersonation" in r.outcome
    mail = db.query_one("SELECT * FROM outbox WHERE external=1")
    assert mail["recipient"] == "rohan.mehta@technova.io"
    ap = db.query_one("SELECT status FROM approvals_queue WHERE id=?", (mail["approval_id"],))
    assert ap["status"] == "approved"                                   # V8 still holds for the outreach
    tn = db.query_one("SELECT committed_amount FROM sponsors WHERE id='s-technova'")
    assert tn["committed_amount"] == 500000
    assert trust.reputation("rohan.mehta@technova-io.com")["rejected"] == 1
    reply = db.query_one("SELECT * FROM messages WHERE in_reply_to='e-25'")
    assert reply and reply["sender"] == "rohan.mehta@technova.io"


def test_contact_on_file_confirms_then_the_run_completes():
    async def ask(run):
        await verifications.decide(item_for(run)["id"], "ask_sender")

    async def confirm(run):
        await _until(lambda: item_for(run)["status"] == "awaiting_reply")
        verifications.sender_reply(item_for(run)["id"], genuine=True)

    r = asyncio.run(_drive("e-25", [ask, confirm]))
    assert r.state == "DONE", (r.outcome, r.error)
    assert r.resolved.human_confirmed and r.verification.ok
    reply = db.query_one("SELECT id FROM messages WHERE in_reply_to='e-25'")["id"]
    assert reply in r.resolved.evidence_refs
    assert item_for(r)["status"] == "confirmed"


def test_human_corrects_the_amount_and_the_sender_earns_trust():
    before = trust.sender_trust(msg("e-21"))[0]

    async def correct(run):
        await verifications.decide(item_for(run)["id"], "correct", amount=325000)

    r = asyncio.run(_drive("e-21", [correct]))
    assert r.state == "DONE" and r.resolved.new_amount == 325000
    assert item_for(r)["status"] == "corrected"
    assert trust.sender_trust(msg("e-21"))[0] > before                 # track record feeds the next score
    cal = trust.calibration()
    assert cal["n"] == 1


def test_reject_dismisses_without_writes():
    async def reject(run):
        await verifications.decide(item_for(run)["id"], "reject", reason="not from TechNova")

    r = asyncio.run(_drive("e-25", [reject]))
    assert r.state == "DONE" and "not genuine" in r.outcome
    assert db.query_one("SELECT COUNT(*) n FROM idempotency")["n"] == 0


# --- negotiation ------------------------------------------------------------------------------
def test_no_counter_offer_at_the_top_tier():
    assert negotiation.analyze("s-technova")["eligible"] is False


def test_counter_offer_after_the_cut():
    r = run_scenario("e-19")
    assert r.state == "DONE"
    a = negotiation.analyze("s-technova")
    assert a["eligible"] and a["dropped"] and a["topup"] == 100000
    offers = {o["id"]: o for o in a["offers"]}
    assert offers["restore"]["total"] == 400000 and offers["restore"]["tier"] == "Gold"
    assert offers["addon"]["add"] == 75000 and "keynote" in offers["addon"]["gets"][0]
    assert a["budget_effect"]["restore_covers"] == 100000
    assert "₹1,00,000" in a["draft"]["body"] and a["draft"]["to"] == "rohan.mehta@technova.io"


def test_sending_and_accepting_the_counter_offer_restores_gold():
    run_scenario("e-19")

    async def flow():
        n = await negotiation.send("s-technova")
        assert n["status"] == "sent"
        try:
            await negotiation.send("s-technova")
            raise AssertionError("second send should be refused")
        except ValueError:
            pass
        n, reply = negotiation.sponsor_reply(n["id"], "restore")
        r = coordinator.create_run(reply["id"], 0)
        task = asyncio.create_task(coordinator.drive(r))
        while not task.done():
            await asyncio.sleep(0.05)
            for ap in db.query("SELECT id FROM approvals_queue WHERE status='pending' AND run_id=?", (r.id,)):
                approvals.decide(ap["id"], "approve")
        return await task

    r = asyncio.run(flow())
    assert r.state == "DONE", (r.outcome, r.error, r.verification)
    tn = db.query_one("SELECT committed_amount, tier FROM sponsors WHERE id='s-technova'")
    assert (tn["committed_amount"], tn["tier"]) == (400000, "Gold")
    assert db.query_one("SELECT status FROM deliverables WHERE id='d-keynote'")["status"] == "active"


# --- radar ------------------------------------------------------------------------------------
def ids(scan):
    return {i["id"]: i for i in scan["items"]}


def test_radar_before_any_email():
    items = ids(radar.scan())
    assert items["unpaid:s-codekart"]["severity"] == "high"
    assert items["unsettled:s-technova"]["severity"] == "high"
    assert "e-25" in items["unsettled:s-technova"]["evidence"]
    assert items["payment:s-technova"]["days_left"] == 11
    assert "approval:oa-prizes" in items


def test_radar_after_the_cut_sees_the_poster_and_the_tier_boundary():
    run_scenario("e-19")
    items = ids(radar.scan())
    assert items["promo:p-poster:s-technova"]["severity"] == "high"
    assert items["tier:s-technova"]["actions"][0]["kind"] == "negotiate"
    assert "₹2,00,000 still outstanding" in items["payment:s-technova"]["title"]


def test_radar_action_sends_once_and_marks_the_item_handled():
    async def go():
        await radar.act("unpaid:s-codekart")
        await radar.act("unpaid:s-codekart")             # double click: idempotent
    asyncio.run(go())
    assert db.query_one("SELECT COUNT(*) n FROM outbox WHERE change_id='radar:unpaid:s-codekart'")["n"] == 1
    assert ids(radar.scan())["unpaid:s-codekart"]["handled"]["what"] == "Email sent"


def test_radar_catches_entitlement_drift():
    run_scenario("e-19")
    db.execute("UPDATE deliverables SET status='active' WHERE id='d-keynote'")
    assert ids(radar.scan())["entitlement:d-keynote"]["severity"] in ("high", "medium")

"""Risk radar: spot trouble before any email arrives.

Plain rules over the live workspace and the scenario clock (config.SCENARIO_NOW). No model call:
each item says which rows it read, how many days are left, and what a person can do about it.

  payment_due        a payment date is coming and money is still outstanding
  unpaid             a sponsor has paid nothing and has no payment date, but their logo is printing
  unsettled          unread or unverified messages change a sponsor's amount before a print deadline
  entitlement        a deliverable no longer matches the sponsor's tier (drift, outside edits)
  stale_promo        a published asset names a sponsor at the wrong tier
  approval_pending   a sign-off is still pending, or its amount no longer matches the budget line
  budget             the budget is short with no plan, cuts are waiting for the treasurer, or a gap is open
  tier_boundary      a sponsor just dropped a tier and is close enough to win back (counter-offer)
"""
from __future__ import annotations

import re
from datetime import date, datetime

from . import config, db, negotiation, outreach, trust
from .agents.communication import triage
from .knowledge.resolve import resolve, sponsor_mentions

SEV = {"high": 0, "medium": 1, "low": 2}
inr = negotiation.inr


def _today() -> date:
    return datetime.fromisoformat(config.SCENARIO_NOW).date()


def _days(d: str) -> int:
    return (date.fromisoformat(d[:10]) - _today()).days


def _fmt(d: str) -> str:
    x = date.fromisoformat(d[:10])
    return f"{x:%b} {x.day}"


def _in(days: int) -> str:
    return "today" if days == 0 else "tomorrow" if days == 1 else f"in {days} days" if days > 0 else f"{-days} days ago"


def _sev(days: int | None, base: str = "medium") -> str:
    if days is not None and days <= config.RADAR_URGENT_DAYS:
        return "high"
    return base


def _first(contact: str | None) -> str:
    row = db.query_one("SELECT sender_name FROM messages WHERE lower(sender)=? AND sender_name IS NOT NULL",
                       ((contact or "").lower(),))
    return row["sender_name"].split()[0] if row else "there"


def _sign() -> str:
    me = db.query_one("SELECT name, role FROM people WHERE id='p-sponsorship'")
    return f"{me['name']}\n{me['role']}, Innovision 2026" if me else "Innovision 2026 team"


def scan() -> dict:
    items: list[dict] = []
    sponsors = {s["id"]: s for s in db.query("SELECT * FROM sponsors WHERE status='active'")}
    events = db.query("SELECT * FROM calendar_events WHERE status='active' ORDER BY date")
    dels = db.query("SELECT * FROM deliverables ORDER BY deadline")
    people = {p["id"]: p for p in db.query("SELECT * FROM people")}
    horizon = config.RADAR_HORIZON_DAYS

    def add(**it) -> None:
        it.setdefault("actions", [])
        it.setdefault("evidence", [])
        items.append(it)

    # payment_due -----------------------------------------------------------------------------
    paid_events = set()
    for ev in events:
        sp = sponsors.get(ev["linked_entity"])
        if not sp or "payment" not in ev["title"].lower():
            continue
        paid_events.add(sp["id"])
        out = sp["committed_amount"] - sp["received_amount"]
        d = _days(ev["date"])
        if out <= 0 or d > horizon:
            continue
        name = sp["name"].split()[0]
        add(id=f"payment:{sp['id']}", rule="payment_due", severity=_sev(d, "high" if sp["received_amount"] == 0 else "medium"),
            title=f"{name} payment due {_fmt(ev['date'])}: {inr(out)} still outstanding",
            detail=f"{inr(sp['received_amount'])} of {inr(sp['committed_amount'])} received so far; due {_in(d)}.",
            due=ev["date"], days_left=d, entities=[sp["id"], ev["id"]],
            actions=[{"kind": "email", "label": "Send a payment reminder", "draft": {
                "to": sp["contact"], "cc": ["treasurer@innovision.in"],
                "subject": f"Innovision 2026: payment schedule for {name}",
                "body": f"Hi {_first(sp['contact'])},\n\nA quick reminder that {name}'s sponsorship payment is due on "
                        f"{_fmt(ev['date'])}. We have received {inr(sp['received_amount'])} of "
                        f"{inr(sp['committed_amount'])} so far, so {inr(out)} is outstanding.\n\nCould you share the "
                        f"expected transfer date?\n\nThanks,\n{_sign()}"}}])

    # unpaid --------------------------------------------------------------------------------------
    for sp in sponsors.values():
        if sp["id"] in paid_events or sp["received_amount"] > 0 or sp["committed_amount"] <= 0:
            continue
        soon = next((x for x in dels if x["sponsor_id"] == sp["id"] and x["status"] == "active"), None)
        d = _days(soon["deadline"]) if soon else None
        name = sp["name"].split()[0]
        add(id=f"unpaid:{sp['id']}", rule="unpaid", severity=_sev(d),
            title=f"{name} has paid nothing and has no payment date",
            detail=f"₹0 of {inr(sp['committed_amount'])} received."
                   + (f" Their {negotiation.benefit_label(soon['kind'], soon['spec']).removeprefix('the ')} is due "
                      f"{_fmt(soon['deadline'])} ({_in(d)})." if soon else ""),
            due=soon["deadline"] if soon else None, days_left=d, entities=[sp["id"]] + ([soon["id"]] if soon else []),
            actions=[{"kind": "email", "label": "Ask for a payment date", "draft": {
                "to": sp["contact"], "cc": ["treasurer@innovision.in"],
                "subject": f"Innovision 2026: {name} sponsorship payment",
                "body": f"Hi {_first(sp['contact'])},\n\nThank you again for sponsoring Innovision 2026 at "
                        f"{inr(sp['committed_amount'])}. We have not yet received a payment or a payment date. Could "
                        f"you let us know when to expect the transfer?\n\nThanks,\n{_sign()}"}}])

    # unsettled -----------------------------------------------------------------------------------
    open_ver = db.query("SELECT * FROM verifications WHERE status IN ('pending','awaiting_reply')")
    unread: dict[str, list[dict]] = {}
    for m in db.query("SELECT * FROM messages WHERE processed=0 ORDER BY received_at"):
        if m["id"] in {v["message_id"] for v in open_ver}:
            continue
        if db.query_one("SELECT 1 FROM runs WHERE message_id=?", (m["id"],)):
            continue
        if triage(m).label != "relevant":
            continue
        mentions = sponsor_mentions(m["body"])
        sid, _, _ = resolve(mentions[0][0] if mentions else "", m["sender"])
        if sid in sponsors:
            unread.setdefault(sid, []).append(m)
    for v in open_ver:
        if v["sponsor_id"] in sponsors:
            unread.setdefault(v["sponsor_id"], [])
    for sid, msgs in unread.items():
        sp = sponsors[sid]
        vers = [v for v in open_ver if v["sponsor_id"] == sid]
        soon = next((x for x in dels if x["sponsor_id"] == sid and x["status"] == "active"
                     and _days(x["deadline"]) <= horizon), None)
        d = _days(soon["deadline"]) if soon else None
        name = sp["name"].split()[0]
        parts = []
        for m in msgs[:4]:
            amt = re.search(r"(₹\s?[\d,]+|\d+(\.\d+)?\s?(L|lakh)\b)", m["body"], re.I)
            low = trust.sender_trust(m)[0] < config.TRUST_LOW
            parts.append(f"{m['id']} ({amt.group(0) if amt else 'no amount'}"
                         + (", sender not verified" if low else "") + ") not processed yet")
        parts += [f"{v['message_id']} {'waiting for the contact to reply' if v['status'] == 'awaiting_reply' else 'waiting for verification'}"
                  for v in vers]
        add(id=f"unsettled:{sid}", rule="unsettled", severity=_sev(d, "medium"),
            title=f"{name}'s commitment is not settled"
                  + (f" and {negotiation.benefit_label(soon['kind'], soon['spec'])} is due {_fmt(soon['deadline'])}"
                     if soon else ""),
            detail=f"Tracker says {inr(sp['committed_amount'])} ({sp['tier']}), but: " + "; ".join(parts) + ".",
            due=soon["deadline"] if soon else None, days_left=d, entities=[sid] + ([soon["id"]] if soon else []),
            evidence=[m["id"] for m in msgs] + [v["message_id"] for v in vers],
            actions=[{"kind": "run", "label": f"Process {m['id']} now", "message_id": m["id"]} for m in msgs[:3]]
                    + [{"kind": "verify", "label": "Open the verification", "verification_id": v["id"]} for v in vers])

    # entitlement drift -------------------------------------------------------------------------
    for x in dels:
        sp = sponsors.get(x["sponsor_id"])
        if not sp:
            continue
        want = config.ENTITLEMENTS[sp["tier"]].get(x["kind"])
        ok = (want is None and x["status"] == "removed") or (want is not None and (x["status"], x["spec"]) == ("active", want))
        if ok:
            continue
        d = _days(x["deadline"])
        name = sp["name"].split()[0]
        add(id=f"entitlement:{x['id']}", rule="entitlement", severity=_sev(d),
            title=f"{name}'s {x['kind'].replace('_', ' ')} does not match its {sp['tier']} tier",
            detail=f"It is {x['status']} ({x['spec']}); {sp['tier']} gets {want or 'no ' + x['kind'].replace('_', ' ')}. "
                   f"Due {_fmt(x['deadline'])}, owner {people.get(x['owner'], {}).get('name', x['owner'])}.",
            due=x["deadline"], days_left=d, entities=[x["id"], sp["id"]])

    # stale promo ---------------------------------------------------------------------------------
    for p in db.query("SELECT * FROM promo_assets WHERE published=1"):
        for seg in p["text"].split("|"):
            m = re.search(r"(Gold|Silver|Bronze)\s+Partners?:\s*(.+)", seg.strip(), re.I)
            if not m:
                continue
            printed = m.group(1).capitalize()
            for nm in m.group(2).split(","):
                hit = sponsor_mentions(nm.strip())
                sp = sponsors.get(hit[0][1]) if hit else None
                if not sp or sp["tier"] == printed:
                    continue
                name = sp["name"].split()[0]
                flagged = any(name.lower() in str(f).lower() or sp["id"] in str(f) for f in (p["flags"] or []))
                add(id=f"promo:{p['id']}:{sp['id']}", rule="stale_promo", severity="high",
                    title=f"The published {p['kind']} still calls {name} a {printed} partner",
                    detail=f"{name} is {sp['tier']} now. "
                           + ("A correction is flagged but it has not been reprinted." if flagged
                              else "No correction has been flagged."),
                    due=None, days_left=None, entities=[p["id"], sp["id"]],
                    actions=[{"kind": "chat", "label": "Ask design to fix it", "draft": {
                        "channel": "#core-team",
                        "body": f"@Ananya the published {p['kind']} still lists {name} as a {printed} partner; they are "
                                f"{sp['tier']} now. Can we fix and reprint before it goes further?"}}])

    # approvals -----------------------------------------------------------------------------------
    lines = {b["id"]: b for b in db.query("SELECT * FROM budget_lines")}
    for oa in db.query("SELECT * FROM org_approvals WHERE status='pending'"):
        d = _days(config.FEST_DATE)
        who = people.get(oa["approver"], {}).get("name", oa["approver"])
        line = lines.get(oa["linked_line"])
        stale = line and line["amount"] != oa["amount"]
        add(id=f"approval:{oa['id']}", rule="approval_pending", severity="high" if stale else _sev(d),
            title=f"{oa['subject']} is still waiting for {who}",
            detail=(f"The budget line is now {inr(line['amount'])}, but the request says {inr(oa['amount'])}. "
                    if stale else "") + f"The fest is on {_fmt(config.FEST_DATE)} ({_in(d)}).",
            due=config.FEST_DATE, days_left=d, entities=[oa["id"]] + ([line["id"]] if line else []),
            actions=[{"kind": "email", "label": f"Remind {who}", "draft": {
                "to": people.get(oa["approver"], {}).get("email", oa["approver"]), "cc": [],
                "subject": f"Approval needed: {oa['subject']}",
                "body": f"Dear {who},\n\nThe sign-off for {oa['subject']} is still pending. "
                        + (f"Note the amount is now {inr(line['amount'])}. " if stale else "")
                        + f"Could you review it before {_fmt(config.FEST_DATE)}?\n\nThank you,\n{_sign()}"}}])

    # budget --------------------------------------------------------------------------------------
    b = db.budget_summary()
    uncovered = max(0, b["shortfall"])
    if uncovered > b["recorded_gap"] + b["pending_reductions"]:
        add(id="budget:unplanned", rule="budget", severity="high",
            title=f"The budget is {inr(uncovered - b['recorded_gap'] - b['pending_reductions'])} short with no plan",
            detail=f"Expenses {inr(b['expense'])}, income {inr(b['income'])}. No recorded gap or pending cuts cover it.",
            due=None, days_left=None, entities=["budget"])
    if b["pending_reductions"] > 0:
        add(id="budget:pending", rule="budget", severity="medium",
            title=f"{inr(b['pending_reductions'])} of budget cuts are waiting for the treasurer",
            detail="The budget tool was unavailable, so these were flagged for a manual update.",
            due=None, days_left=None, entities=[p["line_id"] for p in db.query("SELECT line_id FROM pending_updates WHERE status='pending'")],
            actions=[{"kind": "chat", "label": "Nudge the treasurer", "draft": {
                "channel": "#core-team",
                "body": f"@Meera {inr(b['pending_reductions'])} of budget cuts are still pending in the tracker. Can you "
                        f"apply them in the budget sheet today?"}}])
    if b["recorded_gap"] > 0:
        add(id="budget:gap", rule="budget", severity="medium",
            title=f"A {inr(b['recorded_gap'])} funding gap is still open",
            detail="Recorded when the shortfall could not be fully covered. A new sponsor or a counter-offer can close it.",
            due=None, days_left=None, entities=[g["sponsor_id"] for g in db.query("SELECT sponsor_id FROM gaps")])

    # tier boundary -------------------------------------------------------------------------------
    for sid, sp in sponsors.items():
        a = negotiation.analyze(sid)
        if not a or not a.get("eligible") or not a.get("dropped"):
            continue
        n = negotiation.latest(sid)
        sent = n and n["status"] == "sent"
        add(id=f"tier:{sid}", rule="tier_boundary", severity="medium",
            title=a["headline"],
            detail=(f"Counter-offer sent; waiting for {a['sponsor']}'s reply." if sent else
                    f"Dropped from {a['previous_tier']} to {a['tier']}. "
                    + ("; ".join(f"{o['title']} for {inr(o['add'])} more" for o in a["offers"] if o["add"]) + ".")),
            due=a.get("reply_by"), days_left=_days(a["reply_by"]) if a.get("reply_by") else None, entities=[sid],
            actions=[] if sent else [{"kind": "negotiate", "label": "Draft a counter-offer", "sponsor_id": sid}],
            handled={"what": "Counter-offer sent", "at": n["created_at"]} if sent else None)

    # what has already been done about each item ----------------------------------------------------
    for it in items:
        if it.get("handled"):
            continue
        row = db.query_one("SELECT * FROM outbox WHERE change_id=? ORDER BY id DESC LIMIT 1", (f"radar:{it['id']}",))
        it["handled"] = ({"what": "Email sent" if row["channel"] == "email" else "Chat posted", "at": row["created_at"],
                          "outbox_id": row["id"]} if row else None)

    items.sort(key=lambda i: (bool(i["handled"]), SEV[i["severity"]],
                              i["days_left"] if i["days_left"] is not None else 99))
    counts = {s: sum(1 for i in items if i["severity"] == s and not i["handled"]) for s in SEV}
    return {"now": config.SCENARIO_NOW, "horizon_days": horizon, "items": items, "counts": counts}


async def act(item_id: str, index: int = 0, body: str | None = None, by: str = "demo-user") -> dict:
    item = next((i for i in scan()["items"] if i["id"] == item_id), None)
    if item is None:
        raise KeyError(item_id)
    if index >= len(item["actions"]):
        raise ValueError("no such action")
    a = item["actions"][index]
    if a["kind"] not in ("email", "chat"):
        raise ValueError(f"action '{a['kind']}' is done from the console, not here")
    d = a["draft"]
    return await outreach.send_approved(
        run_id=None, change_id=f"radar:{item_id}", key=f"radar.{item['rule']}", rationale=item["title"],
        evidence=item["evidence"], to=d.get("to"), cc=d.get("cc"), subject=d.get("subject", ""),
        body=body or d["body"], channel="email" if a["kind"] == "email" else d["channel"], by=by)

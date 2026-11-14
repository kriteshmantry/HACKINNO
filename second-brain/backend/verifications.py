"""The "Needs verification" queue.

A run whose gate score (min of trust and certainty) is too low stops in AWAIT_CLARIFICATION and
opens one item here. A person can:
  confirm     the change is genuine and read correctly
  correct     the change is genuine but the amount is different
  reject      not genuine (or not a real change): nothing is written
  ask_sender  email the contact ON FILE (never the reply-to of the message itself) to confirm,
              the call-back rule banks use against payment fraud. The run keeps waiting.
Every verdict updates the sender's track record, which feeds the next trust score.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime

from . import approvals, config, db, outreach, trust
from .events import emit

OPEN = ("pending", "awaiting_reply")


def _name(run_id: str) -> str:
    return f"clarify:{run_id}"


def get(ver_id: str) -> dict | None:
    return db.query_one("SELECT * FROM verifications WHERE id=?", (ver_id,))


def list_items(status: str | None = None, run_id: str | None = None) -> list[dict]:
    sql, params = "SELECT * FROM verifications WHERE 1=1", []
    if status == "open":
        sql += " AND status IN ('pending','awaiting_reply')"
    elif status:
        sql, params = sql + " AND status=?", params + [status]
    if run_id:
        sql, params = sql + " AND run_id=?", params + [run_id]
    return db.query(sql + " ORDER BY created_at DESC", tuple(params))


def draft_outreach(contact: str | None, sponsor_name: str, claimed: int | None, msg: dict, low_trust: bool) -> dict | None:
    if not contact:
        return None
    first = (db.query_one("SELECT sender_name FROM messages WHERE lower(sender)=? AND sender_name IS NOT NULL",
                          (contact.lower(),)) or {}).get("sender_name") or ""
    first = first.split()[0] if first else "there"
    me = db.query_one("SELECT name, role FROM people WHERE id='p-sponsorship'")
    sign = f"{me['name']}\n{me['role']}, Innovision 2026" if me else "Innovision 2026 team"
    amt = f"₹{claimed:,}" if claimed else "a new amount"
    when = msg["received_at"][:16].replace("T", " ")
    if low_trust:
        body = (f"Hi {first},\n\nWe received a message on {when} from {msg['sender']} saying that "
                f"{sponsor_name}'s commitment to Innovision 2026 is now {amt}. Before we change anything, could "
                f"you confirm whether this came from your team?\n\nWe are writing to the address we have on file "
                f"rather than replying to that message.\n\nThanks,\n{sign}")
        subject = f"Please confirm: {sponsor_name} sponsorship update"
    else:
        body = (f"Hi {first},\n\nThanks for the update. Could you confirm the final committed amount for "
                f"Innovision 2026 ({amt} in your note), and whether board approval is still pending?\n\n"
                f"Thanks,\n{sign}")
        subject = f"Confirming {sponsor_name}'s sponsorship for Innovision 2026"
    return {"to": contact, "cc": [], "subject": subject, "body": body}


def open_item(*, run_id: str, msg: dict, sponsor_id: str | None, sponsor_name: str | None, claimed: dict,
              question: str, reasons: list[str], trust_score: float | None, certainty: float | None,
              overall: float | None, report: dict, contact: str | None) -> dict:
    existing = db.query_one("SELECT * FROM verifications WHERE run_id=? AND status IN ('pending','awaiting_reply')",
                            (run_id,))
    if existing:
        return existing
    low_trust = trust_score is not None and trust_score < config.TRUST_LOW
    draft = draft_outreach(contact, sponsor_name or "the sponsor", claimed.get("new_amount"), msg, low_trust)
    recommended = "ask_sender" if (low_trust and draft) else "confirm_or_correct"
    vid = f"v-{uuid.uuid4().hex[:6]}"
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO verifications (id, run_id, message_id, sender, sponsor_id, status, trust, certainty, overall, "
            "report, claimed, question, recommended, outreach, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (vid, run_id, msg["id"], msg["sender"].lower(), sponsor_id, "pending", trust_score, certainty, overall,
             json.dumps({**report, "reasons": reasons}, default=str), json.dumps(claimed), question, recommended,
             json.dumps(draft) if draft else None, datetime.now().isoformat()))
    return get(vid)


def _close(row: dict, status: str, verdict: str, args: dict | None, by: str, reply_id: str | None = None) -> None:
    db.execute("UPDATE verifications SET status=?, verdict=?, verdict_args=?, decided_by=?, decided_at=?, "
               "reply_message_id=COALESCE(?, reply_message_id) WHERE id=?",
               (status, verdict, json.dumps(args or {}), by, datetime.now().isoformat(), reply_id, row["id"]))
    trust.record_verdict(row["sender"], {"confirmed": "confirmed", "corrected": "corrected"}.get(status, "rejected"))


async def decide(ver_id: str, verdict: str, *, amount: int | None = None, reason: str | None = None,
                 body: str | None = None, by: str = "demo-user") -> dict:
    row = get(ver_id)
    if row is None:
        raise KeyError(ver_id)
    if row["status"] not in OPEN:
        raise ValueError(f"verification {ver_id} is already {row['status']}")
    claimed = row["claimed"] or {}
    if verdict == "ask_sender":
        draft = row["outreach"]
        if not draft:
            raise ValueError("there is no contact on file to ask")
        if row["status"] == "awaiting_reply":
            raise ValueError("already asked; waiting for the reply")
        sent = await outreach.send_approved(
            run_id=row["run_id"], change_id=f"{row['message_id']}#verify", key="verify.ask_sender",
            to=draft["to"], cc=draft.get("cc", []), subject=draft["subject"], body=body or draft["body"],
            rationale="Verify the change with the contact on file before acting on it", evidence=[row["message_id"]],
            by=by)
        draft = {**draft, "body": body or draft["body"], "sent_at": datetime.now().isoformat(),
                 "outbox_id": sent["outbox"]["id"] if sent["outbox"] else None, "approval_id": sent["approval_id"]}
        db.execute("UPDATE verifications SET status='awaiting_reply', outreach=? WHERE id=?", (json.dumps(draft), ver_id))
        emit(row["run_id"], "Communication", "verification.outreach",
             f"Asked {draft['to']} (contact on file) to confirm; the run keeps waiting", {"verification_id": ver_id,
                                                                                      "to": draft["to"]}, [row["message_id"]])
        approvals.send_signal(_name(row["run_id"]), {"decision": "ask_sender", "verification_id": ver_id})
        return get(ver_id)

    if verdict not in ("confirm", "correct", "reject"):
        raise ValueError("verdict must be confirm | correct | reject | ask_sender")
    if not approvals.is_waiting(_name(row["run_id"])):
        raise ValueError("the run is no longer waiting for this verification")
    if verdict == "reject":
        _close(row, "rejected", "reject", {"reason": reason}, by)
        approvals.send_signal(_name(row["run_id"]), {
            "decision": "dismiss", "verification_id": ver_id,
            "outcome": "dismissed: a person marked the message as not genuine; nothing was changed"})
    else:
        amount = amount or claimed.get("new_amount")
        if not amount:
            raise ValueError("an amount is needed to confirm")
        status = "corrected" if (verdict == "correct" or amount != claimed.get("new_amount")) else "confirmed"
        _close(row, status, verdict, {"amount": amount, "reason": reason}, by)
        approvals.send_signal(_name(row["run_id"]), {
            "decision": "confirm", "amount": amount, "verification_id": ver_id,
            "how": "corrected by a person" if status == "corrected" else "confirmed by a person"})
    return get(ver_id)


def sender_reply(ver_id: str, genuine: bool, amount: int | None = None) -> dict:
    """Demo: the contact on file answers the verification email."""
    row = get(ver_id)
    if row is None:
        raise KeyError(ver_id)
    if row["status"] != "awaiting_reply":
        raise ValueError("no verification email has been sent for this item")
    draft, claimed = row["outreach"], row["claimed"] or {}
    sp = db.query_one("SELECT * FROM sponsors WHERE id=?", (row["sponsor_id"],))
    name = (db.query_one("SELECT sender_name FROM messages WHERE lower(sender)=? AND sender_name IS NOT NULL",
                         (draft["to"].lower(),)) or {}).get("sender_name") or draft["to"]
    first = name.split()[0]
    amount = amount or claimed.get("new_amount")
    if genuine:
        body = (f"Hi Priya, yes, that was us. {sp['name'].split()[0]}'s revised commitment is ₹{amount:,}. "
                f"Regards, {first}")
    else:
        body = (f"Hi Priya, we did not send that message. {sp['name'].split()[0]}'s commitment is unchanged at "
                f"₹{sp['committed_amount']:,}. Please ignore it and do not reply to that address. Regards, {first}")
    if not approvals.is_waiting(_name(row["run_id"])):
        raise ValueError("the run is no longer waiting for this verification")
    reply = outreach.inject_message(sender=draft["to"], sender_name=name, subject=f"Re: {draft['subject']}", body=body,
                                    in_reply_to=row["message_id"])
    if genuine:
        _close(row, "confirmed" if amount == claimed.get("new_amount") else "corrected", "confirmed_by_contact",
               {"amount": amount}, f"{draft['to']} (contact on file)", reply["id"])
        approvals.send_signal(_name(row["run_id"]), {
            "decision": "confirm", "amount": amount, "verification_id": ver_id, "evidence": [reply["id"]],
            "how": f"confirmed by {draft['to']}, the contact on file ({reply['id']})"})
    else:
        _close(row, "rejected", "denied_by_contact", {}, f"{draft['to']} (contact on file)", reply["id"])
        approvals.send_signal(_name(row["run_id"]), {
            "decision": "dismiss", "verification_id": ver_id, "evidence": [reply["id"]],
            "outcome": f"dismissed: {draft['to']} (contact on file) says they never sent it, likely impersonation; "
                       f"nothing was changed"})
    return get(ver_id)


def settle(ver_id: str | None, sig: dict | None) -> None:
    """Close an item the run moved past without a queue verdict (legacy /clarify, timeout)."""
    row = get(ver_id) if ver_id else None
    if row is None or row["status"] not in OPEN:
        return
    if sig is None:
        db.execute("UPDATE verifications SET status='expired', decided_at=? WHERE id=?",
                   (datetime.now().isoformat(), ver_id))
    elif sig.get("decision") == "confirm":
        claimed = row["claimed"] or {}
        _close(row, "confirmed" if sig.get("amount") in (None, claimed.get("new_amount")) else "corrected",
               "confirm", {"amount": sig.get("amount")}, "demo-user")
    else:
        _close(row, "rejected", "dismiss", {}, "demo-user")

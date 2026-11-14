"""Messages a person sends with one click: asking the real contact to confirm, a counter-offer,
a payment reminder.

The click is the approval. It is recorded in approvals_queue like any other approval, so the
"every external message was approved" invariant (V8) still holds, and the send goes through the
normal tool layer (idempotent, so a double click cannot send twice).
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta

from . import config, db
from .events import RunCtx, emit
from .tools import invoke


async def send_approved(*, run_id: str | None, change_id: str, key: str, rationale: str, evidence: list[str],
                        to: str | None = None, cc: list[str] | None = None, subject: str = "", body: str,
                        channel: str = "email", by: str = "demo-user") -> dict:
    ap_id = f"ap-{uuid.uuid4().hex[:6]}"
    if channel == "email":
        tool, args = "comms.email", {"to": to, "cc": cc or [], "subject": subject, "body": body}
        preview = [{"label": f"Email to {to}", "from": None, "to": subject, "body": body}]
    else:
        tool, args = "comms.chat", {"channel": channel, "body": body}
        preview = [{"label": f"Post in {channel}", "from": None, "to": body}]
    now = datetime.now().isoformat()
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO approvals_queue (id, run_id, action_id, action_key, tool, status, original_args, final_args, "
            "preview, risk_score, risk_reasons, rationale, evidence_refs, reason, decided_by, created_at, decided_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (ap_id, run_id, f"outreach:{key}", key, tool, "approved", json.dumps(args), json.dumps(args),
             json.dumps(preview), 6 if channel == "email" else 0,
             json.dumps(["+3 external", "+3 irreversible"] if channel == "email" else []), rationale,
             json.dumps(evidence), "sent by a person from the console", by, now, now))
    meta: dict = {}
    result = await invoke(tool, {**args, "approval_id": ap_id}, RunCtx(run_id, change_id, "Communication"), meta=meta)
    row = db.query_one("SELECT * FROM outbox WHERE approval_id=?", (ap_id,))
    emit(run_id, "Communication", "outreach.sent",
         f"{'Already sent' if meta.get('duplicate') else 'Sent'}: {subject or body[:60]} → {to or channel}",
         {"key": key, "approval_id": ap_id, "tool": tool, "to": to or channel, "duplicate": bool(meta.get("duplicate")),
          "outbox_id": row["id"] if row else None}, evidence)
    return {"approval_id": ap_id, "duplicate": bool(meta.get("duplicate")), "result": result, "outbox": row}


def inject_message(*, sender: str, sender_name: str, subject: str, body: str, channel: str = "email",
                   in_reply_to: str | None = None, reply_to: str | None = None) -> dict:
    """Add an incoming message to the inbox (used by the demo to simulate a reply)."""
    ids = [m["id"] for m in db.query("SELECT id FROM messages WHERE id LIKE 'e-%'")]
    n = max((int(i.split("-")[1]) for i in ids if i.split("-")[1].isdigit()), default=0) + 1
    latest = db.query_one("SELECT MAX(received_at) t FROM messages")["t"] or config.SCENARIO_NOW
    at = (max(datetime.fromisoformat(latest), datetime.fromisoformat(config.SCENARIO_NOW))
          + timedelta(minutes=20)).isoformat(timespec="seconds")
    row = {"id": f"e-{n}", "channel": channel, "sender": sender, "sender_name": sender_name, "subject": subject,
           "body": body, "received_at": at, "processed": 0, "in_reply_to": in_reply_to, "reply_to": reply_to}
    with db.tx() as conn:
        conn.execute(f"INSERT INTO messages ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})",
                     tuple(row.values()))
    emit(None, "System", "message.arrived", f"New message {row['id']} from {sender}", {"message": row}, [row["id"]])
    return row

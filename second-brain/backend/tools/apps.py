"""Simulated workspace apps (tracker, budget sheet, calendar, approvals, promo, docs,
memory, email/chat outbox). Every write is declarative ("set to X, expecting Y"), so
it is idempotent and converges under replanning: if the value is already X it is a no-op.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime

from pydantic import BaseModel

from .registry import PermanentToolError, PreconditionFailed, tool


def _one(conn: sqlite3.Connection, sql: str, params: tuple) -> sqlite3.Row:
    row = conn.execute(sql, params).fetchone()
    if row is None:
        raise PermanentToolError(f"not found: {params}")
    return row


def _append_unique(conn, table: str, col: str, row_id: str, item: str) -> dict:
    items = json.loads(_one(conn, f"SELECT {col} FROM {table} WHERE id=?", (row_id,))[0] or "[]")
    if item in items:
        return {"id": row_id, "noop": True}
    items.append(item)
    conn.execute(f"UPDATE {table} SET {col}=? WHERE id=?", (json.dumps(items), row_id))
    return {"id": row_id, "added": item}


# --- sponsor tracker ---------------------------------------------------------------------
class SetCommitted(BaseModel):
    sponsor_id: str
    new: int
    expect: int


@tool("tracker.set_committed", SetCommitted)
def set_committed(conn, sponsor_id, new, expect):
    """Set a sponsor's committed amount."""
    cur = _one(conn, "SELECT committed_amount FROM sponsors WHERE id=?", (sponsor_id,))[0]
    if cur == new:
        return {"sponsor_id": sponsor_id, "noop": True, "value": cur}
    if cur != expect:
        raise PreconditionFailed(f"{sponsor_id}.committed_amount is {cur}, expected {expect}")
    conn.execute("UPDATE sponsors SET committed_amount=?, version=version+1 WHERE id=?", (new, sponsor_id))
    return {"sponsor_id": sponsor_id, "before": cur, "after": new}


class SetTier(BaseModel):
    sponsor_id: str
    new: str
    expect: str


@tool("tracker.set_tier", SetTier)
def set_tier(conn, sponsor_id, new, expect):
    """Set a sponsor's tier."""
    cur = _one(conn, "SELECT tier FROM sponsors WHERE id=?", (sponsor_id,))[0]
    if cur == new:
        return {"sponsor_id": sponsor_id, "noop": True, "value": cur}
    if cur != expect:
        raise PreconditionFailed(f"{sponsor_id}.tier is {cur}, expected {expect}")
    conn.execute("UPDATE sponsors SET tier=?, version=version+1 WHERE id=?", (new, sponsor_id))
    return {"sponsor_id": sponsor_id, "before": cur, "after": new}


class SetGap(BaseModel):
    sponsor_id: str
    amount: int
    note: str
    source_ref: str


@tool("tracker.set_gap", SetGap)
def set_gap(conn, sponsor_id, amount, note, source_ref):
    """Record (or clear) the open funding gap caused by a sponsor change."""
    conn.execute("DELETE FROM gaps WHERE sponsor_id=?", (sponsor_id,))
    if amount > 0:
        conn.execute("INSERT INTO gaps VALUES (?,?,?,?)", (sponsor_id, amount, note, source_ref))
    return {"sponsor_id": sponsor_id, "gap": amount}


class LineChange(BaseModel):
    line_id: str
    new: int
    expect: int


class FlagPending(BaseModel):
    changes: list[LineChange]
    note: str


@tool("tracker.flag_pending_update", FlagPending)
def flag_pending_update(conn, changes, note):
    """Degraded path: record intended budget changes as pending for a human to apply.
    The given changes replace the whole pending set (an empty list withdraws it)."""
    keep = {c["line_id"] for c in changes}
    for (line_id,) in conn.execute("SELECT line_id FROM pending_updates").fetchall():
        if line_id not in keep:
            conn.execute("DELETE FROM pending_updates WHERE line_id=?", (line_id,))
            conn.execute("UPDATE budget_lines SET status='ok' WHERE id=? AND status='pending_update'", (line_id,))
    for c in changes:
        cur = _one(conn, "SELECT amount FROM budget_lines WHERE id=?", (c["line_id"],))[0]
        conn.execute("INSERT OR REPLACE INTO pending_updates VALUES (?,?,?,?,?)",
                     (c["line_id"], c["new"], cur, note, "pending"))
        conn.execute("UPDATE budget_lines SET status='pending_update' WHERE id=?", (c["line_id"],))
    return {"flagged": [c["line_id"] for c in changes]}


# --- budget sheet ------------------------------------------------------------------------
class SetLines(BaseModel):
    changes: list[LineChange]


@tool("budget.set_lines", SetLines)
def set_lines(conn, changes):
    """Set several budget lines atomically (all or nothing)."""
    applied = []
    for c in changes:
        row = _one(conn, "SELECT amount, floor FROM budget_lines WHERE id=?", (c["line_id"],))
        cur, floor = row[0], row[1]
        if cur == c["new"]:
            continue
        if cur != c["expect"]:
            raise PreconditionFailed(f"{c['line_id']} is {cur}, expected {c['expect']}")
        if c["new"] < floor:
            raise PermanentToolError(f"{c['line_id']}: {c['new']} is below floor {floor}")
        conn.execute("UPDATE budget_lines SET amount=?, status='ok' WHERE id=?", (c["new"], c["line_id"]))
        applied.append({"line_id": c["line_id"], "before": cur, "after": c["new"]})
    # the sheet now holds the real numbers: intents left pending by an earlier fallback are superseded
    cleared = [r[0] for r in conn.execute("SELECT line_id FROM pending_updates").fetchall()]
    conn.execute("DELETE FROM pending_updates")
    conn.execute("UPDATE budget_lines SET status='ok' WHERE status='pending_update'")
    return {"applied": applied, "cleared_pending": cleared, "noop": not applied and not cleared}


# --- organisational approvals ------------------------------------------------------------
class UpdateApproval(BaseModel):
    org_approval_id: str
    amount: int
    status: str
    note: str
    expect_amount: int


@tool("approvals.update", UpdateApproval, touches_public=True)
def update_approval(conn, org_approval_id, amount, status, note, expect_amount):
    """Amend a pending organisational approval (amount/status) and annotate it."""
    cur = _one(conn, "SELECT amount, status FROM org_approvals WHERE id=?", (org_approval_id,))
    if cur[0] != amount and cur[0] != expect_amount:
        raise PreconditionFailed(f"{org_approval_id}.amount is {cur[0]}, expected {expect_amount}")
    conn.execute("UPDATE org_approvals SET amount=?, status=? WHERE id=?", (amount, status, org_approval_id))
    _append_unique(conn, "org_approvals", "notes", org_approval_id, note)
    return {"org_approval_id": org_approval_id, "before": {"amount": cur[0], "status": cur[1]},
            "after": {"amount": amount, "status": status}}


# --- deliverables ------------------------------------------------------------------------
class SetDeliverable(BaseModel):
    deliverable_id: str
    spec: str | None
    status: str
    expect_spec: str | None
    expect_status: str


@tool("deliverables.set", SetDeliverable)
def set_deliverable(conn, deliverable_id, spec, status, expect_spec, expect_status):
    """Change a sponsor deliverable's spec or status (e.g. banner logo L->M, keynote removed)."""
    cur = _one(conn, "SELECT spec, status FROM deliverables WHERE id=?", (deliverable_id,))
    if (cur[0], cur[1]) == (spec, status):
        return {"deliverable_id": deliverable_id, "noop": True}
    if (cur[0], cur[1]) != (expect_spec, expect_status):
        raise PreconditionFailed(f"{deliverable_id} is {tuple(cur)}, expected {(expect_spec, expect_status)}")
    conn.execute("UPDATE deliverables SET spec=?, status=? WHERE id=?", (spec, status, deliverable_id))
    return {"deliverable_id": deliverable_id, "before": {"spec": cur[0], "status": cur[1]},
            "after": {"spec": spec, "status": status}}


# --- calendar ----------------------------------------------------------------------------
class SetEventStatus(BaseModel):
    event_id: str
    status: str
    expect: str


@tool("calendar.set_status", SetEventStatus)
def set_event_status(conn, event_id, status, expect):
    """Set a calendar event's status (active/cancelled)."""
    cur = _one(conn, "SELECT status FROM calendar_events WHERE id=?", (event_id,))[0]
    if cur == status:
        return {"event_id": event_id, "noop": True}
    if cur != expect:
        raise PreconditionFailed(f"{event_id}.status is {cur}, expected {expect}")
    conn.execute("UPDATE calendar_events SET status=? WHERE id=?", (status, event_id))
    return {"event_id": event_id, "before": cur, "after": status}


class AddNote(BaseModel):
    target_id: str
    note: str


@tool("calendar.add_note", AddNote)
def calendar_add_note(conn, target_id, note):
    """Attach a note to a calendar event."""
    return _append_unique(conn, "calendar_events", "notes", target_id, note)


@tool("promo.flag_correction", AddNote, touches_public=False)
def promo_flag(conn, target_id, note):
    """Flag a promotional asset for correction (does not edit the published asset)."""
    return _append_unique(conn, "promo_assets", "flags", target_id, note)


@tool("docs.append_note", AddNote)
def docs_append(conn, target_id, note):
    """Append a note to a document."""
    return _append_unique(conn, "docs", "notes", target_id, note)


# --- long-term memory --------------------------------------------------------------------
class SupersedeFact(BaseModel):
    entity: str
    predicate: str
    value: str
    source_ref: str
    confidence: float
    valid_from: str


@tool("memory.supersede_fact", SupersedeFact)
def supersede_fact(conn, entity, predicate, value, source_ref, confidence, valid_from):
    """Record a new version of a fact; the old version is closed, never deleted."""
    cur = conn.execute("SELECT id, value FROM facts WHERE entity=? AND predicate=? AND valid_to IS NULL",
                       (entity, predicate)).fetchone()
    if cur is not None and cur[1] == value:
        return {"fact_id": cur[0], "noop": True}
    n = conn.execute("SELECT COUNT(*) FROM facts").fetchone()[0] + 1
    new_id = f"f-{n}"
    while conn.execute("SELECT 1 FROM facts WHERE id=?", (new_id,)).fetchone():
        n += 1
        new_id = f"f-{n}"
    if cur is not None:
        conn.execute("UPDATE facts SET valid_to=?, superseded_by=? WHERE id=?", (valid_from, new_id, cur[0]))
    conn.execute("INSERT INTO facts (id, entity, predicate, value, valid_from, valid_to, superseded_by, "
                 "source_ref, confidence) VALUES (?,?,?,?,?,NULL,NULL,?,?)",
                 (new_id, entity, predicate, value, valid_from, source_ref, confidence))
    return {"fact_id": new_id, "superseded": cur[0] if cur else None}


# --- communications (outbox) -------------------------------------------------------------
def _require_approval(conn, approval_id: str | None) -> None:
    if not approval_id:
        raise PermanentToolError("outbound message has no approval")
    row = conn.execute("SELECT status FROM approvals_queue WHERE id=?", (approval_id,)).fetchone()
    if row is None or row[0] not in ("approved", "edited"):
        raise PermanentToolError(f"approval {approval_id} is not approved")


class SendEmail(BaseModel):
    to: str
    cc: list[str] = []
    subject: str
    body: str
    approval_id: str | None = None


@tool("comms.email", SendEmail, reversible=False, external=True, needs_key=True)
def send_email(conn, to, cc, subject, body, approval_id, idem_key, change_id):
    """Queue an email in the outbox (simulated send). External; always needs approval."""
    _require_approval(conn, approval_id)
    conn.execute("INSERT INTO outbox (idem_key, channel, recipient, cc, subject, body, external, status, "
                 "approval_id, change_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                 (idem_key, "email", to, json.dumps(cc), subject, body, 1, "sent", approval_id, change_id,
                  datetime.now().isoformat()))
    return {"outbox": "email", "to": to, "status": "sent"}


class PostChat(BaseModel):
    channel: str
    body: str
    approval_id: str | None = None


@tool("comms.chat", PostChat, reversible=True, needs_key=True)
def post_chat(conn, channel, body, approval_id, idem_key, change_id):
    """Post to an internal team channel (simulated). Internal; a correction can follow."""
    conn.execute("INSERT INTO outbox (idem_key, channel, recipient, cc, subject, body, external, status, "
                 "approval_id, change_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                 (idem_key, "chat", channel, "[]", "", body, 0, "sent", approval_id, change_id,
                  datetime.now().isoformat()))
    return {"outbox": "chat", "channel": channel, "status": "sent"}


WRITE_TOOLS = {
    "tracker.set_committed", "tracker.set_tier", "tracker.set_gap", "tracker.flag_pending_update",
    "budget.set_lines", "approvals.update", "deliverables.set", "calendar.set_status",
    "calendar.add_note", "promo.flag_correction", "docs.append_note", "memory.supersede_fact",
    "comms.email", "comms.chat",
}

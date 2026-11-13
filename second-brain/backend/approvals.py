"""Human-in-the-loop gates: action approvals, shortfall option choice, clarifications.

Approvals are persisted (approvals_queue) and woken through an asyncio.Event, so the API
can decide them while the coordinator awaits. A decision on the same action (same key and
same planned args) is reused by later plan versions instead of asking the human twice.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime

from . import config, db
from .events import RunCtx
from .models import PlannedAction

_waiters: dict[str, asyncio.Event] = {}


def _strip(args: dict) -> dict:
    return {k: v for k, v in args.items() if k != "approval_id"}


def preview(action: PlannedAction) -> list[dict]:
    """Dry-run diff: current value -> proposed value, for the approval modal."""
    a, out = action.args, []
    if action.tool == "budget.set_lines" or action.tool == "tracker.flag_pending_update":
        for c in a["changes"]:
            line = db.query_one("SELECT category, amount FROM budget_lines WHERE id=?", (c["line_id"],))
            out.append({"label": f"Budget: {line['category']}", "from": line["amount"], "to": c["new"]})
    elif action.tool == "tracker.set_committed":
        out.append({"label": "Committed amount", "from": a["expect"], "to": a["new"]})
    elif action.tool == "tracker.set_tier":
        out.append({"label": "Tier", "from": a["expect"], "to": a["new"]})
    elif action.tool == "approvals.update":
        oa = db.query_one("SELECT subject, amount, status FROM org_approvals WHERE id=?", (a["org_approval_id"],))
        out.append({"label": oa["subject"], "from": f"{oa['amount']} ({oa['status']})",
                    "to": f"{a['amount']} ({a['status']})"})
    elif action.tool == "deliverables.set":
        out.append({"label": a["deliverable_id"], "from": f"{a['expect_spec']} ({a['expect_status']})",
                    "to": f"{a['spec']} ({a['status']})"})
    elif action.tool == "comms.email":
        out.append({"label": f"Email to {a['to']}", "from": None, "to": a["subject"], "body": a["body"]})
    elif action.tool == "comms.chat":
        out.append({"label": f"Post in {a['channel']}", "from": None, "to": a["body"]})
    else:
        out.append({"label": action.tool, "from": None, "to": json.dumps(_strip(a))})
    return out


async def request(ctx: RunCtx, action: PlannedAction) -> dict:
    prev = db.query_one(
        "SELECT * FROM approvals_queue WHERE run_id=? AND action_key=? AND tool=? "
        "AND status IN ('approved','edited','rejected') ORDER BY created_at DESC LIMIT 1",
        (ctx.run_id, action.key, action.tool))
    if prev and _strip(prev["original_args"]) == _strip(action.args):
        ctx.emit("approval.reused", f"Reusing earlier decision '{prev['status']}' for {action.key}",
                 {"approval_id": prev["id"], "action_id": action.id})
        return prev

    ap_id = f"ap-{uuid.uuid4().hex[:6]}"
    ev = asyncio.Event()
    _waiters[ap_id] = ev
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO approvals_queue (id, run_id, action_id, action_key, tool, status, original_args, "
            "final_args, preview, risk_score, risk_reasons, rationale, evidence_refs, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (ap_id, ctx.run_id, action.id, action.key, action.tool, "pending", json.dumps(action.args),
             json.dumps(action.args), json.dumps(preview(action), default=str), action.risk_score,
             json.dumps(action.risk_reasons), action.rationale, json.dumps(action.evidence_refs),
             datetime.now().isoformat()))
    ctx.emit("approval.requested", f"Approval needed: {action.tool} ({action.rationale})",
             {"approval_id": ap_id, "action_id": action.id, "tool": action.tool, "risk": action.risk_score,
              "risk_reasons": action.risk_reasons}, action.evidence_refs)
    try:
        await asyncio.wait_for(ev.wait(), config.APPROVAL_TIMEOUT_S)
    except asyncio.TimeoutError:
        db.execute("UPDATE approvals_queue SET status='expired', decided_at=? WHERE id=? AND status='pending'",
                   (datetime.now().isoformat(), ap_id))
        ctx.emit("approval.expired", f"Approval {ap_id} expired", {"approval_id": ap_id})
    finally:
        _waiters.pop(ap_id, None)
    return db.query_one("SELECT * FROM approvals_queue WHERE id=?", (ap_id,))


def decide(ap_id: str, decision: str, args: dict | None = None, reason: str | None = None,
           by: str = "demo-user") -> dict:
    row = db.query_one("SELECT * FROM approvals_queue WHERE id=?", (ap_id,))
    if row is None:
        raise KeyError(ap_id)
    if row["status"] != "pending":
        raise ValueError(f"approval {ap_id} is already {row['status']}")
    if decision not in ("approve", "reject", "edit"):
        raise ValueError("decision must be approve | reject | edit")
    status = {"approve": "approved", "reject": "rejected", "edit": "edited"}[decision]
    final = dict(row["original_args"], **(args or {})) if decision == "edit" else row["original_args"]
    db.execute("UPDATE approvals_queue SET status=?, final_args=?, reason=?, decided_by=?, decided_at=? "
               "WHERE id=?", (status, json.dumps(final), reason, by, datetime.now().isoformat(), ap_id))
    from .events import emit
    emit(row["run_id"], "Human", "approval.decided", f"{status}: {row['tool']}" + (f" ({reason})" if reason else ""),
         {"approval_id": ap_id, "decision": status, "final_args": final, "action_id": row["action_id"]})
    if (ev := _waiters.get(ap_id)) is not None:
        ev.set()
    return db.query_one("SELECT * FROM approvals_queue WHERE id=?", (ap_id,))


# --- generic named waits (option choice, clarification) ---------------------------------
_signals: dict[str, tuple[asyncio.Event, dict]] = {}


async def wait_signal(name: str, timeout: float) -> dict | None:
    ev = asyncio.Event()
    box: dict = {}
    _signals[name] = (ev, box)
    try:
        await asyncio.wait_for(ev.wait(), timeout)
        return box
    except asyncio.TimeoutError:
        return None
    finally:
        _signals.pop(name, None)


def send_signal(name: str, data: dict) -> bool:
    if name not in _signals:
        return False
    ev, box = _signals[name]
    box.update(data)
    ev.set()
    return True

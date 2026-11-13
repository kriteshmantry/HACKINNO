"""Event store + live fan-out. The audit log, the live UI and verification all read this stream."""
from __future__ import annotations

import asyncio
import json
import threading
from datetime import datetime
from typing import Any

from . import db

_subs: dict[str, list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]]] = {}
_lock = threading.Lock()
ALL = "*"   # subscribe to every run


def emit(run_id: str | None, agent: str, type_: str, message: str,
         payload: dict | None = None, evidence: list[str] | None = None) -> dict:
    ts = datetime.now().isoformat(timespec="milliseconds")
    with db.tx() as conn:
        cur = conn.execute(
            "INSERT INTO events (run_id, ts, agent, type, message, evidence_refs, payload_json) "
            "VALUES (?,?,?,?,?,?,?)",
            (run_id, ts, agent, type_, message, json.dumps(evidence or []),
             json.dumps(payload or {}, default=str)))
        ev_id = cur.lastrowid
    ev = {"id": ev_id, "run_id": run_id, "ts": ts, "agent": agent, "type": type_, "message": message,
          "evidence_refs": evidence or [], "payload": payload or {}}
    with _lock:
        targets = list(_subs.get(run_id or "", [])) + list(_subs.get(ALL, []))
    for loop, q in targets:
        try:
            loop.call_soon_threadsafe(q.put_nowait, ev)
        except RuntimeError:       # loop closed (client gone)
            pass
    return ev


def subscribe(run_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    with _lock:
        _subs.setdefault(run_id, []).append((asyncio.get_running_loop(), q))
    return q


def unsubscribe(run_id: str, q: asyncio.Queue) -> None:
    with _lock:
        _subs[run_id] = [(l, x) for l, x in _subs.get(run_id, []) if x is not q]


def events_after(run_id: str | None, last_id: int = 0) -> list[dict]:
    if run_id in (None, ALL):
        rows = db.query("SELECT * FROM events WHERE id > ? ORDER BY id", (last_id,))
    else:
        rows = db.query("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id", (run_id, last_id))
    for r in rows:
        r["payload"] = r.pop("payload_json")
    return rows


class RunCtx:
    """Per-agent handle: who is acting, for which change, with which tools allowed."""

    def __init__(self, run_id: str, change_id: str, agent: str, allowlist: set[str] | None = None):
        self.run_id, self.change_id, self.agent = run_id, change_id, agent
        self.allowlist = allowlist or set()

    def emit(self, type_: str, message: str, payload: dict | None = None,
             evidence: list[str] | None = None) -> dict:
        return emit(self.run_id, self.agent, type_, message, payload, evidence)

    def as_agent(self, agent: str, allowlist: set[str] | None = None) -> "RunCtx":
        return RunCtx(self.run_id, self.change_id, agent, allowlist)

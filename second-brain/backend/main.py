"""FastAPI app: commands (REST) + live event feed (SSE with replay)."""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import approvals, context, coordinator, db, events
from .knowledge import graph as kg
from .knowledge import memory
from .tools import breaker, registry, set_fault

SCENARIOS = {
    "S1": {"message_id": "e-19", "title": "Clear cut: TechNova ₹5L → ₹3L"},
    "S2": {"message_id": "e-21", "title": "Ambiguous: 'around 3L, subject to board approval'"},
    "S3": {"message_id": "c-11", "title": "Chat relay: 'board approved 3.5L final'"},
    "S4": {"message_id": "e-23", "title": "Prompt injection from a look-alike domain"},
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.ensure_db()
    yield
    for t in coordinator.TASKS.values():
        t.cancel()


app = FastAPI(title="Second Brain", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _run_or_404(run_id: str):
    run = coordinator.load(run_id)
    if run is None:
        raise HTTPException(404, f"run {run_id} not found")
    return run


# --- control ---------------------------------------------------------------------------
@app.post("/api/reset")
async def reset():
    for t in coordinator.TASKS.values():
        t.cancel()
    coordinator.TASKS.clear()
    registry.FAULTS.clear()
    breaker.reset()
    db.reset()
    events.emit(None, "System", "system.reset", "Workspace reseeded")
    return {"ok": True}


class StartRun(BaseModel):
    message_id: str
    option_wait_seconds: float | None = None


@app.post("/api/runs")
async def start_run(body: StartRun):
    if db.query_one("SELECT 1 FROM messages WHERE id=?", (body.message_id,)) is None:
        raise HTTPException(404, f"message {body.message_id} not found")
    run = coordinator.start(body.message_id, body.option_wait_seconds)
    return {"run_id": run.id}


@app.get("/api/scenarios")
async def scenarios():
    return SCENARIOS


@app.post("/api/scenarios/{sid}")
async def run_scenario(sid: str, reset_first: bool = True, option_wait_seconds: float | None = None):
    if sid not in SCENARIOS:
        raise HTTPException(404, f"unknown scenario {sid}")
    if reset_first:
        await reset()
    run = coordinator.start(SCENARIOS[sid]["message_id"], option_wait_seconds)
    return {"run_id": run.id, **SCENARIOS[sid]}


# --- read models -----------------------------------------------------------------------
@app.get("/api/runs")
async def list_runs():
    return db.query("SELECT id, message_id, state, started_at, updated_at FROM runs ORDER BY started_at DESC")


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str):
    return _run_or_404(run_id).model_dump()


@app.get("/api/runs/{run_id}/plan")
async def get_plan(run_id: str):
    run = _run_or_404(run_id)
    return {"current": run.plan.model_dump() if run.plan else None,
            "history": [p.model_dump() for p in run.plan_history]}


@app.get("/api/runs/{run_id}/log")
async def get_log(run_id: str):
    return events.events_after(run_id, 0)


@app.get("/api/runs/{run_id}/snapshots")
async def get_snapshots(run_id: str):
    rows = db.query("SELECT phase, state_json FROM snapshots WHERE run_id=?", (run_id,))
    return {r["phase"]: json.loads(r["state_json"]) for r in rows}


@app.get("/api/runs/{run_id}/trace/{action_id}")
async def trace(run_id: str, action_id: str):
    """Provenance chain: source message → extracted fact → graph path → option → action → tool → checks."""
    run = _run_or_404(run_id)
    action = next((a for p in run.plan_history[::-1] for a in p.actions if a.id == action_id), None)
    if action is None:
        raise HTTPException(404, f"action {action_id} not found")
    rc = run.resolved
    msgs = db.query(f"SELECT id, channel, sender, subject, body, received_at FROM messages WHERE id IN "
                    f"({','.join('?' * len(action.evidence_refs))})", tuple(action.evidence_refs)) \
        if action.evidence_refs else []
    path = next((n.model_dump() for n in (run.impact.nodes if run.impact else [])
                 if n.node in json.dumps(action.args)), None)
    tool_events = [e for e in events.events_after(run_id, 0)
                   if e["payload"].get("action_id") == action_id or
                   (e["type"].startswith("tool.") and e["payload"].get("tool") == action.tool)]
    approval = db.query_one("SELECT * FROM approvals_queue WHERE id=?", (action.approval_id,)) \
        if action.approval_id else None
    return {
        "action": action.model_dump(),
        "sources": msgs,
        "evidence_span": run.extracted.evidence_span if run.extracted else None,
        "change": rc.model_dump() if rc else None,
        "graph_path": path,
        "option": next((o.model_dump() for o in run.options if o.id == run.chosen_option), None),
        "approval": approval,
        "tool_events": tool_events,
        "verification": run.verification.model_dump() if run.verification else None,
    }


@app.get("/api/runs/{run_id}/context/{agent}")
async def run_context(run_id: str, agent: str):
    """What one agent was given for this run (context packet); null before it has run."""
    return context.packet(_run_or_404(run_id), agent)


@app.get("/api/memory")
async def memory_overview():
    """Long-term memory beyond facts: one summary per finished run."""
    return context.memory_overview()


@app.get("/api/state")
async def state():
    return db.workspace_state()


@app.get("/api/messages")
async def messages():
    return db.query("SELECT * FROM messages ORDER BY received_at DESC")


@app.get("/api/outbox")
async def outbox():
    return db.query("SELECT * FROM outbox ORDER BY id")


@app.get("/api/graph")
async def graph(run_id: str | None = None):
    G = kg.build()
    impacted = None
    if run_id:
        run = _run_or_404(run_id)
        impacted = [n.model_dump() for n in run.impact.nodes] if run.impact else None
    return kg.to_json(G, impacted)


@app.get("/api/memory/facts")
async def facts(entity: str | None = None):
    return memory.fact_history(entity)


# --- human decisions -------------------------------------------------------------------
@app.get("/api/approvals")
async def list_approvals(status: str | None = None, run_id: str | None = None):
    sql, params = "SELECT * FROM approvals_queue WHERE 1=1", []
    if status:
        sql, params = sql + " AND status=?", params + [status]
    if run_id:
        sql, params = sql + " AND run_id=?", params + [run_id]
    return db.query(sql + " ORDER BY created_at", tuple(params))


class Decision(BaseModel):
    decision: str                   # approve | reject | edit
    args: dict | None = None
    reason: str | None = None


@app.post("/api/approvals/{ap_id}")
async def decide(ap_id: str, body: Decision):
    try:
        return approvals.decide(ap_id, body.decision, body.args, body.reason)
    except KeyError:
        raise HTTPException(404, f"approval {ap_id} not found")
    except ValueError as e:
        raise HTTPException(409, str(e))


@app.post("/api/runs/{run_id}/options/{option_id}")
async def choose_option(run_id: str, option_id: str):
    _run_or_404(run_id)
    if not approvals.send_signal(f"option:{run_id}", {"option": option_id}):
        raise HTTPException(409, "run is not waiting for an option choice")
    return {"ok": True}


class Clarify(BaseModel):
    decision: str                   # confirm | dismiss
    amount: int | None = None


@app.post("/api/runs/{run_id}/clarify")
async def clarify(run_id: str, body: Clarify):
    _run_or_404(run_id)
    if not approvals.send_signal(f"clarify:{run_id}", body.model_dump()):
        raise HTTPException(409, "run is not waiting for clarification")
    return {"ok": True}


# --- debug / demo controls -------------------------------------------------------------
class Fault(BaseModel):
    tool: str
    mode: str                        # once | always | slow | off


@app.post("/api/debug/fault")
async def fault(body: Fault):
    if body.tool not in registry.REGISTRY:
        raise HTTPException(404, f"unknown tool {body.tool}")
    set_fault(body.tool, body.mode)
    events.emit(None, "System", "debug.fault", f"Fault '{body.mode}' armed on {body.tool}", body.model_dump())
    return {"faults": registry.FAULTS}


@app.post("/api/debug/corrupt")
async def corrupt():
    """Re-activate a deliverable the sponsor is no longer entitled to (breaks V3) for the verifier demo."""
    db.execute("UPDATE deliverables SET status='active' WHERE id='d-keynote'")
    events.emit(None, "System", "debug.corrupt", "d-keynote forced back to active (breaks V3)")
    return {"ok": True}


@app.get("/api/tools")
async def tools():
    return [{"name": s.name, "description": s.description, "external": s.external,
             "reversible": s.reversible, "schema": s.args_model.model_json_schema()}
            for s in registry.REGISTRY.values()]


# --- live feed -------------------------------------------------------------------------
@app.get("/api/runs/{run_id}/stream")
async def stream(run_id: str, request: Request):
    return _sse(run_id, request)


@app.get("/api/stream")
async def stream_all(request: Request):
    return _sse(events.ALL, request)


def _sse(run_id: str, request: Request) -> StreamingResponse:
    last = int(request.headers.get("last-event-id") or request.query_params.get("after") or 0)

    async def gen():
        q = events.subscribe(run_id)
        try:
            sent = last
            for ev in events.events_after(run_id, last):            # replay what the client missed
                sent = ev["id"]
                yield f"id: {ev['id']}\ndata: {json.dumps(ev, default=str)}\n\n"
            while not await request.is_disconnected():
                try:
                    ev = await asyncio.wait_for(q.get(), 15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if ev["id"] <= sent:
                    continue
                sent = ev["id"]
                yield f"id: {ev['id']}\ndata: {json.dumps(ev, default=str)}\n\n"
        finally:
            events.unsubscribe(run_id, q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

"""Coordinator agent: a deterministic, persisted state machine that owns control flow.

INGEST → TRIAGE → EXTRACT → RESOLVE → [AWAIT_CLARIFICATION] → ANALYZE → OPTIONS → PLAN →
VALIDATE → EXECUTE (⇄ approvals) → VERIFY → DONE | REPLAN | ESCALATE
Terminal: DONE, IGNORED, QUARANTINED, ESCALATED.
"""
from __future__ import annotations

import asyncio
import json
import traceback
import uuid
from datetime import datetime

from . import approvals, config, db
from .agents import communication, execution, knowledge, planning, verification
from .events import RunCtx, emit
from .models import RunState

TRANSITIONS = {
    "INGEST": {"TRIAGE"},
    "TRIAGE": {"EXTRACT", "IGNORED", "QUARANTINED"},
    "EXTRACT": {"RESOLVE"},
    "RESOLVE": {"ANALYZE", "AWAIT_CLARIFICATION", "DONE"},
    "AWAIT_CLARIFICATION": {"ANALYZE", "DONE", "ESCALATED"},
    "ANALYZE": {"OPTIONS"},
    "OPTIONS": {"PLAN"},
    "PLAN": {"VALIDATE"},
    "VALIDATE": {"EXECUTE", "ESCALATED"},
    "EXECUTE": {"VERIFY", "REPLAN", "ESCALATED"},
    "VERIFY": {"DONE", "REPLAN"},
    "REPLAN": {"PLAN", "ESCALATED"},
}
TERMINAL = {"DONE", "IGNORED", "QUARANTINED", "ESCALATED"}
DEGRADABLE = {"budget.set_lines"}

TASKS: dict[str, asyncio.Task] = {}


def save(run: RunState) -> None:
    db.execute("UPDATE runs SET state=?, state_json=?, updated_at=? WHERE id=?",
               (run.state, run.model_dump_json(), datetime.now().isoformat(), run.id))


def load(run_id: str) -> RunState | None:
    row = db.query_one("SELECT state_json FROM runs WHERE id=?", (run_id,))
    return RunState.model_validate_json(row["state_json"]) if row else None


def create_run(message_id: str, option_wait_s: float | None = None) -> RunState:
    run = RunState(id=f"r-{uuid.uuid4().hex[:6]}", message_id=message_id, change_id=message_id,
                   option_wait_s=config.DEFAULT_OPTION_WAIT_S if option_wait_s is None else option_wait_s)
    now = datetime.now().isoformat()
    with db.tx() as conn:
        conn.execute("INSERT INTO runs VALUES (?,?,?,?,?,?,?)",
                     (run.id, message_id, run.change_id, run.state, run.model_dump_json(), now, now))
    return run


def start(message_id: str, option_wait_s: float | None = None) -> RunState:
    run = create_run(message_id, option_wait_s)
    TASKS[run.id] = asyncio.get_running_loop().create_task(drive(run))
    return run


class Coordinator:
    def __init__(self, run: RunState):
        self.run = run
        self.ctx = RunCtx(run.id, run.change_id, "Coordinator")
        self.msg = communication.get_message(run.message_id)
        self.G = None

    # --- plumbing ------------------------------------------------------------------------
    def agent(self, name: str) -> RunCtx:
        return self.ctx.as_agent(name)

    def handoff(self, frm: str, to: str, summary: str) -> None:
        emit(self.run.id, "Coordinator", "agent.handoff", f"{frm} → {to}: {summary}",
             {"from": frm, "to": to, "summary": summary})

    def transition(self, nxt: str) -> None:
        cur = self.run.state
        if nxt not in TRANSITIONS.get(cur, set()):
            raise RuntimeError(f"illegal transition {cur} -> {nxt}")
        self.run.state = nxt
        save(self.run)
        emit(self.run.id, "Coordinator", "run.state", f"{cur} → {nxt}", {"from": cur, "to": nxt})

    def finish(self, outcome: str) -> None:
        self.run.outcome = outcome
        db.execute("UPDATE messages SET processed=1, triage=? WHERE id=?",
                   (json.dumps(self.run.triage.model_dump() if self.run.triage else None), self.run.message_id))
        if self.run.resolved:
            db.snapshot(self.run.id, "after")
            summary = (f"{self.run.resolved.sponsor_name}: {self.run.resolved.old_amount} → "
                       f"{self.run.resolved.new_amount}; option {self.run.chosen_option}; outcome {outcome}; "
                       f"replans {self.run.replans}; rejected {self.run.rejected_keys}")
            db.execute("INSERT OR REPLACE INTO episodes VALUES (?,?,?)",
                       (self.run.id, summary, datetime.now().isoformat()))
        save(self.run)
        emit(self.run.id, "Coordinator", "run.completed", outcome,
             {"state": self.run.state, "outcome": outcome,
              "verification_ok": self.run.verification.ok if self.run.verification else None})

    # --- states --------------------------------------------------------------------------
    async def step(self) -> None:
        handler = getattr(self, f"on_{self.run.state.lower()}")
        await handler()

    async def on_ingest(self) -> None:
        if self.msg is None:
            raise RuntimeError(f"message {self.run.message_id} not found")
        emit(self.run.id, "Coordinator", "run.started", f"Processing {self.msg['id']}: {self.msg['subject']}",
             {"message_id": self.msg["id"]}, [self.msg["id"]])
        self.transition("TRIAGE")

    async def on_triage(self) -> None:
        c = self.agent("Communication")
        c.emit("agent.started", "Triage", {})
        t = communication.triage(self.msg)
        self.run.triage = t
        c.emit("triage", f"{t.label}: {'; '.join(t.reasons)}", t.model_dump(), [self.msg["id"]])
        c.emit("agent.finished", f"Triage: {t.label}", {})
        if t.label == "suspicious":
            self.transition("QUARANTINED")
            self.finish("quarantined: message never reaches the planner")
        elif t.label == "noise":
            self.transition("IGNORED")
            self.finish("ignored: not a sponsor commitment change")
        else:
            self.transition("EXTRACT")

    async def on_extract(self) -> None:
        c = self.agent("Communication")
        c.emit("agent.started", "Extracting the change", {})
        ex = communication.extract(self.msg, c)
        self.run.extracted = ex
        c.emit("extracted", f"{ex.sponsor_mention or self.msg['sender']}: new amount {ex.new_amount} "
               f"(old {ex.old_amount}) via {ex.source}", ex.model_dump(), [self.msg["id"]])
        c.emit("agent.finished", "Extraction done", {})
        self.handoff("Communication", "Knowledge", "extracted change")
        self.transition("RESOLVE")

    async def on_resolve(self) -> None:
        k = self.agent("Knowledge")
        k.emit("agent.started", "Resolving entity, checking memory, scoring confidence", {})
        try:
            rc = knowledge.resolve_change(self.msg, self.run.extracted)
        except knowledge.Unresolved as u:
            self.run.clarification = {"question": u.question, "reasons": ["could not resolve"]}
            k.emit("agent.finished", f"Needs clarification: {u.question}", {})
            self.transition("AWAIT_CLARIFICATION")
            return
        self.run.resolved = rc
        k.emit("resolved", f"{rc.sponsor_name} via {rc.resolution_method}; {rc.old_amount} → {rc.new_amount}",
               rc.model_dump(include={"sponsor_id", "resolution_method", "old_amount", "new_amount",
                                      "old_tier", "new_tier", "shortfall"}), rc.evidence_refs)
        k.emit("confidence", f"{rc.confidence:.2f} → {rc.band}",
               {"score": rc.confidence, "band": rc.band, "reasons": rc.confidence_reasons}, [rc.change_id])
        if rc.contradiction:
            c = rc.contradiction
            k.emit("memory.contradiction", f"Memory says {c['old_value']} ({c['old_source']}); "
                   f"new message says {c['new_value']} ({c['new_source']})", c,
                   [c["old_source"], c["new_source"]])
        k.emit("agent.finished", "Resolution done", {})
        if rc.new_amount == rc.old_amount:
            self.transition("DONE")
            self.finish("no change: workspace already reflects this commitment")
        elif rc.band == "clarify":
            self.run.clarification = {
                "question": f"Is {rc.sponsor_name}'s new commitment of ₹{rc.new_amount:,} final?",
                "reasons": rc.confidence_reasons,
                "draft": f"Hi, thanks for the update. Could you confirm the final committed amount for "
                         f"Innovision 2026, and whether board approval is still pending?"}
            self.transition("AWAIT_CLARIFICATION")
        else:
            self.handoff("Knowledge", "Knowledge", "impact analysis")
            self.transition("ANALYZE")

    async def on_await_clarification(self) -> None:
        emit(self.run.id, "Coordinator", "clarification.requested", self.run.clarification["question"],
             self.run.clarification)
        save(self.run)
        sig = await approvals.wait_signal(f"clarify:{self.run.id}", config.APPROVAL_TIMEOUT_S)
        if sig is None:
            self.transition("ESCALATED")
            self.finish("escalated: clarification not answered in time")
            return
        if sig.get("decision") != "confirm" or self.run.resolved is None:
            self.transition("DONE")
            self.finish("dismissed by human: no changes made")
            return
        rc = self.run.resolved
        if sig.get("amount"):
            rc.new_amount = int(sig["amount"])
            rc.new_tier = config.tier_for(rc.new_amount)
            rc.shortfall = rc.old_amount - rc.new_amount
        rc.human_confirmed, rc.confidence, rc.band = True, 1.0, "autonomous"
        rc.confidence_reasons.append("confirmed by a human")
        emit(self.run.id, "Human", "clarification.answered", f"Confirmed ₹{rc.new_amount:,}", sig)
        self.transition("ANALYZE")

    async def on_analyze(self) -> None:
        k = self.agent("Knowledge")
        k.emit("agent.started", "Impact analysis over the knowledge graph", {})
        db.snapshot(self.run.id, "before")
        impact, self.G = knowledge.analyze(self.run.resolved)
        self.run.impact = impact
        high = [n.label for n in impact.nodes if n.severity == "high"]
        k.emit("impact", f"{len(impact.nodes)} affected items, {len(high)} high severity",
               {"nodes": [n.model_dump() for n in impact.nodes]}, [self.run.change_id])
        k.emit("agent.finished", "Impact analysis done", {})
        self.handoff("Knowledge", "Planning", f"{len(impact.nodes)} impacted nodes")
        self.transition("OPTIONS")

    async def on_options(self) -> None:
        p = self.agent("Planning")
        p.emit("agent.started", "Computing shortfall options", {})
        opts = planning.options(self.run.resolved)
        self.run.options = opts
        if opts:
            rec = next(o for o in opts if o.recommended)
            p.emit("options.ready", f"Shortfall ₹{self.run.resolved.shortfall:,}: {len(opts)} options; "
                   f"recommended {rec.id} ({rec.name})", {"options": [o.model_dump() for o in opts],
                                                           "wait_s": self.run.option_wait_s})
            save(self.run)
            choice = None
            if self.run.option_wait_s > 0:
                sig = await approvals.wait_signal(f"option:{self.run.id}", self.run.option_wait_s)
                choice = sig and sig.get("option")
            self.run.chosen_option = choice if choice in {o.id for o in opts} else rec.id
            self.run.option_chosen_by = "human" if choice else "recommended (auto)"
            p.emit("options.chosen", f"Option {self.run.chosen_option} chosen by {self.run.option_chosen_by}",
                   {"option": self.run.chosen_option, "by": self.run.option_chosen_by})
        self.transition("PLAN")

    async def on_plan(self) -> None:
        p = self.agent("Planning")
        if self.G is None:
            self.run.impact, self.G = knowledge.analyze(self.run.resolved)
        option = next((o for o in self.run.options if o.id == self.run.chosen_option), None)
        done = {a.key for pl in self.run.plan_history for a in pl.actions if a.status in execution.OK}
        version = len(self.run.plan_history) + 1
        plan, errors = planning.make_plan(
            self.run.id, version, self.run.resolved, self.run.impact, self.G, option,
            rejected_keys=set(self.run.rejected_keys), degraded_tools=set(self.run.degraded_tools),
            done_keys=done)
        self.run.plan = plan
        self.run.meta["validation_errors"] = errors
        p.emit("plan.created", f"Plan v{version}: {len(plan.actions)} actions, "
               f"{sum(a.requires_approval for a in plan.actions)} need approval",
               {"plan": plan.model_dump()}, [self.run.change_id])
        p.emit("agent.finished", "Planning done", {})
        self.transition("VALIDATE")

    async def on_validate(self) -> None:
        errors = self.run.meta.get("validation_errors", [])
        if errors:
            emit(self.run.id, "Planning", "plan.rejected", f"{len(errors)} validation errors", {"errors": errors})
            self.transition("ESCALATED")
            self.finish("escalated: plan failed validation")
            return
        emit(self.run.id, "Planning", "plan.validated", "Plan passed validation", {})
        self.handoff("Planning", "Execution", f"plan v{self.run.plan.version}")
        self.transition("EXECUTE")

    async def on_execute(self) -> None:
        plan = self.run.plan
        self.run.plan_history = [p for p in self.run.plan_history if p.version != plan.version] + [plan]
        x = self.agent("Execution")
        x.emit("agent.started", f"Executing plan v{plan.version}", {})
        res = await execution.execute(plan, self.ctx, lambda: save(self.run))
        x.emit("agent.finished", "Execution pass complete",
               {"failed": [a.id for a in res.failed], "rejected": [a.id for a in res.rejected],
                "blocked": [a.id for a in res.blocked]})
        if res.expired:
            self.transition("ESCALATED")
            self.finish("escalated: an approval expired")
            return
        for a in res.rejected:
            if a.key not in self.run.rejected_keys:
                self.run.rejected_keys.append(a.key)
        for a in res.failed:
            if a.tool in DEGRADABLE and a not in res.precondition and a.tool not in self.run.degraded_tools:
                self.run.degraded_tools.append(a.tool)
        if res.needs_replan:
            self.run.meta["replan_reason"] = (
                [f"{a.id} {a.tool} failed: {a.error}" for a in res.failed]
                + [f"{a.id} {a.tool} rejected by human" for a in res.rejected])
            self.transition("REPLAN")
        else:
            self.handoff("Execution", "Verification", "all actions completed")
            self.transition("VERIFY")

    async def on_verify(self) -> None:
        v = self.agent("Verification")
        v.emit("agent.started", "Checking invariants V1-V10", {})
        rep = verification.verify(self.run.resolved, self.run.plan, self.run.id, self.run.rejected_keys)
        self.run.verification = rep
        for c in rep.checks:
            v.emit("verify.pass" if c.ok else "verify.fail", f"{c.id} {c.name}", c.model_dump())
        v.emit("agent.finished", f"{sum(c.ok for c in rep.checks)}/{len(rep.checks)} checks passed", {})
        if rep.ok:
            self.transition("DONE")
            self.finish(f"done: {len(rep.checks)}/{len(rep.checks)} checks passed")
        else:
            self.run.meta["replan_reason"] = [f"{c.id} failed: expected {c.expected}, got {c.actual}"
                                              for c in rep.checks if not c.ok]
            self.transition("REPLAN")

    async def on_replan(self) -> None:
        self.run.replans += 1
        reasons = self.run.meta.get("replan_reason", [])
        if self.run.replans > config.MAX_REPLANS:
            emit(self.run.id, "Coordinator", "escalate", "Replan budget exhausted; handing over to a human",
                 {"reasons": reasons})
            self.transition("ESCALATED")
            self.finish("escalated: could not converge within the replan budget")
            return
        emit(self.run.id, "Coordinator", "replan", f"Replan #{self.run.replans}: {'; '.join(reasons)}",
             {"reasons": reasons, "degraded_tools": self.run.degraded_tools,
              "rejected_keys": self.run.rejected_keys})
        self.G = None          # rebuild from the current DB
        self.transition("PLAN")


async def drive(run: RunState) -> RunState:
    co = Coordinator(run)
    try:
        while run.state not in TERMINAL:
            await co.step()
    except asyncio.CancelledError:
        save(run)
        raise
    except Exception as e:  # never crash silently mid-demo
        run.error = f"{type(e).__name__}: {e}"
        emit(run.id, "Coordinator", "run.error", run.error, {"traceback": traceback.format_exc()})
        run.state = "ESCALATED"
        run.outcome = f"escalated: internal error ({run.error})"
        save(run)
    return run

"""Tool layer: schema validation, allowlists, transactional idempotency, retries,
circuit breaker and fault injection. Every state change in the system goes through `invoke`.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import random
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

from pydantic import BaseModel, ValidationError

from .. import config, db


class ToolError(Exception): ...
class TransientToolError(ToolError): ...      # timeouts, 503, lock contention -> retry
class PermanentToolError(ToolError): ...      # bad args, not found, exhausted -> replan
class PreconditionFailed(ToolError): ...      # world changed since planning -> re-read + replan


@dataclass
class ToolSpec:
    name: str
    fn: Callable
    args_model: type[BaseModel]
    writes: bool = True
    reversible: bool = True
    external: bool = False
    touches_public: bool = False
    needs_key: bool = False
    key_exclude: tuple[str, ...] = ("approval_id",)   # args that don't change what the action *is*
    description: str = ""


REGISTRY: dict[str, ToolSpec] = {}


def tool(name: str, args_model: type[BaseModel], **flags) -> Callable:
    def deco(fn: Callable) -> Callable:
        REGISTRY[name] = ToolSpec(name, fn, args_model, description=(fn.__doc__ or "").strip(), **flags)
        return fn
    return deco


# --- fault injection --------------------------------------------------------------------
# {"budget.set_lines": {"mode": "once" | "always" | "slow", "sleep": 6.0}}
FAULTS: dict[str, dict] = {}
_fault_lock = threading.Lock()


def set_fault(name: str, mode: str | None, sleep: float | None = None) -> None:
    with _fault_lock:
        if mode in (None, "off"):
            FAULTS.pop(name, None)
        else:
            FAULTS[name] = {"mode": mode, "sleep": sleep or config.TOOL_TIMEOUT_S + 1}


def _inject(name: str) -> None:
    with _fault_lock:
        f = FAULTS.get(name)
        if f and f["mode"] in ("once", "slow"):
            FAULTS.pop(name)
    if not f:
        return
    if f["mode"] == "once":
        raise TransientToolError("503 Service Unavailable (injected, once)")
    if f["mode"] == "always":
        raise TransientToolError("503 Service Unavailable (injected, persistent)")
    if f["mode"] == "slow":
        time.sleep(f["sleep"])         # the write still commits; the caller has already timed out


# --- circuit breaker --------------------------------------------------------------------
class Breaker:
    def __init__(self) -> None:
        self.fails: dict[str, int] = {}
        self.opened: dict[str, float] = {}

    def is_open(self, name: str) -> bool:
        t = self.opened.get(name)
        if t is None:
            return False
        if time.monotonic() - t > config.BREAKER_COOLDOWN_S:   # half-open: allow one try
            self.opened.pop(name, None)
            self.fails[name] = config.BREAKER_THRESHOLD - 1
            return False
        return True

    def ok(self, name: str) -> None:
        self.fails.pop(name, None)
        self.opened.pop(name, None)

    def fail(self, name: str) -> bool:
        self.fails[name] = self.fails.get(name, 0) + 1
        if self.fails[name] >= config.BREAKER_THRESHOLD and name not in self.opened:
            self.opened[name] = time.monotonic()
            return True
        return False

    def reset(self) -> None:
        self.fails.clear()
        self.opened.clear()


breaker = Breaker()


# --- idempotency ------------------------------------------------------------------------
def idem_key(name: str, args: dict, change_id: str) -> str:
    """Keyed on the business change (the source message), not the run, so re-processing
    the same email in a new run can never apply anything twice."""
    raw = f"{change_id}:{name}:{json.dumps(args, sort_keys=True, default=str)}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _run_in_txn(spec: ToolSpec, args: dict, key: str | None, change_id: str) -> tuple[Any, bool]:
    with db.tx() as conn:                                            # BEGIN IMMEDIATE
        if key:
            hit = conn.execute("SELECT result_json FROM idempotency WHERE key=?", (key,)).fetchone()
            if hit is not None:                                      # check INSIDE the txn
                return json.loads(hit[0]), True
        _inject(spec.name)
        call_args = dict(args, idem_key=key, change_id=change_id) if spec.needs_key else args
        result = spec.fn(conn, **call_args)
        if key:                                                      # same txn -> exactly-once effect
            conn.execute("INSERT INTO idempotency VALUES (?,?,?,?,?)",
                         (key, spec.name, change_id, json.dumps(result, default=str),
                          datetime.now().isoformat()))
        return result, False


async def invoke(name: str, raw_args: dict, ctx, *, retries: int | None = None,
                 base_delay: float | None = None, timeout: float | None = None,
                 meta: dict | None = None) -> Any:
    meta = meta if meta is not None else {}
    retries = retries or config.TOOL_RETRIES
    base_delay = config.TOOL_BASE_DELAY_S if base_delay is None else base_delay
    timeout = timeout or config.TOOL_TIMEOUT_S
    spec = REGISTRY.get(name)
    if spec is None:
        raise PermanentToolError(f"unknown tool {name}")
    if ctx.allowlist and name not in ctx.allowlist:
        raise PermanentToolError(f"agent {ctx.agent} is not allowed to call {name}")
    if breaker.is_open(name):
        ctx.emit("tool.failed", f"{name}: circuit open, failing fast", {"tool": name, "retryable": False})
        raise PermanentToolError(f"circuit open: {name}")
    try:
        args = spec.args_model.model_validate(raw_args).model_dump()
    except ValidationError as e:
        raise PermanentToolError(f"invalid args for {name}: {e}") from e
    identity = {k: v for k, v in args.items() if k not in spec.key_exclude}
    key = idem_key(name, identity, ctx.change_id) if spec.writes else None

    for attempt in range(1, retries + 1):
        try:
            result, dup = await asyncio.wait_for(
                asyncio.to_thread(_run_in_txn, spec, args, key, ctx.change_id), timeout)
            breaker.ok(name)
            meta.update(duplicate=dup, attempts=attempt, key=key)
            ctx.emit("tool.skipped_duplicate" if dup else "tool.success",
                     f"{name} {'already applied (idempotency key hit)' if dup else 'ok'}",
                     {"tool": name, "attempt": attempt, "key": key, "args": args, "result": result})
            return result
        except (TransientToolError, asyncio.TimeoutError) as e:
            msg = str(e) or f"timed out after {timeout}s"
            ctx.emit("tool.retry", f"{name} attempt {attempt}/{retries} failed: {msg}",
                     {"tool": name, "attempt": attempt, "error": msg})
            if attempt < retries:
                await asyncio.sleep(base_delay * 2 ** (attempt - 1) + random.uniform(0, 0.2))
        except (PermanentToolError, PreconditionFailed) as e:
            # a precondition failure means the world moved, not that the tool is unhealthy
            if not isinstance(e, PreconditionFailed) and breaker.fail(name):
                ctx.emit("tool.circuit_open", f"{name}: circuit opened", {"tool": name})
            ctx.emit("tool.failed", f"{name}: {e}",
                     {"tool": name, "retryable": False, "kind": type(e).__name__, "error": str(e)})
            raise
    if breaker.fail(name):
        ctx.emit("tool.circuit_open", f"{name}: circuit opened after repeated failures", {"tool": name})
    ctx.emit("tool.failed", f"{name}: exhausted {retries} attempts",
             {"tool": name, "retryable": False, "kind": "PermanentToolError"})
    raise PermanentToolError(f"{name}: exhausted {retries} attempts")

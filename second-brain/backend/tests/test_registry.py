import asyncio

import pytest

from backend import db
from backend.events import RunCtx
from backend.tools import PermanentToolError, PreconditionFailed, invoke, set_fault

CTX = RunCtx("r-test", "e-19", "Execution")
ARGS = {"sponsor_id": "s-technova", "new": 300000, "expect": 500000}


def committed() -> int:
    return db.query_one("SELECT committed_amount FROM sponsors WHERE id='s-technova'")["committed_amount"]


def version() -> int:
    return db.query_one("SELECT version FROM sponsors WHERE id='s-technova'")["version"]


def test_duplicate_call_is_skipped():
    meta1, meta2 = {}, {}
    asyncio.run(invoke("tracker.set_committed", ARGS, CTX, meta=meta1))
    asyncio.run(invoke("tracker.set_committed", ARGS, CTX, meta=meta2))
    assert committed() == 300000
    assert version() == 2                      # written exactly once
    assert meta1["duplicate"] is False and meta2["duplicate"] is True
    assert db.query_one("SELECT COUNT(*) n FROM idempotency")["n"] == 1


def test_same_change_in_a_new_run_is_still_skipped():
    asyncio.run(invoke("tracker.set_committed", ARGS, RunCtx("r-1", "e-19", "Execution")))
    meta = {}
    asyncio.run(invoke("tracker.set_committed", ARGS, RunCtx("r-2", "e-19", "Execution"), meta=meta))
    assert meta["duplicate"] and version() == 2


def test_fault_once_retries_and_recovers():
    set_fault("tracker.set_committed", "once")
    meta = {}
    asyncio.run(invoke("tracker.set_committed", ARGS, CTX, meta=meta))
    assert meta["attempts"] == 2 and committed() == 300000


def test_fault_always_becomes_permanent():
    set_fault("tracker.set_committed", "always")
    with pytest.raises(PermanentToolError):
        asyncio.run(invoke("tracker.set_committed", ARGS, CTX))
    assert committed() == 500000               # nothing half-applied


def test_slow_write_then_retry_is_a_duplicate_not_a_double_write():
    set_fault("tracker.set_committed", "slow", sleep=0.6)
    meta = {}
    asyncio.run(invoke("tracker.set_committed", ARGS, CTX, timeout=0.3, meta=meta))
    assert committed() == 300000 and version() == 2
    assert meta["duplicate"] is True           # the timed-out attempt had committed


def test_precondition_detects_drift():
    db.execute("UPDATE sponsors SET committed_amount=450000 WHERE id='s-technova'")
    with pytest.raises(PreconditionFailed):
        asyncio.run(invoke("tracker.set_committed", ARGS, CTX))
    assert committed() == 450000


def test_invalid_args_and_allowlist():
    with pytest.raises(PermanentToolError):
        asyncio.run(invoke("tracker.set_committed", {"sponsor_id": "s-technova"}, CTX))
    with pytest.raises(PermanentToolError):
        asyncio.run(invoke("tracker.set_committed", ARGS, RunCtx("r", "e-19", "Planning", {"docs.append_note"})))


def test_external_email_requires_an_approval():
    with pytest.raises(PermanentToolError):
        asyncio.run(invoke("comms.email", {"to": "x@technova.io", "subject": "s", "body": "b"}, CTX))
    assert db.query_one("SELECT COUNT(*) n FROM outbox")["n"] == 0


def test_budget_lines_are_all_or_nothing():
    changes = [{"line_id": "bl-swag", "new": 25000, "expect": 100000},
               {"line_id": "bl-food", "new": 100000, "expect": 300000}]      # below floor
    with pytest.raises(PermanentToolError):
        asyncio.run(invoke("budget.set_lines", {"changes": changes}, CTX))
    assert db.query_one("SELECT amount FROM budget_lines WHERE id='bl-swag'")["amount"] == 100000

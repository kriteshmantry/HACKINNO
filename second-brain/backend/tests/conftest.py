import os
import tempfile
from pathlib import Path

import pytest

# isolated DB + offline LLM + fast retries for every test run (set before backend imports)
_tmp = Path(tempfile.mkdtemp(prefix="sb-test-"))
os.environ.setdefault("SB_DB_PATH", str(_tmp / "test.db"))
os.environ.setdefault("SB_LLM_MODE", "off")
os.environ.setdefault("SB_TOOL_BASE_DELAY_S", "0.01")
os.environ.setdefault("SB_TOOL_TIMEOUT_S", "2")
os.environ.setdefault("SB_APPROVAL_TIMEOUT_S", "10")

from backend import db  # noqa: E402
from backend.tools import breaker, registry  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_db():
    registry.FAULTS.clear()
    breaker.reset()
    db.reset()
    yield

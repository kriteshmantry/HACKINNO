"""SQLite access: schema, transactions, seed/reset, snapshots.

Every write goes through `tx()` which opens a fresh connection and takes the write
lock up front (BEGIN IMMEDIATE), so a tool's write and its idempotency record commit
together or not at all.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator

from . import config

SCHEMA = """
CREATE TABLE sponsors (id TEXT PRIMARY KEY, name TEXT, tier TEXT, committed_amount INTEGER,
  received_amount INTEGER, status TEXT, domain TEXT, contact TEXT, version INTEGER DEFAULT 1);
CREATE TABLE other_income (id TEXT PRIMARY KEY, source TEXT, amount INTEGER);
CREATE TABLE budget_lines (id TEXT PRIMARY KEY, category TEXT, amount INTEGER, floor INTEGER,
  priority INTEGER, funded_by TEXT, cuttable INTEGER, public INTEGER, owner TEXT, status TEXT DEFAULT 'ok');
CREATE TABLE deliverables (id TEXT PRIMARY KEY, sponsor_id TEXT, kind TEXT, spec TEXT, deadline TEXT,
  status TEXT, owner TEXT);
CREATE TABLE calendar_events (id TEXT PRIMARY KEY, title TEXT, date TEXT, owner TEXT, linked_entity TEXT,
  status TEXT, notes TEXT DEFAULT '[]');
CREATE TABLE org_approvals (id TEXT PRIMARY KEY, subject TEXT, approver TEXT, amount INTEGER, status TEXT,
  linked_line TEXT, notes TEXT DEFAULT '[]');
CREATE TABLE promo_assets (id TEXT PRIMARY KEY, kind TEXT, text TEXT, published INTEGER, sponsor_ids TEXT,
  flags TEXT DEFAULT '[]');
CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT, sponsor_id TEXT, body TEXT, notes TEXT DEFAULT '[]');
CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT, role TEXT, email TEXT);
CREATE TABLE entity_aliases (alias TEXT PRIMARY KEY, entity_id TEXT, kind TEXT, role TEXT);
CREATE TABLE facts (id TEXT PRIMARY KEY, entity TEXT, predicate TEXT, value TEXT, valid_from TEXT,
  valid_to TEXT, superseded_by TEXT, source_ref TEXT, confidence REAL);
CREATE TABLE messages (id TEXT PRIMARY KEY, channel TEXT, sender TEXT, sender_name TEXT, subject TEXT,
  body TEXT, received_at TEXT, processed INTEGER DEFAULT 0, triage TEXT, reply_to TEXT, in_reply_to TEXT);
CREATE TABLE verifications (id TEXT PRIMARY KEY, run_id TEXT, message_id TEXT, sender TEXT, sponsor_id TEXT,
  status TEXT, trust REAL, certainty REAL, overall REAL, report TEXT, claimed TEXT, question TEXT,
  recommended TEXT, outreach TEXT, verdict TEXT, verdict_args TEXT, reply_message_id TEXT, decided_by TEXT,
  created_at TEXT, decided_at TEXT);
CREATE TABLE sender_reputation (sender TEXT PRIMARY KEY, confirmed INTEGER DEFAULT 0, corrected INTEGER DEFAULT 0,
  rejected INTEGER DEFAULT 0, updated_at TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE negotiations (id TEXT PRIMARY KEY, sponsor_id TEXT, run_id TEXT, status TEXT, analysis TEXT,
  draft TEXT, outbox_id INTEGER, reply_message_id TEXT, reply_run_id TEXT, outcome TEXT, created_at TEXT,
  decided_at TEXT);
CREATE TABLE gaps (sponsor_id TEXT PRIMARY KEY, amount INTEGER, note TEXT, source_ref TEXT);
CREATE TABLE pending_updates (line_id TEXT PRIMARY KEY, intended_amount INTEGER, current_amount INTEGER,
  note TEXT, status TEXT);
CREATE TABLE runs (id TEXT PRIMARY KEY, message_id TEXT, change_id TEXT, state TEXT, state_json TEXT,
  started_at TEXT, updated_at TEXT);
CREATE TABLE approvals_queue (id TEXT PRIMARY KEY, run_id TEXT, action_id TEXT, action_key TEXT, tool TEXT,
  status TEXT, original_args TEXT, final_args TEXT, preview TEXT, risk_score INTEGER, risk_reasons TEXT,
  rationale TEXT, evidence_refs TEXT, reason TEXT, decided_by TEXT, created_at TEXT, decided_at TEXT);
CREATE TABLE idempotency (key TEXT PRIMARY KEY, tool TEXT, change_id TEXT, result_json TEXT, created_at TEXT);
CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, idem_key TEXT UNIQUE, channel TEXT,
  recipient TEXT, cc TEXT, subject TEXT, body TEXT, external INTEGER, status TEXT, approval_id TEXT,
  change_id TEXT, created_at TEXT);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts TEXT, agent TEXT, type TEXT,
  message TEXT, evidence_refs TEXT, payload_json TEXT);
CREATE TABLE snapshots (run_id TEXT, phase TEXT, state_json TEXT, PRIMARY KEY (run_id, phase));
CREATE TABLE episodes (run_id TEXT PRIMARY KEY, summary TEXT, created_at TEXT);
CREATE INDEX idx_events_run ON events(run_id, id);
"""

TABLES = [line.split()[2] for line in SCHEMA.splitlines() if line.startswith("CREATE TABLE")]
JSON_COLS = {"notes", "flags", "sponsor_ids", "original_args", "final_args", "preview",
             "risk_reasons", "evidence_refs", "payload_json", "triage", "cc", "report", "claimed",
             "outreach", "verdict_args", "analysis", "draft"}


def connect() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, timeout=30, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def _row(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    for k in JSON_COLS & d.keys():
        if isinstance(d[k], str):
            try:
                d[k] = json.loads(d[k])
            except json.JSONDecodeError:
                pass
    return d


def query(sql: str, params: tuple = (), conn: sqlite3.Connection | None = None) -> list[dict]:
    own = conn is None
    conn = conn or connect()
    try:
        return [_row(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        if own:
            conn.close()


def query_one(sql: str, params: tuple = (), conn: sqlite3.Connection | None = None) -> dict | None:
    rows = query(sql, params, conn)
    return rows[0] if rows else None


def execute(sql: str, params: tuple = ()) -> None:
    with tx() as conn:
        conn.execute(sql, params)


def _insert(conn: sqlite3.Connection, table: str, row: dict[str, Any]) -> None:
    row = {k: (json.dumps(v) if isinstance(v, (list, dict)) else v) for k, v in row.items()}
    cols = ", ".join(row)
    conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))


def reset() -> None:
    """Drop everything and reseed. Deterministic: the same seed gives the same DB."""
    workspace = json.loads((config.SEED_DIR / "workspace.json").read_text(encoding="utf-8"))
    messages = json.loads((config.SEED_DIR / "messages.json").read_text(encoding="utf-8"))
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        for t in TABLES:
            conn.execute(f"DROP TABLE IF EXISTS {t}")
        for stmt in SCHEMA.strip().split(";"):
            if stmt.strip():
                conn.execute(stmt)
        for table, rows in workspace.items():
            for r in rows:
                _insert(conn, table, r)
        for m in messages:
            _insert(conn, "messages", m)
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def ensure_db() -> None:
    try:
        query_one("SELECT 1 FROM sponsors LIMIT 1")
    except sqlite3.OperationalError:
        reset()


# --- read models used by agents and the API --------------------------------------------

def workspace_state() -> dict:
    return {
        "sponsors": query("SELECT * FROM sponsors ORDER BY committed_amount DESC"),
        "other_income": query("SELECT * FROM other_income"),
        "budget_lines": query("SELECT * FROM budget_lines ORDER BY id"),
        "deliverables": query("SELECT * FROM deliverables ORDER BY id"),
        "calendar_events": query("SELECT * FROM calendar_events ORDER BY date"),
        "org_approvals": query("SELECT * FROM org_approvals ORDER BY id"),
        "promo_assets": query("SELECT * FROM promo_assets ORDER BY id"),
        "docs": query("SELECT * FROM docs ORDER BY id"),
        "gaps": query("SELECT * FROM gaps"),
        "pending_updates": query("SELECT * FROM pending_updates"),
        "facts": query("SELECT * FROM facts ORDER BY entity, predicate, valid_from"),
        "budget_summary": budget_summary(),
    }


def budget_summary() -> dict:
    income = (query_one("SELECT COALESCE(SUM(committed_amount),0) s FROM sponsors WHERE status='active'")["s"]
              + query_one("SELECT COALESCE(SUM(amount),0) s FROM other_income")["s"])
    expense = query_one("SELECT COALESCE(SUM(amount),0) s FROM budget_lines")["s"]
    gap = query_one("SELECT COALESCE(SUM(amount),0) s FROM gaps")["s"]
    pending = query_one("SELECT COALESCE(SUM(current_amount - intended_amount),0) s FROM pending_updates "
                        "WHERE status='pending'")["s"]
    return {"income": income, "expense": expense, "shortfall": expense - income,
            "recorded_gap": gap, "pending_reductions": pending}


def snapshot(run_id: str, phase: str) -> None:
    state = json.dumps(workspace_state(), default=str)
    with tx() as conn:
        conn.execute("INSERT OR REPLACE INTO snapshots VALUES (?,?,?)", (run_id, phase, state))

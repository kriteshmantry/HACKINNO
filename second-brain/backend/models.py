"""Typed contracts passed between agents. Every LLM output and plan is validated against these."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class TriageResult(BaseModel):
    label: Literal["relevant", "noise", "suspicious"]
    reasons: list[str] = []


class LLMExtraction(BaseModel):
    """Exactly what Claude is asked to report about one message. Ids, the source label and every
    score are set in code; amounts it reports are re-checked against the text before use."""
    sponsor_mention: str = Field(description="The sponsor exactly as written in the message, e.g. 'TechNova' or 'TN'. "
                                             "Empty string if no sponsor is named.")
    new_amount: int | None = Field(description="The newly committed amount in rupees as an integer "
                                               "(₹3,00,000 -> 300000, 3L or 3 lakh -> 300000, 3.5L -> 350000). "
                                               "Null if the message states no new amount.")
    old_amount: int | None = Field(description="The previous amount in rupees if the message itself states it, else null.")
    effective_date: str | None = Field(description="Date the change takes effect if stated (YYYY-MM-DD), else null.")
    evidence_span: str = Field(description="The shortest exact substring of the message, copied character for character, "
                                           "that states the new amount. Empty string if there is none.")
    ambiguity_notes: list[str] = Field(description="Each word or phrase that makes the amount uncertain or not final, "
                                                   "e.g. 'probably', 'around', 'subject to board approval'. Empty if none.")
    self_confidence: float = Field(description="Your own confidence from 0 to 1 that new_amount is the final, committed "
                                               "amount. Logged for comparison only.")


class ExtractedChange(BaseModel):
    """What the Communication agent read out of one message (LLM or regex)."""
    sponsor_mention: str
    old_amount: int | None = None
    new_amount: int | None = None
    effective_date: str | None = None
    ambiguity_notes: list[str] = []
    evidence_span: str = ""
    evidence_message_id: str = ""
    llm_confidence: float | None = None
    source: Literal["llm", "cache", "cache-fallback", "rules"] = "rules"


class TrustSignal(BaseModel):
    """One observable reason a score moved, e.g. ('lookalike_domain', -0.45, 'techn0va-billing.com
    imitates technova.io')."""
    signal: str
    delta: float
    detail: str


class TrustReport(BaseModel):
    """Two separate questions about one message, scored from visible signals:
    trust     = is the sender who they claim to be?
    certainty = is the change itself clear and final?
    The gate (overall) is the weaker of the two: a precise email from an impostor and a genuine
    but hedged email both stop for a person."""
    message_id: str
    sender: str
    sponsor_id: str | None = None
    trust: float
    trust_signals: list[TrustSignal]
    certainty: float | None = None
    certainty_signals: list[str] = []
    overall: float
    band: Literal["autonomous", "supervised", "clarify"]
    route: str
    known_contact: str | None = None
    claimed_amount: int | None = None


class ResolvedChange(BaseModel):
    change_id: str                     # the source message id; idempotency is keyed on it
    sponsor_id: str
    sponsor_name: str
    resolution_method: str
    old_amount: int
    new_amount: int
    old_tier: str
    new_tier: str
    shortfall: int                     # old - new (negative = increase)
    confidence: float
    band: Literal["autonomous", "supervised", "clarify"]
    confidence_reasons: list[str]
    contradiction: dict | None = None
    human_confirmed: bool = False
    evidence_refs: list[str] = []
    # Email Trust Score: confidence (the gate) = min(certainty, trust)
    certainty: float | None = None
    trust: float | None = None
    trust_signals: list[TrustSignal] = []
    known_contact: str | None = None


class ImpactNode(BaseModel):
    node: str
    type: str
    label: str
    path: list[str]                    # [node, edge_type, node, edge_type, ...]
    depth: int
    severity: Literal["high", "medium", "low"]


class ImpactReport(BaseModel):
    root: str
    nodes: list[ImpactNode]


class Option(BaseModel):
    id: Literal["A", "B", "C", "H"]          # H = amounts a person set while approving
    name: str
    strategy: str
    cuts: dict[str, int]               # line_id -> new amount
    reductions: dict[str, int]         # line_id -> amount removed
    coverage: float                    # 0..1 of the shortfall
    open_gap: int
    public_changes: int
    approvals_affected: list[str]
    violations: list[str]
    score: float
    recommended: bool = False


class PlannedAction(BaseModel):
    id: str
    key: str                           # semantic key, stable across plan versions
    tool: str
    args: dict[str, Any]
    depends_on: list[str] = []
    rationale: str
    evidence_refs: list[str] = []
    money_delta: int | None = None
    risk_score: int = 0
    risk_reasons: list[str] = []
    requires_approval: bool = False
    status: str = "pending"            # pending|running|awaiting_approval|done|skipped_duplicate|
                                       # rejected_by_human|failed|blocked|replaced
    result: Any = None
    error: str | None = None
    approval_id: str | None = None
    # set on a repair after an outside edit: the write is re-applied under this idempotency scope
    idem_scope: str | None = None


class Plan(BaseModel):
    run_id: str
    version: int
    option_id: str | None
    actions: list[PlannedAction]
    planner: str = "template"


class VerificationCheck(BaseModel):
    id: str
    name: str
    ok: bool
    expected: Any = None
    actual: Any = None


class VerificationReport(BaseModel):
    ok: bool
    checks: list[VerificationCheck]


class RunState(BaseModel):
    id: str
    message_id: str
    change_id: str
    state: str = "INGEST"
    triage: TriageResult | None = None
    extracted: ExtractedChange | None = None
    resolved: ResolvedChange | None = None
    impact: ImpactReport | None = None
    options: list[Option] = []
    chosen_option: str | None = None
    option_chosen_by: str | None = None
    plan: Plan | None = None
    plan_history: list[Plan] = []
    replans: int = 0
    rejected_keys: list[str] = []
    degraded_tools: list[str] = []
    verification: VerificationReport | None = None
    clarification: dict | None = None
    outcome: str | None = None
    error: str | None = None
    option_wait_s: float = 0.0
    meta: dict[str, Any] = Field(default_factory=dict)

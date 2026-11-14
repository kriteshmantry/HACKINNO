/**
 * Domain types + the event contract shared with the FastAPI backend.
 * Field names are snake_case on purpose: they are the wire format (see INTEGRATION.md).
 */

export type AgentId = 'Coordinator' | 'Communication' | 'Knowledge' | 'Planning' | 'Execution' | 'Verification'
export const AGENTS: AgentId[] = ['Coordinator', 'Communication', 'Knowledge', 'Planning', 'Execution', 'Verification']
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'done' | 'error'

export type RunStateName =
  | 'IDLE' | 'INGEST' | 'TRIAGE' | 'EXTRACT' | 'RESOLVE' | 'AWAIT_CLARIFICATION' | 'ANALYZE' | 'OPTIONS'
  | 'PLAN' | 'VALIDATE' | 'EXECUTE' | 'AWAIT_APPROVAL' | 'VERIFY' | 'REPLAN' | 'PREEMPTED' | 'DONE'
  | 'ESCALATE' | 'IGNORED' | 'QUARANTINED'

export type ScenarioId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
export type Band = 'autonomous' | 'supervised' | 'clarify'
export type Severity = 'high' | 'medium' | 'low'
export type FaultMode = 'off' | 'once' | 'always' | 'slow'

/* ---------- source apps ---------- */
export interface InboxMessage {
  id: string
  channel: 'email' | 'chat'
  from: string
  from_role?: string
  address?: string // email sender
  chat_channel?: string // e.g. #sponsorships
  subject?: string
  body: string
  at: string // ISO
}

/* ---------- world state (the simulated apps) ---------- */
export interface Sponsor { id: string; name: string; tier: string; committed: number; received: number; status: string; version: number }
export interface IncomeLine { id: string; source: string; amount: number; sponsor_id?: string }
export interface BudgetLine { id: string; category: string; amount: number; floor: number; priority: number | null; funded_by?: string; cuttable: boolean; status: string }
export interface Deliverable { id: string; sponsor_id: string; kind: string; spec: string; deadline?: string; status: 'active' | 'removed' | 'changed' }
export interface CalendarEvent { id: string; title: string; date: string; owner: string; linked?: string; status: 'scheduled' | 'cancelled'; note?: string; expected_amount?: number }
export interface OrgApproval { id: string; subject: string; approver: string; amount: number; status: 'pending' | 'approved' | 'on_hold' | 'amended' }
export interface PromoAsset { id: string; kind: string; text: string; published: boolean; status: 'live' | 'flagged' }
export interface DocNote { id: string; doc: string; text: string; change_id: string }
export interface OutboxItem { id: string; channel: 'email' | 'chat'; to: string; cc?: string[]; subject?: string; body: string; status: 'queued' | 'sent'; approval_id?: string; change_id: string }
export interface Task { id: string; title: string; owner: string; status: 'open' | 'done' }

export interface WorldState {
  sponsors: Sponsor[]
  income: IncomeLine[]
  budget: BudgetLine[]
  deliverables: Deliverable[]
  calendar: CalendarEvent[]
  approvals: OrgApproval[]
  promo: PromoAsset[]
  docs: DocNote[]
  outbox: OutboxItem[]
  tasks: Task[]
}
export type WorldTable = keyof WorldState

/* ---------- knowledge graph ---------- */
export type NodeKind = 'Sponsor' | 'Tier' | 'Budget' | 'BudgetLine' | 'Deliverable' | 'CalendarEvent' | 'OrgApproval' | 'Doc' | 'PromoAsset' | 'Person' | 'Message'
export type EdgeKind = 'funds' | 'has_tier' | 'entitles' | 'scheduled_as' | 'depicted_in' | 'approves' | 'owned_by' | 'mentions'
  | 'contributes_to' | 'pays_by' | 'documented_in' | 'allocates'
export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  sub?: string
  /** which world row (and optionally field) this node shows, for live values and "updated" marks */
  ref?: { table: WorldTable; id: string; field?: string }
  /** raw attributes from the backend graph (status, date, published...) used for severity */
  attrs?: Record<string, unknown>
}
export interface GraphEdge { id: string; source: string; target: string; kind: EdgeKind }
export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[] }
export interface ImpactNode {
  node: string
  /** alternating node ids and edge kinds: [root, 'funds', 'bl-prizes', 'approves', 'oa-2'] */
  path: string[]
  depth: number
  severity: Severity
  why: string
}

/* ---------- reasoning artefacts ---------- */
export interface ConfidenceReason { delta: number; label: string }
export interface TrustSignal { signal: string; delta: number; detail: string }
export interface Confidence {
  score: number; band: Band; reasons: ConfidenceReason[]; llm_self_reported?: number
  /** Email Trust Score: the gate (score) is the weaker of the two */
  certainty?: number; trust?: number; gated_by?: 'trust' | 'certainty'; trust_signals?: TrustSignal[]
}

export interface ExtractedChange {
  change_id: string
  message_id: string
  entity_mention: string
  predicate: 'committed_amount'
  old_value?: number
  new_value: number
  span: string
  source: 'llm' | 'cache' | 'regex'
  regex_amount?: number
}
export interface Resolution { mention: string; entity_id: string | null; entity_name?: string; method: 'alias' | 'domain' | 'person' | 'fuzzy' | 'unresolved'; score: number; note?: string }

export interface Fact {
  id: string
  entity: string
  predicate: string
  value: number
  valid_from: string
  valid_to?: string
  superseded_by?: string
  source_ref: string
  confidence: number
  status: 'current' | 'superseded' | 'proposed'
}

export interface OptionCut { line_id: string; category: string; from: number; to: number }
export interface ShortfallOption {
  id: 'A' | 'B' | 'C' | 'H' // H = amounts you set while approving
  name: string
  strategy: string
  cuts: OptionCut[]
  coverage: number // 0..1
  open_gap: number
  public_changes: number
  approvals_affected: number
  policy_violations: number
  notes?: string
}

export type ActionStatus =
  | 'pending' | 'running' | 'retrying' | 'awaiting_approval' | 'done' | 'failed'
  | 'replaced' | 'skipped_duplicate' | 'rejected' | 'superseded' | 'blocked'

export interface PlannedAction {
  id: string
  tool: string
  title: string
  target_nodes: string[]
  args: Record<string, unknown>
  risk: number
  risk_reasons: string[]
  requires_approval: boolean
  level: number
  depends_on: string[]
  evidence_refs: string[]
  external?: boolean
  learned?: string // badge text when a learned preference shaped this action
  diff?: 'added' | 'changed' | 'carried' // set on plan v2+
}
export interface Plan {
  version: number
  source: 'template' | 'llm' | 'llm-cache'
  option: 'A' | 'B' | 'C' | 'H'
  change_id: string
  rationale: string
  actions: PlannedAction[]
  removed?: { id: string; title: string; reason: string }[]
}

export interface DiffRow { field: string; from: string; to: string }
export interface Approval {
  id: string
  action_id: string
  title: string
  tool: string
  external: boolean
  risk: number
  risk_reasons: string[]
  rationale: string
  diff: DiffRow[]
  args: Record<string, unknown>
  editable: string[]
  evidence: { ref: string; quote: string }[]
  band: Band
  status: 'pending' | 'approved' | 'rejected' | 'edited' | 'expired'
  learned?: string
}
export type ApprovalDecision = { decision: 'approve' | 'reject' | 'edit'; args?: Record<string, unknown>; reason?: string }

export interface VerifyCheck { id: string; label: string; pass: boolean; expected: string; actual: string }

export interface TraceLink {
  kind: 'message' | 'fact' | 'graph' | 'computed' | 'action' | 'approval' | 'tool' | 'verify'
  title: string
  detail: string
  ref?: string
  quote?: string
  ok?: boolean
}

export interface ContextPacket {
  agent: AgentId
  task: string
  facts: string[]
  evidence: { ref: string; quote: string }[]
  subgraph: string[]
  computed: Record<string, string | number>
  tools: string[]
  policies: string[]
  preferences: string[]
  excluded: string[]
  token_estimate: number
  hash: string
}

export interface Preference { id: string; scope: string; rule: string; source_ref: string; learned_in_run: string }
export interface Episode { run_id: string; summary: string; at: string }

/* ---------- event contract ---------- */
export type EventType =
  | 'run.started' | 'state' | 'agent.status' | 'agent.handoff'
  | 'message.arrived' | 'message.triaged' | 'llm.call'
  | 'change.extracted' | 'entity.resolved' | 'confidence' | 'memory.contradiction'
  | 'impact' | 'computed' | 'options' | 'option.chosen'
  | 'plan' | 'plan.validated' | 'plan.rejected'
  | 'action.status' | 'tool.success' | 'tool.retry' | 'tool.failed' | 'tool.skipped_duplicate' | 'breaker.open'
  | 'approval.requested' | 'approval.decided' | 'approval.expired' | 'preference.learned'
  | 'world.patch' | 'fact.added' | 'fact.superseded' | 'outbox.queued'
  | 'preempted' | 'verify.check' | 'verify.summary'
  | 'run.done' | 'run.escalated' | 'run.waiting' | 'run.quarantined' | 'episode'
  | 'clarification.requested' | 'clarification.answered' | 'log'
  | 'trust.scored' | 'negotiation.available' | 'verification.outreach' | 'outreach.sent'

export interface RunEvent<P = any> {
  id: number
  run_id: string
  ts: string
  agent: AgentId
  type: EventType
  message: string
  evidence_refs: string[]
  payload: P
}

/** A question the backend asks a person before it will act (low-confidence change). */
export interface Clarification {
  question: string; reasons: string[]; draft?: string; amount?: number
  /** set when the backend opened an item in the verification queue */
  verification_id?: string; recommended?: 'ask_sender' | 'confirm_or_correct'; low_trust?: boolean; contact?: string
}

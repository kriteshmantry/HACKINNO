import type {
  AgentId, ApprovalDecision, ContextPacket, Episode, Fact, FaultMode, GraphData, InboxMessage,
  Preference, RunEvent, ScenarioId, TraceLink, WorldState,
} from '@/lib/types'

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'closed'

/** Facts about a backend the UI needs up front: names, ids and which features exist. */
export interface BackendProfile {
  eventName: string
  /** entity id of the sponsor the scenarios are about (s-technova on the API, sp-technova in the simulator) */
  primarySponsor: string
  triggerMessage: string
  /** the tool the fault buttons break */
  faultTool: string
  treasurerEmail: string
  /** fixed scenario clock used for deadline maths */
  now: string
  scenarios: Record<ScenarioId, { name: string; hint: string }>
  caps: {
    /** a newer message can pause a running plan and replan the difference */
    preemption: boolean
    /** per-agent context packets can be inspected */
    context: boolean
    /** edits to approvals are learned as preferences */
    preferences: boolean
    /** low-confidence changes ask a person a question (instead of drafting an email for approval) */
    clarifyQuestion: boolean
  }
}

/**
 * The single seam between UI and backend. Implementations:
 *  - HttpBackend: the FastAPI server (REST commands + SSE), translated by http/adapter.ts
 *  - MockBackend: an in-browser simulation of the pipeline (offline fallback)
 *  - AutoBackend: uses the API when it answers, otherwise falls back to the simulator
 * Every UI panel is derived from RunEvents, so all of them look the same to the UI.
 */
export interface Backend {
  readonly kind: 'mock' | 'http'
  readonly profile: BackendProfile
  /** resolves once the implementation is chosen and reachable */
  ready(): Promise<void>

  reset(): Promise<void>
  getState(): Promise<WorldState>
  getInbox(): Promise<InboxMessage[]>
  getGraph(runId?: string): Promise<GraphData>
  getFacts(entity: string): Promise<Fact[]>
  getMemory(): Promise<{ preferences: Preference[]; episodes: Episode[] }>
  forgetPreferences(): Promise<void>

  startScenario(s: ScenarioId): Promise<{ run_id: string }>
  /** Subscribe to a run's events. Must replay past events first (Last-Event-ID semantics). */
  subscribe(runId: string, onEvent: (e: RunEvent) => void, onStatus: (s: StreamStatus) => void): () => void

  chooseOption(runId: string, optionId: string): Promise<void>
  decideApproval(approvalId: string, d: ApprovalDecision): Promise<void>
  answerClarification?(runId: string, decision: 'confirm' | 'dismiss', amount?: number): Promise<void>
  /** Deliver a new message. If the backend starts a new run for it, it returns that run's id. */
  injectMessage(messageId: string): Promise<{ run_id?: string } | void>
  setFault(tool: string, mode: FaultMode): Promise<void>
  /** Break a deliverable outside the system. If a new run re-checks it, its id is returned. */
  corrupt(): Promise<{ run_id?: string } | void>
  redeliver(messageId: string): Promise<{ run_id: string }>

  getTrace(runId: string, actionId: string): Promise<TraceLink[]>
  getContext(runId: string, agent: AgentId): Promise<ContextPacket | null>
  exportLog(runId: string): Promise<RunEvent[]>
  /** The workspace as it was when the run started (for before/after after a page reload). */
  getBaseline?(runId: string): Promise<WorldState | null>
}

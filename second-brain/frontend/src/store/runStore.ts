/**
 * Event-sourced UI store. Every panel derives from RunEvents, so the UI always agrees
 * with the audit log, survives refresh via replay, and works with either backend.
 */
import { create } from 'zustand'
import { backend } from '@/backend'
import type { StreamStatus } from '@/backend/Backend'
import type {
  AgentId, AgentStatus, Approval, ApprovalDecision, Clarification, Confidence, Episode, ExtractedChange, Fact,
  FaultMode, GraphData, ImpactNode, InboxMessage, Plan, Preference, Resolution, RunEvent, RunStateName,
  ScenarioId, ShortfallOption, VerifyCheck, WorldState, ActionStatus,
} from '@/lib/types'
import { AGENTS } from '@/lib/types'

export type DockTab = 'options' | 'plan' | 'state' | 'checks' | 'memory'
export interface AgentCard { status: AgentStatus; note: string; at?: string }
export interface Outcome { kind: 'done' | 'escalated' | 'waiting' | 'quarantined' | 'preempted' | 'error'; text: string; detail?: string }
export interface Computed { shortfall: number; old_tier: string; new_tier: string; income_before: number; income_after: number; deliverable_diff: string[] }

const idleAgents = () => Object.fromEntries(AGENTS.map((a) => [a, { status: 'idle', note: 'Ready' }])) as Record<AgentId, AgentCard>

interface RunSlice {
  runId?: string
  streamStatus: StreamStatus | 'idle'
  state: RunStateName
  visited: RunStateName[]
  startedAt?: string
  trigger?: string
  agents: Record<AgentId, AgentCard>
  handoff?: { from: AgentId; to: AgentId; summary: string; key: number }
  triage: Record<string, { verdict: 'relevant' | 'noise' | 'suspicious'; reasons: string[] }>
  extraction?: ExtractedChange
  resolution?: Resolution
  confidence?: Confidence
  contradiction?: { old_fact: Fact; new_claim: number; source_old: string; source_new: string }
  impact: ImpactNode[]
  impactKey: number
  computed?: Computed
  options: ShortfallOption[]
  recommended?: string
  optionRationale?: string
  chosen?: string
  plans: Plan[]
  viewPlan?: number
  validated: Record<number, { label: string; pass: boolean }[]>
  statuses: Record<string, ActionStatus>
  approvals: Record<string, Approval>
  log: RunEvent[]
  checks: VerifyCheck[]
  outcome?: Outcome
  touched: Record<string, number>
  llmCalls: number
  replans: number
  preempted?: { by: string; kept: string[]; superseded: string[] }
  clarification?: Clarification & { answered?: boolean }
}

// Every optional key is listed explicitly so a new run fully clears the previous one.
const emptyRun = (): RunSlice => ({
  runId: undefined, startedAt: undefined, trigger: undefined, handoff: undefined, extraction: undefined,
  resolution: undefined, confidence: undefined, contradiction: undefined, computed: undefined, recommended: undefined,
  optionRationale: undefined, chosen: undefined, viewPlan: undefined, outcome: undefined, preempted: undefined, clarification: undefined,
  streamStatus: 'idle', state: 'IDLE', visited: [], agents: idleAgents(), triage: {}, impact: [], impactKey: 0,
  options: [], plans: [], validated: {}, statuses: {}, approvals: {}, log: [], checks: [], touched: {}, llmCalls: 0, replans: 0,
})

interface Store extends RunSlice {
  ready: boolean
  error?: string
  world?: WorldState
  baseline?: WorldState
  inbox: InboxMessage[]
  graph?: GraphData
  facts: Fact[]
  preferences: Preference[]
  episodes: Episode[]
  fault: FaultMode
  scenario?: ScenarioId
  tab: DockTab
  selectedNode?: string
  focusMessage?: { id: string; key: number }
  modalApproval?: string
  modalDismissed: boolean
  traceAction?: string
  contextAgent?: AgentId
  toast?: { text: string; tone: 'note' | 'ok' | 'wait' | 'fail'; key: number }

  init(): Promise<void>
  start(s: ScenarioId): Promise<void>
  reset(): Promise<void>
  chooseOption(id: string): Promise<void>
  decide(id: string, d: ApprovalDecision): Promise<void>
  inject(): Promise<void>
  setFault(m: FaultMode): Promise<void>
  corrupt(): Promise<void>
  clarify(decision: 'confirm' | 'dismiss', amount?: number): Promise<void>
  resume(runId: string): Promise<void>
  redeliver(): Promise<void>
  forgetPreferences(): Promise<void>
  exportLog(): Promise<void>
  set<K extends keyof Store>(k: K, v: Store[K]): void
  openApproval(id?: string): void
  focusMsg(id: string): void
}

let unsubscribe: (() => void) | undefined
let refreshTimer: number | undefined

export const useRun = create<Store>((set, get) => {
  const fail = (e: unknown) => set({ toast: { text: e instanceof Error ? e.message : String(e), tone: 'fail', key: Date.now() } })

  const refreshWorld = () => {
    clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(async () => {
      try {
        const [world, facts, mem] = await Promise.all([backend.getState(), backend.getFacts(backend.profile.primarySponsor), backend.getMemory()])
        set({ world, facts, preferences: mem.preferences, episodes: mem.episodes })
      } catch (e) { fail(e) }
    }, 120)
  }

  const attach = (runId: string) => {
    unsubscribe?.()
    unsubscribe = backend.subscribe(runId, (e) => apply(e), (s) => set({ streamStatus: s }))
  }

  /** The reducer: one RunEvent in, derived UI state out. */
  const apply = (e: RunEvent) => {
    const s = get()
    if (s.runId && e.run_id !== s.runId) return
    const p = e.payload ?? {}
    const patch: Partial<Store> = { log: [e, ...s.log] }
    switch (e.type) {
      case 'run.started':
        patch.startedAt = e.ts
        patch.trigger = p.message_id
        break
      case 'state': {
        patch.state = p.to
        if (!s.visited.includes(p.to)) patch.visited = [...s.visited, p.to]
        if (p.to === 'REPLAN') patch.replans = s.replans + 1
        break
      }
      case 'agent.status':
        patch.agents = { ...s.agents, [p.agent]: { status: p.status, note: p.note, at: e.ts } }
        break
      case 'agent.handoff':
        patch.handoff = { from: p.from, to: p.to, summary: p.summary, key: e.id }
        break
      case 'message.arrived':
        if (!s.inbox.some((m) => m.id === p.message.id)) patch.inbox = [...s.inbox, p.message]
        break
      case 'message.triaged':
        patch.triage = { ...s.triage, [p.message_id]: { verdict: p.verdict, reasons: p.reasons } }
        break
      case 'llm.call':
        patch.llmCalls = s.llmCalls + 1
        break
      case 'change.extracted':
        patch.extraction = p.change
        break
      case 'entity.resolved':
        patch.resolution = p.resolution
        break
      case 'confidence':
        patch.confidence = p.confidence
        break
      case 'memory.contradiction':
        patch.contradiction = p
        break
      case 'impact':
        patch.impact = p.nodes
        patch.impactKey = s.impactKey + 1
        break
      case 'computed':
        patch.computed = p
        break
      case 'options':
        patch.options = p.options
        patch.recommended = p.recommended
        patch.optionRationale = p.rationale
        patch.chosen = undefined
        patch.tab = 'options'
        break
      case 'option.chosen':
        patch.chosen = p.option_id
        break
      case 'plan': {
        const plan = p.plan as Plan
        const statuses = { ...s.statuses }
        for (const a of plan.actions) if (!statuses[a.id]) statuses[a.id] = 'pending'
        patch.plans = [...s.plans.filter((x) => x.version !== plan.version), plan]
        patch.viewPlan = plan.version
        patch.statuses = statuses
        patch.tab = 'plan'
        break
      }
      case 'plan.validated':
        patch.validated = { ...s.validated, [p.version]: p.checks }
        break
      case 'action.status':
        patch.statuses = { ...s.statuses, [p.action_id]: p.status }
        break
      case 'approval.requested': {
        const ap = p.approval as Approval
        patch.approvals = { ...s.approvals, [ap.id]: ap }
        if (!s.modalApproval && !s.modalDismissed) patch.modalApproval = ap.id
        break
      }
      case 'approval.decided':
      case 'approval.expired': {
        const ap = s.approvals[p.approval_id]
        if (ap) {
          const status: Approval['status'] = e.type === 'approval.expired' ? 'expired' : p.decision === 'approve' ? 'approved' : p.decision === 'edit' ? 'edited' : 'rejected'
          const approvals = { ...s.approvals, [ap.id]: { ...ap, status } }
          patch.approvals = approvals
          if (s.modalApproval === ap.id) {
            const next = Object.values(approvals).find((x) => x.status === 'pending')
            patch.modalApproval = s.modalDismissed ? undefined : next?.id
          }
          if (e.type === 'approval.expired' && s.modalApproval === ap.id)
            patch.toast = { text: `${ap.id} was superseded by newer information, so it no longer needs a decision`, tone: 'wait', key: e.id }
        }
        break
      }
      case 'preference.learned':
        patch.preferences = [...s.preferences.filter((x) => x.id !== p.preference.id), p.preference]
        patch.toast = { text: `Learned: ${p.preference.rule}`, tone: 'note', key: e.id }
        break
      case 'world.patch': {
        if (!s.world) break
        const table = p.table as keyof WorldState
        const rows = s.world[table] as unknown as Record<string, unknown>[] | undefined
        const row = rows?.find((r) => r.id === p.id)
        if (rows && row) {
          const nextRows = rows.map((r) => (r.id === p.id ? { ...r, [p.field]: p.to } : r))
          patch.world = { ...s.world, [table]: nextRows }
        } else refreshWorld()
        patch.touched = { ...s.touched, [`${p.table}:${p.id}`]: e.id, [`${p.table}:${p.id}:${p.field}`]: e.id }
        break
      }
      case 'fact.added':
      case 'fact.superseded':
      case 'outbox.queued':
      case 'episode':
        refreshWorld()
        break
      case 'preempted':
        patch.preempted = { by: p.by_message, kept: p.kept, superseded: p.superseded }
        patch.toast = { text: `New information in ${p.by_message}: paused at a safe point and replanning only what differs`, tone: 'wait', key: e.id }
        break
      case 'verify.check':
        patch.checks = [...s.checks.filter((c) => c.id !== p.check.id), p.check].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
        if (s.tab !== 'checks' && s.checks.length === 0) patch.tab = 'checks'
        break
      case 'run.done':
        patch.outcome = { kind: 'done', text: e.message, detail: p.summary }
        refreshWorld()
        break
      case 'run.escalated':
        patch.outcome = { kind: 'escalated', text: e.message, detail: [...(p.done ?? []).map((d: string) => `Done: ${d}`), ...(p.not_done ?? []).map((d: string) => `Not done: ${d}`)].join('\n') }
        break
      case 'run.waiting':
        patch.outcome = { kind: 'waiting', text: e.message }
        break
      case 'clarification.requested':
        patch.clarification = { ...p.clarification, amount: s.extraction?.new_value }
        break
      case 'clarification.answered':
        if (s.clarification) patch.clarification = { ...s.clarification, answered: true }
        break
      case 'run.quarantined':
        patch.outcome = { kind: 'quarantined', text: e.message }
        break
    }
    // a fresh verification pass (e.g. after an outside edit) clears the old outcome
    if (e.type === 'state' && p.to === 'VERIFY') { patch.checks = []; patch.outcome = undefined }
    set(patch)
  }

  return {
    ...emptyRun(),
    ready: false,
    inbox: [],
    facts: [],
    preferences: [],
    episodes: [],
    fault: 'off',
    tab: 'options',
    modalDismissed: false,

    async init() {
      try {
        await backend.ready()
        const [world, inbox, graph, facts, mem] = await Promise.all([
          backend.getState(), backend.getInbox(), backend.getGraph(), backend.getFacts(backend.profile.primarySponsor), backend.getMemory(),
        ])
        set({ world, baseline: structuredClone(world), inbox, graph, facts, preferences: mem.preferences, episodes: mem.episodes, ready: true, error: undefined })
        if (backend.fellBack) set({ toast: { text: 'The backend at /api did not answer, so the console is running on the built-in simulator. Start the FastAPI server and reload to use it.', tone: 'wait', key: Date.now() } })
      } catch (e) {
        set({ ready: true, error: `Could not reach the ${backend.kind === 'http' ? 'backend at /api' : 'simulator'}: ${e instanceof Error ? e.message : e}` })
      }
    },

    async start(sc) {
      try {
        unsubscribe?.()
        set({ ...emptyRun(), scenario: sc, selectedNode: undefined, modalApproval: undefined, modalDismissed: false, traceAction: undefined, tab: 'options', toast: undefined })
        const { run_id } = await backend.startScenario(sc)
        if (get().fault !== 'off') await backend.setFault('budget.set_line', get().fault)
        const [world, inbox, facts] = await Promise.all([backend.getState(), backend.getInbox(), backend.getFacts(backend.profile.primarySponsor)])
        set({ runId: run_id, world, baseline: structuredClone(world), inbox, facts })
        attach(run_id)
      } catch (e) { fail(e) }
    },

    async reset() {
      try {
        unsubscribe?.()
        await backend.reset()
        set({ ...emptyRun(), scenario: undefined, selectedNode: undefined, modalApproval: undefined, traceAction: undefined, toast: undefined })
        await get().init()
        if (get().fault !== 'off') await backend.setFault('budget.set_line', get().fault)
      } catch (e) { fail(e) }
    },

    async chooseOption(id) {
      const { runId } = get()
      if (runId) await backend.chooseOption(runId, id).catch(fail)
    },

    async decide(id, d) {
      try {
        await backend.decideApproval(id, d)
      } catch (e) { fail(e) }
    },

    async inject() {
      try {
        const r = await backend.injectMessage('c-11')
        // With no active run the backend starts a new one on top of the current state; follow it.
        if (r?.run_id && r.run_id !== get().runId) {
          unsubscribe?.()
          const world = get().world
          set({ ...emptyRun(), runId: r.run_id, baseline: world ? structuredClone(world) : undefined, modalDismissed: false })
          attach(r.run_id)
        }
      } catch (e) { fail(e) }
    },

    async setFault(m) {
      set({ fault: m })
      await backend.setFault('budget.set_line', m).catch(fail)
    },

    async corrupt() {
      try {
        const r = await backend.corrupt()
        if (r && r.run_id && r.run_id !== get().runId) {
          unsubscribe?.()
          set({ ...emptyRun(), runId: r.run_id, modalDismissed: false })
          attach(r.run_id)
        } else set({ toast: { text: 'Keynote re-enabled outside the system. Verification will catch it before the run finishes.', tone: 'wait', key: Date.now() } })
      } catch (e) { fail(e) }
    },

    async resume(runId) {
      try {
        unsubscribe?.()
        set({ ...emptyRun(), runId, modalDismissed: false })
        const before = await backend.getBaseline(runId)
        if (before) set({ baseline: before })
        attach(runId)
      } catch (e) { fail(e) }
    },

    async clarify(decision, amount) {
      const { runId } = get()
      if (!runId) return
      try { await backend.answerClarification(runId, decision, amount) } catch (e) { fail(e) }
    },

    async redeliver() {
      try {
        const { run_id } = await backend.redeliver('e-19')
        unsubscribe?.()
        set({ ...emptyRun(), runId: run_id, tab: 'plan', modalApproval: undefined })
        const world = await backend.getState()
        set({ world, baseline: structuredClone(world) })
        attach(run_id)
      } catch (e) { fail(e) }
    },

    async forgetPreferences() {
      await backend.forgetPreferences().catch(fail)
      set({ preferences: [] })
    },

    async exportLog() {
      const { runId } = get()
      if (!runId) return
      const events = await backend.exportLog(runId)
      const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `second-brain-${runId}-audit-log.json`
      a.click()
      URL.revokeObjectURL(a.href)
    },

    set(k, v) { set({ [k]: v } as Partial<Store>) },
    openApproval(id) { set({ modalApproval: id, modalDismissed: !id }) },
    focusMsg(id) { set({ focusMessage: { id, key: Date.now() } }) },
  }
})

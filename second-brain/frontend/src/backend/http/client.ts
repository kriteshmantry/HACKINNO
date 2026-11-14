/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Backend, BackendProfile, StreamStatus } from '../Backend'
import type {
  AgentId, ApprovalDecision, ContextPacket, Episode, Fact, FaultMode, GraphData, GraphNode, InboxMessage,
  Preference, RunEvent, ScenarioId, TraceLink, WorldState,
} from '@/lib/types'
import { EventTranslator, mapFacts, mapGraph, mapInbox, mapTrace, mapWorld, type AdapterApi } from './adapter'

const BASE = '/api'
/** Long enough for a person to read the options card and choose one. */
const OPTION_WAIT_S = 900

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(BASE + path, {
    method, signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let detail = ''
    try { const j = await res.json(); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail) } catch { /* not json */ }
    throw new Error(detail ? `The backend refused ${method} ${path}: ${detail}` : `${method} ${path} failed with ${res.status}`)
  }
  const ct = res.headers.get('content-type') || ''
  return (ct.includes('application/json') ? res.json() : undefined) as Promise<T>
}

export const HTTP_PROFILE: BackendProfile = {
  eventName: 'Innovision 2026',
  primarySponsor: 's-technova',
  triggerMessage: 'e-19',
  faultTool: 'budget.set_lines',
  treasurerEmail: 'treasurer@innovision.in',
  now: '2026-11-14T00:00:00',
  scenarios: {
    S1: { name: 'Clear cut', hint: 'TechNova’s CFO cuts ₹5L to ₹3L. Impact, options, approvals, verification' },
    S2: { name: 'Ambiguous', hint: '“Probably around 3L, subject to our board.” Confidence 0.30, so it asks a person and changes nothing' },
    S3: { name: 'Chat relay', hint: 'The sponsorship lead relays “TN: board approved 3.5L final” in chat. “TN” is resolved to TechNova' },
    S4: { name: 'Injection', hint: 'A lookalike-domain email tries to give the system orders. Quarantined at triage' },
  },
  caps: { preemption: false, context: true, preferences: false, clarifyQuestion: true },
}

/** The FastAPI backend in second-brain/backend, spoken to through the adapter. */
export class HttpBackend implements Backend {
  readonly kind = 'http' as const
  readonly profile = HTTP_PROFILE
  private people = new Map<string, string>()
  private graph?: GraphData
  private messageIds = new Set<string>()
  private translators = new Map<string, EventTranslator>()
  private lastMessage = 'e-19'

  async ready() { await req('GET', '/scenarios') }

  private api: AdapterApi = {
    state: () => req<any>('GET', '/state'),
    outbox: () => req<any[]>('GET', '/outbox'),
    approvals: (runId) => req<any[]>('GET', `/approvals?run_id=${encodeURIComponent(runId)}`),
    people: () => this.people,
    graphNode: (id) => this.graph?.nodes.find((n) => n.id === id),
    messageIds: () => this.messageIds,
  }

  private async ensureGraph() {
    if (!this.graph) this.graph = mapGraph(await req<any>('GET', '/graph'), this.profile.primarySponsor, this.people)
    return this.graph
  }

  async reset() { await req('POST', '/reset'); this.translators.clear() }
  async getState(): Promise<WorldState> {
    await this.ensureGraph()
    const [state, outbox] = await Promise.all([req<any>('GET', '/state'), req<any[]>('GET', '/outbox')])
    return mapWorld(state, outbox, this.people)
  }
  async getInbox(): Promise<InboxMessage[]> {
    const rows = await req<any[]>('GET', '/messages')
    this.messageIds = new Set(rows.map((m) => m.id))
    return mapInbox(rows)
  }
  async getGraph(): Promise<GraphData> { this.graph = undefined; return structuredClone(await this.ensureGraph()) }
  async getFacts(entity: string): Promise<Fact[]> { return mapFacts(await req<any[]>('GET', `/memory/facts?entity=${encodeURIComponent(entity)}`)) }
  async getMemory(): Promise<{ preferences: Preference[]; episodes: Episode[] }> { return req('GET', '/memory') }
  async forgetPreferences() { /* not part of this backend yet */ }

  async startScenario(s: ScenarioId) {
    this.translators.clear()
    const r = await req<{ run_id: string; message_id: string }>('POST', `/scenarios/${s}?reset_first=true&option_wait_seconds=${OPTION_WAIT_S}`)
    this.lastMessage = r.message_id
    return { run_id: r.run_id }
  }

  subscribe(runId: string, onEvent: (e: RunEvent) => void, onStatus: (s: StreamStatus) => void) {
    // One translator per run; events are translated strictly in order (some translations read the API).
    const tr = this.translators.get(runId) ?? new EventTranslator(runId, this.api)
    this.translators.set(runId, tr)
    const es = new EventSource(`${BASE}/runs/${encodeURIComponent(runId)}/stream`)
    const seen = new Set<number>()
    let chain = Promise.resolve()
    let closed = false
    onStatus('connecting')
    es.onopen = () => onStatus('live')
    es.onerror = () => onStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting')
    es.onmessage = (m) => {
      let raw: any
      try { raw = JSON.parse(m.data) } catch { return }
      if (seen.has(raw.id)) return
      seen.add(raw.id)
      chain = chain.then(async () => {
        if (closed) return
        try {
          for (const ev of await tr.translate(raw)) if (!closed) onEvent(ev)
        } catch (err) {
          console.warn('Could not translate backend event', raw, err)
          onEvent({ id: raw.id * 100, run_id: runId, ts: raw.ts, agent: raw.agent, type: 'log', message: raw.message, evidence_refs: raw.evidence_refs ?? [], payload: raw.payload })
        }
      })
    }
    return () => { closed = true; es.close(); onStatus('closed') }
  }

  async chooseOption(runId: string, optionId: string) { await req('POST', `/runs/${runId}/options/${optionId}`) }
  async decideApproval(id: string, d: ApprovalDecision) { await req('POST', `/approvals/${id}`, d) }
  async answerClarification(runId: string, decision: 'confirm' | 'dismiss', amount?: number) {
    await req('POST', `/runs/${runId}/clarify`, { decision, amount })
  }

  /** No mid-run preemption in this backend: a new message starts a new run that plans only the difference. */
  async injectMessage(messageId: string) {
    const r = await req<{ run_id: string }>('POST', '/runs', { message_id: messageId, option_wait_seconds: OPTION_WAIT_S })
    this.lastMessage = messageId
    return { run_id: r.run_id }
  }
  async setFault(_tool: string, mode: FaultMode) { await req('POST', '/debug/fault', { tool: this.profile.faultTool, mode }) }
  /** Breaks invariant V3. Press it while a run is still executing; its verification catches it and replans. */
  async corrupt() { await req('POST', '/debug/corrupt') }
  async redeliver(messageId: string) {
    const r = await req<{ run_id: string }>('POST', '/runs', { message_id: messageId, option_wait_seconds: OPTION_WAIT_S })
    this.lastMessage = messageId
    return { run_id: r.run_id }
  }

  async getTrace(runId: string, actionId: string): Promise<TraceLink[]> {
    const raw = await req<any>('GET', `/runs/${runId}/trace/${actionId}`)
    const graph = await this.ensureGraph()
    const label = (id: string) => graph.nodes.find((n: GraphNode) => n.id === id)?.label ?? id
    const planned = this.translators.get(runId)?.planList.flatMap((p) => p.actions).find((a) => a.id === actionId)
    return mapTrace(raw, planned, label)
  }
  async getContext(runId: string, agent: AgentId): Promise<ContextPacket | null> {
    return req<ContextPacket | null>('GET', `/runs/${encodeURIComponent(runId)}/context/${agent}`)
  }
  async exportLog(runId: string) { return req<RunEvent[]>('GET', `/runs/${runId}/log`) }
  async getBaseline(runId: string): Promise<WorldState | null> {
    const snaps = await req<any>('GET', `/runs/${runId}/snapshots`)
    return snaps?.before ? mapWorld(snaps.before, [], this.people) : null
  }
}

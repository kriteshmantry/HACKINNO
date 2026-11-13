import type { Backend, BackendProfile, StreamStatus } from './Backend'
import { HttpBackend } from './http/client'
import { MockBackend } from './mock/engine'
import type { ApprovalDecision, AgentId, FaultMode, RunEvent, ScenarioId } from '@/lib/types'

type Mode = 'auto' | 'http' | 'mock'

/** ?backend=http|mock|auto overrides VITE_BACKEND. The default, auto, uses the API when it answers. */
function mode(): Mode {
  const q = new URLSearchParams(location.search).get('backend')
  if (q === 'http' || q === 'mock' || q === 'auto') return q
  const env = import.meta.env.VITE_BACKEND
  return env === 'http' || env === 'mock' ? env : 'auto'
}

/**
 * Picks the FastAPI backend when it is reachable and falls back to the in-browser simulator
 * otherwise, so the demo still works offline. Every call waits until the choice is made.
 */
class AutoBackend implements Backend {
  private impl: Backend
  private choice: Promise<void>
  /** true when auto mode wanted the API but had to fall back */
  fellBack = false

  constructor(private m: Mode) {
    const http = new HttpBackend()
    this.impl = m === 'mock' ? new MockBackend() : http
    this.choice = m === 'auto'
      ? Promise.race([http.ready(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))])
          .then(() => { this.impl = http })
          .catch(() => { this.impl = new MockBackend(); this.fellBack = true })
      : this.impl.ready()
  }

  get kind() { return this.impl.kind }
  get profile(): BackendProfile { return this.impl.profile }
  get requested() { return this.m }
  ready() { return this.choice }

  private async go<T>(f: (b: Backend) => Promise<T>) { await this.choice; return f(this.impl) }
  reset() { return this.go((b) => b.reset()) }
  getState() { return this.go((b) => b.getState()) }
  getInbox() { return this.go((b) => b.getInbox()) }
  getGraph(runId?: string) { return this.go((b) => b.getGraph(runId)) }
  getFacts(entity: string) { return this.go((b) => b.getFacts(entity)) }
  getMemory() { return this.go((b) => b.getMemory()) }
  forgetPreferences() { return this.go((b) => b.forgetPreferences()) }
  startScenario(s: ScenarioId) { return this.go((b) => b.startScenario(s)) }
  subscribe(runId: string, onEvent: (e: RunEvent) => void, onStatus: (s: StreamStatus) => void) {
    let off: (() => void) | undefined
    let cancelled = false
    this.choice.then(() => { if (!cancelled) off = this.impl.subscribe(runId, onEvent, onStatus) })
    return () => { cancelled = true; off?.() }
  }
  chooseOption(runId: string, o: string) { return this.go((b) => b.chooseOption(runId, o)) }
  decideApproval(id: string, d: ApprovalDecision) { return this.go((b) => b.decideApproval(id, d)) }
  answerClarification(runId: string, decision: 'confirm' | 'dismiss', amount?: number) {
    return this.go(async (b) => { if (!b.answerClarification) throw new Error('This backend drafts a clarifying email instead'); await b.answerClarification(runId, decision, amount) })
  }
  injectMessage(id: string) { return this.go((b) => b.injectMessage(id)) }
  setFault(tool: string, m: FaultMode) { return this.go((b) => b.setFault(tool, m)) }
  corrupt() { return this.go((b) => b.corrupt()) }
  redeliver(id: string) { return this.go((b) => b.redeliver(id)) }
  getTrace(runId: string, a: string) { return this.go((b) => b.getTrace(runId, a)) }
  getContext(runId: string, a: AgentId) { return this.go((b) => b.getContext(runId, a)) }
  exportLog(runId: string) { return this.go((b) => b.exportLog(runId)) }
  getBaseline(runId: string) { return this.go(async (b) => (b.getBaseline ? b.getBaseline(runId) : null)) }
}

export const backend = new AutoBackend(mode())
export type { Backend } from './Backend'

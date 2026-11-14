import { create } from 'zustand'
import { backend } from '@/backend'
import { extras, type Negotiation, type Policy, type Radar, type Reputation, type TrustRow, type Verification } from '@/backend/http/extras'
import { useRun } from './runStore'

/**
 * Workspace watch: the risk radar, Email Trust Scores for every message, the verification queue
 * and tier-boundary negotiation. Read over REST (not the run's event stream) and refreshed
 * whenever the current run moves, so it always reflects the live workspace.
 */
interface Watch {
  enabled: boolean
  loaded: boolean
  radar?: Radar
  trust: Record<string, TrustRow>
  queue: Verification[]
  policy?: Policy
  senders: Reputation[]
  negotiation?: Negotiation | null
  panel?: 'radar' | 'trust'
  busy: Record<string, boolean>
  init(): void
  refresh(): Promise<void>
  open(panel: 'radar' | 'trust'): void
  close(): void
  /** run an async action with a busy flag and a toast on failure */
  act<T>(key: string, f: () => Promise<T>, ok?: string): Promise<T | undefined>
  followRun(runId: string): Promise<void>
}

let timer: number | undefined
let started = false

export const useWatch = create<Watch>((set, get) => ({
  enabled: false,
  loaded: false,
  trust: {},
  queue: [],
  senders: [],
  busy: {},

  init() {
    if (started) return
    started = true
    backend.ready().then(() => {
      if (backend.kind !== 'http') return
      set({ enabled: true })
      get().refresh()
      // refresh after the run moves (new events) or a different run is attached
      let last = ''
      useRun.subscribe((s) => {
        const key = `${s.runId}|${s.log.length}|${s.state}`
        if (key === last) return
        last = key
        clearTimeout(timer)
        timer = window.setTimeout(() => get().refresh(), 450)
      })
    }).catch(() => { /* the console shows the connection error */ })
  },

  async refresh() {
    if (!get().enabled) return
    const runId = useRun.getState().runId
    try {
      const [radar, rows, queue, policy, senders, negotiation] = await Promise.all([
        extras.radar(), extras.trustInbox(), extras.verifications(), extras.policy(), extras.senders(),
        runId ? extras.runNegotiation(runId) : extras.negotiation(backend.profile.primarySponsor),
      ])
      set({ radar, trust: Object.fromEntries(rows.map((r) => [r.message_id, r])), queue, policy, senders, negotiation, loaded: true })
    } catch (e) {
      console.warn('Workspace watch refresh failed', e)
    }
  },

  open(panel) { set({ panel }) },
  close() { set({ panel: undefined }) },

  async act(key, f, ok) {
    set({ busy: { ...get().busy, [key]: true } })
    try {
      const r = await f()
      if (ok) useRun.getState().set('toast', { text: ok, tone: 'ok', key: Date.now() })
      await get().refresh()
      return r
    } catch (e) {
      useRun.getState().set('toast', { text: e instanceof Error ? e.message : String(e), tone: 'fail', key: Date.now() })
      return undefined
    } finally {
      set({ busy: { ...get().busy, [key]: false } })
    }
  },

  async followRun(runId) {
    await useRun.getState().resume(runId)
    const [inbox, world, facts] = await Promise.all([backend.getInbox(), backend.getState(), backend.getFacts(backend.profile.primarySponsor)])
    useRun.setState({ inbox, world, facts })
    set({ panel: undefined })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  },
}))

/** Colour for a 0..1 score under the current thresholds. */
export function scoreTone(x: number | null | undefined, policy?: Policy): 'ok' | 'wait' | 'fail' | 'faint' {
  if (x === null || x === undefined) return 'faint'
  const a = policy?.autonomous ?? 0.8, s = policy?.supervised ?? 0.5
  return x >= a ? 'ok' : x >= s ? 'wait' : 'fail'
}

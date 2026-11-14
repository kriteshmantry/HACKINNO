/**
 * Workspace-level features of the FastAPI backend that are not tied to one run's event stream:
 * the Email Trust Score, the verification queue, tier-boundary negotiation and the risk radar.
 * They exist only on the live backend; the simulator hides the panels that use them.
 */
import type { TrustSignal } from '@/lib/types'

const BASE = '/api'

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let detail = ''
    try { const j = await res.json(); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail) } catch { /* not json */ }
    throw new Error(detail || `${method} ${path} failed with ${res.status}`)
  }
  return res.json() as Promise<T>
}

export type Band = 'autonomous' | 'supervised' | 'clarify'

export interface TrustRow {
  message_id: string
  sender: string
  sponsor_id: string | null
  trust: number
  trust_signals: TrustSignal[]
  certainty: number | null
  certainty_signals: string[]
  overall: number
  band: Band
  route: string
  known_contact: string | null
  claimed_amount: number | null
  triage: { label: 'relevant' | 'noise' | 'suspicious'; reasons: string[] }
  subject: string
  channel: 'email' | 'chat'
  received_at: string
  reply_to?: string | null
  verification: { id: string; status: string; verdict: string | null } | null
}

export interface Outreach { to: string; cc: string[]; subject: string; body: string; sent_at?: string }

export interface Verification {
  id: string
  run_id: string
  message_id: string
  sender: string
  sponsor_id: string | null
  status: 'pending' | 'awaiting_reply' | 'confirmed' | 'corrected' | 'rejected' | 'expired'
  trust: number | null
  certainty: number | null
  overall: number | null
  report: { trust_signals?: TrustSignal[]; certainty_reasons?: string[]; reasons?: string[] }
  claimed: { new_amount?: number; old_amount?: number; new_tier?: string }
  question: string
  recommended: 'ask_sender' | 'confirm_or_correct'
  outreach: Outreach | null
  verdict: string | null
  reply_message_id: string | null
  decided_by: string | null
  created_at: string
}

export interface Reputation { sender: string; confirmed: number; corrected: number; rejected: number; genuine: number; total: number; reliability: number }
export interface Policy { autonomous: number; supervised: number; trust_low?: number }
export interface Calibration { n: number; bins: { range: [number, number]; n: number; genuine_rate: number | null }[]; note: string }

export interface Offer { id: 'restore' | 'addon' | 'accept'; title: string; add: number; total: number; tier: string; gets: string[]; lost_anyway: string[] }
export interface Negotiation {
  sponsor_id: string
  sponsor: string
  amount: number
  tier: string
  contact: string
  eligible: boolean
  reason?: string
  headline?: string
  previous_amount?: number | null
  previous_tier?: string | null
  dropped?: boolean
  target_tier?: string
  topup?: number
  benefits?: { kind: string; label: string; change: string; loss: string; deadline: string | null; days_left: number | null; still_possible: boolean; price: number | null }[]
  offers: Offer[]
  reply_by?: string | null
  deadline_reason?: string | null
  budget_effect?: { cut: number; restore_covers: number; text: string } | null
  draft?: Outreach
  record?: { id: string; status: 'sent' | 'accepted' | 'declined'; outcome: string | null; reply_message_id: string | null; reply_run_id: string | null; created_at: string } | null
}

export type RadarAction =
  | { kind: 'email'; label: string; draft: Outreach }
  | { kind: 'chat'; label: string; draft: { channel: string; body: string } }
  | { kind: 'run'; label: string; message_id: string }
  | { kind: 'verify'; label: string; verification_id: string }
  | { kind: 'negotiate'; label: string; sponsor_id: string }

export interface RadarItem {
  id: string
  rule: string
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
  due: string | null
  days_left: number | null
  entities: string[]
  evidence: string[]
  actions: RadarAction[]
  handled: { what: string; at: string; outbox_id?: number } | null
}
export interface Radar { now: string; horizon_days: number; items: RadarItem[]; counts: Record<'high' | 'medium' | 'low', number> }

export const extras = {
  trustInbox: () => req<TrustRow[]>('GET', '/trust/inbox'),
  senders: () => req<Reputation[]>('GET', '/trust/senders'),
  calibration: () => req<Calibration>('GET', '/trust/calibration'),
  policy: () => req<Policy>('GET', '/trust/policy'),
  setPolicy: (p: Policy) => req<Policy>('PUT', '/trust/policy', p),

  verifications: (status?: string) => req<Verification[]>('GET', `/verifications${status ? `?status=${status}` : ''}`),
  verification: (id: string) => req<Verification>('GET', `/verifications/${id}`),
  decide: (id: string, verdict: 'confirm' | 'correct' | 'reject' | 'ask_sender', extra: { amount?: number; reason?: string; body?: string } = {}) =>
    req<Verification>('POST', `/verifications/${id}`, { verdict, ...extra }),
  simulateReply: (id: string, genuine: boolean) => req<Verification>('POST', `/debug/verification-reply/${id}`, { genuine }),

  negotiation: (sponsorId: string) => req<Negotiation>('GET', `/negotiation/${sponsorId}`),
  runNegotiation: (runId: string) => req<Negotiation | null>('GET', `/runs/${runId}/negotiation`),
  sendOffer: (sponsorId: string, body: { subject?: string; body?: string; run_id?: string }) => req<unknown>('POST', `/negotiation/${sponsorId}/send`, body),
  simulateOfferReply: (negId: string, choice: 'restore' | 'decline') =>
    req<{ run_id: string | null }>('POST', `/debug/negotiation-reply/${negId}`, { choice }),

  radar: () => req<Radar>('GET', '/radar'),
  radarAct: (itemId: string, action: number, body?: string) => req<unknown>('POST', `/radar/${itemId}/act`, { action, body }),
  startRun: (messageId: string) => req<{ run_id: string }>('POST', '/runs', { message_id: messageId, option_wait_seconds: 900 }),
}

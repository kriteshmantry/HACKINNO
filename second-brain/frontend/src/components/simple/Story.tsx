import clsx from 'clsx'
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { backend } from '@/backend'
import { useRun } from '@/store/runStore'
import type { Approval, PlannedAction, ScenarioId, WorldState } from '@/lib/types'
import { lakhs, rupees } from '@/lib/format'
import type { AgentId, NodeKind } from '@/lib/types'
import { Button, kindLabel, LoadBar, Mono, Spinner, severityColor, statusLabel, statusTone, useAsyncClick, useCountUp } from '../ui'
import { STAGES, useStages, type StageId, type StageStatus } from './status'
import { TrustMeter } from '../watch/TrustParts'
import { VerificationInline } from '../watch/VerificationInline'
import { NegotiationCard } from '../watch/NegotiationCard'
import { useWatch } from '@/store/watchStore'

/* ------------------------------------------------------------------ */
/* Stage shell                                                         */
/* ------------------------------------------------------------------ */
const TAG: Record<StageStatus, { text: string; cls: string } | null> = {
  upcoming: null,
  active: { text: 'In progress', cls: 'bg-work-soft text-work' },
  needs: { text: 'Needs you', cls: 'bg-wait-soft text-wait' },
  done: { text: 'Done', cls: 'bg-ok-soft text-ok' },
  skipped: { text: 'Not needed', cls: 'bg-surface-2 text-faint' },
  stopped: { text: 'Stopped', cls: 'bg-fail-soft text-fail' },
}

function Stage({ n, id, title, idle, status, summary, agents, children }: { n: number; id: StageId; title: string; idle: string; status: StageStatus; summary?: ReactNode; agents: AgentId[]; children: ReactNode }) {
  const [override, setOverride] = useState<boolean>()
  // the result stays open once the run finishes: it is the answer people came for
  const auto = status === 'active' || status === 'needs' || status === 'stopped' || (id === 'check' && status === 'done')
  const open = override ?? auto
  const canOpen = status !== 'upcoming' && status !== 'skipped'
  useEffect(() => { setOverride(undefined) }, [status])
  const tag = TAG[status]
  return (
    <li id={`stage-${id}`} style={{ animationDelay: `${(n - 1) * 70}ms` }} className={clsx('rise scroll-mt-20 rounded-md border transition-[border-color,background-color,box-shadow] duration-300',
      status === 'needs' ? 'border-wait bg-surface' : status === 'active' ? 'border-text/50 bg-surface' : status === 'stopped' ? 'border-fail bg-surface'
        : status === 'upcoming' || status === 'skipped' ? 'border-line-soft' : 'border-line bg-surface')}>
      <button disabled={!canOpen} onClick={() => setOverride(!open)} aria-expanded={canOpen ? open : undefined}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left disabled:cursor-default">
        <span key={status} className={clsx('mt-px grid h-6 w-6 shrink-0 place-items-center rounded-sm text-[12px] font-bold transition-colors',
          status === 'needs' && 'needs-ring', status === 'done' && 'done-flash',
          status === 'done' ? 'bg-ok text-bg' : status === 'needs' ? 'bg-wait text-bg' : status === 'active' ? 'bg-text text-bg' : status === 'stopped' ? 'bg-fail text-bg' : 'bg-surface-2 text-faint')}>
          {status === 'active' ? <Spinner /> : n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className={clsx('text-[15px] font-bold tracking-[-0.01em]', (status === 'upcoming' || status === 'skipped') && 'text-muted')}>{title}</span>
            {tag && <span key={status} className={clsx('pop rounded-xs px-1.5 text-[11.5px] font-bold leading-5', tag.cls)}>{tag.text}</span>}
            <span className="text-[12px] text-faint">by the {agents.join(' and ')} agent{agents.length > 1 ? 's' : ''}</span>
          </span>
          <span className="mt-0.5 block text-[13px] text-muted">{status === 'upcoming' ? idle : status === 'skipped' ? 'Not needed for this message.' : summary}</span>
        </span>
        {canOpen && <span className="mt-1 shrink-0 text-[12px] font-semibold text-work">{open ? 'Hide' : 'Details'}</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && canOpen && (
          <motion.div key="body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.2, 0.7, 0.2, 1] }} className="overflow-hidden">
            <div className="border-t border-line-soft px-4 py-4">
              {children}
              <ContextLinks agents={agents} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  )
}

/** Context engineering, made visible: the curated slice each agent was given. */
function ContextLinks({ agents }: { agents: AgentId[] }) {
  const runId = useRun((s) => s.runId)
  const withContext = agents.filter((a) => ['Communication', 'Knowledge', 'Planning'].includes(a))
  if (!runId || !backend.profile.caps.context || !withContext.length) return null
  return (
    <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-line-soft pt-3 text-[12.5px] text-muted">
      <span>Context engineering:</span>
      {withContext.map((a) => (
        <button key={a} onClick={() => useRun.getState().set('contextAgent', a)} className="font-semibold text-work hover:underline">What the {a} agent was given</button>
      ))}
    </p>
  )
}

function Fact({ label, children, tone }: { label: string; children: ReactNode; tone?: 'fail' | 'ok' | 'wait' }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[150px_1fr]">
      <dt className="text-[12.5px] font-semibold text-muted">{label}</dt>
      <dd className={clsx('text-[13.5px] leading-relaxed', tone && `text-${tone}`)}>{children}</dd>
    </div>
  )
}

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="text-[12.5px] font-semibold text-work hover:underline">{open ? 'Hide' : label}</button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Inline decisions                                                    */
/* ------------------------------------------------------------------ */
/** "2,40,000", "240000", "2.4L", "75k" -> rupees; NaN when it cannot be read. */
function parseRupees(s: string): number {
  const t = s.trim().toLowerCase().replace(/[₹,\s]/g, '').replace(/^rs\.?/, '')
  const m = /^(\d+(?:\.\d+)?)(l|lakh|lakhs|k)?$/.exec(t)
  if (!m) return NaN
  const n = Number(m[1]) * (m[2] === 'k' ? 1_000 : m[2] ? 100_000 : 1)
  return Math.round(n)
}

/** Edit the budget line amounts before approving; everything after is re-planned from them. */
function BudgetEditor({ ap, onClose }: { ap: Approval; onClose: () => void }) {
  const world = useRun((s) => s.world)
  const shortfall = useRun((s) => s.computed?.shortfall ?? 0)
  const proposed = useMemo(() => new Map(((ap.args.changes as { line_id: string; new: number }[]) ?? []).map((c) => [c.line_id, c.new])), [ap.args])
  const lines = useMemo(() => (world?.budget ?? []).filter((b) => b.cuttable || proposed.has(b.id))
    .sort((a, b) => Number(proposed.has(b.id)) - Number(proposed.has(a.id)) || (a.priority ?? 0) - (b.priority ?? 0)), [world, proposed])
  const initial = () => Object.fromEntries(lines.map((l) => [l.id, String(proposed.get(l.id) ?? l.amount)]))
  const [vals, setVals] = useState<Record<string, string>>(initial)
  const parsed = lines.map((l) => ({ l, v: parseRupees(vals[l.id] ?? '') }))
  const bad = parsed.filter(({ l, v }) => Number.isNaN(v) || v < l.floor)
  const cut = parsed.reduce((s, { l, v }) => s + (Number.isNaN(v) ? 0 : l.amount - v), 0)
  const open = Math.max(0, shortfall - cut)
  const changed = parsed.some(({ l, v }) => v !== (proposed.get(l.id) ?? l.amount))
  const submit = () => useRun.getState().decide(ap.id, {
    decision: 'edit', reason: 'amounts set by a person',
    args: { changes: parsed.map(({ l, v }) => ({ line_id: l.id, new: v })) },
  })
  return (
    <div className="rise mt-2 rounded-sm border border-line bg-surface px-3 py-2.5">
      <p className="text-[12.5px] font-semibold">Set your own amounts</p>
      <p className="text-[12px] text-muted">Everything after this step (the open gap, the prize-pool approval, the messages and the checks) is re-planned from your numbers. You can type 240000, 2,40,000 or 2.4L.</p>
      <table className="mt-2 w-full text-[12.5px]">
        <thead><tr className="text-left text-[11.5px] text-faint"><th className="py-1 font-semibold">Line</th><th className="font-semibold">Now</th><th className="font-semibold">New amount</th><th className="text-right font-semibold">Floor</th></tr></thead>
        <tbody>
          {parsed.map(({ l, v }) => {
            const wrong = Number.isNaN(v) || v < l.floor
            return (
              <tr key={l.id} className="border-t border-line-soft">
                <td className="py-1.5 pr-2 font-semibold">{l.category}{proposed.has(l.id) && <span className="ml-1.5 text-[11px] font-normal text-faint">proposed</span>}</td>
                <td className="tnum pr-2 text-muted">{rupees(l.amount)}</td>
                <td className="pr-2">
                  <input value={vals[l.id] ?? ''} inputMode="numeric" aria-label={`New amount for ${l.category}`} aria-invalid={wrong}
                    onChange={(e) => setVals({ ...vals, [l.id]: e.target.value })}
                    className={clsx('h-7 w-28 rounded-sm border bg-surface px-2 text-[12.5px] outline-none', wrong ? 'border-fail text-fail' : 'border-line focus:border-work')} />
                  {!Number.isNaN(v) && v !== l.amount && !wrong && <span className={clsx('tnum ml-1.5 text-[11.5px]', v < l.amount ? 'text-fail' : 'text-ok')}>{v < l.amount ? '−' : '+'}{lakhs(Math.abs(l.amount - v))}</span>}
                </td>
                <td className="tnum text-right text-faint">{rupees(l.floor)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className={clsx('mt-2 text-[12.5px]', bad.length ? 'text-fail' : open ? 'text-wait' : 'text-ok')}>
        {bad.length ? `${bad.map(({ l }) => l.category).join(', ')}: ${bad.some(({ v }) => Number.isNaN(v)) ? 'enter an amount' : 'cannot go below the floor'}.`
          : <>Your amounts free up <span className="font-semibold">{rupees(Math.max(0, cut))}</span> of the {rupees(shortfall)} shortfall
            {open ? <>; <span className="font-semibold">{rupees(open)}</span> will be recorded as an open gap.</> : cut > shortfall ? <>, {rupees(cut - shortfall)} more than needed.</> : ', so it is fully covered.'}</>}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={!!bad.length || !changed} onClick={submit}>Approve with my amounts</Button>
        <Button size="sm" variant="ghost" onClick={() => setVals(initial())}>Back to the proposal</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  )
}

function ApprovalInline({ ap }: { ap: Approval }) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const { decide, openApproval } = useRun.getState()
  const approve = async () => { setBusy(true); await decide(ap.id, { decision: 'approve' }); setBusy(false) }
  const budget = ap.tool === 'budget.set_lines'
  return (
    <div className="mt-2 rounded-sm border border-wait/50 bg-wait-soft px-3 py-2.5">
      <p className="text-[13px]"><span className="font-semibold">Needs your OK.</span> <span className="text-muted">{ap.rationale}</span></p>
      {ap.diff.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[12.5px]">
          {ap.diff.slice(0, 4).map((d) => (
            <li key={d.field + d.to}><span className="text-muted">{d.field}:</span> {d.from && <span className="was">{d.from}</span>} <span className="font-semibold">{d.to}</span></li>
          ))}
          {ap.diff.length > 4 && <li className="text-faint">and {ap.diff.length - 4} more</li>}
        </ul>
      )}
      {ap.risk_reasons.length > 0 && <p className="mt-1 text-[12px] text-muted">Why it needs you: {ap.risk_reasons.map((r) => r.replace(/^[+-]d+s+/, '')).join('; ')}.</p>}
      {!editing && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" disabled={busy} onClick={approve}>Approve</Button>
          {budget && <Button size="sm" variant="quiet" onClick={() => setEditing(true)}>Edit amounts</Button>}
          <Button size="sm" variant="quiet" onClick={() => openApproval(ap.id)}>{ap.editable.length ? 'Review or edit' : 'Review'}</Button>
        </div>
      )}
      {editing && <BudgetEditor ap={ap} onClose={() => setEditing(false)} />}
    </div>
  )
}

function ClarifyInline() {
  const c = useRun((s) => s.clarification)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  if (!c || c.answered) return null
  const value = Number(amount.replace(/[^\d]/g, '')) || c.amount || 0
  const go = async (d: 'confirm' | 'dismiss') => { setBusy(true); await useRun.getState().clarify(d, d === 'confirm' ? value : undefined); setBusy(false) }
  return (
    <div className="mt-3 rounded-sm border border-wait/50 bg-wait-soft px-3 py-3">
      <p className="text-[14px] font-semibold">{c.question}</p>
      <p className="mt-1 text-[12.5px] text-muted">Nothing has been changed. It is not sure enough to act on its own, because:</p>
      <ul className="mt-1 list-disc pl-5 text-[12.5px] text-muted marker:text-faint">{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      {c.draft && <p className="mt-2 text-[12.5px]"><span className="font-semibold">Suggested reply: </span>{c.draft}</p>}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-[12px] text-muted">Confirmed amount
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={c.amount ? rupees(c.amount) : '₹3,00,000'} inputMode="numeric"
            className="mt-0.5 block h-8 w-36 rounded-sm border border-line bg-surface px-2.5 text-[13px] text-text outline-none focus:border-work" />
        </label>
        <Button size="sm" variant="primary" disabled={busy || !value} onClick={() => go('confirm')}>Confirm and continue</Button>
        <Button size="sm" variant="quiet" disabled={busy} onClick={() => go('dismiss')}>Dismiss, change nothing</Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 1. Read the message                                                 */
/* ------------------------------------------------------------------ */
const BAND_TEXT = {
  autonomous: 'Sure enough to make low-risk changes by itself. Risky ones still wait for you.',
  supervised: 'Not fully sure: every change waits for your OK.',
  clarify: 'Not sure enough to change anything. A person has to confirm first.',
}

/** The mention as it appears in the message, not as the alias table stores it. */
function asWritten(body: string, mention: string) {
  const i = mention ? body.toLowerCase().indexOf(mention.toLowerCase()) : -1
  return i >= 0 ? body.slice(i, i + mention.length) : mention
}

function ReadStage() {
  const inbox = useRun((s) => s.inbox)
  const trigger = useRun((s) => s.trigger)
  const extraction = useRun((s) => s.extraction)
  const triageAll = useRun((s) => s.triage)
  const confidence = useRun((s) => s.confidence)
  const contradiction = useRun((s) => s.contradiction)
  const resolution = useRun((s) => s.resolution)
  const outcome = useRun((s) => s.outcome)
  const approvals = useRun((s) => s.approvals)
  const state = useRun((s) => s.state)
  const msg = inbox.find((m) => m.id === (extraction?.message_id ?? trigger))
  const triage = msg ? triageAll[msg.id] : undefined
  const span = extraction?.message_id === msg?.id ? extraction?.span : undefined
  const i = span && msg ? msg.body.indexOf(span) : -1
  const pending = useMemo(() => Object.values(approvals).filter((a) => a.status === 'pending'), [approvals])
  const sponsorName = useRun((s) => s.world?.sponsors.find((x) => x.id === backend.profile.primarySponsor)?.name.split(' ')[0])
  const clarification = useRun((s) => s.clarification)
  const watchOn = useWatch((s) => s.enabled)
  if (!msg) return <p className="text-[13px] text-muted">Waiting for the message…</p>
  const quarantined = triage?.verdict === 'suspicious'
  const unverified = !quarantined && confidence?.trust !== undefined && confidence.trust < (useWatch.getState().policy?.trust_low ?? 0.5)
  return (
    <div>
      <figure className={clsx('rounded-sm border px-4 py-3', quarantined ? 'border-fail/50 bg-fail-soft' : 'border-line-soft bg-bg-2/60')}>
        <figcaption className="text-[12.5px] text-muted">
          <span className="font-semibold text-text">{msg.from}</span>{msg.from_role ? ` (${msg.from_role})` : ''}, {msg.channel === 'email' ? msg.address : msg.chat_channel}
          <Mono className="ml-2 text-faint">{msg.id}</Mono>
        </figcaption>
        {msg.subject && <p className="mt-1 text-[13.5px] font-semibold">{msg.subject}</p>}
        <blockquote className="mt-1 text-[14px] leading-relaxed">
          {i >= 0 ? <>{msg.body.slice(0, i)}<mark className="evidence">{span}</mark>{msg.body.slice(i + span!.length)}</> : msg.body}
        </blockquote>
      </figure>
      <button onClick={() => useRun.getState().set('panel', 'inbox')} className="mt-1.5 text-[12.5px] font-semibold text-work hover:underline">See all {inbox.length} messages</button>

      <dl className="mt-2 divide-y divide-line-soft">
        {triage && (
          <Fact label="Safe to act on?" tone={quarantined ? 'fail' : unverified ? 'wait' : undefined}>
            {quarantined ? <>No. It was quarantined before any agent planned anything: {triage.reasons.join('; ').toLowerCase()}.</>
              : unverified ? <>Not yet. It is about a sponsor commitment, but the sender could not be verified (trust {confidence!.trust!.toFixed(2)}), so it is held until someone checks with the real contact.</>
                : <>Yes: {triage.reasons.join(', ').toLowerCase()}.</>}
          </Fact>
        )}
        {resolution && resolution.entity_id && (
          <Fact label="Who it is about">
            <span className="font-semibold">{resolution.entity_name ?? resolution.entity_id}</span>, matched by {
              resolution.method === 'person' ? 'the sender’s address, a known sponsor contact'
                : resolution.method === 'domain' ? 'the sender’s email domain'
                  : resolution.method === 'alias' ? <>the name used in the message (“{asWritten(msg.body, resolution.mention || extraction?.entity_mention || '')}”)</>
                    : 'a close spelling match'}.
            <span className="block text-[12.5px] text-muted">The same sponsor is recognised across the tracker, email, chat and documents, whatever it is called there.</span>
          </Fact>
        )}
        {extraction && (
          <Fact label="What changed">
            {sponsorName ?? extraction.entity_mention}’s commitment: {extraction.old_value ? <><span className="was">{rupees(extraction.old_value)}</span> </> : null}<span className="font-semibold">{rupees(extraction.new_value)}</span>
          </Fact>
        )}
        {contradiction && (
          <Fact label="What we remembered">
            {rupees(contradiction.old_fact.value)} from {contradiction.source_old}. The new amount replaces it, and the old one is kept as history.
          </Fact>
        )}
        {confidence && (
          <Fact label="How sure">
            <span className="flex items-center gap-3">
              <Score value={confidence.score} className="tnum text-[18px] font-bold" style={{ color: `var(--${confidence.band === 'autonomous' ? 'ok' : confidence.band === 'supervised' ? 'wait' : 'fail'})` }} />
              <span className="relative h-1.5 w-40 rounded-full bg-surface-2" aria-hidden>
                <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out" style={{ width: `${confidence.score * 100}%`, background: `var(--${confidence.band === 'autonomous' ? 'ok' : confidence.band === 'supervised' ? 'wait' : 'fail'})` }} />
              </span>
            </span>
            <span className="block text-muted">{BAND_TEXT[confidence.band]}</span>
            {confidence.trust !== undefined ? <div className="mt-2"><TrustMeter c={confidence} /></div> : (
            <Disclosure label="How this score was worked out">
              <ul className="tnum space-y-0.5 text-[12.5px]">
                <li className="flex justify-between gap-4 text-muted"><span>Starting point</span><span>0.50</span></li>
                {confidence.reasons.map((r) => (
                  <li key={r.label} className="flex justify-between gap-4"><span className="text-muted">{r.label}</span><span className={r.delta >= 0 ? 'text-ok' : 'text-fail'}>{r.delta >= 0 ? '+' : '−'}{Math.abs(r.delta).toFixed(2)}</span></li>
                ))}
              </ul>
            </Disclosure>)}
          </Fact>
        )}
      </dl>
      {state === 'AWAIT_CLARIFICATION' && (clarification?.verification_id && watchOn ? <VerificationInline id={clarification.verification_id} /> : <ClarifyInline />)}
      {state === 'AWAIT_CLARIFICATION' && pending.map((ap) => <div key={ap.id}><p className="mt-3 text-[13.5px] font-semibold">{ap.title}</p><ApprovalInline ap={ap} /></div>)}
      {outcome?.kind === 'waiting' && <p className="mt-3 rounded-sm bg-wait-soft px-3 py-2 text-[13px] text-wait">{outcome.text}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 2. Find what it affects                                             */
/* ------------------------------------------------------------------ */
const GROUPS = [
  { sev: 'high' as const, title: 'Urgent', hint: 'Published, pending sign-off, or due within 72 hours' },
  { sev: 'medium' as const, title: 'Needs updating', hint: 'Records and plans that depend on the amount' },
  { sev: 'low' as const, title: 'People and documents to inform', hint: '' },
]

const APP: Partial<Record<NodeKind, string>> = {
  Sponsor: 'sponsor tracker', Tier: 'sponsor tracker', Budget: 'budget sheet', BudgetLine: 'budget sheet', Deliverable: 'sponsor deliverables',
  CalendarEvent: 'calendar', OrgApproval: 'approvals', PromoAsset: 'published promotions', Doc: 'documents',
}

function ImpactStage() {
  const impact = useRun((s) => s.impact)
  const graph = useRun((s) => s.graph)
  const world = useRun((s) => s.world)
  const [open, setOpen] = useState<string>()
  const label = (id: string) => graph?.nodes.find((n) => n.id === id)?.label ?? id
  const kindOf = (id: string) => graph?.nodes.find((n) => n.id === id)?.kind
  const apps = [...new Set(impact.map((x) => APP[kindOf(x.node) as NodeKind]).filter(Boolean))]
  const now = new Date(backend.profile.now)
  const ids = new Set(impact.map((x) => x.node))
  const deadlines = [
    ...(world?.calendar ?? []).filter((c) => ids.has(c.id)).map((c) => ({ id: c.id, what: c.title, date: c.date, gone: c.status === 'cancelled' })),
    ...(world?.deliverables ?? []).filter((d) => ids.has(d.id) && d.deadline).map((d) => ({ id: d.id, what: `${d.kind} due`, date: d.deadline!, gone: d.status === 'removed' })),
  ].sort((a, b) => a.date.localeCompare(b.date))
  const days = (d: string) => Math.ceil((new Date(`${d}T09:00:00`).getTime() - now.getTime()) / 864e5)
  const pathText = (p: string[]) => p.map((x, i) => (i % 2 ? (x === 'approves' ? 'is approved by' : x.replace(/_/g, ' ')) : label(x))).join(' ')
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13.5px] text-muted">Followed from the sponsor through the knowledge graph{apps.length ? <>, across {apps.length} apps: {apps.join(', ')}</> : ''}. Pick any item to see why it is affected.</p>
        <Button size="sm" variant="quiet" onClick={() => useRun.getState().set('panel', 'map')}>Open the map</Button>
      </div>
      {deadlines.length > 0 && (
        <section className="mt-3 rounded-sm bg-surface-2 px-3 py-2.5">
          <h4 className="text-[12.5px] font-bold">Deadlines at risk</h4>
          <ul className="mt-1 grid gap-x-6 gap-y-0.5 text-[12.5px] sm:grid-cols-2">
            {deadlines.map((d) => (
              <li key={d.id} className={clsx(d.gone && 'was')}>
                <span className="tnum font-semibold">{new Date(d.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span> {d.what}
                <span className={clsx('ml-1', days(d.date) <= 3 && !d.gone ? 'text-fail' : 'text-faint')}>({days(d.date) <= 0 ? 'today' : `in ${days(d.date)} day${days(d.date) === 1 ? '' : 's'}`})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        {GROUPS.map((g) => {
          const items = impact.filter((x) => x.severity === g.sev)
          if (!items.length) return null
          return (
            <section key={g.sev}>
              <h4 className="flex items-baseline gap-2 text-[12.5px] font-bold"><span style={{ color: severityColor[g.sev] }}>{g.title}</span><span className="text-faint">{items.length}</span></h4>
              {g.hint && <p className="text-[11.5px] text-faint">{g.hint}</p>}
              <ul className="mt-1.5 space-y-1">
                {items.map((x) => (
                  <li key={x.node}>
                    <button onClick={() => setOpen(open === x.node ? undefined : x.node)} aria-expanded={open === x.node}
                      className={clsx('w-full rounded-sm px-2 py-1.5 text-left hover:bg-surface-2', open === x.node && 'bg-surface-2')}>
                      <span className="block text-[13px] font-semibold">{label(x.node)} <span className="text-[11px] font-normal text-faint">{kindOf(x.node) ? kindLabel[kindOf(x.node)!] : ''}</span></span>
                      <span className="block text-[12px] text-muted">{x.why}</span>
                    </button>
                    {open === x.node && (
                      <div className="px-2 pb-1.5 text-[12px]">
                        <p className="text-muted">Why: {pathText(x.path)}.</p>
                        <button className="mt-0.5 font-semibold text-work hover:underline" onClick={() => { useRun.getState().set('selectedNode', x.node); useRun.getState().set('panel', 'map') }}>Show on the map</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 3. Choose how to cover the gap                                      */
/* ------------------------------------------------------------------ */
function DecideStage() {
  const computed = useRun((s) => s.computed)
  const options = useRun((s) => s.options)
  const recommended = useRun((s) => s.recommended)
  const rationale = useRun((s) => s.optionRationale)
  const chosen = useRun((s) => s.chosen)
  const waiting = useRun((s) => s.agents.Planning.status === 'waiting')
  if (!computed) return <p className="text-[13px] text-muted">Working out how much is missing…</p>
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1">
        <p className="text-[22px] font-extrabold tracking-[-0.02em]">{computed.shortfall > 0 ? <>Short by <span className="tnum text-fail"><Rupees value={computed.shortfall} /></span></> : 'No money is missing'}</p>
        <p className="text-[13px] text-muted">Tier {computed.old_tier === computed.new_tier ? <>stays {computed.new_tier}</> : <><span className="was">{computed.old_tier}</span> {computed.new_tier}</>}{computed.deliverable_diff.length ? `: ${computed.deliverable_diff.map((d) => d.charAt(0).toLowerCase() + d.slice(1)).join(', ')}` : ''}</p>
      </div>
      <p className="mt-1 text-[12.5px] text-muted">Every number here is computed in code, not by a language model.</p>

      {options.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label="Ways to cover the gap">
          {options.map((o, oi) => {
            const isChosen = chosen === o.id
            const isRec = recommended === o.id
            return (
              <li key={o.id} style={{ animationDelay: `${oi * 80}ms` }} className={clsx('rise lift rounded-sm border px-3 py-2.5', isChosen ? 'border-ok bg-ok-soft' : isRec && !chosen ? 'border-text/40' : 'border-line', chosen && !isChosen && 'opacity-55')}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[14px] font-bold">{o.id}. {o.name} {isRec && <span className="ml-1 text-[12px] font-semibold text-work">recommended</span>}</p>
                    <p className="text-[12.5px] text-muted">{o.strategy}</p>
                    <p className="mt-1 text-[12.5px]">
                      Covers <span className="font-semibold">{Math.round(o.coverage * 100)}%</span>
                      {o.open_gap > 0 && <>, leaves <span className="font-semibold text-wait">{rupees(o.open_gap)}</span> open</>}
                      {o.approvals_affected > 0 && <>, reopens {o.approvals_affected} approval</>}
                      {o.public_changes > 0 && <>, {o.public_changes} public change{o.public_changes > 1 ? 's' : ''}</>}
                    </p>
                  </div>
                  {isChosen ? <span className="text-[12.5px] font-bold text-ok">Chosen</span>
                    : !chosen && <Button size="sm" variant={isRec ? 'primary' : 'quiet'} disabled={!waiting} onClick={() => useRun.getState().chooseOption(o.id)}>Choose {o.id}</Button>}
                </div>
                <div className="mt-1">
                  <Disclosure label="See the cuts">
                    <ul className="space-y-0.5 text-[12.5px]">
                      {o.cuts.map((c) => <li key={c.line_id}><span className="text-muted">{c.category}:</span> <span className="was">{lakhs(c.from)}</span> <span className="font-semibold">{lakhs(c.to)}</span></li>)}
                    </ul>
                  </Disclosure>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {rationale && <p className="mt-3 text-[12.5px] text-muted"><span className="font-semibold text-text">Why {recommended}: </span>{rationale}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 4. Make the changes                                                 */
/* ------------------------------------------------------------------ */
function useAllActions(): PlannedAction[] {
  const plans = useRun((s) => s.plans)
  const statuses = useRun((s) => s.statuses)
  return useMemo(() => {
    if (!plans.length) return []
    const latest = plans[plans.length - 1]
    const titles = new Set(latest.actions.map((a) => a.title))
    const earlier = plans.slice(0, -1).flatMap((p) => p.actions)
      .filter((a) => ['done', 'skipped_duplicate'].includes(statuses[a.id]) && !titles.has(a.title))
    return [...earlier, ...latest.actions]
  }, [plans, statuses])
}

function ChangeRow({ a }: { a: PlannedAction }) {
  const status = useRun((s) => s.statuses[a.id] ?? 'pending')
  const ap = useRun((s) => Object.values(s.approvals).find((x) => x.action_id === a.id && x.status === 'pending'))
  const tone = statusTone[status]
  return (
    <li className="slide-in py-2">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex w-[112px] shrink-0 items-center gap-1.5 text-[12px] font-semibold" style={{ color: `var(--${tone === 'muted' ? 'faint' : tone})` }}>
          {(status === 'running' || status === 'retrying') && <Spinner />}<span key={status} className="pop">{statusLabel[status]}</span>
        </span>
        <span className={clsx('min-w-0 flex-1 text-[13.5px]', ['replaced', 'superseded', 'rejected'].includes(status) && 'was')}>{a.title}</span>
        <button onClick={() => useRun.getState().set('traceAction', a.id)} className="shrink-0 text-[12px] font-semibold text-work hover:underline" aria-label={`Why: ${a.title}`}>Why?</button>
      </div>
      {ap && <div className="sm:ml-[124px]"><ApprovalInline ap={ap} /></div>}
    </li>
  )
}

function ChangeStage() {
  const actions = useAllActions()
  const statuses = useRun((s) => s.statuses)
  const plans = useRun((s) => s.plans)
  const preempted = useRun((s) => s.preempted)
  const replans = useRun((s) => s.replans)
  const edited = useRun((s) => s.chosen === 'H')
  if (!actions.length) return <p className="text-[13px] text-muted">Writing the plan…</p>
  const finished = actions.filter((a) => ['done', 'skipped_duplicate'].includes(statuses[a.id])).length
  const latest = plans[plans.length - 1]
  const failedTools = new Set(plans.flatMap((p) => p.actions).filter((a) => statuses[a.id] === 'failed').map((a) => a.tool))
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="h-1.5 flex-1 rounded-full bg-surface-2" aria-hidden><span className="block h-full rounded-full bg-ok transition-[width] duration-500" style={{ width: `${(finished / actions.length) * 100}%` }} /></span>
        <span className="tnum shrink-0 text-[12.5px] text-muted">{finished} of {actions.length} done</span>
      </div>
      {plans.length > 1 && (
        <p className="mt-2 rounded-sm bg-surface-2 px-3 py-2 text-[12.5px]">
          <span className="font-semibold">The plan was updated {plans.length - 1} time{plans.length > 2 ? 's' : ''}.</span>{' '}
          <span className="text-muted">{preempted ? `Newer information arrived in ${preempted.by}, so only what still differs was planned again.`
            : failedTools.size ? `${[...failedTools].join(', ')} kept failing, so a safe fallback took its place.`
              : edited ? 'You set your own budget amounts, so everything that depends on them was planned again from your numbers.'
              : replans ? 'A check found something out of place, so only that part was planned again.' : 'Only what still differs from the target is planned again.'}</span>
        </p>
      )}
      <ul className="mt-2 divide-y divide-line-soft">{actions.map((a) => <ChangeRow key={a.id} a={a} />)}</ul>
      <p className="mt-2 text-[12px] text-faint">Plan v{latest.version}. Every step says “set X, expecting Y”, so repeating one can never apply it twice.</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 5. Check the result                                                 */
/* ------------------------------------------------------------------ */
function changesBetween(before: WorldState, after: WorldState, sponsor: string) {
  const rows: { label: string; from: string; to: string }[] = []
  const add = (label: string, a: unknown, b: unknown, fmt = (v: unknown) => (typeof v === 'number' ? rupees(v) : String(v ?? 'none'))) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) rows.push({ label, from: fmt(a), to: fmt(b) })
  }
  const sb = before.sponsors.find((s) => s.id === sponsor), sa = after.sponsors.find((s) => s.id === sponsor)
  if (sb && sa) { add(`${sa.name.split(' ')[0]} commitment`, sb.committed, sa.committed); add(`${sa.name.split(' ')[0]} tier`, sb.tier, sa.tier) }
  for (const d of after.deliverables.filter((x) => x.sponsor_id === sponsor)) {
    const o = before.deliverables.find((x) => x.id === d.id)
    if (o) add(d.kind, o.status === 'removed' ? 'Removed' : o.spec, d.status === 'removed' ? 'Removed' : d.spec)
  }
  for (const b of after.budget) { const o = before.budget.find((x) => x.id === b.id); if (o) add(`Budget: ${b.category}`, o.amount, b.amount) }
  for (const c of after.calendar) { const o = before.calendar.find((x) => x.id === c.id); if (o) add(c.title, o.status, c.status) }
  for (const a of after.approvals) { const o = before.approvals.find((x) => x.id === a.id); if (o) add(`${a.subject} approval`, `${lakhs(o.amount)}, ${o.status}`, `${lakhs(a.amount)}, ${a.status.replace('_', ' ')}`) }
  for (const p of after.promo) { const o = before.promo.find((x) => x.id === p.id); if (o) add(`${p.kind}`, o.status, p.status === 'flagged' ? 'flagged for correction' : p.status) }
  const sent = after.outbox.length - before.outbox.length
  if (sent > 0) rows.push({ label: 'Messages sent through the outbox', from: '', to: String(sent) })
  return rows
}

function CheckStage() {
  const checks = useRun((s) => s.checks)
  const outcome = useRun((s) => s.outcome)
  const before = useRun((s) => s.baseline)
  const after = useRun((s) => s.world)
  const facts = useRun((s) => s.facts)
  const failed = checks.filter((c) => !c.pass)
  const changes = useMemo(() => (before && after ? changesBetween(before, after, backend.profile.primarySponsor) : []), [before, after])
  const current = facts.find((f) => f.status === 'current')
  const old = facts.filter((f) => f.status === 'superseded')
  return (
    <div>
      {outcome && (outcome.kind === 'done' || outcome.kind === 'escalated') && (
        <p className={clsx('text-[17px] font-bold', outcome.kind === 'done' ? 'text-ok' : 'text-fail')}>{outcome.text}</p>
      )}
      {outcome?.kind === 'escalated' && outcome.detail && <p className="mt-1 whitespace-pre-line text-[12.5px] text-muted">{outcome.detail}</p>}
      {!outcome && <p className="text-[13px] text-muted">Re-reading the live records…</p>}

      {failed.length > 0 && (
        <ul className="mt-2 space-y-1">
          {failed.map((c) => <li key={c.id} className="rounded-sm bg-fail-soft px-3 py-1.5 text-[12.5px]"><span className="font-bold text-fail">{c.id} failed:</span> {c.label}. Expected {c.expected}; found {c.actual}.</li>)}
        </ul>
      )}
      {checks.length > 0 && (
        <div className="mt-2">
          <Disclosure label={`See all ${checks.length} checks`}>
            <ul className="space-y-0.5 text-[12.5px]">
              {checks.map((c) => <li key={c.id} className="flex gap-2"><span className={clsx('w-9 shrink-0 font-bold', c.pass ? 'text-ok' : 'text-fail')}>{c.pass ? 'Pass' : 'Fail'}</span><span><Mono className="text-faint">{c.id}</Mono> {c.label}</span></li>)}
            </ul>
          </Disclosure>
        </div>
      )}

      {changes.length > 0 && (
        <section className="mt-4">
          <h4 className="text-[12.5px] font-bold text-muted">What changed</h4>
          <ul className="mt-1 divide-y divide-line-soft text-[13px]">
            {changes.slice(0, 8).map((r) => (
              <li key={r.label} className="flex flex-wrap justify-between gap-x-4 py-1.5"><span>{r.label}</span><span className="tnum">{r.from && <span className="was mr-1.5">{r.from}</span>}<span className="font-semibold">{r.to}</span></span></li>
            ))}
          </ul>
          <button onClick={() => useRun.getState().set('panel', 'changes')} className="mt-1 text-[12.5px] font-semibold text-work hover:underline">
            {changes.length > 8 ? `See all ${changes.length} changes` : 'See the full before and after'}
          </button>
        </section>
      )}
      {current && old.length > 0 && (
        <p className="mt-3 text-[12.5px] text-muted"><span className="font-semibold text-text">Memory:</span> now {rupees(current.value)} (from {current.source_ref}). The earlier {old.map((f) => `${rupees(f.value)} (${f.source_ref})`).join(', ')} is kept as history, not deleted.</p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Summaries and the page                                              */
/* ------------------------------------------------------------------ */
function useSummaries(): Record<StageId, ReactNode> {
  const extraction = useRun((s) => s.extraction)
  const confidence = useRun((s) => s.confidence)
  const triage = useRun((s) => s.triage)
  const trigger = useRun((s) => s.trigger)
  const impact = useRun((s) => s.impact)
  const computed = useRun((s) => s.computed)
  const chosen = useRun((s) => s.chosen)
  const options = useRun((s) => s.options)
  const actions = useAllActions()
  const statuses = useRun((s) => s.statuses)
  const approvals = useRun((s) => s.approvals)
  const checks = useRun((s) => s.checks)
  const outcome = useRun((s) => s.outcome)
  const quarantined = trigger && triage[trigger]?.verdict === 'suspicious'
  const sponsorName = useRun((s) => s.world?.sponsors.find((x) => x.id === backend.profile.primarySponsor)?.name.split(' ')[0])
  const decided = Object.values(approvals).filter((a) => a.status === 'approved' || a.status === 'edited').length
  const done = actions.filter((a) => ['done', 'skipped_duplicate'].includes(statuses[a.id])).length
  const opt = options.find((o) => o.id === chosen)
  return {
    read: quarantined ? 'Quarantined: it tried to give the system orders' : extraction
      ? `${sponsorName ?? extraction.entity_mention}: ${extraction.old_value ? `${lakhs(extraction.old_value)} → ` : ''}${lakhs(extraction.new_value)}${confidence ? `, confidence ${confidence.score.toFixed(2)}` : ''}`
      : 'Reading the message',
    impact: impact.length ? `${impact.length} things affected, ${impact.filter((x) => x.severity === 'high').length} urgent` : 'Following the knowledge graph',
    decide: opt ? `Option ${opt.id}, ${opt.name.toLowerCase()}, covers ${Math.round(opt.coverage * 100)}% of ${computed ? rupees(computed.shortfall) : 'the gap'}`
      : computed && computed.shortfall <= 0 ? 'Nothing to cover' : computed ? `Short by ${rupees(computed.shortfall)}: choose one of ${options.length} ways to cover it` : 'Working out the gap',
    change: actions.length ? `${done} of ${actions.length} changes made${decided ? `, ${decided} approved by you` : ''}` : 'Writing the plan',
    check: outcome && (outcome.kind === 'done' || outcome.kind === 'escalated') ? outcome.text : checks.length ? `${checks.filter((c) => c.pass).length} of ${checks.length} checks passed so far` : 'Re-reading the live records',
  }
}

function Starting({ id }: { id: ScenarioId }) {
  const sc = backend.profile.scenarios[id]
  return (
    <section role="status" className="rounded-md border border-text/50 bg-surface px-5 py-4">
      <p className="flex items-center gap-2 text-[16px] font-bold"><Spinner /> Starting {id}{sc ? `: ${sc.name}` : ''}</p>
      <p className="mt-1 text-[13.5px] text-muted">Resetting the workspace and handing the message to the agents. The steps below fill in as they work.</p>
    </section>
  )
}

function StartFailed({ id, message }: { id: ScenarioId; message: string }) {
  return (
    <section role="alert" className="rounded-md border border-fail bg-surface px-5 py-4">
      <p className="text-[16px] font-bold text-fail">{id}{backend.profile.scenarios[id] ? `: ${backend.profile.scenarios[id]!.name}` : ''} could not start</p>
      <p className="mt-1 text-[13.5px] text-muted">{message}</p>
      <p className="mt-1 text-[13px] text-muted">{backend.kind === 'http' ? 'Check that the backend is running (run-demo.ps1 starts it), then try again.' : 'Try again.'}</p>
      <Button variant="primary" className="mt-3" onClick={() => useRun.getState().start(id)}>Try {id} again</Button>
    </section>
  )
}

/** A scenario to start: lifts under the pointer, shows a loading bar inside itself once clicked. */
function ScenarioCard({ id, i, current, running }: { id: ScenarioId; i: number; current?: boolean; running?: boolean }) {
  const sc = backend.profile.scenarios[id]!
  const click = useAsyncClick(() => useRun.getState().start(id))
  return (
    <li className="rise" style={{ animationDelay: `${120 + i * 60}ms` }}>
      <button onClick={click.onClick} disabled={click.pending} aria-busy={click.pending || undefined}
        className="lift relative h-full w-full overflow-hidden rounded-sm border border-line bg-surface px-3 py-2.5 text-left hover:border-text/40 disabled:cursor-progress">
        <span className="block text-[14px] font-bold">{id}: {sc.name}
          {current ? <span className="ml-2 text-[12px] font-semibold text-work">{running ? 'running now' : 'last run'}</span>
            : id === 'S1' && current === undefined && <span className="ml-2 text-[12px] font-semibold text-work">start here</span>}</span>
        <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{click.pending ? 'Starting…' : sc.hint}</span>
        {click.pending && <span className="text-work"><LoadBar /></span>}
      </button>
    </li>
  )
}

/** A 0..1 score that counts up to its value. */
function Score({ value, className, style }: { value: number; className?: string; style?: React.CSSProperties }) {
  return <span className={className} style={style}>{useCountUp(value).toFixed(2)}</span>
}

/** A rupee amount that counts up to its value. */
function Rupees({ value }: { value: number }) {
  return <>{rupees(Math.round(useCountUp(value, 900)))}</>
}

/** Always on the page once a run exists: pick the next scenario without hunting for the menu. */
function MoreScenarios() {
  const state = useRun((s) => s.state)
  const scenario = useRun((s) => s.scenario)
  const running = !['DONE', 'QUARANTINED', 'IGNORED', 'ESCALATE', 'IDLE'].includes(state)
  const ids = Object.keys(backend.profile.scenarios) as ScenarioId[]
  return (
    <section aria-label="Run a scenario" className="rise rounded-md border border-line bg-surface px-4 py-4">
      <h3 className="text-[15px] font-bold">{running ? 'Run a different scenario' : 'Run another scenario'}</h3>
      <p className="text-[12.5px] text-muted">Each one resets the workspace and plays its message through the agents{running ? '. The run in progress stops' : ''}.</p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {ids.map((id, i) => <ScenarioCard key={id} id={id} i={i} current={id === scenario} running={running} />)}
      </ul>
    </section>
  )
}

function Welcome() {
  const { profile } = backend
  return (
    <section className="rise rounded-md border border-line bg-surface px-5 py-5">
      <h2 className="text-[20px] font-extrabold tracking-[-0.02em]">Watch one sponsor email ripple through {profile.eventName}</h2>
      <p className="mt-1 max-w-[46rem] text-[14px] leading-relaxed text-muted">
        TechNova is a Gold sponsor at ₹5,00,000 and the budget balances at ₹13L. Pick a scenario: the agents read the message, trace what it affects, ask you to decide anything risky, make the changes and check the result. Each step appears below as it happens.
      </p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {(Object.keys(profile.scenarios) as ScenarioId[]).map((id, i) => <ScenarioCard key={id} id={id} i={i} />)}
      </ul>
    </section>
  )
}

export function Story() {
  const stages = useStages()
  const runId = useRun((s) => s.runId)
  const starting = useRun((s) => s.starting)
  const startError = useRun((s) => s.startError)
  const summaries = useSummaries()
  // bring the stage that needs attention into view when it changes
  const focus = STAGES.find((s) => stages[s.id] === 'needs')?.id ?? STAGES.find((s) => stages[s.id] === 'active')?.id
  const last = useRef<string>(undefined)
  useEffect(() => {
    if (!focus || focus === last.current) return
    last.current = focus
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(`stage-${focus}`)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' })
  }, [focus])
  const content: Record<StageId, ReactNode> = { read: <ReadStage />, impact: <ImpactStage />, decide: <DecideStage />, change: <ChangeStage />, check: <CheckStage /> }
  return (
    <div className="space-y-3">
      {!runId && starting && <Starting id={starting} />}
      {!runId && !starting && startError && <StartFailed id={startError.scenario} message={startError.message} />}
      {!runId && !starting && !startError && <Welcome />}
      <ol className="space-y-2.5" aria-label="What the agents are doing">
        {STAGES.map((s, i) => (
          <Stage key={s.id} n={i + 1} id={s.id} title={s.title} idle={s.idle} status={stages[s.id]} summary={summaries[s.id]} agents={s.agents}>{content[s.id]}</Stage>
        ))}
      </ol>
      <NegotiationCard />
      {runId && <MoreScenarios />}
    </div>
  )
}

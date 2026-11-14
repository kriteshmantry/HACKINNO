import clsx from 'clsx'
import { useEffect, useMemo, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useRun } from '@/store/runStore'
import { AGENTS, type RunEvent } from '@/lib/types'
import { lakhs, rupees, shortDate } from '@/lib/format'
import { backend } from '@/backend'
import { agentMeta, agentStatusColor, CloseButton } from '../ui'
import { Drawer } from '../console/Drawers'
import { InboxPanel } from '../console/InboxPanel'
import { ActionLog } from '../console/ActionLog'
import { ImpactGraph } from '../console/ImpactGraph'
import { BeforeAfter } from '../console/BeforeAfter'
import { RadarRail } from '../watch/Radar'

/** Events worth telling a person about, in their words; the rest stays in the full log. */
const SHOW = new Set(['run.started', 'message.triaged', 'change.extracted', 'confidence', 'impact', 'options', 'option.chosen', 'plan',
  'approval.requested', 'approval.decided', 'tool.retry', 'tool.failed', 'breaker.open', 'preempted', 'verify.check', 'run.done',
  'run.escalated', 'run.quarantined', 'run.waiting', 'clarification.requested', 'preference.learned', 'tool.skipped_duplicate',
  'negotiation.available', 'verification.outreach', 'outreach.sent', 'clarification.answered'])

/** Each event as a short sentence a person can follow, whichever backend produced it. */
function say(e: RunEvent): string {
  const p = e.payload ?? {}
  switch (e.type) {
    case 'run.started': return `Started on ${p.message_id}`
    case 'message.triaged': return p.verdict === 'suspicious' ? `${p.message_id} quarantined: it tried to give orders` : p.verdict === 'relevant' ? `${p.message_id} is about a sponsor commitment` : `${p.message_id} is not relevant`
    case 'change.extracted': return `Read the change: ${p.change?.old_value ? `${lakhs(p.change.old_value)} → ` : ''}${lakhs(p.change?.new_value ?? 0)}`
    case 'confidence': return `Confidence ${Number(p.confidence?.score).toFixed(2)}: ${p.confidence?.band === 'autonomous' ? 'can act on low-risk steps' : p.confidence?.band === 'supervised' ? 'every change needs your OK' : 'needs a person to confirm'}`
    case 'impact': return `Found ${p.nodes?.length ?? 0} affected items`
    case 'options': return `${p.options?.length ?? 0} ways to cover the gap, ${p.recommended} recommended`
    case 'option.chosen': return `Option ${p.option_id} chosen${p.by === 'human' ? ' by you' : ' automatically'}`
    case 'plan': return `Plan v${p.plan?.version}: ${p.plan?.actions?.length ?? 0} changes`
    case 'approval.requested': return `Needs your OK: ${p.approval?.title ?? 'a change'}`
    case 'approval.decided': return p.decision === 'reject' ? 'You rejected a change' : p.decision === 'edit' ? 'You edited and approved a change' : 'You approved a change'
    case 'tool.retry': return `${p.tool} failed, retrying`
    case 'tool.failed': return `${p.tool} failed`
    case 'breaker.open': return `Stopped calling ${p.tool} for now`
    case 'tool.skipped_duplicate': return 'Skipped a step that was already applied'
    case 'preempted': return 'Newer information arrived: replanning'
    case 'verify.check': return `Check ${p.check?.id} failed: ${String(p.check?.label ?? '').toLowerCase()}`
    case 'clarification.requested': return p.clarification?.low_trust ? 'Held: the sender could not be verified' : 'Asked you to confirm the amount'
    case 'clarification.answered': return e.message
    case 'confidence': return p.confidence?.gated_by === 'trust'
      ? `Sender trust ${Number(p.confidence?.trust).toFixed(2)} is the weak point: ${p.confidence?.band === 'clarify' ? 'held for verification' : 'every change needs your OK'}`
      : `Confidence ${Number(p.confidence?.score).toFixed(2)}: ${p.confidence?.band === 'autonomous' ? 'can act on low-risk steps' : p.confidence?.band === 'supervised' ? 'every change needs your OK' : 'needs a person to confirm'}`
    case 'negotiation.available': return p.negotiation?.headline ? `${p.negotiation.headline}: counter-offer drafted` : e.message
    case 'verification.outreach': return `Asked ${p.to} (contact on file) to confirm`
    case 'outreach.sent': return e.message
    default: return e.message
  }
}

export function SideRail() {
  const agents = useRun((s) => s.agents)
  const log = useRun((s) => s.log)
  const startedAt = useRun((s) => s.startedAt)
  const handoff = useRun((s) => s.handoff)
  const runId = useRun((s) => s.runId)
  const state = useRun((s) => s.state)
  const facts = useRun((s) => s.facts)
  const episodes = useRun((s) => s.episodes)
  const feed = useMemo(() => {
    const out: RunEvent[] = []
    for (const e of log) {
      if (!SHOW.has(e.type)) continue
      if (e.type === 'verify.check' && e.payload?.check?.pass) continue // passing checks are summarised in the story
      out.push(e)
      if (out.length >= 9) break
    }
    return out
  }, [log])
  const t0 = startedAt ? +new Date(startedAt) : 0
  const rel = (ts: string) => { const s = Math.max(0, Math.round((+new Date(ts) - t0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
  const tone = (e: RunEvent) => /retry|approval.requested|preempted|waiting|clarification/.test(e.type) ? 'wait'
    : /failed|breaker|escalated|quarantined/.test(e.type) || (e.type === 'verify.check' && !e.payload?.check?.pass) ? 'fail'
      : /done|decided|chosen/.test(e.type) ? 'ok' : 'faint'
  return (
    <aside className="space-y-3 lg:sticky lg:top-[72px]">
      <RadarRail />
      <section className="rounded-md border border-line bg-surface px-4 py-3">
        <h2 className="text-[13px] font-bold">Who is working</h2>
        <ul className="mt-2 space-y-1.5">
          {AGENTS.map((id) => {
            const a = agents[id]
            return (
              <li key={id} className="flex items-start gap-2.5" title={agentMeta[id].role}>
                <span className={clsx('mt-[5px] h-2 w-2 shrink-0 rounded-full', a.status === 'working' && 'working')}
                  style={{ background: a.status === 'idle' ? 'transparent' : agentStatusColor[a.status], border: `1.5px solid ${a.status === 'idle' ? 'var(--line)' : agentStatusColor[a.status]}` }} />
                <span className="min-w-0">
                  <span className={clsx('block text-[13px] font-semibold', a.status === 'idle' && 'text-muted')}>{id}</span>
                  <span className="block truncate text-[12px] text-muted">{a.status === 'idle' ? agentMeta[id].role : a.note}</span>
                </span>
              </li>
            )
          })}
        </ul>
        {handoff && (
          <p className="mt-2.5 border-t border-line-soft pt-2 text-[12px] text-muted">
            <span className="font-semibold text-text">Last handoff:</span> {handoff.from} passed to {handoff.to}: {handoff.summary}
          </p>
        )}
        <p className="mt-2 text-[11.5px] text-faint">The Coordinator runs a state machine: it hands each agent a typed result and decides what happens next.</p>
      </section>
      <section className="rounded-md border border-line bg-surface px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[13px] font-bold">Memory</h2>
          <button onClick={() => useRun.getState().set('panel', 'memory')} className="text-[12px] font-semibold text-work hover:underline">Open</button>
        </div>
        <dl className="mt-1.5 space-y-1.5 text-[12.5px]">
          <div>
            <dt className="font-semibold">Short-term</dt>
            <dd className="text-muted">{runId ? `Run ${runId} (${state.toLowerCase().replace(/_/g, ' ')}) ` : 'The current run’s working state '}{backend.kind === 'http' ? 'is saved after every step, so a reload or restart picks it up again.' : 'is kept in this browser tab.'}</dd>
          </div>
          <div>
            <dt className="font-semibold">Long-term</dt>
            <dd className="text-muted">{facts.length} version{facts.length === 1 ? '' : 's'} of what TechNova committed{facts.length > 1 ? ', old ones kept as history' : ''}; {episodes.length} finished run{episodes.length === 1 ? '' : 's'} remembered.</dd>
          </div>
        </dl>
      </section>
      <section className="rounded-md border border-line bg-surface px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[13px] font-bold">Latest activity</h2>
          <button onClick={() => useRun.getState().set('panel', 'log')} disabled={!log.length} className="text-[12px] font-semibold text-work hover:underline disabled:text-faint disabled:no-underline">Full log</button>
        </div>
        {feed.length ? (
          <ol className="mt-2 space-y-1.5">
            {feed.map((e) => (
              <li key={e.id} className="slide-in grid grid-cols-[34px_1fr] gap-2 text-[12.5px] leading-snug">
                <span className="tnum pt-px text-[11px] text-faint">{rel(e.ts)}</span>
                <span className={clsx(tone(e) !== 'faint' && `text-${tone(e)}`)}>{say(e)}</span>
              </li>
            ))}
          </ol>
        ) : <p className="mt-1.5 text-[12.5px] text-muted">Nothing yet. Every step the agents take is recorded with the evidence it relied on.</p>}
      </section>
    </aside>
  )
}

/** A large dialog for the map and the full before and after. */
function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 grid place-items-center bg-[var(--overlay)] p-3 sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div role="dialog" aria-modal="true" aria-label={title} className="flex h-[min(86vh,900px)] w-full max-w-[1200px] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-[var(--shadow)]"
            initial={{ y: 12 }} animate={{ y: 0 }} exit={{ y: 8, opacity: 0 }} onClick={(e) => e.stopPropagation()}>
            <header className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
              <h2 className="text-[15px] font-bold">{title}</h2>
              <CloseButton onClick={onClose} />
            </header>
            <div className="min-h-0 flex-1">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function MemoryView() {
  const facts = useRun((s) => s.facts)
  const episodes = useRun((s) => s.episodes)
  const prefs = useRun((s) => s.preferences)
  const sorted = [...facts].sort((a, b) => a.valid_from.localeCompare(b.valid_from))
  return (
    <div className="space-y-6 text-[13px]">
      <section>
        <h3 className="font-bold">What we believe TechNova committed, over time</h3>
        <p className="mt-0.5 text-[12.5px] text-muted">Long-term memory is versioned. A new fact supersedes the old one instead of overwriting it, so you can still ask what was believed on any date.</p>
        <ol className="mt-3 space-y-3 border-l border-line pl-4">
          {sorted.map((f) => (
            <li key={f.id} className="relative">
              <span className={clsx('absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-xs border-2', f.status === 'current' ? 'border-text bg-text' : 'border-faint bg-surface')} aria-hidden />
              <p><span className={clsx('text-[15px] font-bold', f.status === 'superseded' && 'was')}>{rupees(f.value)}</span> <span className={clsx('ml-1 text-[12px] font-semibold', f.status === 'current' ? 'text-ok' : f.status === 'proposed' ? 'text-wait' : 'text-faint')}>{f.status}</span></p>
              <p className="text-[12.5px] text-muted">From {f.source_ref}, valid from {shortDate(f.valid_from)}{f.valid_to ? ` until ${shortDate(f.valid_to)}` : ''}. Confidence {f.confidence.toFixed(2)}.</p>
            </li>
          ))}
        </ol>
      </section>
      <section>
        <h3 className="font-bold">Past runs</h3>
        <p className="mt-0.5 text-[12.5px] text-muted">Each finished run leaves a one-line summary the next run can learn from.</p>
        {episodes.length ? (
          <ul className="mt-2 space-y-1.5">{episodes.map((e) => <li key={e.run_id + e.at}><span className="font-mono text-[11.5px] text-faint">{e.run_id}</span> <span className="text-muted">{e.summary.replace(/(d{5,})/g, (n) => rupees(Number(n))).replace(/; rejected []/, '').replace(/outcome done: /, '')}</span></li>)}</ul>
        ) : <p className="mt-2 text-muted">None yet. Finish a scenario and it appears here.</p>}
      </section>
      <section>
        <h3 className="font-bold">Short-term memory</h3>
        <p className="mt-0.5 text-[12.5px] text-muted">{backend.kind === 'http'
          ? 'The run being worked on (its state, extracted change, impact, options, plans and approvals) is saved to the database after every step. Reloading this page, or restarting the server, resumes from there.'
          : 'On the built-in simulator the run being worked on lives in this browser tab.'}</p>
      </section>
      {backend.profile.caps.preferences && (
        <section>
          <h3 className="font-bold">Learned from your edits</h3>
          {prefs.length ? <ul className="mt-2 space-y-1">{prefs.map((p) => <li key={p.id}>{p.rule} <span className="text-muted">(from {p.source_ref})</span></li>)}</ul>
            : <p className="mt-1 text-muted">Nothing yet. Edit an approval, for example add the treasurer to cc, and the next run does it for you.</p>}
        </section>
      )}
    </div>
  )
}

export function Panels() {
  const panel = useRun((s) => s.panel)
  const close = () => useRun.getState().set('panel', undefined)
  return (
    <>
      <Dialog open={panel === 'map'} title="Map of what the change affects" onClose={close}>
        <div className="h-full p-2"><ImpactGraph /></div>
      </Dialog>
      <Dialog open={panel === 'changes'} title="Before and after" onClose={close}><BeforeAfter /></Dialog>
      <Drawer open={panel === 'inbox'} onClose={close} title="Inbox and chat" sub="Everything the team received. The message being processed is highlighted.">
        <div className="-mx-5 -my-4 h-[calc(100vh-96px)]"><InboxPanel /></div>
      </Drawer>
      <Drawer open={panel === 'memory'} onClose={close} title="Memory" sub="What Second Brain remembers between messages and between runs.">
        <MemoryView />
      </Drawer>
      <Drawer open={panel === 'log'} onClose={close} title="Full log" sub="Every step every agent took, in order, with the evidence it relied on. Export it as JSON for the audit trail.">
        <div className="-mx-5 -my-4 h-[calc(100vh-96px)]"><ActionLog /></div>
      </Drawer>
    </>
  )
}

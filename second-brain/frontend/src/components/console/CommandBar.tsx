import clsx from 'clsx'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useRun } from '@/store/runStore'
import { backend } from '@/backend'
import type { FaultMode, RunStateName, ScenarioId } from '@/lib/types'
import { Button, ThemeToggle, Wordmark } from '../ui'

const TRACK: { s: RunStateName; label: string }[] = [
  { s: 'TRIAGE', label: 'Triage' }, { s: 'EXTRACT', label: 'Extract' }, { s: 'RESOLVE', label: 'Resolve' },
  { s: 'ANALYZE', label: 'Impact' }, { s: 'OPTIONS', label: 'Options' }, { s: 'PLAN', label: 'Plan' },
  { s: 'VALIDATE', label: 'Validate' }, { s: 'EXECUTE', label: 'Execute' }, { s: 'VERIFY', label: 'Verify' }, { s: 'DONE', label: 'Done' },
]
const DETOUR: Partial<Record<RunStateName, { at: RunStateName; label: string; tone: 'wait' | 'fail' }>> = {
  AWAIT_APPROVAL: { at: 'EXECUTE', label: 'Waiting for your approval', tone: 'wait' },
  REPLAN: { at: 'PLAN', label: 'Replanning', tone: 'wait' },
  PREEMPTED: { at: 'EXTRACT', label: 'Paused: newer information arrived', tone: 'wait' },
  AWAIT_CLARIFICATION: { at: 'RESOLVE', label: 'Asking the sponsor to confirm', tone: 'wait' },
  QUARANTINED: { at: 'TRIAGE', label: 'Quarantined at triage', tone: 'fail' },
  ESCALATE: { at: 'VERIFY', label: 'Handed to a person', tone: 'fail' },
  INGEST: { at: 'TRIAGE', label: 'Message received', tone: 'wait' },
}

function StateTrack() {
  const state = useRun((s) => s.state)
  const visited = useRun((s) => s.visited)
  const detour = DETOUR[state]
  const at = detour?.at ?? state
  const idx = TRACK.findIndex((t) => t.s === at)
  const label = state === 'IDLE' ? 'No run yet' : detour ? detour.label : TRACK.find((t) => t.s === state)?.label ?? state
  return (
    <div className="flex min-w-0 items-center gap-4">
      <ol className="hidden items-center md:flex" aria-label="Coordinator steps">
        {TRACK.map((t, i) => {
          const reached = visited.includes(t.s) || (idx >= 0 && i < idx)
          const current = i === idx && state !== 'IDLE'
          const color = current
            ? state === 'DONE' ? 'var(--ok)' : detour ? `var(--${detour.tone})` : 'var(--work)'
            : reached ? 'var(--text)' : 'var(--line)'
          return (
            <li key={t.s} className="flex items-center" aria-current={current ? 'step' : undefined}>
              {i > 0 && <span className="h-px w-3 lg:w-4" style={{ background: reached || current ? 'var(--muted)' : 'var(--line)' }} />}
              <span title={t.label} className={clsx('block h-2.5 w-2.5 rounded-xs', current && state !== 'DONE' && 'working')}
                style={{ background: reached || current ? color : 'transparent', border: `1.5px solid ${color}` }} />
              <span className="sr-only">{t.label}{current ? ' (current)' : reached ? ' (done)' : ''}</span>
            </li>
          )
        })}
      </ol>
      <span role="status" className={clsx('truncate text-[12.5px] font-semibold', detour ? (detour.tone === 'fail' ? 'text-fail' : 'text-wait') : state === 'DONE' ? 'text-ok' : 'text-muted')}>
        {label}
      </span>
    </div>
  )
}

function StreamStatus() {
  const st = useRun((s) => s.streamStatus)
  const runId = useRun((s) => s.runId)
  const word = st === 'live' ? 'live' : st === 'reconnecting' ? 'reconnecting' : st === 'connecting' ? 'connecting' : 'idle'
  return (
    <span className="hidden items-center gap-2 text-[12px] text-muted md:inline-flex"
      title={backend.kind === 'mock' ? 'Running on the in-browser simulator, which emits the same events as the FastAPI backend' : 'Connected to the FastAPI backend over server-sent events'}>
      {runId ? <span className="font-mono text-[11.5px] text-text">{runId}</span> : null}
      <span className={clsx(st === 'live' ? 'text-ok' : st === 'reconnecting' ? 'text-wait' : 'text-faint')}>{word}</span>
      <span className="text-faint">on {backend.kind === 'mock' ? 'the simulator' : 'the live API'}</span>
    </span>
  )
}

export function CommandBar() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4">
      <div className="flex min-w-0 items-center gap-5">
        <Link to="/" className="shrink-0" aria-label="Second Brain overview"><Wordmark className="text-[15px]" /></Link>
        <span className="hidden text-[12.5px] text-muted lg:inline">{backend.profile.eventName} operations</span>
        <span className="hidden h-5 w-px bg-line md:block" />
        <StateTrack />
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <StreamStatus />
        <ThemeToggle />
      </div>
    </header>
  )
}

const FAULTS: { m: FaultMode; label: string; hint: string }[] = [
  { m: 'off', label: 'Off', hint: 'No injected failures' },
  { m: 'once', label: 'Once', hint: 'One 503, then recovers on retry' },
  { m: 'always', label: 'Always', hint: 'Fails every time: the circuit opens and the plan switches to a fallback' },
  { m: 'slow', label: 'Slow', hint: 'Times out after the write commits, so the retry is skipped as already applied' },
]

function Segmented<T extends string>({ label, items, value, onPick, activeCls }: { label: string; items: { v: T; text: ReactNode; hint: string }[]; value?: T; onPick: (v: T) => void; activeCls: (v: T) => string }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 rounded-sm border border-line bg-surface p-0.5">
      {items.map((it) => (
        <button key={it.v} onClick={() => onPick(it.v)} title={it.hint} aria-pressed={value === it.v}
          className={clsx('flex h-7 items-center gap-1.5 whitespace-nowrap rounded-xs px-2.5 text-[12.5px] font-semibold transition-colors', value === it.v ? activeCls(it.v) : 'text-muted hover:text-text')}>
          {it.text}
        </button>
      ))}
    </div>
  )
}

export function Toolbar() {
  const scenario = useRun((s) => s.scenario)
  const fault = useRun((s) => s.fault)
  const state = useRun((s) => s.state)
  const runId = useRun((s) => s.runId)
  const { start, setFault, inject, redeliver, corrupt, reset } = useRun.getState()
  const { profile } = backend
  const SCENARIOS = (Object.keys(profile.scenarios) as ScenarioId[]).map((id) => ({ id, ...profile.scenarios[id] }))
  const active = !!runId && !['DONE', 'QUARANTINED', 'IGNORED', 'ESCALATE', 'IDLE', 'AWAIT_CLARIFICATION'].includes(state)
  // the simulator re-checks after a run; the API catches it in the running run's own verification
  const canCorrupt = profile.caps.preemption ? state === 'DONE' : active && ['EXECUTE', 'AWAIT_APPROVAL'].includes(state)
  const canInject = !!runId && state !== 'QUARANTINED' && (profile.caps.preemption || !active)
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-bg-2 px-4 py-2 [&>*]:max-w-full [&>*]:overflow-x-auto">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[12px] font-semibold text-muted">Scenario</span>
        <Segmented label="Scenario" value={scenario} onPick={(v) => start(v)} activeCls={() => 'bg-text text-bg'}
          items={SCENARIOS.map((s) => ({ v: s.id, hint: s.hint, text: <><span className="font-mono text-[11px] opacity-70">{s.id}</span>{s.name}</> }))} />
      </div>

      <div className="flex items-center gap-2">
        <span className="shrink-0 whitespace-nowrap text-[12px] font-semibold text-muted">Break <span className="font-mono text-[11.5px] font-normal text-text">{profile.faultTool}</span></span>
        <Segmented label="Fault injection" value={fault} onPick={(v) => setFault(v)} activeCls={(v) => (v === 'off' ? 'bg-surface-2 text-text' : 'bg-wait-soft text-wait')}
          items={FAULTS.map((f) => ({ v: f.m, hint: f.hint, text: f.label }))} />
      </div>

      <div className="flex items-center gap-1 xl:ml-auto">
        <Button size="sm" variant="ghost" onClick={inject} disabled={!canInject} title={profile.caps.preemption ? 'Chat: “TN just called, board approved 3.5L final”. A running plan pauses and replans the difference' : 'Chat: “TN just called, board approved 3.5L final”. Starts a new run that plans only what still differs. Available once a run has finished'}>
          Send the “3.5L final” chat
        </Button>
        <Button size="sm" variant="ghost" onClick={redeliver} disabled={state !== 'DONE'} title="Deliver e-19 again, as a duplicate webhook would. Nothing should apply twice">
          Deliver e-19 again
        </Button>
        <Button size="sm" variant="ghost" onClick={corrupt} disabled={!canCorrupt} title={profile.caps.preemption ? 'Someone re-enables the keynote outside the system after the run. Verification must catch it' : 'Someone re-enables the keynote outside the system while the run waits for an approval. Its verification must catch it before the run can finish'}>
          Edit outside the system
        </Button>
        <Button size="sm" variant="quiet" onClick={reset}>Reset</Button>
      </div>
    </div>
  )
}

import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { backend } from '@/backend'
import { useRun } from '@/store/runStore'
import type { FaultMode, ScenarioId } from '@/lib/types'
import { Button, ThemeToggle, Wordmark } from '../ui'
import { useRunStatus } from './status'
import { WatchButtons } from '../watch/WatchPanels'

/** A button that opens a small panel; closes on outside click or Escape. */
function Popover({ label, variant = 'quiet', children, align = 'right' }: { label: ReactNode; variant?: 'primary' | 'quiet'; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <Button variant={variant} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>
        {label}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={clsx('transition-transform', open && 'rotate-180')}><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </Button>
      {open && (
        <div role="menu" className={clsx('absolute top-11 z-50 w-[min(360px,calc(100vw-24px))] rounded-md border border-line bg-surface p-2 shadow-[var(--shadow)]', align === 'right' ? 'right-0' : 'left-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function MenuItem({ title, hint, onClick, disabled, why }: { title: string; hint: string; onClick: () => void; disabled?: boolean; why?: string }) {
  return (
    <button role="menuitem" disabled={disabled} onClick={onClick}
      className="block w-full rounded-sm px-3 py-2 text-left hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent">
      <span className="block text-[13.5px] font-semibold">{title}</span>
      <span className="block text-[12px] leading-snug text-muted">{disabled && why ? why : hint}</span>
    </button>
  )
}

function ScenarioMenu() {
  const scenario = useRun((s) => s.scenario)
  const runId = useRun((s) => s.runId)
  const state = useRun((s) => s.state)
  const { profile } = backend
  const running = !!runId && !['DONE', 'QUARANTINED', 'IGNORED', 'ESCALATE', 'IDLE'].includes(state)
  return (
    <Popover label={<><span className="sm:hidden">Run</span><span className="hidden sm:inline">Run a scenario</span></>} variant="primary">
      {(close) => (
        <div>
          <p className="px-3 pb-1 pt-1.5 text-[12px] text-muted">
            Pick one to run. It resets the workspace and plays its message through the agents{running ? '; the run in progress stops' : ''}.
          </p>
          {(Object.keys(profile.scenarios) as ScenarioId[]).map((id) => (
            <MenuItem key={id} title={`${id}: ${profile.scenarios[id]!.name}${scenario === id ? (running ? ' (running now)' : ' (last run)') : ''}`} hint={profile.scenarios[id]!.hint}
              onClick={() => { close(); useRun.getState().start(id) }} />
          ))}
        </div>
      )}
    </Popover>
  )
}

const FAULTS: { m: FaultMode; label: string; hint: string }[] = [
  { m: 'off', label: 'Off', hint: 'The budget tool works normally.' },
  { m: 'once', label: 'Once', hint: 'Fails once, then the retry succeeds.' },
  { m: 'always', label: 'Always', hint: 'Keeps failing: the plan switches to a safe fallback.' },
  { m: 'slow', label: 'Slow', hint: 'Times out after writing; the retry must not apply it twice.' },
]

function DemoMenu() {
  const fault = useRun((s) => s.fault)
  const state = useRun((s) => s.state)
  const runId = useRun((s) => s.runId)
  const { profile } = backend
  const { setFault, inject, redeliver, corrupt, reset } = useRun.getState()
  const active = !!runId && !['DONE', 'QUARANTINED', 'IGNORED', 'ESCALATE', 'IDLE', 'AWAIT_CLARIFICATION'].includes(state)
  const canCorrupt = profile.caps.preemption ? state === 'DONE' : active && ['EXECUTE', 'AWAIT_APPROVAL'].includes(state)
  const canInject = !!runId && state !== 'QUARANTINED' && (profile.caps.preemption || !active)
  return (
    <Popover label={<><span className="sm:hidden">Demo</span><span className="hidden sm:inline">Demo controls</span></>}>
      {(close) => (
        <div>
          <div className="px-3 pb-2 pt-1.5">
            <div className="text-[13.5px] font-semibold">Make the budget tool fail</div>
            <div role="group" aria-label="Budget tool failure" className="mt-1.5 flex rounded-sm border border-line p-0.5">
              {FAULTS.map((f) => (
                <button key={f.m} aria-pressed={fault === f.m} onClick={() => setFault(f.m)}
                  className={clsx('h-7 flex-1 rounded-xs text-[12.5px] font-semibold', fault === f.m ? (f.m === 'off' ? 'bg-surface-2 text-text' : 'bg-wait-soft text-wait') : 'text-muted hover:text-text')}>
                  {f.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[12px] text-muted">{FAULTS.find((f) => f.m === fault)?.hint} Applies to the next run.</p>
          </div>
          <div className="my-1 h-px bg-line-soft" />
          <MenuItem title="Send the “3.5L final” chat" hint="The sponsorship lead says the board approved ₹3.5L. Only the difference gets planned."
            disabled={!canInject} why={!runId ? 'Run S1 first.' : 'Available once the current run has finished.'} onClick={() => { close(); inject() }} />
          <MenuItem title="Deliver e-19 again" hint="Like a duplicate webhook. Nothing should be applied twice."
            disabled={state !== 'DONE'} why="Available after a run finishes." onClick={() => { close(); redeliver() }} />
          <MenuItem title="Edit a record outside the system" hint="Re-enables the keynote behind the agents’ back. Verification must catch it."
            disabled={!canCorrupt} why={profile.caps.preemption ? 'Available after a run finishes.' : 'Available while a run waits for your approval.'} onClick={() => { close(); corrupt() }} />
          <div className="my-1 h-px bg-line-soft" />
          <MenuItem title="Reset the workspace" hint="Back to the starting budget, tracker and inbox." onClick={() => { close(); reset() }} />
          <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[12px] text-muted">
            <span>Connected to {backend.kind === 'http' ? 'the live backend' : 'the built-in simulator'}</span>
            <ThemeToggle />
          </div>
        </div>
      )}
    </Popover>
  )
}

export function SimpleHeader() {
  const status = useRunStatus()
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface">
      <div className="mx-auto flex h-14 max-w-[1180px] items-center gap-2 px-3 sm:gap-3 sm:px-4">
        <Link to="/" className="shrink-0" aria-label="Second Brain overview"><Wordmark className="text-[15px]" /></Link>
        <span className="hidden shrink-0 text-[12.5px] text-muted lg:inline">{backend.profile.eventName}</span>
        <span className="hidden h-5 w-px shrink-0 bg-line md:block" />
        <p role="status" className="hidden min-w-0 flex-1 items-center gap-2 text-[13px] md:flex">
          <span className={clsx('h-2 w-2 shrink-0 rounded-full', status.busy && 'working')} style={{ background: `var(--${status.tone})` }} />
          <span className="truncate font-semibold">{status.text}</span>
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <WatchButtons />
          <ScenarioMenu />
          <DemoMenu />
        </div>
      </div>
    </header>
  )
}

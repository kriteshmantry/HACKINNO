import clsx from 'clsx'
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'
import type { ActionStatus, AgentId, AgentStatus, NodeKind, Severity } from '@/lib/types'
import { useTheme } from '@/lib/theme'

/* ------------------------------------------------------------------ */
/* Buttons: ink-on-paper primary, bordered secondary, quiet ghost.     */
/* ------------------------------------------------------------------ */
export function Button({ variant = 'quiet', size = 'md', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'quiet' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  return (
    <button
      {...p}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-sm font-semibold transition-colors disabled:opacity-40 whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-9 px-3.5 text-[13.5px]',
        variant === 'primary' && 'bg-text text-bg hover:bg-text/85',
        variant === 'quiet' && 'border border-line bg-surface text-text hover:border-text/40',
        variant === 'ghost' && 'text-muted hover:text-text hover:bg-surface-2',
        variant === 'danger' && 'border border-fail/50 text-fail hover:bg-fail-soft',
        className,
      )}
    />
  )
}

export type Tone = 'work' | 'wait' | 'fail' | 'ok' | 'note' | 'muted'
const toneCls: Record<Tone, string> = {
  work: 'bg-work-soft text-work',
  wait: 'bg-wait-soft text-wait',
  fail: 'bg-fail-soft text-fail',
  ok: 'bg-ok-soft text-ok',
  note: 'bg-note-soft text-note',
  muted: 'bg-surface-2 text-muted',
}
export function Chip({ tone = 'muted', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={clsx('inline-flex items-center gap-1 rounded-xs px-1.5 text-[11.5px] font-semibold leading-5', toneCls[tone], className)}>{children}</span>
}

export const Mono = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={clsx('font-mono text-[11.5px]', className)}>{children}</span>
)

/** The one glyph we draw ourselves: close. Everything else is a word. */
export function CloseGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square">
      <path d="M3 3l8 8M11 3l-8 8" />
    </svg>
  )
}
export function CloseButton({ onClick, label = 'Close' }: { onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} aria-label={label} className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-muted hover:bg-surface-2 hover:text-text">
      <CloseGlyph />
    </button>
  )
}

export const Spinner = ({ className }: { className?: string }) => <span className={clsx('spinner', className)} aria-hidden />

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span className={clsx('skeleton block', className)} style={style} aria-hidden />
}

export function RiskChip({ risk, reasons }: { risk: number; reasons: string[] }) {
  const tone: Tone = risk >= 6 ? 'fail' : risk >= 3 ? 'wait' : risk > 0 ? 'work' : 'muted'
  return (
    <span className="group relative" tabIndex={reasons.length ? 0 : -1}>
      <Chip tone={tone}>risk {risk}</Chip>
      {reasons.length > 0 && (
        <span role="tooltip" className="pointer-events-none absolute right-0 top-6 z-30 hidden w-56 rounded-sm border border-line bg-surface p-2 text-[12px] text-muted shadow-[var(--shadow)] group-hover:block group-focus:block">
          {reasons.map((r) => <span key={r} className="block">{r}</span>)}
          <span className="mt-1 block text-faint">Approval needed at 3 or more</span>
        </span>
      )}
    </span>
  )
}

export const statusTone: Record<ActionStatus, Tone> = {
  pending: 'muted', running: 'work', retrying: 'wait', awaiting_approval: 'wait', done: 'ok', failed: 'fail',
  replaced: 'muted', skipped_duplicate: 'note', rejected: 'fail', superseded: 'muted', blocked: 'fail',
}
export const statusLabel: Record<ActionStatus, string> = {
  pending: 'Pending', running: 'Running', retrying: 'Retrying', awaiting_approval: 'Needs approval', done: 'Done', failed: 'Failed',
  replaced: 'Replaced', skipped_duplicate: 'Already applied', rejected: 'Rejected', superseded: 'Superseded', blocked: 'Blocked',
}

export const agentStatusColor: Record<AgentStatus, string> = {
  idle: 'var(--line)', working: 'var(--work)', waiting: 'var(--wait)', done: 'var(--ok)', error: 'var(--fail)',
}
export const agentStatusWord: Record<AgentStatus, string> = { idle: 'Idle', working: 'Working', waiting: 'Waiting', done: 'Done', error: 'Error' }

export const severityColor: Record<Severity, string> = { high: 'var(--fail)', medium: 'var(--wait)', low: 'var(--work)' }

export const kindLabel: Record<NodeKind, string> = {
  Sponsor: 'Sponsor', Tier: 'Tier', Budget: 'Budget', BudgetLine: 'Budget line', Deliverable: 'Deliverable', CalendarEvent: 'Calendar',
  OrgApproval: 'Approval', Doc: 'Document', PromoAsset: 'Published asset', Person: 'Person', Message: 'Message',
}

export const agentMeta: Record<AgentId, { role: string; engine: 'Model and rules' | 'Code' | 'Code, model chooses' }> = {
  Coordinator: { role: 'Runs the state machine, budgets and handoffs', engine: 'Code' },
  Communication: { role: 'Triages messages, extracts the change, drafts replies', engine: 'Model and rules' },
  Knowledge: { role: 'Resolves entities, checks memory, traces impact', engine: 'Code' },
  Planning: { role: 'Computes options in code, picks one, writes the plan', engine: 'Code' },
  Execution: { role: 'Calls tools exactly once, with retries and approvals', engine: 'Code' },
  Verification: { role: 'Checks 10 invariants against live state', engine: 'Code' },
}

export function ThemeToggle() {
  const [theme, toggle] = useTheme()
  return (
    <button onClick={toggle} className="h-8 rounded-sm px-2 text-[12.5px] font-semibold text-muted hover:bg-surface-2 hover:text-text"
      aria-label={theme === 'dark' ? 'Switch to the day theme' : 'Switch to the night theme'}>
      {theme === 'dark' ? 'Day' : 'Night'}
    </button>
  )
}

/** Wordmark: two linked nodes, the smallest picture of "this change touches that". */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-2 font-bold tracking-[-0.02em]', className)}>
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
        <rect x="1.5" y="1.5" width="7" height="7" rx="1" fill="var(--text)" />
        <rect x="11.5" y="11.5" width="7" height="7" rx="1" fill="none" stroke="var(--text)" strokeWidth="1.6" />
        <path d="M8.5 5 H15 V11.5" fill="none" stroke="var(--text)" strokeWidth="1.6" />
      </svg>
      Second Brain
    </span>
  )
}

export function Panel({ title, aside, children, className, bodyClass }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={clsx('flex h-full min-h-0 flex-col rounded-md border border-line bg-surface', className)}>
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line-soft px-3.5">
        <h2 className="whitespace-nowrap text-[13px] font-bold tracking-[-0.005em]">{title}</h2>
        {aside}
      </header>
      <div className={clsx('min-h-0 flex-1', bodyClass)}>{children}</div>
    </section>
  )
}

import clsx from 'clsx'
import { useRun } from '@/store/runStore'

const INVARIANTS = [
  ['V1', 'Commitment matches the email'], ['V2', 'Tier follows the tier rules'], ['V3', 'Deliverables match the tier exactly'],
  ['V4', 'Budget balances, or the gap is tracked'], ['V5', 'No calendar event for a removed deliverable'], ['V6', 'Every plan step reached a final state'],
  ['V7', 'Each change applied at most once'], ['V8', 'Every outbound message was approved'], ['V9', 'Every write traces back to a source message'],
  ['V10', 'Old fact superseded, not deleted'],
] as const

export function ChecksView() {
  const checks = useRun((s) => s.checks)
  const outcome = useRun((s) => s.outcome)
  const passed = checks.filter((c) => c.pass).length
  return (
    <div className="h-full overflow-y-auto p-3.5">
      <div className="mb-2 flex flex-wrap items-baseline gap-3">
        <p className="text-[15px] font-semibold">
          {checks.length ? <><span className={passed === checks.length ? 'text-ok' : 'text-fail'}>{passed} of {checks.length}</span> checks passed</> : 'Verified in code after every run'}
        </p>
        <span className="text-[12.5px] text-muted">Read straight from the live tracker, budget, calendar, outbox and memory. A failed check triggers a targeted replan.</span>
      </div>
      <ol className="grid gap-x-6 md:grid-cols-2">
        {INVARIANTS.map(([id, label]) => {
          const c = checks.find((x) => x.id === id)
          return (
            <li key={id} className="flex items-start gap-2.5 border-t border-line-soft py-1.5">
              <span className={clsx('w-11 shrink-0 text-[12px] font-bold', !c ? 'text-faint' : c.pass ? 'text-ok' : 'text-fail')}>{!c ? 'Not run' : c.pass ? 'Pass' : 'Fail'}</span>
              <div className="min-w-0">
                <div className="text-[12.5px]"><span className="mr-1.5 font-mono text-[11px] text-faint">{id}</span><span className={clsx(!c && 'text-muted')}>{label}</span></div>
                {c && <div className={clsx('text-[11.5px]', c.pass ? 'text-faint' : 'text-fail')}>Expected {c.expected}; found {c.actual}</div>}
              </div>
            </li>
          )
        })}
      </ol>
      {outcome?.kind === 'done' && outcome.detail && <p className="mt-3 rounded-md bg-ok-soft px-3 py-2 text-[12.5px] text-ok">{outcome.detail}</p>}
    </div>
  )
}

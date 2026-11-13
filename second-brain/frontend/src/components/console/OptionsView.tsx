import clsx from 'clsx'
import { useRun } from '@/store/runStore'
import { lakhs, pct, rupees } from '@/lib/format'
import { Button, Chip } from '../ui'

export function OptionsView() {
  const computed = useRun((s) => s.computed)
  const options = useRun((s) => s.options)
  const recommended = useRun((s) => s.recommended)
  const rationale = useRun((s) => s.optionRationale)
  const chosen = useRun((s) => s.chosen)
  const waiting = useRun((s) => s.agents.Planning.status === 'waiting')
  const outcome = useRun((s) => s.outcome)

  if (!computed) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-sm">
          <p className="text-[13.5px] font-medium">{outcome?.kind === 'quarantined' ? 'No options: the message never reached planning' : outcome?.kind === 'waiting' ? 'No options: nothing changes until TechNova confirms' : 'Shortfall options appear here'}</p>
          <p className="mt-1 text-[12.5px] text-muted">The amount, tier and three ways to cover the gap are computed in code. The model only recommends one and explains why.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3.5">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
        <div>
          <div className="text-[12px] text-muted">Shortfall, computed in code</div>
          <div className="text-[26px] font-bold leading-tight tracking-[-0.03em] text-fail">{rupees(computed.shortfall)}</div>
        </div>
        <div className="text-[12.5px]">
          <div className="text-muted">Income</div>
          <div className="font-semibold">{lakhs(computed.income_before)} → {lakhs(computed.income_after)}</div>
        </div>
        <div className="text-[12.5px]">
          <div className="text-muted">TechNova tier</div>
          <div className="font-semibold">{computed.old_tier} → {computed.new_tier}</div>
        </div>
        {computed.deliverable_diff.length > 0 && (
          <div className="flex flex-wrap gap-1 pb-0.5">
            {computed.deliverable_diff.map((d) => <Chip key={d}>{d}</Chip>)}
          </div>
        )}
      </div>

      <div className="grid gap-2.5 md:grid-cols-3">
        {options.map((o) => {
          const isRec = o.id === recommended
          const isChosen = o.id === chosen
          return (
            <div key={o.id} className={clsx('flex flex-col rounded-md border p-3 transition-opacity',
              isChosen ? 'border-ok bg-ok-soft' : isRec && !chosen ? 'border-work' : 'border-line',
              chosen && !isChosen && 'opacity-50')}>
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-bold leading-tight">{o.id}. {o.name}</span>
                  <span className="block text-[11.5px] font-semibold text-work">{isRec ? 'Recommended by the planner' : ' '}</span>
                </span>
                {isChosen ? <Chip tone="ok">Chosen</Chip> : !chosen && (
                  <Button size="sm" variant={isRec ? 'primary' : 'quiet'} disabled={!waiting} onClick={() => useRun.getState().chooseOption(o.id)}>
                    Choose {o.id}
                  </Button>
                )}
              </div>
              <p className="mt-1 text-[12px] leading-snug text-muted">{o.strategy}</p>
              <ul className="mt-2 space-y-0.5 text-[12px]">
                {o.cuts.map((c) => (
                  <li key={c.line_id} className="flex justify-between gap-2">
                    <span>{c.category}</span>
                    <span className="font-mono text-[11.5px]"><span className="text-faint">{lakhs(c.from)} →</span> {lakhs(c.to)} <span className="text-fail">{lakhs(c.to - c.from)}</span></span>
                  </li>
                ))}
                {o.open_gap > 0 && <li className="flex justify-between gap-2 text-wait"><span>Open gap</span><span className="font-mono text-[11.5px]">{lakhs(o.open_gap)}</span></li>}
              </ul>
              <div className="mt-auto pt-3">
                <div className="flex items-center gap-2 text-[11.5px]">
                  <span className="text-muted">Covered</span>
                  <span className="h-1.5 flex-1 rounded-full bg-surface-2"><span className="block h-full rounded-full" style={{ width: pct(o.coverage), background: o.coverage >= 1 ? 'var(--ok)' : 'var(--wait)' }} /></span>
                  <span className="font-semibold">{pct(o.coverage)}</span>
                </div>
                <dl className="mt-1.5 grid grid-cols-3 gap-1 text-[11px] text-muted">
                  <div><dt>Public changes</dt><dd className="text-[13px] font-semibold text-text">{o.public_changes}</dd></div>
                  <div><dt>Approvals hit</dt><dd className="text-[13px] font-semibold text-text">{o.approvals_affected}</dd></div>
                  <div><dt>Rule breaks</dt><dd className={clsx('text-[13px] font-semibold', o.policy_violations ? 'text-fail' : 'text-ok')}>{o.policy_violations}</dd></div>
                </dl>
              </div>
            </div>
          )
        })}
      </div>

      {rationale && (
        <div className="rounded-md border border-line-soft px-3 py-2.5 text-[12.5px]">
          <span className="font-semibold">Why {recommended}: </span>
          <span className="text-muted">{rationale}</span>
          <span className="ml-1 text-[11.5px] text-faint">Written by the model from computed numbers only.</span>
        </div>
      )}
    </div>
  )
}

import clsx from 'clsx'
import { useMemo } from 'react'
import { useRun } from '@/store/runStore'
import type { ActionStatus, PlannedAction } from '@/lib/types'
import { Button, Chip, Mono, RiskChip, Spinner, statusLabel, statusTone } from '../ui'

function StatusWord({ s }: { s: ActionStatus }) {
  const spinning = s === 'running' || s === 'retrying'
  return (
    <span className="flex w-[104px] shrink-0 items-center gap-1.5 text-[12px] font-semibold" style={{ color: `var(--${statusTone[s] === 'muted' ? 'faint' : statusTone[s]})` }}>
      {spinning && <Spinner />}
      {statusLabel[s]}
    </span>
  )
}

function ActionRow({ a }: { a: PlannedAction }) {
  const status = useRun((s) => s.statuses[a.id] ?? 'pending')
  const approval = useRun((s) => Object.values(s.approvals).find((x) => x.action_id === a.id && x.status === 'pending'))
  const { set, openApproval } = useRun.getState()
  const struck = status === 'replaced' || status === 'superseded' || status === 'rejected'
  return (
    <li className={clsx('flex items-center gap-3 rounded-sm px-2 py-1.5', status === 'awaiting_approval' && 'bg-wait-soft', status === 'running' && 'bg-work-soft')}>
      <StatusWord s={status} />
      <div className="min-w-0 flex-1">
        <div className={clsx('flex items-center gap-1.5 text-[13px] font-semibold', struck && 'was font-medium')}>
          <span className="truncate">{a.title}</span>
          {a.learned && <span title={a.learned} className="shrink-0 bg-note-soft px-1 text-[11px] font-semibold text-text">learned from your edit</span>}
        </div>
        <div className="flex items-center gap-1.5 text-[11.5px] text-faint">
          <Mono>{a.id}</Mono><Mono className="text-muted">{a.tool}</Mono>
          {a.diff && <span className={clsx('text-[11px] font-semibold', a.diff === 'added' ? 'text-work' : a.diff === 'changed' ? 'text-wait' : 'text-faint')}>{a.diff}</span>}
        </div>
      </div>
      <RiskChip risk={a.risk} reasons={a.risk_reasons} />
      {approval ? (
        <Button size="sm" variant="primary" onClick={() => openApproval(approval.id)}>Review</Button>
      ) : (
        <button onClick={() => set('traceAction', a.id)} className="rounded-sm px-1.5 py-1 text-[12px] font-semibold text-work hover:bg-work-soft" aria-label={`Why: trace ${a.id} back to its evidence`}>Why?</button>
      )}
    </li>
  )
}
export function PlanView() {
  const plans = useRun((s) => s.plans)
  const view = useRun((s) => s.viewPlan)
  const validated = useRun((s) => s.validated)
  const approvals = useRun((s) => s.approvals)
  const pending = useMemo(() => Object.values(approvals).filter((a) => a.status === 'pending'), [approvals])
  const preempted = useRun((s) => s.preempted)
  const plan = plans.find((p) => p.version === view) ?? plans[plans.length - 1]

  if (!plan) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-sm">
          <p className="text-[13.5px] font-medium">The plan appears once an option is chosen</p>
          <p className="mt-1 text-[12.5px] text-muted">Every step says “set X, expecting Y”, so a step can be repeated safely and a newer plan only does what still differs.</p>
        </div>
      </div>
    )
  }
  const checks = validated[plan.version]
  const levels = [...new Set(plan.actions.map((a) => a.level))].sort((a, b) => a - b)
  // name each wave by what is in it; outbound messages always come last
  const waveName = (lv: number, i: number) => {
    const acts = plan.actions.filter((a) => a.level === lv)
    const outbound = acts.every((a) => /^(comms.|email.|chat.)/.test(a.tool))
    return outbound ? 'Tell people, always last' : i === 0 ? 'Record the change' : `Wave ${i + 1}`
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3.5 py-2">
        <div className="flex rounded-md border border-line bg-surface p-0.5">
          {plans.map((p) => (
            <button key={p.version} onClick={() => useRun.getState().set('viewPlan', p.version)}
              className={clsx('h-6 rounded-sm px-2 text-[12px] font-semibold', p.version === plan.version ? 'bg-surface-2 text-text' : 'text-muted hover:text-text')}>
              v{p.version}
            </button>
          ))}
        </div>
        <span className="text-[12px] text-muted">Option {plan.option}, {plan.actions.length} steps, {plan.actions.filter((a) => a.requires_approval).length} need approval</span>
        <Chip tone="muted" title={plan.source === 'template' ? 'Deterministic template planner (offline fallback)' : 'Model-written plan, validated before use'}>{plan.source === 'template' ? 'Template planner' : 'Model plan, from cache'}</Chip>
        {checks && <Chip tone={checks.every((c) => c.pass) ? 'ok' : 'fail'} title={checks.map((c) => `${c.pass ? 'Pass' : 'Fail'}: ${c.label}`).join('\n')}>Validator {checks.filter((c) => c.pass).length}/{checks.length}</Chip>}
        {pending.length > 0 && (
          <Button size="sm" variant="primary" className="ml-auto" onClick={() => useRun.getState().openApproval(pending[0].id)}>
            {pending.length} waiting for you
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {plan.version > 1 && (preempted || plan.removed?.length) ? (
          <div className="mx-1.5 mb-2 rounded-md border border-wait/40 bg-wait-soft px-3 py-2 text-[12.5px]">
            {preempted && <p><span className="font-semibold">Replanned from current state after {preempted.by}.</span> Kept {preempted.kept.length} applied steps; superseded {preempted.superseded.length}. Only differences are planned.</p>}
            {plan.removed?.map((r) => <p key={r.id} className="text-muted">Dropped <Mono>{r.id}</Mono> {r.title.toLowerCase()}: {r.reason.toLowerCase()}</p>)}
          </div>
        ) : null}
        {levels.map((lv, i) => (
          <section key={lv} className="mb-1.5">
            <h3 className="flex items-center gap-2 px-2 pb-0.5 pt-1 text-[11.5px] font-medium text-muted">
              <span className="grid h-4 w-4 place-items-center rounded-full bg-surface-2 text-[10px] font-semibold text-text">{i + 1}</span>
              {waveName(lv, i)}
              {plan.actions.filter((a) => a.level === lv).length > 1 && <span className="text-faint">runs in parallel</span>}
            </h3>
            <ul>{plan.actions.filter((a) => a.level === lv).map((a) => <ActionRow key={a.id} a={a} />)}</ul>
          </section>
        ))}
      </div>
    </div>
  )
}

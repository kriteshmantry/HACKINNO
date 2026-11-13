import clsx from 'clsx'
import type { ReactNode } from 'react'
import { useRun } from '@/store/runStore'
import { backend } from '@/backend'
import { lakhs, rupees } from '@/lib/format'
import type { WorldState } from '@/lib/types'

type Row = { key: string; label: string; before: ReactNode; after: ReactNode; changed: boolean; touch?: number }

function Table({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1 text-[12px] font-semibold text-muted">{title}</h3>
      <table className="tnum w-full text-[12.5px]">
        <thead>
          <tr className="text-left text-[11px] text-faint">
            <th className="py-1 pr-2 font-medium">Item</th><th className="py-1 pr-2 font-medium">Before</th><th className="py-1 font-medium">Now</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-line-soft">
              <td className="py-1 pr-2">{r.label}</td>
              <td className={clsx('py-1 pr-2', r.changed ? 'text-faint line-through decoration-faint/60' : 'text-muted')}>{r.before}</td>
              <td key={r.touch} className={clsx('rounded py-1 pl-1 font-medium', r.changed && 'cell-changed text-ok')}>{r.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

export function BeforeAfter() {
  const before = useRun((s) => s.baseline)
  const now = useRun((s) => s.world)
  const touched = useRun((s) => s.touched)
  const option = useRun((s) => s.chosen)
  const computed = useRun((s) => s.computed)
  if (!before || !now) return null
  const primary = backend.profile.primarySponsor

  const t = (k: string) => touched[k]
  const sum = (w: WorldState, k: 'income' | 'budget') => (w[k] as { amount: number }[]).reduce((s, x) => s + x.amount, 0)
  const incomeNow = sum(now, 'income'), spendNow = sum(now, 'budget')
  const gap = spendNow - incomeNow
  const flagged = now.budget.some((b) => b.status === 'pending update')

  const spB = before.sponsors.find((s) => s.id === primary)!, spA = now.sponsors.find((s) => s.id === primary)!
  const sponsor: Row[] = [
    { key: 'c', label: 'Committed', before: rupees(spB.committed), after: rupees(spA.committed), changed: spB.committed !== spA.committed, touch: t('sponsors:sp-technova:committed') },
    { key: 't', label: 'Tier', before: spB.tier, after: spA.tier, changed: spB.tier !== spA.tier, touch: t('sponsors:sp-technova:tier') },
    { key: 'v', label: 'Record version', before: spB.version, after: spA.version, changed: spB.version !== spA.version },
  ]
  const budget: Row[] = before.budget.map((b) => {
    const a = now.budget.find((x) => x.id === b.id)!
    return { key: b.id, label: b.category, before: lakhs(b.amount), after: <>{lakhs(a.amount)}{a.status === 'pending update' && <span className="ml-1 text-[11px] text-wait">pending</span>}</>, changed: b.amount !== a.amount || b.status !== a.status, touch: t(`budget:${b.id}`) }
  })
  const deliv: Row[] = before.deliverables.filter((d) => d.sponsor_id === primary).map((d) => {
    const a = now.deliverables.find((x) => x.id === d.id)!
    const show = (x: typeof d) => (x.status === 'removed' ? 'Removed' : x.spec)
    return { key: d.id, label: d.kind, before: show(d), after: show(a), changed: show(d) !== show(a), touch: t(`deliverables:${d.id}`) }
  })
  const cal: Row[] = before.calendar.map((c) => {
    const a = now.calendar.find((x) => x.id === c.id)!
    const show = (x: typeof c) => `${fmtDate(x.date)}${x.status === 'cancelled' ? ', cancelled' : ''}${x.expected_amount ? `, ${lakhs(x.expected_amount)}` : ''}${x.note ? `, ${x.note}` : ''}`
    return { key: c.id, label: c.title, before: show(c), after: show(a), changed: show(c) !== show(a), touch: t(`calendar:${c.id}`) }
  })
  const other: Row[] = [
    ...before.approvals.map((o) => {
      const a = now.approvals.find((x) => x.id === o.id)!
      return { key: o.id, label: `${o.subject} approval`, before: `${lakhs(o.amount)}, ${o.status}`, after: `${lakhs(a.amount)}, ${a.status}`, changed: o.amount !== a.amount || o.status !== a.status, touch: t(`approvals:${o.id}`) }
    }),
    ...before.promo.map((p) => {
      const a = now.promo.find((x) => x.id === p.id)!
      return { key: p.id, label: `${p.kind}: “${p.text}”`, before: p.status, after: a.status === 'flagged' ? 'flagged for correction' : a.status, changed: p.status !== a.status, touch: t(`promo:${p.id}`) }
    }),
  ]

  return (
    <div className="h-full overflow-y-auto p-3.5">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        {computed ? (
          <p className="text-[15px] font-semibold">
            Shortfall {rupees(computed.shortfall)}{' '}
            <span className={gap === 0 || flagged ? 'text-ok' : 'text-wait'}>
              {flagged ? 'handed to the treasurer to apply' : gap === 0 ? `covered by option ${option}` : gap > 0 ? `${rupees(gap)} still open${option ? ` with option ${option}` : ''}` : 'covered'}
            </span>
          </p>
        ) : <p className="text-[15px] font-semibold">Budget balanced at {rupees(incomeNow)}</p>}
        <span className="text-[12.5px] text-muted">Income {rupees(incomeNow)}, spend {rupees(spendNow)}</span>
        {now.outbox.length > 0 && <span className="text-[12.5px] text-muted">{now.outbox.length} message{now.outbox.length > 1 ? 's' : ''} queued in the outbox</span>}
      </div>
      <div className="grid gap-x-6 gap-y-4 lg:grid-cols-2">
        <Table title="Sponsor tracker: TechNova" rows={sponsor} />
        <Table title="Budget lines" rows={budget} />
        <Table title="TechNova deliverables" rows={deliv} />
        <Table title="Calendar" rows={cal} />
        <Table title="Approvals and published assets" rows={other} />
        {now.outbox.length > 0 && (
          <div>
            <h3 className="mb-1 text-[12px] font-semibold text-muted">Outbox (sent only after approval)</h3>
            <ul className="space-y-1 text-[12.5px]">
              {now.outbox.map((o) => (
                <li key={o.id} className="rounded-md border border-line-soft px-2.5 py-1.5">
                  <div className="font-medium">{o.channel === 'email' ? 'Email' : 'Chat'} to {o.to}{o.cc?.length ? <span className="text-note">, cc {o.cc.join(', ')}</span> : null}</div>
                  <div className="truncate text-muted">{o.subject ?? o.body}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

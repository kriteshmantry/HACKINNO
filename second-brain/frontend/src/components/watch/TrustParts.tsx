import clsx from 'clsx'
import type { Confidence, TrustSignal } from '@/lib/types'
import type { TrustRow } from '@/backend/http/extras'
import { scoreTone, useWatch } from '@/store/watchStore'

const sign = (d: number) => (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toFixed(2)

export function SignalList({ items, base = true }: { items: { delta: number; label: string }[]; base?: boolean }) {
  return (
    <ul className="tnum space-y-0.5 text-[12.5px]">
      {base && <li className="flex justify-between gap-4 text-faint"><span>Starting point</span><span>0.50</span></li>}
      {items.map((r, i) => (
        <li key={r.label + i} className="flex justify-between gap-4">
          <span className="min-w-0 text-muted [overflow-wrap:anywhere]">{r.label}</span>
          <span className={clsx('shrink-0 font-semibold', r.delta > 0 ? 'text-ok' : r.delta < 0 ? 'text-fail' : 'text-faint')}>{sign(r.delta)}</span>
        </li>
      ))}
    </ul>
  )
}

function Bar({ x, tone }: { x: number; tone: string }) {
  return (
    <span className="relative block h-1.5 w-full rounded-full bg-surface-2" aria-hidden>
      <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500" style={{ width: `${Math.max(2, x * 100)}%`, background: `var(--${tone})` }} />
    </span>
  )
}

function Part({ title, hint, score, decides, items }: { title: string; hint: string; score: number; decides: boolean; items: { delta: number; label: string }[] }) {
  const policy = useWatch((s) => s.policy)
  const tone = scoreTone(score, policy)
  return (
    <section className={clsx('rounded-sm border px-3 py-2.5', decides ? 'border-text/40 bg-surface' : 'border-line-soft')}>
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[13px] font-bold">{title}</h4>
        {decides && <span className="rounded-xs bg-surface-2 px-1.5 text-[11px] font-bold leading-5 text-muted">This one decides</span>}
      </div>
      <p className="text-[11.5px] text-faint">{hint}</p>
      <div className="mt-1.5 flex items-center gap-2.5">
        <span className="tnum w-10 text-[17px] font-bold" style={{ color: `var(--${tone})` }}>{score.toFixed(2)}</span>
        <Bar x={score} tone={tone} />
      </div>
      <div className="mt-2"><SignalList items={items} /></div>
    </section>
  )
}

/** Two separate questions, scored from visible signals. The gate is the weaker one. */
export function TrustMeter({ c }: { c: Confidence }) {
  const trustItems = (c.trust_signals ?? []).map((s) => ({ delta: s.delta, label: s.detail }))
  return (
    <div>
      <p className="text-[12.5px] text-muted">
        Two separate questions. It acts on the <span className="font-semibold text-text">weaker</span> of the two, so a precise email from an impostor and a vague email from the real CFO both stop for a person.
      </p>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <Part title="Is the sender genuine?" hint="Identity, lookalike domain, reply-to, history, pressure, track record" score={c.trust ?? c.score} decides={c.gated_by === 'trust'} items={trustItems} />
        <Part title="Is the change clear?" hint="Authority, amount in the text, hedges, corroboration, size of change" score={c.certainty ?? c.score} decides={c.gated_by !== 'trust'} items={c.reasons} />
      </div>
    </div>
  )
}

/** Compact inbox badge with a hover breakdown. */
export function TrustBadge({ row }: { row?: TrustRow }) {
  const policy = useWatch((s) => s.policy)
  if (!row) return null
  const noise = row.triage.label === 'noise'
  const quarantined = row.triage.label === 'suspicious'
  const shown = noise ? row.trust : row.overall
  const tone = quarantined ? 'fail' : noise ? 'faint' : scoreTone(shown, policy)
  const negatives = row.trust_signals.filter((s) => s.delta < 0)
  return (
    <span className="group relative inline-flex" tabIndex={0}>
      <span className="inline-flex items-center gap-1 rounded-xs px-1.5 text-[11.5px] font-semibold leading-5"
        style={{ background: `color-mix(in srgb, var(--${tone === 'faint' ? 'line' : tone}) 14%, transparent)`, color: `var(--${tone})` }}>
        {noise ? 'Sender' : 'Trust'} {shown.toFixed(2)}
      </span>
      <span role="tooltip" className="pointer-events-none absolute left-0 top-6 z-30 hidden w-72 rounded-sm border border-line bg-surface p-2.5 text-[12px] shadow-[var(--shadow)] group-hover:block group-focus:block">
        <span className="block font-semibold">{row.route}</span>
        {!noise && (
          <span className="mt-1 block text-muted">Sender {row.trust.toFixed(2)}{row.certainty !== null ? `, change ${row.certainty.toFixed(2)}` : ''}: acts on the weaker.</span>
        )}
        {negatives.length > 0 && (
          <span className="mt-1.5 block">
            {negatives.slice(0, 5).map((s) => <span key={s.signal} className="block text-fail">{sign(s.delta)} {s.detail}</span>)}
          </span>
        )}
        {negatives.length === 0 && row.trust_signals.filter((s) => s.delta > 0).map((s) => <span key={s.signal} className="mt-0.5 block text-ok">{sign(s.delta)} {s.detail}</span>)}
      </span>
    </span>
  )
}

export function signalItems(signals: TrustSignal[] | undefined) {
  return (signals ?? []).map((s) => ({ delta: s.delta, label: s.detail }))
}

import clsx from 'clsx'
import { useState } from 'react'
import { extras, type RadarAction, type RadarItem } from '@/backend/http/extras'
import { useRun } from '@/store/runStore'
import { useWatch } from '@/store/watchStore'
import { Button, Mono, Skeleton } from '../ui'

const SEV_COLOR = { high: 'fail', medium: 'wait', low: 'work' } as const
const SEV_WORD = { high: 'Urgent', medium: 'Soon', low: 'Watch' } as const

function when(i: RadarItem) {
  if (i.days_left === null || i.days_left === undefined) return null
  return i.days_left <= 0 ? 'today' : i.days_left === 1 ? 'tomorrow' : `in ${i.days_left} days`
}

/** Side-rail summary: what is about to go wrong, before any email arrives. */
export function RadarRail() {
  const radar = useWatch((s) => s.radar)
  const enabled = useWatch((s) => s.enabled)
  if (!enabled) return null
  const open = radar?.items.filter((i) => !i.handled) ?? []
  return (
    <section className="rounded-md border border-line bg-surface px-4 py-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[13px] font-bold">Risk radar</h2>
        <button onClick={() => useWatch.getState().open('radar')} className="text-[12px] font-semibold text-work hover:underline">Open</button>
      </div>
      {!radar ? <div className="mt-2 space-y-1.5"><Skeleton className="h-3 w-40" /><Skeleton className="h-3 w-52" /></div> : (
        <>
          <p className="mt-0.5 text-[12px] text-muted">
            {open.length ? <>{radar.counts.high > 0 && <span className="font-semibold text-fail">{radar.counts.high} urgent</span>}{radar.counts.high > 0 && radar.counts.medium > 0 && ', '}{radar.counts.medium > 0 && <span className="font-semibold text-wait">{radar.counts.medium} soon</span>}. No email needed: it reads the live records.</> : 'Nothing at risk in the next two weeks.'}
          </p>
          <ul className="mt-2 space-y-1.5">
            {open.slice(0, 4).map((i, k) => (
              <li key={i.id} className="slide-in" style={{ animationDelay: `${k * 60}ms` }}>
                <button onClick={() => useWatch.getState().open('radar')} className="grid w-full grid-cols-[8px_1fr] gap-2 text-left">
                  <span className={clsx('mt-[6px] h-2 w-2 rounded-full', i.severity === 'high' && 'working')} style={{ background: `var(--${SEV_COLOR[i.severity]})` }} />
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-semibold leading-snug">{i.title}</span>
                    {when(i) && <span className="block text-[11.5px] text-faint">Due {when(i)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function ActionButton({ item, a, index }: { item: RadarItem; a: RadarAction; index: number }) {
  const busy = useWatch((s) => s.busy)
  const { act, followRun, close } = useWatch.getState()
  const [preview, setPreview] = useState(false)
  const [body, setBody] = useState(a.kind === 'email' || a.kind === 'chat' ? a.draft.body : '')
  const key = `${item.id}:${index}`
  if (a.kind === 'email' || a.kind === 'chat') {
    return (
      <div className="w-full">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="quiet" disabled={busy[key] || !!item.handled} onClick={() => act(key, () => extras.radarAct(item.id, index, body), a.kind === 'email' ? `Email sent to ${a.draft.to}` : `Posted in ${a.draft.channel}`)}>{a.label}</Button>
          <button onClick={() => setPreview(!preview)} className="text-[12px] font-semibold text-work hover:underline">{preview ? 'Hide' : 'Preview'}</button>
        </div>
        {preview && (
          <label className="mt-1.5 block text-[11.5px] text-muted">{a.kind === 'email' ? `To ${a.draft.to}${a.draft.cc.length ? `, cc ${a.draft.cc.join(', ')}` : ''}: ${a.draft.subject}` : a.draft.channel}
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={a.kind === 'email' ? 7 : 3}
              className="mt-0.5 block w-full rounded-sm border border-line bg-bg-2/40 px-2.5 py-2 font-[inherit] text-[12.5px] leading-relaxed text-text outline-none focus:border-work" />
          </label>
        )}
      </div>
    )
  }
  if (a.kind === 'run') {
    return <Button size="sm" variant="quiet" disabled={busy[key]} onClick={async () => { const r = await act(key, () => extras.startRun(a.message_id)); if (r) await followRun(r.run_id) }}>{a.label}</Button>
  }
  if (a.kind === 'verify') {
    return <Button size="sm" variant="quiet" onClick={async () => {
      const v = await extras.verification(a.verification_id)
      if (v.run_id && v.run_id !== useRun.getState().runId) await followRun(v.run_id)
      else close()
    }}>{a.label}</Button>
  }
  return <Button size="sm" variant="quiet" onClick={() => { close(); setTimeout(() => document.getElementById('negotiation')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250) }}>{a.label}</Button>
}

export function RadarList() {
  const radar = useWatch((s) => s.radar)
  if (!radar) return <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
  if (!radar.items.length) return <p className="text-[13px] text-muted">Nothing at risk in the next {radar.horizon_days} days.</p>
  return (
    <div>
      <p className="text-[12.5px] text-muted">Scanned at the scenario clock ({radar.now.slice(0, 10)}), looking {radar.horizon_days} days ahead. Each item names the records it read.</p>
      <ul className="mt-3 space-y-2.5">
        {radar.items.map((i, k) => (
          <li key={i.id} style={{ animationDelay: `${k * 55}ms` }} className={clsx('rise rounded-sm border px-3 py-2.5 transition-opacity', i.handled ? 'border-line-soft opacity-70' : i.severity === 'high' ? 'border-fail/50' : 'border-line')}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-[13.5px] font-bold leading-snug">{i.title}</p>
              <span key={i.handled ? 'done' : i.severity} className={clsx('pop shrink-0 rounded-xs px-1.5 text-[11px] font-bold leading-5', i.handled ? 'bg-ok-soft text-ok' : `bg-${SEV_COLOR[i.severity]}-soft text-${SEV_COLOR[i.severity]}`)}>
                {i.handled ? i.handled.what : SEV_WORD[i.severity]}
              </span>
            </div>
            <p className="mt-0.5 text-[12.5px] text-muted">{i.detail}</p>
            <p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11.5px] text-faint">
              {when(i) && <span>Due {when(i)}</span>}
              {[...i.evidence, ...i.entities].slice(0, 6).map((e) => <Mono key={e}>{e}</Mono>)}
            </p>
            {i.actions.length > 0 && !i.handled && (
              <div className="mt-2 flex flex-wrap gap-2">{i.actions.map((a, n) => <ActionButton key={n} item={i} a={a} index={n} />)}</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { extras, type Calibration } from '@/backend/http/extras'
import { rupees } from '@/lib/format'
import { useRun } from '@/store/runStore'
import { scoreTone, useWatch } from '@/store/watchStore'
import { Button, Mono } from '../ui'
import { TrustBadge } from './TrustParts'

const STATUS = { pending: 'Needs you', awaiting_reply: 'Waiting for the contact', confirmed: 'Confirmed', corrected: 'Corrected', rejected: 'Not genuine', expired: 'Expired' } as const

function Policy() {
  const policy = useWatch((s) => s.policy)
  const [a, setA] = useState(0.8)
  const [s, setS] = useState(0.5)
  useEffect(() => { if (policy) { setA(policy.autonomous); setS(policy.supervised) } }, [policy])
  const dirty = policy && (a !== policy.autonomous || s !== policy.supervised)
  const valid = s < a
  return (
    <section>
      <h3 className="text-[13.5px] font-bold">How cautious to be</h3>
      <p className="text-[12px] text-muted">The gate score decides what happens. Moving these re-scores every message immediately.</p>
      <div className="mt-2 space-y-2">
        <label className="block text-[12.5px]"><span className="flex justify-between"><span>Act on its own at</span><span className="tnum font-semibold">{a.toFixed(2)}</span></span>
          <input type="range" min={0.55} max={1} step={0.05} value={a} onChange={(e) => setA(Number(e.target.value))} className="w-full accent-[var(--ok)]" /></label>
        <label className="block text-[12.5px]"><span className="flex justify-between"><span>Act with your approval at</span><span className="tnum font-semibold">{s.toFixed(2)}</span></span>
          <input type="range" min={0.1} max={0.95} step={0.05} value={s} onChange={(e) => setS(Number(e.target.value))} className="w-full accent-[var(--wait)]" /></label>
        <p className="text-[12px] text-muted">Below {s.toFixed(2)}: held for verification.</p>
        <Button size="sm" variant="primary" disabled={!dirty || !valid}
          onClick={() => useWatch.getState().act('policy', () => extras.setPolicy({ autonomous: a, supervised: s }), 'Thresholds updated; every message was re-scored')}>
          {valid ? 'Apply' : 'Approval level must be below the act-alone level'}
        </Button>
      </div>
    </section>
  )
}

function Calib() {
  const [c, setC] = useState<Calibration>()
  const queue = useWatch((s) => s.queue)
  useEffect(() => { extras.calibration().then(setC).catch(() => {}) }, [queue])
  if (!c) return null
  return (
    <section>
      <h3 className="text-[13.5px] font-bold">Does the score match people’s verdicts?</h3>
      <p className="text-[12px] text-muted">{c.n ? `${c.n} verdict${c.n === 1 ? '' : 's'} so far.` : 'No verdicts yet.'} {c.note}</p>
      <ul className="mt-1.5 space-y-1">
        {c.bins.map((b) => (
          <li key={b.range[0]} className="grid grid-cols-[86px_1fr_54px] items-center gap-2 text-[12px]">
            <span className="tnum text-muted">{b.range[0].toFixed(2)}–{b.range[1].toFixed(2)}</span>
            <span className="h-1.5 rounded-full bg-surface-2"><span className="block h-full rounded-full bg-ok" style={{ width: `${(b.genuine_rate ?? 0) * 100}%` }} /></span>
            <span className="tnum text-right text-muted">{b.n ? `${Math.round((b.genuine_rate ?? 0) * 100)}% of ${b.n}` : '–'}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function TrustPanel() {
  const trust = useWatch((s) => s.trust)
  const queue = useWatch((s) => s.queue)
  const senders = useWatch((s) => s.senders)
  const policy = useWatch((s) => s.policy)
  const inbox = useRun((s) => s.inbox)
  const runId = useRun((s) => s.runId)
  const rows = useMemo(() => Object.values(trust).filter((r) => r.triage.label !== 'noise').sort((a, b) => a.overall - b.overall), [trust])
  const from = (id: string) => inbox.find((m) => m.id === id)?.from
  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-[13.5px] font-bold">Verification queue</h3>
        {queue.length === 0 ? <p className="text-[12.5px] text-muted">Nothing has been held yet. Try S2 (a vague email) or S5 (an impostor).</p> : (
          <ul className="mt-1.5 space-y-1.5">
            {queue.map((v) => (
              <li key={v.id} className="rounded-sm border border-line px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-semibold">{v.question}</span>
                  <span className={clsx('shrink-0 text-[11.5px] font-bold', v.status === 'pending' ? 'text-wait' : v.status === 'rejected' ? 'text-fail' : v.status === 'awaiting_reply' ? 'text-work' : 'text-ok')}>{STATUS[v.status]}</span>
                </div>
                <p className="mt-0.5 text-[12px] text-muted"><Mono>{v.message_id}</Mono> from {v.sender}{v.claimed?.new_amount ? `, claims ${rupees(v.claimed.new_amount)}` : ''}; gate {(v.overall ?? 0).toFixed(2)}</p>
                {['pending', 'awaiting_reply'].includes(v.status) && v.run_id !== runId && (
                  <Button className="mt-1.5" size="sm" variant="quiet" onClick={() => useWatch.getState().followRun(v.run_id)}>Open it</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-[13.5px] font-bold">Every message that claims a change</h3>
        <p className="text-[12px] text-muted">Scored before any run starts. Weakest first; hover a badge for the reasons.</p>
        <ul className="mt-1.5 divide-y divide-line-soft">
          {rows.map((r) => (
            <li key={r.message_id} className="grid grid-cols-[1fr_auto] items-start gap-2 py-1.5">
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-semibold"><Mono className="mr-1 text-faint">{r.message_id}</Mono>{from(r.message_id) ?? r.sender}</span>
                <span className="block text-[11.5px] text-muted">{r.route}</span>
              </span>
              <span className="flex flex-col items-end gap-0.5">
                <TrustBadge row={r} />
                <span className="tnum text-[11px] text-faint">sender <span style={{ color: `var(--${scoreTone(r.trust, policy)})` }}>{r.trust.toFixed(2)}</span>{r.certainty !== null && <>, change <span style={{ color: `var(--${scoreTone(r.certainty, policy)})` }}>{r.certainty.toFixed(2)}</span></>}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <Policy />

      <section>
        <h3 className="text-[13.5px] font-bold">Sender track record</h3>
        {senders.length === 0 ? <p className="text-[12.5px] text-muted">Built from your verdicts. None yet.</p> : (
          <ul className="mt-1 space-y-1 text-[12.5px]">
            {senders.map((s) => (
              <li key={s.sender} className="flex justify-between gap-3"><span className="truncate">{s.sender}</span>
                <span className="tnum shrink-0 text-muted">{s.genuine} genuine, {s.rejected} not; reliability {s.reliability.toFixed(2)}</span></li>
            ))}
          </ul>
        )}
      </section>

      <Calib />
    </div>
  )
}

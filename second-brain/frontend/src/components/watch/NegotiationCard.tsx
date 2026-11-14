import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { extras } from '@/backend/http/extras'
import { rupees } from '@/lib/format'
import { useRun } from '@/store/runStore'
import { useWatch } from '@/store/watchStore'
import { Button } from '../ui'

const fmtDate = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

/** Tier-boundary negotiation: "TechNova is ₹1L short of staying Gold", with a drafted counter-offer. */
export function NegotiationCard() {
  const n = useWatch((s) => s.negotiation)
  const busy = useWatch((s) => s.busy)
  const runId = useRun((s) => s.runId)
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState('')
  useEffect(() => { if (n?.draft?.body) setBody(n.draft.body) }, [n?.draft?.body])
  if (!n || !n.eligible || !n.dropped) return null
  const { act, followRun } = useWatch.getState()
  const rec = n.record
  const sent = rec?.status === 'sent'
  return (
    <section id="negotiation" aria-label="Counter-offer" className="scroll-mt-20 rounded-md border border-work/50 bg-surface px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-[12px] font-bold uppercase tracking-[0.04em] text-work">Win it back</p>
          <h3 className="text-[19px] font-extrabold tracking-[-0.02em]">{n.headline}</h3>
        </div>
        {rec && <span className={clsx('rounded-xs px-1.5 text-[11.5px] font-bold leading-5',
          rec.status === 'sent' ? 'bg-wait-soft text-wait' : rec.status === 'accepted' ? 'bg-ok-soft text-ok' : 'bg-surface-2 text-muted')}>
          {rec.status === 'sent' ? 'Sent, waiting' : rec.status === 'accepted' ? 'Accepted' : 'Declined'}
        </span>}
      </div>
      <p className="mt-1 text-[13px] text-muted">
        At {rupees(n.amount)} {n.sponsor} moved from {n.previous_tier} to {n.tier}: {n.benefits?.map((b) => b.loss).join(', ')}.
        {' '}Prices for add-ons come from the sponsorship policy, not the model.
      </p>

      <ul className="mt-3 grid gap-2 md:grid-cols-3">
        {n.offers.map((o) => (
          <li key={o.id} className={clsx('rounded-sm border px-3 py-2.5', o.id === 'restore' ? 'border-text/40' : 'border-line')}>
            <p className="text-[13.5px] font-bold">{o.title}</p>
            <p className="tnum mt-0.5 text-[12.5px]">{o.add ? <>Add <span className="font-semibold">{rupees(o.add)}</span>, {rupees(o.total)} in total</> : <>No change, {rupees(o.total)}</>}</p>
            {o.gets.length > 0 && <p className="mt-1 text-[12px] text-ok">Gets {o.gets.join(', ')}</p>}
            {o.lost_anyway.length > 0 && <p className="mt-1 text-[12px] text-muted">Loses {o.lost_anyway.join(', ')}</p>}
          </li>
        ))}
      </ul>

      <dl className="mt-3 space-y-1 text-[12.5px]">
        {n.budget_effect && <div><dt className="inline font-semibold">Budget: </dt><dd className="inline text-muted">{n.budget_effect.text}.</dd></div>}
        {n.reply_by && n.deadline_reason && <div><dt className="inline font-semibold">Deadline: </dt><dd className="inline text-muted">{n.deadline_reason}, so a reply by {fmtDate(n.reply_by)} still counts.</dd></div>}
      </dl>

      {!rec && n.draft && (
        <div className="mt-3 border-t border-line-soft pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" disabled={busy.offer}
              onClick={() => act('offer', () => extras.sendOffer(n.sponsor_id, { body, run_id: runId }), `Counter-offer sent to ${n.contact}`)}>
              Send the counter-offer to {n.contact}
            </Button>
            <button onClick={() => setEditing(!editing)} className="text-[12.5px] font-semibold text-work hover:underline">{editing ? 'Hide the email' : 'Read or edit the email'}</button>
          </div>
          {editing && (
            <label className="mt-2 block text-[12px] text-muted">{n.draft.subject}
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12}
                className="mt-0.5 block w-full rounded-sm border border-line bg-bg-2/40 px-2.5 py-2 font-[inherit] text-[12.5px] leading-relaxed text-text outline-none focus:border-work" />
            </label>
          )}
          <p className="mt-1.5 text-[11.5px] text-faint">Sending is your approval: it is recorded like any other, and a double click cannot send it twice.</p>
        </div>
      )}

      {sent && rec && (
        <div className="mt-3 border-t border-line-soft pt-3">
          <p className="text-[12px] font-semibold text-muted">Demo: play {n.sponsor}’s reply</p>
          <div className="mt-1 flex flex-wrap gap-2">
            <Button size="sm" variant="quiet" disabled={busy.offerReply} onClick={async () => {
              const r = await act('offerReply', () => extras.simulateOfferReply(rec.id, 'restore'), `${n.sponsor} accepted. A new run applies the increase.`)
              if (r?.run_id) await followRun(r.run_id)
            }}>“We’ll stay {n.target_tier}”</Button>
            <Button size="sm" variant="quiet" disabled={busy.offerReply} onClick={() => act('offerReply', () => extras.simulateOfferReply(rec.id, 'decline'), `${n.sponsor} declined. Nothing changes.`)}>“We’ll stay at {rupees(n.amount)}”</Button>
          </div>
        </div>
      )}
      {rec?.status === 'accepted' && rec.reply_run_id && rec.reply_run_id !== runId && (
        <Button className="mt-3" size="sm" variant="quiet" onClick={() => followRun(rec.reply_run_id!)}>Open the run that applied it</Button>
      )}
    </section>
  )
}

import { useEffect, useState } from 'react'
import { extras, type Verification } from '@/backend/http/extras'
import { rupees } from '@/lib/format'
import { useWatch } from '@/store/watchStore'
import { Button, Mono, Spinner } from '../ui'
import { SignalList, signalItems } from './TrustParts'

/** The "Needs verification" card for a run held by the Email Trust Score. */
export function VerificationInline({ id }: { id: string }) {
  const [v, setV] = useState<Verification>()
  const [amount, setAmount] = useState('')
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState('')
  const busy = useWatch((s) => s.busy)
  const { act } = useWatch.getState()

  useEffect(() => {
    let alive = true
    const load = async () => { try { const x = await extras.verification(id); if (alive) { setV(x); setBody((b) => b || x.outreach?.body || '') } } catch { /* retry next tick */ } }
    load()
    const t = window.setInterval(load, 1500)
    return () => { alive = false; clearInterval(t) }
  }, [id])

  if (!v) return <div className="mt-3 flex items-center gap-2 text-[13px] text-muted"><Spinner /> Loading the verification…</div>
  const claimed = v.claimed?.new_amount
  const lowTrust = v.recommended === 'ask_sender'
  const typed = Number(amount.replace(/[^\d]/g, '')) || 0
  const run = async <T,>(key: string, f: () => Promise<T>, ok?: string) => {
    const r = await act(key, f, ok)
    try { setV(await extras.verification(id)) } catch { /* ignore */ }
    return r
  }
  const decided = !['pending', 'awaiting_reply'].includes(v.status)

  return (
    <div className="mt-3 rounded-sm border border-wait/50 bg-wait-soft px-3.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[14.5px] font-bold">{v.question}</p>
        <Mono className="text-faint">{v.id}</Mono>
      </div>
      <p className="mt-0.5 text-[12.5px] text-muted">
        Nothing has been changed.{claimed ? <> The message claims <span className="font-semibold text-text">{rupees(claimed)}</span>.</> : null}{' '}
        {lowTrust ? 'The sender could not be verified, so the safe move is to ask the contact already on file, not to reply to the message.' : 'The sender looks genuine, but the change itself is not clear enough to act on.'}
      </p>

      {lowTrust && v.report?.trust_signals && (
        <div className="mt-2 rounded-sm bg-surface px-3 py-2">
          <p className="mb-1 text-[12px] font-bold text-muted">Why the sender is not trusted ({(v.trust ?? 0).toFixed(2)})</p>
          <SignalList items={signalItems(v.report.trust_signals)} />
        </div>
      )}
      {!lowTrust && v.report?.reasons && v.report.reasons.length > 0 && (
        <ul className="mt-1.5 list-disc pl-5 text-[12.5px] text-muted marker:text-faint">{v.report.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      )}

      {v.status === 'awaiting_reply' && v.outreach && (
        <div className="mt-3 rounded-sm border border-line bg-surface px-3 py-2.5">
          <p className="text-[13px]"><span className="font-semibold">Asked {v.outreach.to}</span> <span className="text-muted">(the contact on file). The run keeps waiting for their answer.</span></p>
          <p className="mt-2 text-[12px] font-semibold text-muted">Demo: play the contact’s reply</p>
          <div className="mt-1 flex flex-wrap gap-2">
            <Button size="sm" variant="quiet" disabled={busy.reply} onClick={() => run('reply', () => extras.simulateReply(v.id, true), 'The contact confirmed it. The run continues.')}>“Yes, that was us”</Button>
            <Button size="sm" variant="danger" disabled={busy.reply} onClick={() => run('reply', () => extras.simulateReply(v.id, false), 'The contact denied it. Nothing was changed.')}>“We never sent that”</Button>
          </div>
        </div>
      )}

      {v.status === 'pending' && (
        <>
          {v.outreach && (
            <div className="mt-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant={lowTrust ? 'primary' : 'quiet'} disabled={busy.ask} onClick={() => run('ask', () => extras.decide(v.id, 'ask_sender', { body }), `Verification email sent to ${v.outreach!.to}`)}>
                  Ask {v.outreach.to}
                </Button>
                <button onClick={() => setEditing(!editing)} className="text-[12.5px] font-semibold text-work hover:underline">{editing ? 'Hide the email' : 'Read or edit the email'}</button>
                <span className="text-[12px] text-muted">the contact on file{lowTrust ? ', never the reply-to address' : ''}</span>
              </div>
              {editing && (
                <label className="mt-2 block text-[12px] text-muted">{v.outreach.subject}
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7}
                    className="mt-0.5 block w-full rounded-sm border border-line bg-surface px-2.5 py-2 font-[inherit] text-[12.5px] leading-relaxed text-text outline-none focus:border-work" />
                </label>
              )}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-wait/30 pt-3">
            {claimed ? (
              <Button size="sm" variant={lowTrust ? 'quiet' : 'primary'} disabled={busy.confirm} onClick={() => run('confirm', () => extras.decide(v.id, 'confirm'), 'Confirmed. The run continues.')}>
                It is genuine: {rupees(claimed)}
              </Button>
            ) : null}
            <label className="text-[12px] text-muted">Or a different amount
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="₹3,00,000" inputMode="numeric"
                className="mt-0.5 block h-8 w-32 rounded-sm border border-line bg-surface px-2.5 text-[13px] text-text outline-none focus:border-work" />
            </label>
            <Button size="sm" variant="quiet" disabled={!typed || busy.correct} onClick={() => run('correct', () => extras.decide(v.id, 'correct', { amount: typed }), 'Corrected. The run continues.')}>Correct the amount</Button>
            <Button size="sm" variant="danger" disabled={busy.reject} onClick={() => run('reject', () => extras.decide(v.id, 'reject', { reason: 'not genuine' }), 'Marked as not genuine. Nothing was changed.')}>Not genuine, change nothing</Button>
          </div>
          <p className="mt-2 text-[11.5px] text-faint">Your verdict is added to this sender’s track record and moves their next trust score.</p>
        </>
      )}

      {decided && (
        <p className="mt-2 text-[13px] font-semibold">
          {v.status === 'rejected' ? <span className="text-fail">Not genuine{v.verdict === 'denied_by_contact' ? ': the contact on file says they never sent it' : ''}. Nothing was changed.</span>
            : v.status === 'expired' ? <span className="text-fail">Nobody answered in time; handed to a person.</span>
              : <span className="text-ok">{v.verdict === 'confirmed_by_contact' ? 'Confirmed by the contact on file' : v.status === 'corrected' ? 'Corrected by you' : 'Confirmed by you'}. The run continues.</span>}
        </p>
      )}
    </div>
  )
}

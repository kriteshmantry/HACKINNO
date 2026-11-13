import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useRun } from '@/store/runStore'
import { backend } from '@/backend'
import type { Approval } from '@/lib/types'
import { Button, Chip, CloseButton, Mono } from '../ui'


function Editor({ ap, args, setArgs }: { ap: Approval; args: Record<string, unknown>; setArgs: (a: Record<string, unknown>) => void }) {
  const field = 'w-full rounded-md border border-line bg-bg-2 px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-work'
  const TREASURER = backend.profile.treasurerEmail
  // email if it has a recipient and subject, chat if it has a channel (works for either backend's tool names)
  if ('to' in args && 'subject' in args) {
    const cc = (args.cc as string[]) ?? []
    return (
      <div className="space-y-2">
        <label className="block text-[12px] text-muted">To
          <input className={clsx(field, 'mt-0.5 opacity-70')} value={String(args.to)} readOnly />
        </label>
        <label className="block text-[12px] text-muted">Cc
          <input className={clsx(field, 'mt-0.5')} value={cc.join(', ')} placeholder="nobody"
            onChange={(e) => setArgs({ ...args, cc: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
        </label>
        {!cc.includes(TREASURER) && (
          <button onClick={() => setArgs({ ...args, cc: [...cc, TREASURER] })} className="inline-flex items-center gap-1 rounded-sm bg-surface-2 px-2 py-1 text-[12px] text-muted hover:text-text">
            Add {TREASURER} to cc
          </button>
        )}
        <label className="block text-[12px] text-muted">Subject
          <input className={clsx(field, 'mt-0.5')} value={String(args.subject)} onChange={(e) => setArgs({ ...args, subject: e.target.value })} />
        </label>
        <label className="block text-[12px] text-muted">Message
          <textarea className={clsx(field, 'mt-0.5 h-32 resize-none leading-snug')} value={String(args.body)} onChange={(e) => setArgs({ ...args, body: e.target.value })} />
        </label>
      </div>
    )
  }
  if ('channel' in args) {
    const key = 'text' in args ? 'text' : 'body'
    return (
      <label className="block text-[12px] text-muted">Message to <Mono className="text-text">{String(args.channel)}</Mono>
        <textarea className={clsx(field, 'mt-0.5 h-24 resize-none leading-snug')} value={String(args[key] ?? '')} onChange={(e) => setArgs({ ...args, [key]: e.target.value })} />
      </label>
    )
  }
  return null
}

export function ApprovalModal() {
  const id = useRun((s) => s.modalApproval)
  const ap = useRun((s) => (id ? s.approvals[id] : undefined))
  const approvals = useRun((s) => s.approvals)
  const pending = useMemo(() => Object.values(approvals).filter((a) => a.status === 'pending'), [approvals])
  const { decide, openApproval, focusMsg } = useRun.getState()
  const [args, setArgs] = useState<Record<string, unknown>>({})
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (ap) { setArgs(structuredClone(ap.args)); setRejecting(false); setReason('') } }, [ap?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && id) openApproval(undefined) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [id, openApproval])

  const edited = ap ? JSON.stringify(args) !== JSON.stringify(ap.args) : false
  const go = async (decision: 'approve' | 'edit' | 'reject') => {
    if (!ap) return
    setBusy(true)
    const editable = Object.fromEntries(ap.editable.map((k) => [k, args[k]]))
    await decide(ap.id, decision === 'reject' ? { decision, reason: reason || undefined } : decision === 'edit' ? { decision, args: editable } : { decision })
    setBusy(false)
  }
  const idx = ap ? pending.findIndex((p) => p.id === ap.id) : -1

  return (
    <AnimatePresence>
      {ap && (
        <motion.div className="fixed inset-0 z-50 grid place-items-center bg-[var(--overlay)] p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => openApproval(undefined)}>
          <motion.div role="dialog" aria-modal="true" aria-labelledby="ap-title"
            className="flex max-h-[92vh] w-full max-w-[640px] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-[var(--shadow)]"
            initial={{ y: 16, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 10, opacity: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            onClick={(e) => e.stopPropagation()}>
            <header className="flex items-start justify-between gap-3 border-b border-line-soft px-5 py-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                  <span>{ap.status === 'pending' ? `Needs your approval${pending.length > 1 ? `, ${idx + 1} of ${pending.length}` : ''}` : `Already ${ap.status}`}</span>
                  <Mono className="text-faint">{ap.id}</Mono><Mono className="text-faint">{ap.tool}</Mono>
                </div>
                <h2 id="ap-title" className="mt-0.5 text-[19px] font-semibold leading-snug tracking-[-0.015em]">{ap.title}</h2>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Chip tone={ap.risk >= 6 ? 'fail' : 'wait'}>Risk {ap.risk}</Chip>
                  {ap.risk_reasons.map((r) => <Chip key={r}>{r}</Chip>)}
                  {ap.external && !ap.risk_reasons.includes('Leaves the organisation') && <Chip tone="fail">Leaves the organisation</Chip>}
                  <Chip tone={ap.band === 'autonomous' ? 'ok' : ap.band === 'supervised' ? 'wait' : 'fail'}>Confidence: {ap.band}</Chip>
                </div>
              </div>
              <CloseButton onClick={() => openApproval(undefined)} />
            </header>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <p className="text-[13.5px] leading-relaxed">{ap.rationale}</p>
              {ap.learned && <p className="rounded-sm bg-surface-2 px-3 py-2 text-[12.5px]"><span className="font-semibold">Already applied:</span> {ap.learned}</p>}

              {ap.diff.length > 0 && (
                <div>
                  <h3 className="mb-1 text-[12px] font-semibold text-muted">What changes (dry run against current values)</h3>
                  <table className="tnum w-full text-[13px]">
                    <tbody>
                      {ap.diff.map((d) => (
                        <tr key={d.field + d.to} className="border-t border-line-soft">
                          <td className="py-1.5 pr-3 text-muted">{d.field}</td>
                          <td className="py-1.5 pr-3 text-faint line-through decoration-fail/60">{d.from}</td>
                          <td className="py-1.5 font-semibold text-ok">{d.to}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div>
                <h3 className="mb-1 text-[12px] font-semibold text-muted">Evidence</h3>
                {ap.evidence.map((e) => (
                  <blockquote key={e.ref} className="text-[13px]">
                    <mark className="evidence">“{e.quote}”</mark>
                    <button onClick={() => { focusMsg(e.ref); openApproval(undefined) }} className="ml-2 font-mono text-[11.5px] text-work underline-offset-2 hover:underline">open {e.ref}</button>
                  </blockquote>
                ))}
              </div>

              {ap.editable.length > 0 && ap.status === 'pending' && (
                <div>
                  <h3 className="mb-1.5 text-[12px] font-semibold text-muted">Edit before approving <span className="font-normal text-faint">(edits teach the next run)</span></h3>
                  <Editor ap={ap} args={args} setArgs={setArgs} />
                </div>
              )}

              {rejecting && (
                <label className="block text-[12px] text-muted">Why reject? The planner treats this as a constraint.
                  <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: don't touch prizes"
                    className="mt-0.5 w-full rounded-md border border-line bg-bg-2 px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-fail" />
                </label>
              )}
            </div>

            <footer className="flex items-center justify-between gap-2 border-t border-line-soft px-5 py-3">
              <Button variant="ghost" onClick={() => openApproval(undefined)}>Decide later</Button>
              {ap.status === 'pending' ? (
                <div className="flex gap-2">
                  {rejecting
                    ? <Button variant="danger" disabled={busy} onClick={() => go('reject')}>Reject step</Button>
                    : <Button variant="danger" onClick={() => setRejecting(true)}>Reject</Button>}
                  <Button key={ap.id} autoFocus variant="primary" disabled={busy || rejecting} onClick={() => go(edited ? 'edit' : 'approve')}>
                    {edited ? 'Approve with edits' : 'Approve'}
                  </Button>
                </div>
              ) : <Button onClick={() => openApproval(pending[0]?.id)}>{pending.length ? 'Next approval' : 'Close'}</Button>}
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

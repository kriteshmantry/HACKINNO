import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Button, CloseButton } from '../ui'
import { useRun } from '@/store/runStore'

export function Toast() {
  const toast = useRun((s) => s.toast)
  const [shown, setShown] = useState(toast)
  useEffect(() => {
    setShown(toast)
    if (!toast) return
    const t = setTimeout(() => setShown(undefined), 5200)
    return () => clearTimeout(t)
  }, [toast])
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex justify-center px-4" aria-live="polite">
      <AnimatePresence>
        {shown && (
          <motion.div key={shown.key} initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 8, opacity: 0 }}
            className="pointer-events-auto max-w-xl rounded-md border bg-surface px-4 py-2.5 text-[13px] font-medium shadow-[var(--shadow)]"
            style={{ borderColor: `var(--${shown.tone})`, color: `var(--${shown.tone})` }}>
            {shown.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

const LOOK = {
  done: { word: 'Done', color: 'ok' },
  waiting: { word: 'Waiting', color: 'wait' },
  quarantined: { word: 'Stopped', color: 'fail' },
  escalated: { word: 'Escalated', color: 'fail' },
  preempted: { word: 'Paused', color: 'wait' },
  error: { word: 'Error', color: 'fail' },
} as const

export function OutcomeBanner() {
  const outcome = useRun((s) => s.outcome)
  const [hidden, setHidden] = useState<string>()
  if (!outcome || hidden === outcome.text) return null
  const { word, color } = LOOK[outcome.kind]
  return (
    <div className="pointer-events-none absolute inset-x-0 top-12 z-20 flex justify-center px-3">
    <motion.div initial={{ y: -8, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
      className="pointer-events-auto flex w-full max-w-[620px] items-start gap-3 rounded-md border bg-surface px-4 py-3 shadow-[var(--shadow)]"
      style={{ borderColor: `var(--${color})` }} role="status">
      <span className="mt-0.5 shrink-0 rounded-xs px-1.5 text-[11.5px] font-bold leading-5" style={{ color: `var(--${color})`, background: `var(--${color}-soft)` }}>{word}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-bold">{outcome.text}</p>
        {outcome.detail && <p className="mt-0.5 whitespace-pre-line text-[12.5px] text-muted">{outcome.detail}</p>}
      </div>
      <CloseButton onClick={() => setHidden(outcome.text)} label="Dismiss" />
    </motion.div>
    </div>
  )
}

/** The backend's low-confidence path: it asks a person before it will change anything. */
export function ClarifyCard() {
  const c = useRun((s) => s.clarification)
  const state = useRun((s) => s.state)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  if (!c || c.answered || state !== 'AWAIT_CLARIFICATION') return null
  const value = Number(amount.replace(/[^\d]/g, '')) || c.amount || 0
  const go = async (d: 'confirm' | 'dismiss') => { setBusy(true); await useRun.getState().clarify(d, d === 'confirm' ? value : undefined); setBusy(false) }
  return (
    <div className="pointer-events-none absolute inset-x-0 top-12 z-20 flex justify-center px-3">
      <motion.section initial={{ y: -8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} role="dialog" aria-labelledby="clarify-q"
        className="pointer-events-auto w-full max-w-[620px] rounded-md border border-wait bg-surface px-4 py-3.5 shadow-[var(--shadow)]">
        <div className="flex items-baseline gap-2">
          <span className="rounded-xs bg-wait-soft px-1.5 text-[11.5px] font-bold leading-5 text-wait">Needs a person</span>
          <h3 id="clarify-q" className="text-[14px] font-bold">{c.question}</h3>
        </div>
        <p className="mt-1.5 text-[12.5px] text-muted">Nothing has been changed. The confidence score is too low to act on its own:</p>
        <ul className="mt-1 list-disc pl-4 text-[12.5px] text-muted marker:text-faint">{c.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        {c.draft && <p className="mt-2 rounded-sm bg-surface-2 px-2.5 py-2 text-[12.5px]"><span className="font-semibold">Suggested reply to the sponsor: </span>{c.draft}</p>}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-[12px] text-muted">Confirmed amount
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={c.amount ? String(c.amount) : '300000'} inputMode="numeric"
              className="mt-0.5 block h-9 w-36 rounded-sm border border-line bg-bg-2 px-2.5 text-[13px] text-text outline-none focus:border-work" />
          </label>
          <Button variant="primary" disabled={busy || !value} onClick={() => go('confirm')}>Confirm and continue</Button>
          <Button variant="quiet" disabled={busy} onClick={() => go('dismiss')}>Dismiss, change nothing</Button>
        </div>
      </motion.section>
    </div>
  )
}

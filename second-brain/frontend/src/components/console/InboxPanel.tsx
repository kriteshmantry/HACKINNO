import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRun } from '@/store/runStore'
import type { InboxMessage } from '@/lib/types'
import { shortDate } from '@/lib/format'
import { Chip, Panel } from '../ui'

function Highlighted({ text, span }: { text: string; span?: string }) {
  if (!span) return <>{text}</>
  const i = text.indexOf(span)
  if (i < 0) return <>{text}</>
  return <>{text.slice(0, i)}<mark className="evidence">{span}</mark>{text.slice(i + span.length)}</>
}

function Row({ m, open, onToggle }: { m: InboxMessage; open: boolean; onToggle: () => void }) {
  const trigger = useRun((s) => s.trigger)
  const triage = useRun((s) => s.triage[m.id])
  const extraction = useRun((s) => s.extraction)
  const focus = useRun((s) => s.focusMessage)
  const ref = useRef<HTMLLIElement>(null)
  const isTrigger = trigger === m.id || extraction?.message_id === m.id
  const quarantined = triage?.verdict === 'suspicious'
  const span = extraction?.message_id === m.id ? extraction.span : undefined
  const [flashKey, setFlashKey] = useState(0)

  useEffect(() => {
    if (focus?.id === m.id) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setFlashKey(focus.key)
    }
  }, [focus, m.id])

  return (
    <li ref={ref} key={flashKey} className={clsx('border-b border-line-soft', flashKey ? 'arrived' : '')}>
      <button onClick={onToggle} aria-expanded={open}
        className={clsx('block w-full px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2',
          quarantined && 'bg-fail-soft hover:bg-fail-soft', isTrigger && !quarantined && 'bg-work-soft hover:bg-work-soft')}>
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-bold">{m.from}</span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-faint">{m.id}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-faint">
          <span className="shrink-0 font-semibold text-muted">{m.channel === 'email' ? 'Email' : 'Chat'}</span>
          <span className="truncate">{m.channel === 'email' ? m.address : m.chat_channel}</span>
          <span className="ml-auto shrink-0">{shortDate(m.at)}</span>
        </div>
        {m.subject && <div className="mt-1 truncate text-[12.5px] font-semibold">{m.subject}</div>}
        <p className={clsx('mt-0.5 text-[12.5px] text-muted', !open && 'line-clamp-2', span && 'text-text')}>
          <Highlighted text={m.body} span={span} />
        </p>
        {(isTrigger || triage) && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {isTrigger && !quarantined && <Chip tone="work">Trigger</Chip>}
            {triage && <Chip tone={triage.verdict === 'suspicious' ? 'fail' : triage.verdict === 'relevant' ? 'ok' : 'muted'}>
              {triage.verdict === 'suspicious' ? 'Quarantined' : triage.verdict === 'relevant' ? 'Relevant' : 'Noise'}
            </Chip>}
          </div>
        )}
        {open && triage && (
          <div className="mt-2 text-[11.5px]">
            <div className={clsx('font-semibold', quarantined ? 'text-fail' : 'text-muted')}>{quarantined ? 'Why it was quarantined' : 'Why it counts as relevant'}</div>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-muted marker:text-faint">
              {triage.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
        )}
      </button>
    </li>
  )
}
export function InboxPanel() {
  const inbox = useRun((s) => s.inbox)
  const trigger = useRun((s) => s.trigger)
  const focus = useRun((s) => s.focusMessage)
  const [open, setOpen] = useState<string | undefined>()
  const sorted = useMemo(() => [...inbox].sort((a, b) => +new Date(b.at) - +new Date(a.at)), [inbox])
  useEffect(() => { if (trigger) setOpen(trigger) }, [trigger])
  useEffect(() => { if (focus) setOpen(focus.id) }, [focus])
  const emails = inbox.filter((m) => m.channel === 'email').length
  return (
    <Panel title="Inbox and chat" aside={<span className="text-[11.5px] text-faint">{emails} emails, {inbox.length - emails} chats</span>} bodyClass="overflow-y-auto">
      <ul>{sorted.map((m) => <Row key={m.id} m={m} open={open === m.id} onToggle={() => setOpen(open === m.id ? undefined : m.id)} />)}</ul>
    </Panel>
  )
}

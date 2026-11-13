import clsx from 'clsx'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { backend } from '@/backend'
import { useRun } from '@/store/runStore'
import type { ContextPacket, TraceLink } from '@/lib/types'
import { Chip, CloseButton, Mono, Skeleton } from '../ui'

export function Drawer({ open, onClose, title, sub, children }: { open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && open) onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="fixed inset-0 z-40 bg-[var(--overlay)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside role="dialog" aria-modal="true"
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[460px] flex-col border-l border-line bg-surface shadow-[var(--shadow)]"
            initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ type: 'spring', stiffness: 360, damping: 34 }}>
            <header className="flex items-start justify-between gap-3 border-b border-line-soft px-5 py-4">
              <div className="min-w-0">
                <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
                {sub && <div className="mt-0.5 text-[12.5px] text-muted">{sub}</div>}
              </div>
              <CloseButton onClick={onClose} />
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}

function TraceSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4" style={{ width: `${70 - i * 8}%` }} />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}

const KIND_LABEL: Record<TraceLink['kind'], string> = {
  message: 'Source message', fact: 'Fact in memory', graph: 'Graph path', computed: 'Computed in code',
  action: 'Plan step', approval: 'Human approval', tool: 'Tool result', verify: 'Verification',
}

export function TraceDrawer() {
  const actionId = useRun((s) => s.traceAction)
  const runId = useRun((s) => s.runId)
  const { set, focusMsg } = useRun.getState()
  const [links, setLinks] = useState<TraceLink[] | null>(null)
  useEffect(() => {
    if (!actionId || !runId) return
    setLinks(null)
    backend.getTrace(runId, actionId).then(setLinks).catch(() => setLinks([]))
  }, [actionId, runId])
  const close = () => set('traceAction', undefined)
  const go = (l: TraceLink) => {
    if (l.kind === 'message' && l.ref) { focusMsg(l.ref); close() }
    if (l.kind === 'graph' && l.ref) { set('selectedNode', l.ref); set('panel', 'map'); close() }
  }
  return (
    <Drawer open={!!actionId} onClose={close} title="Why did this happen?" sub={<>The evidence chain for <Mono>{actionId}</Mono>, from the message that started it to the check that confirmed it.</>}>
      {!links ? <TraceSkeleton /> : !links.length ? <p className="text-[13px] text-muted">No trace recorded for this step yet.</p> : (
        <ol className="relative">
          <span className="absolute bottom-3 left-[5px] top-3 w-px bg-line" aria-hidden />
          {links.map((l, i) => {
            const color = l.ok === false ? 'var(--fail)' : l.ok ? 'var(--ok)' : 'var(--text)'
            const clickable = (l.kind === 'message' || l.kind === 'graph') && l.ref
            return (
              <li key={i} className="relative pb-4 pl-6">
                <span className="absolute left-0 top-1 h-[11px] w-[11px] rounded-xs border-2 bg-surface" style={{ borderColor: color }} aria-hidden />
                <div className="flex items-baseline gap-2 text-[11.5px] text-muted">
                  <span>{i + 1}. {KIND_LABEL[l.kind]}</span>
                  {l.ok !== undefined && <span className="font-bold" style={{ color }}>{l.ok ? 'Passed' : 'Failed'}</span>}
                </div>
                <button disabled={!clickable} onClick={() => go(l)} className={clsx('text-left text-[13.5px] font-semibold leading-snug', clickable && 'text-work hover:underline')}>{l.title}</button>
                {l.quote && <blockquote className="mt-1 text-[13px]"><mark className="evidence">“{l.quote}”</mark></blockquote>}
                <div className="mt-0.5 text-[12.5px] text-muted">{l.detail}</div>
              </li>
            )
          })}
        </ol>
      )}
    </Drawer>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mb-4"><h3 className="mb-1 text-[12px] font-semibold text-muted">{title}</h3>{children}</section>
}

export function ContextInspector() {
  const agent = useRun((s) => s.contextAgent)
  const runId = useRun((s) => s.runId)
  const [p, setP] = useState<ContextPacket | null | undefined>(undefined)
  useEffect(() => {
    if (!agent || !runId) return
    setP(undefined)
    backend.getContext(runId, agent).then(setP).catch(() => setP(null))
  }, [agent, runId])
  const close = () => useRun.getState().set('contextAgent', undefined)
  return (
    <Drawer open={!!agent} onClose={close} title={`What the ${agent} agent saw`} sub="A curated packet, never the whole database. Quoted spans only, the affected subgraph, the tools it may use and the rules it must follow.">
      {p === undefined ? <TraceSkeleton /> : p === null ? <p className="text-[13px] text-muted">This agent has not been given a packet in this run yet.</p> : (
        <div className="text-[13px]">
          <div className="mb-4 flex flex-wrap gap-1.5">
            <Chip tone="note">~{p.token_estimate.toLocaleString('en-IN')} tokens</Chip>
            <Chip>hash <Mono>{p.hash}</Mono></Chip>
          </div>
          <Section title="Task">{p.task}</Section>
          {p.evidence.length > 0 && <Section title="Evidence (quoted spans)">{p.evidence.map((e) => <blockquote key={e.ref} className="mb-1"><mark className="evidence">“{e.quote}”</mark> <Mono className="text-faint">{e.ref}</Mono></blockquote>)}</Section>}
          {p.facts.length > 0 && <Section title="Facts (current versions only)"><ul className="list-disc space-y-0.5 pl-4 text-muted">{p.facts.map((f) => <li key={f}>{f}</li>)}</ul></Section>}
          {Object.keys(p.computed).length > 0 && <Section title="Computed in code (given, not to be recalculated)">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">{Object.entries(p.computed).map(([k, v]) => <Fragment key={k}><dt className="font-mono text-[11.5px] text-faint">{k}</dt><dd>{v}</dd></Fragment>)}</dl>
          </Section>}
          {p.subgraph.length > 0 && <Section title={`Subgraph (${p.subgraph.length} nodes)`}><div className="flex flex-wrap gap-1">{p.subgraph.map((n) => <Mono key={n} className="rounded bg-surface-2 px-1.5 py-0.5">{n}</Mono>)}</div></Section>}
          <Section title="Tools it may call"><div className="flex flex-wrap gap-1">{p.tools.map((t) => <Mono key={t} className="rounded bg-work-soft px-1.5 py-0.5 text-work">{t}</Mono>)}</div></Section>
          <Section title="Rules"><ul className="list-disc space-y-0.5 pl-4 text-muted">{p.policies.map((x) => <li key={x}>{x}</li>)}</ul></Section>
          {p.preferences.length > 0 && <Section title="Learned preferences"><ul className="list-disc space-y-0.5 pl-4 text-note">{p.preferences.map((x) => <li key={x}>{x}</li>)}</ul></Section>}
          <Section title="Deliberately left out"><ul className="list-disc space-y-0.5 pl-4 text-muted">{p.excluded.map((x) => <li key={x} className={x.includes('quarantined') ? 'text-fail' : ''}>{x}</li>)}</ul></Section>
        </div>
      )}
    </Drawer>
  )
}

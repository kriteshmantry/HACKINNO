import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { backend } from '@/backend'
import { impacted } from '@/lib/impact'
import { DEMO_NOW, GRAPH, SCENARIO_MESSAGES } from '@/backend/mock/seed'
import type { GraphData, ImpactNode, InboxMessage } from '@/lib/types'
import { severityColor, Skeleton } from '../ui'

/**
 * Not an illustration: the trigger email and the impact report come from the live backend
 * (or the simulator when it is offline), computed with the same traversal the Knowledge agent runs.
 */
export interface Report { message: InboxMessage; span?: string; graph: GraphData; nodes: ImpactNode[] }

/** The sentence that states the new amount, located the way the backend's rule extractor does. */
function findSpan(body: string): string | undefined {
  const m = /(?:\b[A-Z][\w]*\s+)?(?:can |will )?commit[^.]*?instead of[^.]*?(?:₹\s?[\d,.]+\s*L?\b|\d+(?:\.\d+)?\s*L\b)[^.,]*/i.exec(body)
  return m?.[0].trim()
}

/** The same report from the simulator's own seed: used when the backend is offline or incomplete. */
function seedReport(): Report {
  const message = SCENARIO_MESSAGES['e-19']
  return { message, span: findSpan(message.body), graph: GRAPH, nodes: impacted(GRAPH, 'sp-technova', new Date(DEMO_NOW)) }
}

export function useImpactReport() {
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        await backend.ready()
        const [inbox, graph] = await Promise.all([backend.getInbox(), backend.getGraph()])
        // the simulator only delivers the trigger email when a scenario runs, so look in its scenario messages too
        const message = inbox.find((m) => m.id === backend.profile.triggerMessage)
          ?? (backend.kind === 'mock' ? SCENARIO_MESSAGES[backend.profile.triggerMessage] : undefined)
        if (!message) throw new Error('no trigger message')
        const nodes = impacted(graph, backend.profile.primarySponsor, new Date(backend.profile.now))
        if (!nodes.length) throw new Error('empty impact report')
        if (live) setReport({ message, span: findSpan(message.body), graph, nodes })
      } catch {
        // the hero must never be empty: fall back to the simulator's identical seed data
        try { if (live) setReport(seedReport()) } catch { if (live) setError(true) }
      }
    })()
    return () => { live = false }
  }, [])
  return { report, error }
}

export function TriggerEmail({ report }: { report: Report | null }) {
  if (!report) {
    return (
      <div className="rounded-md border border-line bg-surface p-5" aria-busy="true" aria-label="Loading the trigger email">
        <Skeleton className="h-3 w-2/3" /><Skeleton className="mt-2 h-3 w-1/2" /><Skeleton className="mt-6 h-4 w-full" /><Skeleton className="mt-2 h-4 w-5/6" />
      </div>
    )
  }
  const m = report.message
  const i = report.span ? m.body.indexOf(report.span) : -1
  const when = new Date(m.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return (
    <figure className="rounded-md border border-line bg-surface">
      <dl className="grid grid-cols-[64px_1fr] gap-y-1 border-b border-line-soft px-5 py-3.5 text-[13px]">
        <dt className="text-faint">From</dt><dd><span className="font-semibold">{m.from}</span> <span className="text-muted">{m.from_role ? `(${m.from_role}), ` : ''}{m.address}</span></dd>
        <dt className="text-faint">Subject</dt><dd className="font-semibold">{m.subject}</dd>
        <dt className="text-faint">Received</dt><dd className="text-muted">{when}</dd>
      </dl>
      <blockquote className="px-5 py-4 text-[15.5px] leading-relaxed">
        {i >= 0 ? <>{m.body.slice(0, i)}<mark className="evidence">{report.span}</mark>{m.body.slice(i + report.span!.length)}</> : m.body}
      </blockquote>
      <figcaption className="border-t border-line-soft px-5 py-2.5 text-[12px] text-muted">
        <span className="font-mono text-[11.5px] text-text">{m.id}</span>, the trigger in the demo workspace. The highlighted span is the evidence every later step cites.
      </figcaption>
    </figure>
  )
}

const DEPTH_NAME = ['', 'Directly', 'One step removed', 'Two steps removed', 'Three steps removed']

export function ImpactReport({ report, error }: { report: Report | null; error: boolean }) {
  const reduce = useReducedMotion()
  if (error) return <p className="text-[13px] text-muted">The impact report could not be loaded. Open the console to run the scenario.</p>
  if (!report) {
    return (
      <div className="grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2 lg:grid-cols-4" aria-busy="true" aria-label="Loading the impact report">
        {[0, 1, 2, 3].map((c) => <div key={c} className="space-y-3 bg-surface p-4">{[0, 1, 2, 3].map((r) => <Skeleton key={r} className="h-3" style={{ width: `${80 - r * 12}%` }} />)}</div>)}
      </div>
    )
  }
  const { nodes, graph } = report
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id
  const depths = [1, 2, 3, 4].filter((d) => nodes.some((r) => r.depth === d))
  return (
    <section aria-labelledby="report-title">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id="report-title" className="text-[15px] font-bold">What it traced from that one sentence</h2>
        <p className="text-[12.5px] text-muted">
          {nodes.length} items, {nodes.filter((r) => r.severity === 'high').length} urgent. Computed {backend.kind === 'http' ? 'from the live backend’s knowledge graph' : 'by the built-in simulator, because the backend is offline'}.
        </p>
      </div>
      <ol className={`mt-3 grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2 ${depths.length >= 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
        {depths.map((d, col) => (
          <motion.li key={d} className="bg-surface p-4"
            initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 + col * 0.45, duration: 0.4 }}>
            <h3 className="text-[12px] font-bold text-muted">{DEPTH_NAME[d]}</h3>
            <ul className="mt-2 space-y-2.5">
              {nodes.filter((r) => r.depth === d).map((r) => {
                const via = r.path.length > 3 ? label(r.path[r.path.length - 3]) : undefined
                const edge = r.path[r.path.length - 2]
                return (
                  <li key={r.node} className="leading-snug">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13.5px] font-semibold">{label(r.node)}</span>
                      <span className="shrink-0 text-[11px] font-bold capitalize" style={{ color: severityColor[r.severity] }}>{r.severity}</span>
                    </div>
                    <div className="text-[12px] text-muted">
                      {r.why}{via ? <>, {edge === 'approves' ? 'because it approves' : 'via'} {via}</> : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          </motion.li>
        ))}
      </ol>
    </section>
  )
}

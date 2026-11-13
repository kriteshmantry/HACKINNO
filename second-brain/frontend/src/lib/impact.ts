/**
 * Typed impact propagation, mirroring backend/knowledge/graph.py (PROPAGATE, severity, impacted).
 * Used by the landing page, the simulator and the HTTP adapter so every surface tells the same story.
 */
import type { EdgeKind, GraphData, GraphNode, ImpactNode, Severity } from './types'

export const PROPAGATE: Partial<Record<EdgeKind, 'fwd' | 'rev'>> = {
  has_tier: 'fwd', entitles: 'fwd', funds: 'fwd', contributes_to: 'fwd', scheduled_as: 'fwd', pays_by: 'fwd',
  depicted_in: 'fwd', documented_in: 'fwd', owned_by: 'fwd', approves: 'rev',
}

const within72h = (date: unknown, now: Date) => {
  if (typeof date !== 'string' || !date) return false
  const hours = (new Date(date.length <= 10 ? `${date}T09:00:00` : date).getTime() - now.getTime()) / 36e5
  return hours <= 72
}

/** Same rules as the backend's severity(); falls back to the node subtitle for the simulator's graph. */
export function severityOf(n: GraphNode, now: Date): Severity {
  const a = n.attrs ?? {}
  const date = a.date ?? a.deadline ?? (/Nov (\d+)/.exec(n.sub ?? '')?.[1] ? `2026-11-${/Nov (\d+)/.exec(n.sub ?? '')![1].padStart(2, '0')}` : undefined)
  switch (n.kind) {
    case 'PromoAsset': return a.published === undefined || a.published ? 'high' : 'medium'
    case 'OrgApproval': return a.status === undefined || a.status === 'pending' ? 'high' : 'medium'
    case 'CalendarEvent': return within72h(date, now) ? 'high' : 'medium'
    case 'Deliverable': return within72h(a.deadline, now) ? 'high' : 'medium'
    case 'BudgetLine': case 'Tier': case 'Budget': return 'medium'
    default: return 'low'
  }
}

/** Plain-language reason a node is affected, written for the person reading the report. */
export function explain(n: GraphNode, sev: Severity, now: Date): string {
  const a = n.attrs ?? {}
  switch (n.kind) {
    case 'PromoAsset': return sev === 'high' ? 'Published: people have already seen it' : 'Not published yet'
    case 'OrgApproval': return sev === 'high' ? 'Pending sign-off is based on the old amount' : 'Signed off against the old amount'
    case 'CalendarEvent': {
      const d = (a.date as string | undefined)
      if (sev === 'high' && d) {
        const h = Math.round((new Date(`${d}T09:00:00`).getTime() - now.getTime()) / 36e5)
        return `Happens in ${h} hours`
      }
      return sev === 'high' ? 'Happens within 72 hours' : 'Scheduled work depends on it'
    }
    case 'Deliverable': return sev === 'high' ? 'Due within 72 hours, granted by the tier' : 'Granted by the tier'
    case 'Tier': return 'Set by the committed amount'
    case 'Budget': return 'Total income drops'
    case 'BudgetLine': return 'Paid for by this sponsor'
    case 'Doc': return 'States the old terms'
    case 'Person': return 'Needs to be told'
    default: return 'Depends on the committed amount'
  }
}

export function impacted(g: GraphData, root: string, now: Date, maxDepth = 4): ImpactNode[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const seen = new Set([root])
  const out: ImpactNode[] = []
  const queue: { node: string; path: string[] }[] = [{ node: root, path: [root] }]
  while (queue.length) {
    const { node, path } = queue.shift()!
    if ((path.length - 1) / 2 >= maxDepth) continue
    const nbrs: [string, EdgeKind][] = []
    for (const e of g.edges) {
      if (e.source === node && PROPAGATE[e.kind] === 'fwd') nbrs.push([e.target, e.kind])
      if (e.target === node && PROPAGATE[e.kind] === 'rev') nbrs.push([e.source, e.kind])
    }
    for (const [nxt, kind] of nbrs) {
      if (seen.has(nxt) || !byId.has(nxt)) continue
      seen.add(nxt)
      const p = [...path, kind, nxt]
      const n = byId.get(nxt)!
      const severity = severityOf(n, now)
      out.push({ node: nxt, path: p, depth: (p.length - 1) / 2, severity, why: explain(n, severity, now) })
      queue.push({ node: nxt, path: p })
    }
  }
  return out
}

import clsx from 'clsx'
import { memo, useEffect, useMemo, useRef } from 'react'
import {
  Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider,
  useEdgesState, useNodesState, useReactFlow, type Edge, type Node, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { graphlib, layout } from '@dagrejs/dagre'
import { useRun } from '@/store/runStore'
import { backend } from '@/backend'
import type { GraphData, GraphNode, ImpactNode, Severity, WorldState } from '@/lib/types'
import { lakhs, rupees } from '@/lib/format'
import { Chip, CloseButton, kindLabel, Panel, severityColor } from '../ui'

const W = 172
const H = 56
const STEP_MS = 420

type EntityData = {
  g: GraphNode
  sub: string
  mode: 'neutral' | 'hit' | 'dim' | 'root' | 'trigger'
  severity?: Severity
  depth: number
  changed: boolean
  selected: boolean
  animKey: number
  danger?: boolean
}

/** Live subtitle for a node that points at a world row (backend graph). */
function refSub(n: GraphNode, w: WorldState): string {
  const r = n.ref!
  const row = (w[r.table] as unknown as Record<string, unknown>[]).find((x) => x.id === r.id) as Record<string, any> | undefined
  if (!row) return n.sub ?? ''
  switch (r.table) {
    case 'sponsors': return r.field === 'tier' ? `${row.tier}` : `${row.tier}, ${rupees(row.committed)}`
    case 'budget': return `${rupees(row.amount)}${row.status === 'pending update' ? ', pending update' : ''}`
    case 'approvals': return `${lakhs(row.amount)}, ${row.status === 'pending' ? 'pending sign-off' : String(row.status).replace('_', ' ')}`
    case 'deliverables': return row.status === 'removed' ? 'Removed' : row.spec
    case 'calendar': {
      const d = new Date(row.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      return `${d}${row.status === 'cancelled' ? ', cancelled' : row.note ? ', note added' : ''}`
    }
    case 'promo': return row.status === 'flagged' ? 'Flagged for correction' : n.sub ?? ''
    default: return n.sub ?? ''
  }
}

function liveSub(n: GraphNode, w: WorldState | undefined, triggerLabel?: string): string {
  if (n.id === 'msg') return triggerLabel ?? n.sub ?? ''
  if (!w) return n.sub ?? ''
  if (n.ref) return refSub(n, w)
  const sp = w.sponsors.find((s) => s.id === n.id)
  if (sp) return `${sp.tier}, ${rupees(sp.committed)}`
  if (n.id === 'tier-technova') { const t = w.sponsors.find((s) => s.id === 'sp-technova')!; return `${t.tier} (${t.tier === 'Gold' ? '≥ ₹4L' : t.tier === 'Silver' ? '≥ ₹2L' : '≥ ₹50k'})` }
  const bl = w.budget.find((b) => b.id === n.id)
  if (bl) return `${rupees(bl.amount)}${bl.status === 'pending update' ? ', pending update' : ''}`
  const oa = w.approvals.find((a) => a.id === n.id)
  if (oa) return `${lakhs(oa.amount)}, ${oa.status === 'pending' ? 'pending sign-off' : oa.status === 'amended' ? 'amended, re-sign' : oa.status}`
  const dl = w.deliverables.find((d) => d.id === n.id)
  if (dl) return dl.status === 'removed' ? 'Removed' : dl.spec
  const cal = w.calendar.find((c) => c.id === n.id)
  if (cal) {
    const d = new Date(cal.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    if (cal.expected_amount) return `${d}, ${lakhs(cal.expected_amount)} expected`
    return `${d}${cal.status === 'cancelled' ? ', cancelled' : ''}`
  }
  const pr = w.promo.find((p) => p.id === n.id)
  if (pr) return pr.status === 'flagged' ? 'Flagged for correction' : `“${pr.text.split(':')[0]}”`
  return n.sub ?? ''
}

const touchKey = (n: GraphNode): string[] => {
  if (n.ref) return [n.ref.field ? `${n.ref.table}:${n.ref.id}:${n.ref.field}` : n.ref.table === 'sponsors' ? `${n.ref.table}:${n.ref.id}:committed` : `${n.ref.table}:${n.ref.id}`]
  const id = n.id
  if (id === 'tier-technova') return ['sponsors:sp-technova:tier']
  const t = id.startsWith('sp-') ? 'sponsors' : id.startsWith('bl-') ? 'budget' : id.startsWith('oa-') ? 'approvals' : id.startsWith('dl-') ? 'deliverables' : id.startsWith('cal-') ? 'calendar' : id === 'p-1' ? 'promo' : ''
  if (!t) return []
  return id === 'sp-technova' ? ['sponsors:sp-technova:committed'] : [`${t}:${id}`]
}

const EntityNode = memo(function EntityNode({ data }: NodeProps<Node<EntityData, 'entity'>>) {
  const { g, sub, mode, severity, depth, changed, selected, animKey, danger } = data
  const sevColor = severity ? severityColor[severity] : undefined
  const border = danger ? 'var(--fail)' : mode === 'root' ? 'var(--text)' : mode === 'trigger' ? 'var(--note)' : mode === 'hit' ? sevColor : 'var(--line)'
  const bg = danger ? 'var(--fail-soft)' : mode === 'trigger' ? 'var(--note-soft)' : 'var(--surface)'
  return (
    <div
      key={mode === 'hit' ? animKey : 'static'}
      className={clsx('flex h-[56px] w-[172px] flex-col justify-center rounded-sm px-2.5 leading-tight transition-[opacity,border-color] duration-300',
        mode === 'hit' && 'node-hit', mode === 'dim' && 'opacity-40',
        selected && 'outline outline-2 outline-offset-2 outline-work')}
      style={{
        border: `${mode === 'root' ? 2 : mode === 'neutral' || mode === 'dim' ? 1 : 1.5}px solid ${border}`,
        background: bg,
        animationDelay: mode === 'hit' ? `${depth * STEP_MS}ms` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <span className="flex items-baseline justify-between gap-2 text-[10.5px]">
        <span className="truncate text-faint">{kindLabel[g.kind]}</span>
        {changed ? <span className="font-bold text-ok">Updated</span>
          : mode === 'hit' && severity ? <span className="font-bold capitalize" style={{ color: sevColor }}>{severity}</span> : null}
      </span>
      <span className="block truncate text-[13px] font-bold">{g.label}</span>
      <span className="block truncate text-[11.5px] text-muted">{sub}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  )
})
const nodeTypes = { entity: EntityNode }

function layoutGraph(g: GraphData): Record<string, { x: number; y: number }> {
  const d = new graphlib.Graph()
  d.setGraph({ rankdir: 'LR', nodesep: 10, ranksep: 46, marginx: 10, marginy: 10 })
  d.setDefaultEdgeLabel(() => ({}))
  for (const n of g.nodes) d.setNode(n.id, { width: W, height: H })
  for (const e of g.edges) {
    // lay approvals out downstream of the budget line they approve, which is how impact flows
    if (e.kind === 'approves') d.setEdge(e.target, e.source)
    else d.setEdge(e.source, e.target)
  }
  layout(d)
  const out: Record<string, { x: number; y: number }> = {}
  for (const n of g.nodes) { const p = d.node(n.id); out[n.id] = { x: p.x - W / 2, y: p.y - H / 2 } }
  return out
}

function edgeLabel(kind: string) { return kind === 'approves' ? 'approves (impact flows back)' : kind.replace('_', ' ') }

function WhyCard({ node, imp, onClose }: { node: GraphNode; imp?: ImpactNode; onClose: () => void }) {
  const graph = useRun((s) => s.graph)
  const trigger = useRun((s) => s.extraction?.message_id ?? s.trigger)
  const hasImpact = useRun((s) => s.impact.length > 0)
  const focusMsg = useRun((s) => s.focusMsg)
  const label = (id: string) => graph?.nodes.find((n) => n.id === id)?.label ?? id
  return (
    <div className="absolute bottom-3 left-3 z-10 w-[min(440px,calc(100%-24px))] rounded-md border border-line bg-surface p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11.5px] text-muted">{kindLabel[node.kind]}</div>
          <div className="text-[15px] font-semibold">{node.label}</div>
        </div>
        <CloseButton onClick={onClose} />
      </div>
      {imp ? (
        <>
          <div className="mt-2 flex items-center gap-2">
            <Chip tone={imp.severity === 'high' ? 'fail' : imp.severity === 'medium' ? 'wait' : 'work'}>{imp.severity} severity</Chip>
            <span className="text-[12.5px] text-muted">{imp.why}</span>
          </div>
          <div className="mt-3 text-[11.5px] text-muted">Why it’s affected</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1 text-[12.5px]">
            {imp.path.map((p, i) => i % 2 === 0
              ? <span key={i} className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-medium">{label(p)}</span>
              : <span key={i} className={clsx('text-[11.5px]', p === 'approves' ? 'text-wait' : 'text-faint')}>{p === 'approves' ? 'is approved by' : p.replace('_', ' ')}</span>)}
          </div>
          {trigger && (
            <button onClick={() => focusMsg(trigger)} className="mt-3 text-[12.5px] font-semibold text-work hover:underline">
              Show the source message ({trigger})
            </button>
          )}
        </>
      ) : (
        <p className="mt-2 text-[12.5px] text-muted">
          {hasImpact ? 'Not affected. No edge that carries impact reaches it from TechNova, so the plan will not touch it.' : 'Run a scenario to see whether this is affected.'}
        </p>
      )}
    </div>
  )
}

function GraphInner() {
  const graph = useRun((s) => s.graph)
  const world = useRun((s) => s.world)
  const impact = useRun((s) => s.impact)
  const impactKey = useRun((s) => s.impactKey)
  const touched = useRun((s) => s.touched)
  const selected = useRun((s) => s.selectedNode)
  const extraction = useRun((s) => s.extraction)
  const trigger = useRun((s) => s.trigger)
  const inbox = useRun((s) => s.inbox)
  const quarantined = useRun((s) => s.outcome?.kind === 'quarantined')
  const setSel = (id?: string) => useRun.getState().set('selectedNode', id)
  const { fitView } = useReactFlow()

  const pos = useMemo(() => (graph ? layoutGraph(graph) : {}), [graph])
  const impMap = useMemo(() => new Map(impact.map((i) => [i.node, i])), [impact])
  const trigMsg = inbox.find((m) => m.id === (extraction?.message_id ?? trigger))
  const triggerLabel = trigMsg ? `${trigMsg.id}, ${trigMsg.from}` : undefined

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<EntityData, 'entity'>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  useEffect(() => {
    if (!graph) return
    const has = impact.length > 0
    const next: Node<EntityData, 'entity'>[] = graph.nodes.map((g) => {
      const imp = impMap.get(g.id)
      const mode: EntityData['mode'] = g.id === 'msg' ? (trigMsg ? 'trigger' : 'neutral') : g.id === backend.profile.primarySponsor && extraction ? 'root' : imp ? 'hit' : has ? 'dim' : 'neutral'
      return {
        id: g.id, type: 'entity', position: pos[g.id] ?? { x: 0, y: 0 }, width: W, height: H, draggable: false,
        data: {
          g, sub: liveSub(g, world, triggerLabel), mode, severity: imp?.severity, depth: imp?.depth ?? 0,
          changed: touchKey(g).some((k) => touched[k]), selected: selected === g.id, animKey: impactKey, danger: g.id === 'msg' && quarantined,
        },
      }
    })
    setNodes((prev) => next.map((n) => { const p = prev.find((x) => x.id === n.id); return p ? { ...p, ...n, measured: p.measured } : n }))
    const onPath = new Set<string>()
    for (const i of impact) for (let k = 1; k < i.path.length; k += 2) onPath.add(`${i.path[k - 1]}|${i.path[k + 1]}`)
    setEdges(graph.edges.map((e) => {
      const live = onPath.has(`${e.source}|${e.target}`) || onPath.has(`${e.target}|${e.source}`) || (e.kind === 'mentions' && !!trigMsg)
      const color = live ? (e.kind === 'mentions' ? 'var(--muted)' : severityColor[impMap.get(e.kind === 'approves' ? e.source : e.target)?.severity ?? 'low']) : 'var(--line)'
      return {
        id: e.id, source: e.source, target: e.target, type: 'smoothstep', selectable: false,
                label: live ? edgeLabel(e.kind) : undefined,
        style: { stroke: color, strokeWidth: live ? 1.8 : 1.2, opacity: has && !live ? 0.35 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      }
    }))
  }, [graph, world, impact, impactKey, touched, selected, extraction, trigMsg, triggerLabel, pos, impMap, quarantined, setNodes, setEdges])

  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    let t: number | undefined
    const ro = new ResizeObserver(() => { clearTimeout(t); t = window.setTimeout(() => fitView({ padding: 0.06, duration: 300 }), 80) })
    ro.observe(el)
    return () => { ro.disconnect(); clearTimeout(t) }
  }, [fitView])
  useEffect(() => { const t = setTimeout(() => fitView({ padding: 0.06, duration: 300 }), 120); return () => clearTimeout(t) }, [graph, nodes.length, fitView])

  const sel = graph?.nodes.find((n) => n.id === selected)
  const counts = { high: impact.filter((i) => i.severity === 'high').length, medium: impact.filter((i) => i.severity === 'medium').length, low: impact.filter((i) => i.severity === 'low').length }

  return (
    <div ref={wrap} className="relative h-full w-full">
      <ReactFlow
        nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} nodeTypes={nodeTypes}
        onNodeClick={(_, n) => setSel(n.id)} onPaneClick={() => setSel(undefined)}
        onSelectionChange={({ nodes: sel }) => { if (sel[0] && sel[0].id !== useRun.getState().selectedNode) setSel(sel[0].id) }}
        ariaLabelConfig={{ 'node.a11yDescription.default': 'Press Enter to see why this item is affected' }}
        fitView fitViewOptions={{ padding: 0.06 }} minZoom={0.3} maxZoom={1.6} nodesConnectable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={0} color="transparent" />
        <Controls showInteractive={false} position="top-left" />
      </ReactFlow>
      <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-3 rounded-md border border-line-soft bg-surface px-2.5 py-1.5 text-[11.5px] text-muted">
        {impact.length ? <span className="font-semibold text-text">{impact.length} affected</span> : <span>Nothing affected yet</span>}
        {(['high', 'medium', 'low'] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: severityColor[s] }} />{s}{impact.length ? ` ${counts[s]}` : ''}</span>
        ))}
      </div>
      {sel && <WhyCard node={sel} imp={impMap.get(sel.id)} onClose={() => setSel(undefined)} />}
    </div>
  )
}

export function ImpactGraph() {
  const contradiction = useRun((s) => s.contradiction)
  return (
    <Panel
      title="Impact graph"
      aside={contradiction
        ? <span className="truncate text-[11.5px] text-note">Memory said {lakhs(contradiction.old_fact.value)} ({contradiction.source_old}); {contradiction.source_new} says {lakhs(contradiction.new_claim)}</span>
        : <span className="text-[11.5px] text-faint">Built from the tracker, budget, calendar and docs. Click any item</span>}
    >
      <ReactFlowProvider><GraphInner /></ReactFlowProvider>
    </Panel>
  )
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Translates the FastAPI backend (second-brain/backend) into the UI's contract.
 *
 * The backend is the source of truth and is left untouched. Its events and rows use its own
 * vocabulary (run.state, agent.started, options.ready, plan.created, verify.pass, s-technova,
 * committed_amount, budget.set_lines...). Everything here maps those onto src/lib/types.ts,
 * and fills two gaps the UI relies on:
 *   - field-level changes (world.patch) are derived by diffing /api/state after each tool call;
 *   - approval details (dry-run preview, args, rationale) are read from /api/approvals.
 */
import type {
  ActionStatus, AgentId, Approval, Band, Fact, GraphData, GraphNode, ImpactNode, InboxMessage, NodeKind,
  Plan, PlannedAction, RunEvent, RunStateName, ShortfallOption, TraceLink, VerifyCheck, WorldState, WorldTable,
} from '@/lib/types'
import { explain, PROPAGATE, severityOf } from '@/lib/impact'
import { rupees } from '@/lib/format'

export const SCENARIO_NOW = new Date('2026-11-14T00:00:00')

/* ------------------------------------------------------------------ */
/* Backend constants we need to explain things (mirrors config.py)     */
/* ------------------------------------------------------------------ */
const ENTITLEMENTS: Record<string, Record<string, string | null>> = {
  Gold: { banner_logo: 'L', keynote: '20 min', social_posts: '3' },
  Silver: { banner_logo: 'M', keynote: null, social_posts: '2' },
  Bronze: { banner_logo: null, keynote: null, social_posts: null },
  None: { banner_logo: null, keynote: null, social_posts: null },
}
const KIND_NAME: Record<string, string> = { banner_logo: 'Main banner logo', keynote: 'Keynote slot', social_posts: 'Social posts' }
const kindName = (k: string) => KIND_NAME[k] ?? k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
const specText = (kind: string, spec: string | null) =>
  spec == null ? 'none' : kind === 'banner_logo' ? `Size ${spec}` : kind === 'social_posts' ? `${spec} posts` : spec

/** Format a backend value for people: rupees for amounts, sentence case otherwise. */
export function fmtv(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'number') return v >= 1000 || v <= -1000 ? rupees(v) : String(v)
  if (typeof v === 'string') return v.replace(/\b(\d{5,})\b/g, (m) => rupees(Number(m)))
  if (Array.isArray(v)) return v.length ? v.map(fmtv).join(', ') : 'none'
  if (typeof v === 'object') return Object.entries(v as object).map(([k, x]) => `${k.replace(/_/g, ' ')} ${fmtv(x)}`).join(', ')
  return String(v)
}

/* ------------------------------------------------------------------ */
/* Read models                                                         */
/* ------------------------------------------------------------------ */
export function mapInbox(rows: any[]): InboxMessage[] {
  return rows.map((m) => {
    const chat = m.channel === 'chat'
    const [name, role] = String(m.sender_name ?? m.sender).split(/\s*\((.*)\)\s*$/)
    return {
      id: m.id, channel: chat ? 'chat' : 'email', from: name || m.sender, from_role: role || undefined,
      address: chat ? undefined : m.sender, chat_channel: chat ? m.subject : undefined,
      subject: chat ? undefined : m.subject, body: m.body, at: m.received_at,
    }
  })
}

export function mapWorld(state: any, outbox: any[], people: Map<string, string>): WorldState {
  const person = (id?: string | null) => (id ? people.get(id) ?? id : '')
  const sponsors = (state.sponsors ?? []) as any[]
  return {
    sponsors: sponsors.map((s) => ({ id: s.id, name: s.name, tier: s.tier, committed: s.committed_amount, received: s.received_amount, status: s.status, version: s.version })),
    income: [
      ...sponsors.filter((s) => s.status === 'active').map((s) => ({ id: `in-${s.id}`, source: s.name, amount: s.committed_amount, sponsor_id: s.id })),
      ...(state.other_income ?? []).map((i: any) => ({ id: i.id, source: i.source, amount: i.amount })),
    ],
    budget: (state.budget_lines ?? []).map((b: any) => ({
      id: b.id, category: b.category, amount: b.amount, floor: b.floor, priority: b.cuttable ? b.priority : null,
      funded_by: b.funded_by ?? undefined, cuttable: !!b.cuttable, status: b.status === 'pending_update' ? 'pending update' : b.status,
    })),
    deliverables: (state.deliverables ?? []).map((d: any) => ({
      id: d.id, sponsor_id: d.sponsor_id, kind: kindName(d.kind), spec: specText(d.kind, d.spec), deadline: d.deadline, status: d.status,
    })),
    calendar: (state.calendar_events ?? []).map((c: any) => ({
      id: c.id, title: c.title, date: c.date, owner: person(c.owner), linked: c.linked_entity ?? undefined,
      status: c.status === 'cancelled' ? 'cancelled' : 'scheduled', note: (c.notes ?? []).at(-1),
    })),
    approvals: (state.org_approvals ?? []).map((o: any) => ({
      id: o.id, subject: String(o.subject).replace(/\s*₹[\d,]+$/, ''), approver: person(o.approver), amount: o.amount, status: o.status,
    })),
    promo: (state.promo_assets ?? []).map((p: any) => ({
      id: p.id, kind: p.kind === 'social' ? 'Social post' : kindName(p.kind), text: p.text, published: !!p.published, status: (p.flags ?? []).length ? 'flagged' : 'live',
    })),
    docs: (state.docs ?? []).flatMap((d: any) => (d.notes ?? []).map((n: string, i: number) => ({ id: `${d.id}#${i}`, doc: d.title, text: n, change_id: '' }))),
    outbox: outbox.map((o) => ({
      id: String(o.id), channel: o.channel === 'chat' ? 'chat' : 'email', to: o.recipient, cc: o.cc ?? [], subject: o.subject || undefined,
      body: o.body, status: o.status === 'sent' ? 'sent' : 'queued', approval_id: o.approval_id ?? undefined, change_id: o.change_id,
    })),
    tasks: [
      ...(state.gaps ?? []).map((g: any) => ({ id: `gap-${g.sponsor_id}`, title: `Find a sponsor for the ${rupees(g.amount)} gap (${g.note})`, owner: 'Treasurer', status: 'open' as const })),
      ...(state.pending_updates ?? []).filter((p: any) => p.status === 'pending')
        .map((p: any) => ({ id: `pending-${p.line_id}`, title: `Apply ${p.line_id} ${rupees(p.current_amount)} → ${rupees(p.intended_amount)} by hand`, owner: 'Treasurer', status: 'open' as const })),
    ],
  }
}

const KINDS: Record<string, NodeKind> = {
  Sponsor: 'Sponsor', Tier: 'Tier', Budget: 'Budget', BudgetLine: 'BudgetLine', Deliverable: 'Deliverable',
  CalendarEvent: 'CalendarEvent', OrgApproval: 'OrgApproval', Doc: 'Doc', PromoAsset: 'PromoAsset', Person: 'Person',
}

/**
 * The backend graph spans every sponsor, person and line (about 40 nodes). Keep what the
 * scenario is about: everything the primary sponsor can reach along impact-carrying edges,
 * plus the other sponsors so you can see what was deliberately left alone.
 */
export function mapGraph(raw: any, primary: string, people: Map<string, string>): GraphData {
  const sponsorName = new Map<string, string>()
  for (const n of raw.nodes) if (n.type === 'Sponsor') sponsorName.set(n.id, String(n.label).split(' ')[0])
  const nodes: GraphNode[] = raw.nodes.map((n: any) => {
    const kind = KINDS[n.type] ?? 'Doc'
    const attrs = { status: n.status, date: n.date, deadline: n.deadline, published: n.published }
    let label = String(n.label), sub: string | undefined
    let ref: GraphNode['ref']
    switch (kind) {
      case 'Sponsor': label = label.replace(/ Pvt Ltd$/, ''); ref = { table: 'sponsors', id: n.id }; break
      case 'Tier': { const sid = String(n.id).replace(/^tier:/, ''); label = `${sponsorName.get(sid) ?? ''} tier`.trim(); ref = { table: 'sponsors', id: sid, field: 'tier' }; break }
      case 'Budget': label = 'Total budget'; sub = 'Income and spend'; break
      case 'BudgetLine': label = label.replace(/\s*₹[\d,]+$/, ''); ref = { table: 'budget', id: n.id }; break
      case 'Deliverable': {
        const m = /^(.*?) \((.*)\)$/.exec(label)
        label = m ? kindName(m[1].replace(/ /g, '_')) : label
        ref = { table: 'deliverables', id: n.id }; break
      }
      case 'OrgApproval': label = `${label.replace(/\s*₹[\d,]+$/, '')} approval`; ref = { table: 'approvals', id: n.id }; break
      case 'CalendarEvent': label = label.replace(/\s*\(\d\d-\d\d\)$/, ''); ref = { table: 'calendar', id: n.id }; break
      case 'PromoAsset': { const [k, ...rest] = label.split(': '); label = k === 'social' ? 'Social post' : `Published ${k}`; sub = `“${rest.join(': ').slice(0, 28)}”`; ref = { table: 'promo', id: n.id }; break }
      case 'Person': { const m = /^(.*?) \((.*)\)$/.exec(label); label = m?.[1] ?? label; sub = m?.[2]; people.set(n.id, label); break }
    }
    return { id: n.id, kind, label, sub, ref, attrs }
  })
  const edges = raw.edges.map((e: any, i: number) => ({ id: `e${i}`, source: e.source, target: e.target, kind: e.type }))
  // reach from the primary sponsor along propagating edges (depth 4), as the backend's impact walk does
  const keep = new Set<string>([primary])
  let frontier = [primary]
  for (let d = 0; d < 4; d++) {
    const next: string[] = []
    for (const id of frontier) for (const e of edges) {
      const dir = PROPAGATE[e.kind as keyof typeof PROPAGATE]
      const nb = dir === 'fwd' && e.source === id ? e.target : dir === 'rev' && e.target === id ? e.source : null
      if (nb && !keep.has(nb)) { keep.add(nb); next.push(nb) }
    }
    frontier = next
  }
  for (const n of nodes) if (n.kind === 'Sponsor') keep.add(n.id)
  return {
    nodes: nodes.filter((n) => keep.has(n.id)),
    edges: edges.filter((e: any) => keep.has(e.source) && keep.has(e.target) && e.kind !== 'allocates'),
  }
}

export function mapFacts(rows: any[]): Fact[] {
  return rows.filter((f) => f.predicate === 'committed_amount').map((f) => ({
    id: f.id, entity: f.entity, predicate: f.predicate, value: Number(f.value), valid_from: f.valid_from,
    valid_to: f.valid_to ?? undefined, superseded_by: f.superseded_by ?? undefined, source_ref: f.source_ref,
    confidence: Number(f.confidence ?? 0), status: f.valid_to ? 'superseded' : 'current',
  }))
}

/* ------------------------------------------------------------------ */
/* Plan and approval translation                                       */
/* ------------------------------------------------------------------ */
const STATUS: Record<string, ActionStatus> = {
  pending: 'pending', running: 'running', awaiting_approval: 'awaiting_approval', done: 'done', skipped_duplicate: 'skipped_duplicate',
  rejected_by_human: 'rejected', failed: 'failed', blocked: 'blocked', replaced: 'replaced',
}

export function titleFor(a: any, raw: any | undefined): string {
  const args = a.args ?? {}
  const sponsor = raw?.sponsors?.find((s: any) => s.id === args.sponsor_id)
  const sName = sponsor ? String(sponsor.name).split(' ')[0] : 'the sponsor'
  const lineCount = (args.changes ?? []).length
  const find = (table: string, id: string) => raw?.[table]?.find((r: any) => r.id === id)
  switch (a.tool) {
    case 'tracker.set_committed': return `Set ${sName}’s commitment to ${rupees(args.new)}`
    case 'tracker.set_tier': return `Move ${sName} from ${args.expect} to ${args.new}`
    case 'tracker.set_gap': return args.amount ? `Record an open gap of ${rupees(args.amount)}` : 'Clear the open gap'
    case 'tracker.flag_pending_update': return lineCount ? `Flag ${lineCount} budget line${lineCount === 1 ? '' : 's'} for the treasurer to apply` : 'Withdraw budget changes left pending by an earlier fallback'
    case 'budget.set_lines': return `Rebalance ${lineCount} budget line${lineCount === 1 ? '' : 's'}`
    case 'approvals.update': {
      const oa = find('org_approvals', args.org_approval_id)
      const subj = oa ? String(oa.subject).replace(/\s*₹[\d,]+$/, '') : args.org_approval_id
      return args.amount !== args.expect_amount ? `Amend the ${subj.toLowerCase()} approval to ${rupees(args.amount)}` : `Flag the ${subj.toLowerCase()} approval for its approver`
    }
    case 'deliverables.set': {
      const d = find('deliverables', args.deliverable_id)
      const k = d ? kindName(d.kind) : args.deliverable_id
      return args.status === 'removed' ? `Remove the ${k.toLowerCase()}` : `Change the ${k.toLowerCase()} to ${specText(d?.kind ?? '', args.spec).toLowerCase()}`
    }
    case 'calendar.set_status': { const e = find('calendar_events', args.event_id); return `${args.status === 'cancelled' ? 'Cancel' : 'Restore'} “${e?.title ?? args.event_id}”` }
    case 'calendar.add_note': { const e = find('calendar_events', args.target_id); return `Add a note to “${e?.title ?? args.target_id}”` }
    case 'promo.flag_correction': { const p = find('promo_assets', args.target_id); return `Flag the published ${p?.kind ?? 'asset'} for correction` }
    case 'docs.append_note': { const d = find('docs', args.target_id); return `Add a note to the ${d?.title ?? args.target_id}` }
    case 'memory.supersede_fact': return `Supersede the remembered ${String(args.predicate).replace(/_/g, ' ')}`
    case 'comms.email': return `Email ${args.to} with the new terms`
    case 'comms.chat': return `Post in ${args.channel}`
    default: return a.rationale ?? a.tool
  }
}

function targetsOf(args: any): string[] {
  const ids = [args.sponsor_id, args.deliverable_id, args.event_id, args.target_id, args.org_approval_id, ...(args.changes ?? []).map((c: any) => c.line_id)]
  return ids.filter(Boolean)
}

function levels(actions: any[]): Record<string, number> {
  const by = new Map(actions.map((a) => [a.id, a]))
  const memo: Record<string, number> = {}
  const lvl = (id: string, guard = 0): number => {
    if (memo[id]) return memo[id]
    const a = by.get(id)
    const deps = (a?.depends_on ?? []).filter((d: string) => by.has(d))
    memo[id] = guard > 50 || !deps.length ? 1 : 1 + Math.max(...deps.map((d: string) => lvl(d, guard + 1)))
    return memo[id]
  }
  for (const a of actions) lvl(a.id)
  return memo
}

export function mapPlan(p: any, prev: Plan | undefined, raw: any, changeId: string): Plan {
  const lv = levels(p.actions)
  const prevKeys = new Set((prev?.actions ?? []).map((a) => (a as any).key))
  const actions: PlannedAction[] = p.actions.map((a: any) => ({
    id: a.id, tool: a.tool, title: titleFor(a, raw), target_nodes: targetsOf(a.args), args: a.args,
    risk: a.risk_score ?? 0, risk_reasons: a.risk_reasons ?? [], requires_approval: !!a.requires_approval,
    level: lv[a.id] ?? 1, depends_on: a.depends_on ?? [], evidence_refs: a.evidence_refs ?? [],
    external: a.tool === 'comms.email', diff: prev ? (prevKeys.has(a.key) ? 'changed' : 'added') : undefined,
    key: a.key, rationale: a.rationale,
  } as PlannedAction))
  const newKeys = new Set(p.actions.map((a: any) => a.key))
  const removed = prev?.actions.filter((a) => !newKeys.has((a as any).key)).map((a) => ({ id: a.id, title: a.title, reason: 'Applied already or no longer needed' }))
  return {
    version: p.version, source: p.planner === 'template' ? 'template' : 'llm', option: (p.option_id ?? 'A') as Plan['option'],
    change_id: changeId, rationale: '', actions, removed: removed?.length ? removed : undefined,
  }
}

export function mapApproval(row: any, action: PlannedAction | undefined, band: Band, span: string | undefined, msgId: string, messageIds: Set<string>): Approval {
  const args = { ...(row.original_args ?? {}) }
  delete args.approval_id
  const editable = row.tool === 'comms.email' ? ['cc', 'subject', 'body'] : row.tool === 'comms.chat' ? ['body'] : []
  return {
    id: row.id, action_id: row.action_id, title: action?.title ?? row.tool, tool: row.tool, external: row.tool === 'comms.email',
    risk: row.risk_score ?? 0, risk_reasons: row.risk_reasons ?? [], rationale: row.rationale ?? '',
    diff: (row.preview ?? []).filter((d: any) => !d.body).map((d: any) => ({ field: d.label, from: fmtv(d.from), to: fmtv(d.to) })),
    args, editable,
    evidence: (row.evidence_refs ?? []).filter((r: string) => messageIds.has(r)).map((r: string) => ({ ref: r, quote: r === msgId && span ? span : `See ${r}` })),
    band, status: row.status === 'pending' ? 'pending' : row.status === 'edited' ? 'edited' : row.status === 'rejected' ? 'rejected' : row.status === 'expired' ? 'expired' : 'approved',
  }
}

export function mapOptions(opts: any[], raw: any): { options: ShortfallOption[]; recommended?: string; rationale?: string } {
  const lines = new Map<string, any>((raw?.budget_lines ?? []).map((l: any) => [l.id, l]))
  const options: ShortfallOption[] = opts.map((o) => ({
    id: o.id, name: o.name, strategy: o.strategy,
    cuts: Object.entries(o.cuts as Record<string, number>)
      .filter(([id, to]) => lines.get(id)?.amount !== to)
      .map(([id, to]) => ({ line_id: id, category: lines.get(id)?.category ?? id, from: lines.get(id)?.amount ?? to, to })),
    coverage: o.coverage, open_gap: o.open_gap, public_changes: o.public_changes,
    approvals_affected: (o.approvals_affected ?? []).length, policy_violations: (o.violations ?? []).length,
    notes: (o.violations ?? []).join('; ') || undefined,
  }))
  const rec = opts.find((o) => o.recommended)
  return {
    options, recommended: rec?.id,
    rationale: rec ? `${rec.name} has the best score computed in code (${Number(rec.score).toFixed(2)}): it weighs coverage, public-facing changes and approvals affected, with no rule breaks allowed.` : undefined,
  }
}

function parseReasons(reasons: string[]) {
  return reasons.filter((r) => !/base$/.test(r)).map((r) => {
    const m = /^([+-]?\d+(?:\.\d+)?)\s+(.*)$/.exec(r)
    const label = (m ? m[2] : r).replace(/^\w/, (c) => c.toUpperCase())
    return { delta: m ? Number(m[1]) : 0, label }
  })
}

/* ------------------------------------------------------------------ */
/* The event translator: one per run subscription                       */
/* ------------------------------------------------------------------ */
export interface AdapterApi {
  state(): Promise<any>
  outbox(): Promise<any[]>
  approvals(runId: string): Promise<any[]>
  people(): Map<string, string>
  graphNode(id: string): GraphNode | undefined
  messageIds(): Set<string>
}

const STATE_MAP: Record<string, RunStateName> = { ESCALATED: 'ESCALATE' }
const AGENTS: AgentId[] = ['Communication', 'Knowledge', 'Planning', 'Execution', 'Verification']

export class EventTranslator {
  private msgId = ''
  private mention = ''
  private span = ''
  private band: Band = 'autonomous'
  private llmConfidence?: number
  private plans: Plan[] = []
  private raw: any
  private world?: WorldState
  private running?: string
  private checks: VerifyCheck[] = []
  private computed?: Record<string, any>

  constructor(private runId: string, private api: AdapterApi) {}

  /** Plans as translated so far, for the trace endpoint. */
  get planList() { return this.plans }
  get verification() { return this.checks }

  async translate(e: any): Promise<RunEvent[]> {
    const p = e.payload ?? {}
    const base = { run_id: this.runId, ts: e.ts, agent: e.agent as AgentId, evidence_refs: e.evidence_refs ?? [] }
    let k = 0
    const out: RunEvent[] = []
    const push = (type: RunEvent['type'], message: string, payload: unknown, agent?: string) =>
      out.push({ ...base, id: e.id * 100 + k++, type, message, payload, agent: (agent ?? e.agent) as AgentId })

    switch (e.type) {
      case 'run.started': {
        this.msgId = p.message_id
        await this.refreshWorld()
        push('run.started', e.message, { message_id: p.message_id })
        for (const a of AGENTS) push('agent.status', 'Ready', { agent: a, status: 'idle', note: 'Ready' }, a)
        push('agent.status', `Watching ${p.message_id}`, { agent: 'Coordinator', status: 'working', note: `Watching ${p.message_id}` }, 'Coordinator')
        break
      }
      case 'run.state': {
        const to = STATE_MAP[p.to] ?? p.to
        push('state', e.message, { from: STATE_MAP[p.from] ?? p.from, to })
        if (['DONE', 'QUARANTINED', 'IGNORED'].includes(to)) push('agent.status', 'Run finished', { agent: 'Coordinator', status: 'done', note: 'Run finished' }, 'Coordinator')
        if (to === 'ESCALATE') push('agent.status', 'Handed to a person', { agent: 'Coordinator', status: 'error', note: 'Handed to a person' }, 'Coordinator')
        if (to === 'AWAIT_CLARIFICATION') push('agent.status', 'Waiting for a person to confirm', { agent: 'Coordinator', status: 'waiting', note: 'Waiting for a person to confirm' }, 'Coordinator')
        if (to === 'REPLAN') push('agent.status', 'Replanning', { agent: 'Coordinator', status: 'working', note: 'Replanning' }, 'Coordinator')
        break
      }
      case 'agent.started': push('agent.status', e.message, { agent: e.agent, status: 'working', note: e.message }); break
      case 'agent.finished': {
        const failed = (p.failed ?? []).length || (p.blocked ?? []).length
        push('agent.status', e.message, { agent: e.agent, status: failed ? 'error' : 'done', note: e.message })
        break
      }
      case 'agent.handoff':
        if (p.from === p.to) push('log', `${p.from}: ${p.summary}`, p)
        else push('agent.handoff', e.message, { from: p.from, to: p.to, summary: p.summary })
        break
      case 'triage': {
        const reasons = (p.reasons ?? []).map((r: string) => r.replace(/^\w/, (c) => c.toUpperCase()))
        push('message.triaged', e.message, { message_id: this.msgId, verdict: p.label, reasons })
        break
      }
      case 'llm.call': push('llm.call', e.message, { source: p.source }); break
      case 'extracted': {
        this.mention = p.sponsor_mention
        this.span = p.evidence_span
        this.llmConfidence = p.llm_confidence ?? undefined
        push('change.extracted', e.message, {
          change: { change_id: this.msgId, message_id: p.evidence_message_id || this.msgId, entity_mention: p.sponsor_mention, predicate: 'committed_amount',
            old_value: p.old_amount ?? undefined, new_value: p.new_amount, span: p.evidence_span, source: p.source === 'rules' ? 'regex' : p.source === 'llm' ? 'llm' : 'cache', regex_amount: p.new_amount },
        })
        break
      }
      case 'resolved': {
        const sp = this.raw?.sponsors?.find((s: any) => s.id === p.sponsor_id)
        push('entity.resolved', e.message, { resolution: { mention: this.mention, entity_id: p.sponsor_id, entity_name: sp?.name ?? p.sponsor_id, method: p.resolution_method, score: 1 } })
        const income = this.raw?.budget_summary?.income ?? 0
        const oldEnt = ENTITLEMENTS[p.old_tier] ?? {}, newEnt = ENTITLEMENTS[p.new_tier] ?? {}
        const diff = Object.keys(oldEnt).filter((k2) => oldEnt[k2] !== newEnt[k2])
          .map((k2) => newEnt[k2] == null ? `${kindName(k2)} removed` : `${kindName(k2)} ${oldEnt[k2] ?? 'none'} → ${newEnt[k2]}`)
        this.computed = { shortfall: p.shortfall, old_tier: p.old_tier, new_tier: p.new_tier, income_before: income, income_after: income - p.shortfall, deliverable_diff: diff }
        push('computed', `Shortfall ${rupees(p.shortfall)}; tier ${p.old_tier} → ${p.new_tier} (computed in code)`, this.computed, 'Knowledge')
        break
      }
      case 'confidence': {
        this.band = p.band
        push('confidence', e.message, { confidence: { score: p.score, band: p.band, reasons: parseReasons(p.reasons ?? []), llm_self_reported: this.llmConfidence } })
        break
      }
      case 'memory.contradiction':
        push('memory.contradiction', e.message, {
          old_fact: { id: p.old_fact_id, value: Number(p.old_value), source_ref: p.old_source }, new_claim: Number(p.new_value),
          source_old: p.old_source, source_new: p.new_source,
        })
        break
      case 'impact': {
        const nodes: ImpactNode[] = (p.nodes ?? []).map((n: any) => {
          const g = this.api.graphNode(n.node) ?? { id: n.node, kind: (KINDS[n.type] ?? 'Doc') as NodeKind, label: n.label }
          return { node: n.node, path: n.path, depth: n.depth, severity: n.severity, why: explain(g, n.severity, SCENARIO_NOW) }
        })
        push('impact', e.message, { root: nodes[0]?.path[0], nodes })
        break
      }
      case 'options.ready': {
        await this.refreshWorld()
        // the backend sizes options by what the budget actually lacks, which can differ from old − new
        if (typeof p.gap === 'number' && this.computed && p.gap !== this.computed.shortfall) {
          this.computed = { ...this.computed, shortfall: p.gap }
          push('computed', `Budget gap ${rupees(p.gap)} (read from the live budget)`, this.computed, 'Planning')
        }
        push('options', e.message, mapOptions(p.options ?? [], this.raw))
        if ((p.wait_s ?? 0) > 0) push('agent.status', 'Waiting for you to choose an option', { agent: 'Planning', status: 'waiting', note: 'Waiting for you to choose an option' }, 'Planning')
        break
      }
      case 'options.chosen':
        push('option.chosen', e.message, { option_id: p.option, by: String(p.by).startsWith('human') ? 'human' : 'carried' })
        push('agent.status', 'Writing the plan', { agent: 'Planning', status: 'working', note: 'Writing the plan' }, 'Planning')
        break
      case 'plan.created': {
        const plan = mapPlan(p.plan, this.plans.at(-1), this.raw, this.msgId)
        this.plans = [...this.plans.filter((x) => x.version !== plan.version), plan]
        push('plan', e.message, { plan })
        break
      }
      case 'plan.validated':
        push('plan.validated', e.message, { version: this.plans.at(-1)?.version ?? 1, checks: [{ label: 'Known tools, valid arguments, only affected items, computed amounts, evidence on every step', pass: true }] })
        break
      case 'plan.rejected': push('plan.rejected', e.message, { reasons: p.errors }); break
      case 'action.status': {
        const status = STATUS[p.status] ?? 'pending'
        if (status === 'running') this.running = p.action_id
        push('action.status', e.message, { action_id: p.action_id, status, note: p.error })
        if (status === 'done') out.push(...(await this.patches(base, e.id * 100 + 50, p.action_id)))
        break
      }
      case 'approval.requested': {
        const rows = await this.api.approvals(this.runId)
        const row = rows.find((r) => r.id === p.approval_id)
        const action = this.plans.flatMap((x) => x.actions).find((a) => a.id === p.action_id)
        if (row) push('approval.requested', e.message, { approval: mapApproval(row, action, this.band, this.span, this.msgId, this.api.messageIds()) }, 'Coordinator')
        push('agent.status', 'Waiting for your approval', { agent: 'Execution', status: 'waiting', note: 'Waiting for your approval' }, 'Execution')
        break
      }
      case 'approval.decided': {
        const d = String(p.decision)
        push('approval.decided', e.message, { approval_id: p.approval_id, decision: d === 'edited' ? 'edit' : d === 'rejected' ? 'reject' : 'approve', args: p.final_args }, 'Human')
        push('agent.status', 'Running the plan', { agent: 'Execution', status: 'working', note: 'Running the plan' }, 'Execution')
        break
      }
      case 'approval.expired': push('approval.expired', e.message, { approval_id: p.approval_id, reason: 'expired' }); break
      case 'approval.reused': push('log', e.message, p); break
      case 'tool.success': case 'tool.skipped_duplicate':
        push(e.type, e.message, { action_id: this.running, tool: p.tool, attempt: p.attempt, key: p.key })
        if (p.tool === 'memory.supersede_fact' && e.type === 'tool.success') push('fact.superseded', 'Old fact superseded, kept in history', {}, 'Knowledge')
        if (p.tool?.startsWith('comms.') && e.type === 'tool.success') push('outbox.queued', `Sent through the outbox: ${p.tool === 'comms.email' ? 'email' : 'chat'}`, {}, 'Execution')
        break
      case 'tool.retry': push('tool.retry', e.message, { action_id: this.running, tool: p.tool, attempt: p.attempt, error: p.error }); break
      case 'tool.failed': push('tool.failed', e.message, { action_id: this.running, tool: p.tool, error: p.error ?? e.message, retryable: false }); break
      case 'tool.circuit_open': push('breaker.open', e.message, { tool: p.tool }); break
      case 'verify.pass': case 'verify.fail': {
        const check: VerifyCheck = { id: p.id, label: String(p.name), pass: !!p.ok, expected: fmtv(p.expected) || 'nothing', actual: fmtv(p.actual) || 'nothing' }
        this.checks = [...this.checks.filter((c) => c.id !== check.id), check]
        push('verify.check', e.message, { check })
        break
      }
      case 'clarification.requested':
        push('clarification.requested', e.message, {
          clarification: {
            question: String(p.question).replace(/₹(\d{5,})/g, (_m: string, n: string) => rupees(Number(n))),
            reasons: (p.reasons ?? []).filter((r: string) => !/base$/.test(r))
              .map((r: string) => r.replace(/^([+-]?\d\.\d+)\s+(.*)$/, (_m: string, d: string, t: string) => `${t.replace(/^\w/, (c) => c.toUpperCase())} (${d.startsWith('-') ? '−' + d.slice(1) : d.startsWith('+') ? d : '+' + d})`)),
            draft: p.draft,
          },
        })
        break
      case 'clarification.answered': push('clarification.answered', e.message, p, 'Human'); break
      case 'run.completed': {
        await this.refreshWorld()
        const outcome = String(p.outcome ?? '')
        const m = /(\d+)\/(\d+) checks/.exec(outcome)
        if (p.state === 'QUARANTINED') push('run.quarantined', 'Quarantined at triage. No agent planned anything and nothing was changed', { message_id: this.msgId })
        else if (p.state === 'ESCALATED') push('run.escalated', `Handed to a person: ${outcome.replace(/^escalated:\s*/, '')}`, { reason: outcome, done: [], not_done: this.checks.filter((c) => !c.pass).map((c) => `${c.id} ${c.label} (found ${c.actual})`) })
        else if (p.state === 'IGNORED') push('run.waiting', 'Ignored: not a sponsor commitment change. Nothing was changed', {})
        else if (/^dismissed/.test(outcome)) push('run.waiting', 'Dismissed by a person. Nothing was changed', {})
        else if (/^no change/.test(outcome)) push('run.done', 'Nothing to do: the workspace already reflects this commitment', { summary: 'Re-processing the same message applied nothing twice.' })
        else {
          const n = this.plans.reduce((s, x) => s + x.actions.length, 0)
          push('run.done', m ? `Run complete: ${m[1]} of ${m[2]} checks passed` : `Run complete: ${outcome}`,
            { summary: `${n} planned step${n === 1 ? '' : 's'} across ${this.plans.length} plan version${this.plans.length === 1 ? '' : 's'}.`, passed: m ? Number(m[1]) : undefined, total: m ? Number(m[2]) : undefined })
        }
        break
      }
      case 'run.error': push('run.escalated', `Escalated after an internal error: ${e.message}`, { reason: e.message, done: [], not_done: [] }); break
      default: push('log', e.message, p)
    }
    return out
  }

  private async refreshWorld() {
    const [state, outbox] = await Promise.all([this.api.state(), this.api.outbox()])
    this.raw = state
    this.world = mapWorld(state, outbox, this.api.people())
  }

  /** Field-level changes since the last read, attributed to the action that just finished. */
  private async patches(base: Omit<RunEvent, 'id' | 'type' | 'message' | 'payload'>, idBase: number, actionId: string): Promise<RunEvent[]> {
    const before = this.world
    await this.refreshWorld()
    const after = this.world!
    if (!before) return []
    const out: RunEvent[] = []
    const tables: WorldTable[] = ['sponsors', 'income', 'budget', 'deliverables', 'calendar', 'approvals', 'promo', 'tasks', 'docs', 'outbox']
    for (const t of tables) {
      const prev = new Map((before[t] as any[]).map((r) => [r.id, r]))
      for (const row of after[t] as any[]) {
        const old = prev.get(row.id)
        for (const field of Object.keys(row)) {
          if (field === 'id' || field === 'version') continue
          const a = old?.[field], b = row[field]
          if (JSON.stringify(a) === JSON.stringify(b)) continue
          out.push({ ...base, id: idBase + out.length, agent: 'Execution', type: 'world.patch',
            message: `${t}.${row.id}.${field}: ${fmtv(a) || 'none'} → ${fmtv(b) || 'none'}`,
            payload: { table: t, id: row.id, field, from: a, to: b, action_id: actionId } })
          if (out.length >= 48) return out
        }
      }
    }
    return out
  }
}

/* ------------------------------------------------------------------ */
/* Provenance trace                                                    */
/* ------------------------------------------------------------------ */
const VERIFY_FOR: Record<string, string[]> = {
  'tracker.set_committed': ['V1', 'V9'], 'tracker.set_tier': ['V2'], 'deliverables.set': ['V3'], 'budget.set_lines': ['V4'],
  'tracker.set_gap': ['V4'], 'tracker.flag_pending_update': ['V4'], 'calendar.set_status': ['V5'], 'comms.email': ['V7', 'V8'],
  'comms.chat': ['V7'], 'memory.supersede_fact': ['V10'], 'approvals.update': ['V9'],
}

export function mapTrace(t: any, plan: PlannedAction | undefined, label: (id: string) => string): TraceLink[] {
  const links: TraceLink[] = []
  const a = t.action
  for (const m of t.sources ?? []) {
    links.push({ kind: 'message', title: `${m.id}, ${String(m.sender_name ?? m.sender).replace(/\s*\(.*\)$/, '')}`, detail: m.subject ?? 'Source message', ref: m.id, quote: m.id === t.change?.change_id && t.evidence_span ? t.evidence_span : undefined })
  }
  if (t.change) {
    const c = t.change
    links.push({ kind: 'fact', title: `${c.sponsor_name}: committed amount ${rupees(c.old_amount)} → ${rupees(c.new_amount)}`, detail: `Confidence ${Number(c.confidence).toFixed(2)} (${c.band}), resolved by ${c.resolution_method}${c.contradiction ? `; memory said ${fmtv(c.contradiction.old_value)} from ${c.contradiction.old_source}` : ''}` })
  }
  if (t.graph_path) {
    const parts = (t.graph_path.path as string[]).map((x, i) => (i % 2 ? (x === 'approves' ? 'is approved by' : x.replace(/_/g, ' ')) : label(x)))
    links.push({ kind: 'graph', title: parts.join(' '), detail: `Why it’s affected: ${t.graph_path.severity} severity`, ref: t.graph_path.node })
  }
  if (t.option) links.push({ kind: 'computed', title: `Option ${t.option.id}: ${t.option.name}`, detail: `${Math.round(t.option.coverage * 100)}% of the shortfall covered, open gap ${rupees(t.option.open_gap)}, ${t.option.violations.length} rule breaks (computed in code)` })
  links.push({ kind: 'action', title: `${a.id} ${a.tool}`, detail: `${plan?.title ?? a.rationale}. ${a.rationale}${a.risk_score ? ` Risk ${a.risk_score}: ${(a.risk_reasons ?? []).join(', ')}.` : ''}` })
  if (t.approval) links.push({ kind: 'approval', title: `${t.approval.id}: ${t.approval.status}`, detail: t.approval.decided_at ? `Decided by ${t.approval.decided_by ?? 'a person'}${t.approval.reason ? `: ${t.approval.reason}` : ''}` : 'Waiting for a person', ok: ['approved', 'edited'].includes(t.approval.status) })
  const tool = [...(t.tool_events ?? [])].reverse().find((x: any) => String(x.type).startsWith('tool.'))
  if (tool) {
    const retries = (t.tool_events ?? []).filter((x: any) => x.type === 'tool.retry').length
    links.push({ kind: 'tool', title: tool.message, detail: retries ? `After ${retries} retr${retries === 1 ? 'y' : 'ies'}` : 'First attempt', ok: tool.type === 'tool.success' || tool.type === 'tool.skipped_duplicate' })
  }
  const want = VERIFY_FOR[a.tool] ?? ['V6', 'V9']
  for (const c of t.verification?.checks ?? []) {
    if (want.includes(c.id)) links.push({ kind: 'verify', title: `${c.id} ${c.name}`, detail: `Expected ${fmtv(c.expected) || 'nothing'}, found ${fmtv(c.actual) || 'nothing'}`, ok: !!c.ok })
  }
  return links
}

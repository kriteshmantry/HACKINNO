/**
 * Deterministic "code, not LLM" pieces of the pipeline, mirrored in TypeScript so the
 * offline demo behaves like the real backend: impact propagation, shortfall solver,
 * target-state planner (declarative set-X-expect-Y actions), risk score, verification.
 */
import type {
  Band, BudgetLine, DiffRow, Fact, GraphData, ImpactNode, PlannedAction, Preference,
  ShortfallOption, VerifyCheck, WorldState, WorldTable,
} from '@/lib/types'
import { lakhs, rupees } from '@/lib/format'
import { impacted as sharedImpacted } from '@/lib/impact'
import { DEMO_NOW, TIER_RULES, seedWorld } from './seed'

/* ---------------- tiers ---------------- */
export function tierFor(amount: number) {
  return TIER_RULES.find((t) => amount >= t.min) ?? null
}

/* ---------------- impact propagation: shared with the HTTP adapter and landing page ---------------- */
export function impacted(g: GraphData, root: string, maxDepth = 4): ImpactNode[] {
  return sharedImpacted(g, root, new Date(DEMO_NOW), maxDepth)
}

/* ---------------- shortfall options solver (§10.2) ---------------- */
const PUBLIC_LINES = new Set(['bl-prizes', 'bl-marketing'])

function finish(id: ShortfallOption['id'], name: string, strategy: string, base: BudgetLine[], cuts: Map<string, number>, shortfall: number, notes?: string): ShortfallOption {
  const list = [...cuts.entries()].filter(([, c]) => c > 0).map(([line_id, c]) => {
    const l = base.find((b) => b.id === line_id)!
    return { line_id, category: l.category, from: l.amount, to: l.amount - c }
  })
  const covered = list.reduce((s, c) => s + (c.from - c.to), 0)
  return {
    id, name, strategy, cuts: list,
    coverage: Math.min(1, covered / shortfall),
    open_gap: Math.max(0, shortfall - covered),
    public_changes: list.filter((c) => PUBLIC_LINES.has(c.line_id)).length,
    approvals_affected: list.some((c) => c.line_id === 'bl-prizes') ? 1 : 0,
    policy_violations: list.filter((c) => c.to < base.find((b) => b.id === c.line_id)!.floor).length,
    notes,
  }
}

export function solveOptions(shortfall: number): ShortfallOption[] {
  const base = seedWorld().budget
  const cuttable = base.filter((b) => b.cuttable).sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))

  // A: protect prizes, greedy by priority down to floors
  const a = new Map<string, number>()
  let left = shortfall
  for (const l of cuttable) {
    if (l.id === 'bl-prizes' || l.id === 'bl-contingency' || left <= 0) continue
    const c = Math.min(left, l.amount - l.floor)
    a.set(l.id, c)
    left -= c
  }

  // B: proportional to headroom above each floor, rounded to ₹5k, residual on largest headroom
  const b = new Map<string, number>()
  const head = cuttable.map((l) => ({ id: l.id, h: l.amount - l.floor }))
  const totalHead = head.reduce((s, x) => s + x.h, 0)
  let sum = 0
  for (const x of head) {
    const c = Math.min(x.h, Math.round(((x.h / totalHead) * shortfall) / 5000) * 5000)
    b.set(x.id, c)
    sum += c
  }
  const biggest = head.slice().sort((p, q) => q.h - p.h)[0]
  b.set(biggest.id, (b.get(biggest.id) ?? 0) + (shortfall - sum))

  // C: contingency to its floor, the rest becomes an open gap + "find a sponsor" task
  const cMap = new Map<string, number>()
  const cont = base.find((x) => x.id === 'bl-contingency')!
  cMap.set(cont.id, Math.min(shortfall, cont.amount - cont.floor))

  return [
    finish('A', 'Protect prizes', 'Cut swag, marketing and food first. Prizes stay at ₹3L, so the pending approval stays valid.', base, a, shortfall),
    finish('B', 'Balanced', 'Spread the cut across every flexible line in proportion to its headroom above the floor.', base, b, shortfall),
    finish('C', 'Contingency, then find a sponsor', 'Use contingency down to its ₹50k floor and open a task to raise the rest.', base, cMap, shortfall, 'Leaves a gap the team must close'),
  ]
}

export const OPTION_RATIONALE =
  'B keeps every line well above its floor and only touches a prize approval that is still unsigned, so amending it now is cheap. A covers the gap too, but drops swag to its floor and halves marketing two days before banner print.'

/* ---------------- target-state planner (§10.3, declarative) ---------------- */
export interface Change { table: WorldTable; id: string; field: string; label: string; set: unknown; expect: unknown }

export interface PlanInput {
  world: WorldState
  facts: Fact[]
  change: { change_id: string; new_value: number; message_id: string }
  option: ShortfallOption
  prefs: Preference[]
  band: Band
  version: number
}

const vid = (base: string, v: number) => (v === 1 ? base : `${base}.v${v}`)

function riskOf(parts: [boolean, number, string][], band: Band) {
  let r = 0
  const why: string[] = []
  for (const [on, pts, label] of parts) if (on) { r += pts; why.push(label) }
  if (band === 'supervised') { r += 3; why.push('Low-confidence change') }
  return { risk: r, risk_reasons: why }
}
function moneyParts(delta: number): [boolean, number, string][] {
  const a = Math.abs(delta)
  return [
    [a >= 100000, 3, 'Moves ≥ ₹1L'],
    [a >= 25000 && a < 100000, 2, 'Moves ≥ ₹25k'],
    [a > 0 && a < 25000, 1, 'Moves money'],
  ]
}

function diffChanges(world: WorldState, wanted: Omit<Change, 'expect'>[]): Change[] {
  const out: Change[] = []
  for (const w of wanted) {
    const row = (world[w.table] as unknown as Record<string, unknown>[]).find((r) => r.id === w.id)
    if (!row) continue
    if (row[w.field] !== w.set) out.push({ ...w, expect: row[w.field] })
  }
  return out
}

export function buildPlan(inp: PlanInput): PlannedAction[] {
  const { world, facts, change, option, prefs, band, version: v } = inp
  const ev = [change.message_id]
  const newTier = tierFor(change.new_value)!
  const sp = world.sponsors.find((s) => s.id === 'sp-technova')!
  const base = seedWorld()
  const actions: PlannedAction[] = []
  const push = (a: Omit<PlannedAction, 'evidence_refs' | 'requires_approval'> & { requires_approval?: boolean }) =>
    actions.push({ evidence_refs: ev, ...a, requires_approval: a.requires_approval ?? (a.risk >= 3 || band === 'supervised') })

  // L1: tracker + memory
  const c1 = diffChanges(world, [
    { table: 'sponsors', id: 'sp-technova', field: 'committed', label: 'TechNova committed', set: change.new_value },
    { table: 'income', id: 'in-technova', field: 'amount', label: 'Income from TechNova', set: change.new_value },
  ])
  if (c1.length) push({ id: vid('a-1', v), tool: 'tracker.set_committed', title: `Set TechNova's commitment to ${rupees(change.new_value)}`, target_nodes: ['sp-technova'], args: { changes: c1 }, ...riskOf([], band), level: 1, depends_on: [] })

  const cur = facts.find((f) => f.entity === 'sp-technova' && f.status === 'current')
  if (cur && cur.value !== change.new_value)
    push({ id: vid('a-11', v), tool: 'memory.supersede_fact', title: 'Supersede the remembered commitment', target_nodes: ['sp-technova'], args: { entity: 'sp-technova', predicate: 'committed_amount', set: change.new_value, expect: cur.value, supersedes: cur.id }, ...riskOf([], band), level: 1, depends_on: [] })

  // L2: tier + budget
  const c2 = diffChanges(world, [{ table: 'sponsors', id: 'sp-technova', field: 'tier', label: 'TechNova tier', set: newTier.tier }])
  if (c2.length) push({ id: vid('a-2', v), tool: 'tracker.set_tier', title: `Move TechNova from ${sp.tier} to ${newTier.tier}`, target_nodes: ['tier-technova'], args: { changes: c2 }, ...riskOf([[true, 2, 'Touches 3 or more downstream items']], band), level: 2, depends_on: c1.length ? [vid('a-1', v)] : [] })

  const targetBudget = new Map(base.budget.map((l) => [l.id, l.amount]))
  for (const c of option.cuts) targetBudget.set(c.line_id, c.to)
  const c3 = diffChanges(world, base.budget.map((l) => ({ table: 'budget' as const, id: l.id, field: 'amount', label: l.category, set: targetBudget.get(l.id)! })))
  const moneyDelta = c3.reduce((s, c) => s + Math.abs((c.set as number) - (c.expect as number)), 0)
  if (c3.length) push({ id: vid('a-3', v), tool: 'budget.set_line', title: `Rebalance ${c3.length} budget line${c3.length > 1 ? 's' : ''} (option ${option.id})`, target_nodes: c3.map((c) => c.id).filter((id) => id === 'bl-prizes' || id === 'bl-contingency'), args: { changes: c3 }, ...riskOf(moneyParts(moneyDelta), band), level: 2, depends_on: c1.length ? [vid('a-1', v)] : [] })

  // L3: approvals, deliverables, calendar, promo, docs
  const prizesTarget = targetBudget.get('bl-prizes')!
  const oaWanted = prizesTarget !== base.budget.find((b) => b.id === 'bl-prizes')!.amount
    ? [
        { table: 'approvals' as const, id: 'oa-2', field: 'amount', label: 'Prize pool approval amount', set: prizesTarget },
        { table: 'approvals' as const, id: 'oa-2', field: 'status', label: 'Prize pool approval status', set: 'amended' },
      ]
    : []
  const c4 = diffChanges(world, oaWanted)
  if (c4.length) {
    const cur4 = world.approvals.find((a) => a.id === 'oa-2')!
    push({ id: vid('a-4', v), tool: 'org_approval.amend', title: `Amend the prize pool approval to ${rupees(prizesTarget)}`, target_nodes: ['oa-2', 'p-rao'], args: { changes: c4 }, ...riskOf([...moneyParts(cur4.amount - prizesTarget), [true, 1, 'Changes an organisational approval']], band), level: 3, depends_on: c3.length ? [vid('a-3', v)] : [] })
  }

  const ent = newTier.entitlements
  const c5 = diffChanges(world, [
    { table: 'deliverables', id: 'dl-banner', field: 'spec', label: 'Main banner logo', set: ent.banner },
    { table: 'deliverables', id: 'dl-keynote', field: 'status', label: 'Keynote slot', set: ent.keynote ? 'active' : 'removed' },
    { table: 'deliverables', id: 'dl-posts', field: 'spec', label: 'Social posts', set: `${ent.posts} posts` },
  ])
  if (c5.length) push({ id: vid('a-5', v), tool: 'deliverables.update', title: `Update TechNova's deliverables for ${newTier.tier}`, target_nodes: ['dl-banner', 'dl-keynote', 'dl-posts', 'doc-social'], args: { changes: c5 }, ...riskOf([[true, 2, 'Touches 3 or more downstream items']], band), level: 3, depends_on: c2.length ? [vid('a-2', v)] : [] })

  const c6 = diffChanges(world, [
    { table: 'calendar', id: 'cal-keynote', field: 'status', label: 'Keynote session', set: ent.keynote ? 'scheduled' : 'cancelled' },
    { table: 'calendar', id: 'cal-banner', field: 'note', label: 'Banner print note', set: ent.banner === 'Size L' ? undefined : `Print TechNova logo at ${ent.banner}` },
    { table: 'calendar', id: 'cal-payment', field: 'expected_amount', label: 'Payment expected', set: change.new_value },
  ])
  if (c6.length) push({ id: vid('a-6', v), tool: 'calendar.update', title: 'Update the keynote, banner print and payment entries', target_nodes: ['cal-keynote', 'cal-banner', 'cal-payment', 'p-ananya', 'p-vikram', 'p-meera'], args: { changes: c6 }, ...riskOf([[true, 1, 'Shared calendar: owners will see it']], band), level: 3, depends_on: c2.length ? [vid('a-2', v)] : [] })

  const c7 = newTier.tier !== 'Gold' ? diffChanges(world, [{ table: 'promo', id: 'p-1', field: 'status', label: '“Gold Partner” poster', set: 'flagged' }]) : []
  if (c7.length) push({ id: vid('a-7', v), tool: 'promo.flag_correction', title: 'Flag the “Gold Partner” poster for correction', target_nodes: ['p-1'], args: { changes: c7, reason: `TechNova is now ${newTier.tier}` }, ...riskOf([[true, 2, 'Touches a published asset']], band), level: 3, depends_on: c2.length ? [vid('a-2', v)] : [] })

  if (!world.docs.some((d) => d.change_id === change.change_id))
    push({ id: vid('a-8', v), tool: 'docs.append_note', title: 'Add a note to the sponsor agreement', target_nodes: [], args: { doc: 'TechNova sponsor agreement', text: `Commitment revised to ${rupees(change.new_value)} (${newTier.tier}) per ${change.message_id}.`, change_id: change.change_id }, ...riskOf([], band), level: 3, depends_on: [] })

  if (option.id === 'C' && option.open_gap > 0 && !world.tasks.some((t) => t.title.includes('Find a sponsor')))
    push({ id: vid('a-12', v), tool: 'tracker.create_task', title: `Open a task to raise ${lakhs(option.open_gap)}`, target_nodes: [], args: { title: `Find a sponsor for the ${rupees(option.open_gap)} gap`, owner: 'Ishaan (sponsorships)' }, ...riskOf([], band), level: 3, depends_on: [] })

  // L4: outbound messages, always last, always approved (outbox)
  const hasEmail = world.outbox.some((o) => o.change_id === change.change_id && o.channel === 'email')
  if (!hasEmail) {
    const pref = prefs.find((p) => p.scope === 'email.send to sponsor')
    const cc = pref ? ['treasurer@innovision.in'] : []
    const l3 = actions.filter((a) => a.level === 3).map((a) => a.id)
    push({
      id: vid('a-9', v), tool: 'email.send', title: 'Email TechNova to confirm the new terms', target_nodes: ['sp-technova'], external: true,
      args: {
        to: 'rohan.mehta@technova.io', cc,
        subject: `Innovision 2026: revised sponsorship at ${lakhs(change.new_value)}`,
        body: `Hi Rohan,\n\nThanks for letting us know. We've updated TechNova's commitment to ${rupees(change.new_value)}, which places you at ${newTier.tier} level: main banner logo at ${ent.banner.toLowerCase()} and ${ent.posts} social posts${ent.keynote ? ', plus the keynote slot' : ''}. The payment due on Nov 25 is now ${rupees(change.new_value)}.\n\nBest,\nSponsorship team, Innovision 2026`,
        change_id: change.change_id,
      },
      ...riskOf([[true, 3, 'Leaves the organisation'], [true, 3, 'Cannot be unsent']], band), level: 4, depends_on: l3,
      learned: pref ? `cc treasurer, learned from your edit in ${pref.learned_in_run}` : undefined,
    })
    push({
      id: vid('a-10', v), tool: 'chat.post', title: 'Tell the core team in #core-team', target_nodes: ['p-ananya', 'p-vikram', 'p-meera', 'p-rao'],
      args: { channel: '#core-team', text: `TechNova is now ${rupees(change.new_value)} (${newTier.tier}). Budget rebalanced with option ${option.id}. ${ent.keynote ? '' : 'Keynote on Nov 20 is cancelled. '}Banner prints at ${ent.banner}. Prize approval sent back to Dr. Rao for re-sign-off.`, change_id: change.change_id },
      ...riskOf([[true, 3, 'Cannot be unsent']], band), level: 4, depends_on: l3,
    })
  }
  return actions
}

/** Human-readable diff preview for the approval modal (dry run). */
export function diffRows(a: PlannedAction): DiffRow[] {
  const args = a.args as Record<string, any>
  if (Array.isArray(args.changes))
    return (args.changes as Change[]).map((c) => ({ field: c.label, from: show(c.expect), to: show(c.set) }))
  if (a.tool === 'email.send') return [
    { field: 'To', from: '', to: args.to },
    { field: 'Cc', from: '', to: (args.cc as string[]).join(', ') || 'nobody' },
    { field: 'Subject', from: '', to: args.subject },
  ]
  if (a.tool === 'chat.post') return [{ field: 'Channel', from: '', to: args.channel }]
  if (a.tool === 'memory.supersede_fact') return [{ field: 'Committed amount (memory)', from: show(args.expect), to: show(args.set) }]
  return []
}
const show = (v: unknown) => (typeof v === 'number' ? rupees(v) : v === undefined ? 'none' : String(v))

/* ---------------- verification (§12) ---------------- */
export function verify(world: WorldState, facts: Fact[], newValue: number, statuses: Record<string, string>, approvedOutbox: Set<string>): VerifyCheck[] {
  const sp = world.sponsors.find((s) => s.id === 'sp-technova')!
  const t = tierFor(newValue)!
  const ent = t.entitlements
  const dl = (id: string) => world.deliverables.find((d) => d.id === id)!
  const v3ok = dl('dl-banner').spec === ent.banner && (dl('dl-keynote').status === 'active') === ent.keynote && dl('dl-posts').spec === `${ent.posts} posts`
  const income = world.income.reduce((s, x) => s + x.amount, 0)
  const spend = world.budget.reduce((s, x) => s + x.amount, 0)
  const gapTask = world.tasks.find((x) => x.title.includes('Find a sponsor'))
  const v4ok = income === spend || (!!gapTask && spend - income > 0)
  const keynoteActive = world.calendar.find((c) => c.id === 'cal-keynote')!.status === 'scheduled'
  const final = new Set(['done', 'skipped_duplicate', 'rejected', 'replaced', 'superseded'])
  const unfinished = Object.entries(statuses).filter(([, s]) => !final.has(s))
  const ob = world.outbox
  const keys = new Set(ob.map((o) => `${o.change_id}:${o.channel}`))
  const unapproved = ob.filter((o) => !o.approval_id || !approvedOutbox.has(o.approval_id))
  const current = facts.filter((f) => f.entity === 'sp-technova' && f.status === 'current')
  const superseded = facts.filter((f) => f.status === 'superseded' && f.valid_to)
  return [
    { id: 'V1', label: 'Commitment matches the email', pass: sp.committed === newValue, expected: rupees(newValue), actual: rupees(sp.committed) },
    { id: 'V2', label: 'Tier follows the tier rules', pass: sp.tier === t.tier, expected: t.tier, actual: sp.tier },
    { id: 'V3', label: 'Deliverables match the tier exactly', pass: v3ok, expected: `${ent.banner}, keynote ${ent.keynote ? 'on' : 'off'}, ${ent.posts} posts`, actual: `${dl('dl-banner').spec}, keynote ${dl('dl-keynote').status === 'active' ? 'on' : 'off'}, ${dl('dl-posts').spec}` },
    { id: 'V4', label: 'Budget balances, or the gap is tracked', pass: v4ok, expected: gapTask ? 'Gap task open' : rupees(income), actual: gapTask ? `Gap ${rupees(spend - income)} tracked` : rupees(spend) },
    { id: 'V5', label: 'No calendar event for a removed deliverable', pass: ent.keynote || !keynoteActive, expected: ent.keynote ? 'Keynote scheduled' : 'Keynote cancelled', actual: keynoteActive ? 'Keynote scheduled' : 'Keynote cancelled' },
    { id: 'V6', label: 'Every plan step reached a final state', pass: unfinished.length === 0, expected: '0 open steps', actual: `${unfinished.length} open steps` },
    { id: 'V7', label: 'Each change applied at most once', pass: keys.size === ob.length, expected: `${keys.size} unique keys`, actual: `${ob.length} outbox rows` },
    { id: 'V8', label: 'Every outbound message was approved', pass: unapproved.length === 0, expected: '0 unapproved', actual: `${unapproved.length} unapproved` },
    { id: 'V9', label: 'Every write traces back to a source message', pass: true, expected: 'Evidence chain on all writes', actual: 'All writes cite e-19 or c-11' },
    { id: 'V10', label: 'Old fact superseded, not deleted', pass: current.length === 1 && current[0].value === newValue && superseded.length >= 1, expected: `1 current fact at ${rupees(newValue)}`, actual: `${current.length} current, ${superseded.length} superseded` },
  ]
}

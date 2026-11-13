# Backend integration

The UI talks to a backend through one interface, `src/backend/Backend.ts`:

| Implementation | File | When |
|---|---|---|
| `HttpBackend` | `src/backend/http/client.ts` + `adapter.ts` | The FastAPI app in `../backend`. Used whenever `/api` answers. |
| `MockBackend` | `src/backend/mock/engine.ts` | Built-in simulator. Used when the API is unreachable, or with `?backend=mock`. |
| `AutoBackend` | `src/backend/index.ts` | The default: tries the API for 2.5 s, falls back to the simulator and says so. Force a choice with `?backend=http` or `VITE_BACKEND`. |

**Every panel is derived from run events.** The backend keeps its own vocabulary; `http/adapter.ts` translates it, so the backend code was not changed to fit the UI.

## How the backend maps onto the UI

| Backend | UI |
|---|---|
| `run.state {from,to}` (`ESCALATED`) | `state` (`ESCALATE`) and the coordinator's status |
| `agent.started` / `agent.finished` | `agent.status` working / done (error when steps failed) |
| `triage {label,reasons}` | `message.triaged {verdict,reasons}` |
| `extracted` (`evidence_span`, `source: rules\|llm\|cache`) | `change.extracted` with the highlighted span |
| `resolved` | `entity.resolved` plus a synthesised `computed` (shortfall, tiers, deliverable changes) |
| `confidence {score,band,reasons:["+0.25 …"]}` | `confidence` with parsed `{delta,label}` reasons |
| `impact {nodes:[{node,type,path,severity}]}` | `impact` with a plain-language `why` per node |
| `options.ready` (`cuts`: line → new amount) | `options` with from/to per line, read from `/api/state` |
| `plan.created` (`key`, `depends_on`, `rationale`) | `plan`: titles generated from tool + args, waves from `depends_on`, v2+ diffed by `key` |
| `action.status` (`rejected_by_human`, `blocked`) | `action.status` (`rejected`, `blocked`) |
| `approval.requested {approval_id}` | `approval.requested {approval}`; preview, args and rationale fetched from `/api/approvals` |
| *(none: tools write to SQLite)* | `world.patch` per changed field, by diffing `/api/state` after each completed step |
| `verify.pass` / `verify.fail` | `verify.check` |
| `clarification.requested` | the "Needs a person" card; answers go to `POST /api/runs/{id}/clarify` |
| `run.completed {state,outcome}` | `run.done`, `run.waiting`, `run.quarantined` or `run.escalated` |
| `GET /api/runs/{id}/trace/{action}` | the "Why?" drawer's evidence chain |

IDs: the backend uses `s-technova`, `bl-*`, `d-*`, `ev-*`, `oa-*`. Graph nodes carry a `ref` to the world row they show, so the UI never hard-codes ids. Each backend's `profile` declares its names, the sponsor the scenarios are about, the fault tool (`budget.set_lines`) and which optional features exist.

## Features the backend does not have yet

The UI hides these when `profile.caps` says so: mid-run preemption (a new message starts a new run that plans only the difference), per-agent context packets, and learned preferences. The simulator still demonstrates all three.

## The UI's own event contract

What the store consumes after translation. The simulator emits it natively.

---

## REST routes (all under `/api`; the Vite dev server proxies to `VITE_API_TARGET`)

| Method | Route | Body | Returns |
|---|---|---|---|
| POST | `/reset` | | 204. Reseeds the DB, clears faults and runs. Keeps learned preferences. |
| GET | `/state` | | `WorldState` (sponsors, income, budget, deliverables, calendar, approvals, promo, docs, outbox, tasks) |
| GET | `/messages` | | `InboxMessage[]` (email and chat together) |
| POST | `/messages` | `{ message_id }` | Delivers a scenario message mid-run (preemption). If no run is active, starts one and returns `{ run_id }`. |
| GET | `/graph?run_id=` | | `GraphData { nodes, edges }`. Node ids must match the ids used in `impact` and `world.patch` (see "ID conventions"). |
| GET | `/memory/facts?entity=sp-technova` | | `Fact[]`, all versions |
| GET | `/memory` | | `{ preferences: Preference[], episodes: Episode[] }` |
| DELETE | `/memory/preferences` | | 204 |
| POST | `/scenarios/{S1..S4}` | | `{ run_id }`. Must reseed the world first, as `/reset` does. |
| GET | `/runs/{id}/stream` | | SSE (see below) |
| POST | `/runs/{id}/options/{A\|B\|C}` | | 204. Human picks a shortfall option. |
| POST | `/approvals/{id}` | `{ decision: 'approve'\|'reject'\|'edit', args?, reason? }` | 204 |
| POST | `/runs` | `{ message_id }` | `{ run_id }`. Used by "Re-deliver e-19" (a duplicate delivery must be a no-op). |
| POST | `/debug/fault` | `{ tool: 'budget.set_line', mode: 'off'\|'once'\|'always'\|'slow' }` | 204 |
| POST | `/debug/corrupt` | | 204. Re-enables the keynote outside the system, then re-verifies the current run. |
| GET | `/runs/{id}/trace/{action_id}` | | `TraceLink[]` (provenance chain) |
| GET | `/runs/{id}/context/{agent}` | | `ContextPacket \| null` |
| GET | `/runs/{id}/log` | | `RunEvent[]` (audit export) |

## SSE stream

```
id: 42
data: {"id":42,"run_id":"r-1","ts":"2026-11-13T22:10:03.120Z","agent":"Execution","type":"tool.retry","message":"budget.set_line attempt 1 failed: 503","evidence_refs":["e-19"],"payload":{...}}

```

* `id` is monotonic across the events table. On reconnect the browser sends `Last-Event-ID`; **replay everything after it** from the DB first, then stream live. The client also de-duplicates by `id`.
* Send `: keepalive` comments every 15 s.
* `message` is shown verbatim in the action log, so write it for humans.
* `evidence_refs` are message ids (`e-19`, `c-11`). The UI renders them as chips that scroll the inbox to that message.

## Events and payloads

| type | agent | payload | Drives |
|---|---|---|---|
| `run.started` | Coordinator | `{ scenario, message_id }` | trigger highlight, log clock |
| `state` | Coordinator | `{ from, to }` (`RunStateName`) | state track in the header |
| `agent.status` | any | `{ agent, status: idle\|working\|waiting\|done\|error, note }` | agent cards |
| `agent.handoff` | from | `{ from, to, summary }` | animated relay bead and handoff line |
| `message.arrived` | Communication | `{ message: InboxMessage }` | inbox (mid-stream chat) |
| `message.triaged` | Communication | `{ message_id, verdict: relevant\|noise\|suspicious, reasons[] }` | inbox chips, quarantine styling |
| `llm.call` | any | `{ purpose, source: llm\|cache\|cache-fallback, ms }` | model-call budget counter |
| `change.extracted` | Communication | `{ change: ExtractedChange }` with `span` = exact substring of the message body | evidence highlight |
| `entity.resolved` | Knowledge | `{ resolution: Resolution }` | confidence footer |
| `confidence` | Knowledge | `{ confidence: { score, band, reasons:[{delta,label}], llm_self_reported } }` | confidence meter |
| `memory.contradiction` | Knowledge | `{ old_fact: Fact, new_claim, source_old, source_new }` | graph header |
| `impact` | Knowledge | `{ root, nodes: ImpactNode[] }` with `path` = `[node, edge, node, ...]`, `depth`, `severity`, `why` | cascade animation and "why affected" card |
| `computed` | Planning | `{ shortfall, old_tier, new_tier, income_before, income_after, deliverable_diff[] }` | options header |
| `options` | Planning | `{ options: ShortfallOption[], recommended, rationale }` | option cards (the UI switches to this tab) |
| `option.chosen` | Planning | `{ option_id, by: human\|carried }` | |
| `plan` | Planning | `{ plan: Plan }`. On v2+, set `action.diff` (`added\|changed\|carried`) and `plan.removed[]` | plan view and version toggle |
| `plan.validated` | Planning | `{ version, checks:[{label,pass}] }` | validator chip |
| `action.status` | Execution | `{ action_id, status: ActionStatus, note? }` | plan rows |
| `tool.success` / `tool.retry` / `tool.failed` / `tool.skipped_duplicate` | Execution | `{ action_id, tool, attempt, key?, error? }` | log colours (teal, amber, rose, violet) |
| `breaker.open` | Execution | `{ tool, seconds }` | log |
| `approval.requested` | Coordinator | `{ approval: Approval }` with `diff[]`, `editable[]`, `evidence[]` | approval modal (opens automatically) |
| `approval.decided` | Coordinator | `{ approval_id, decision, args?, reason? }` | |
| `approval.expired` | Coordinator | `{ approval_id, reason }` | superseded by preemption |
| `preference.learned` | Knowledge | `{ preference: Preference }` | toast and memory tab |
| `world.patch` | Execution | `{ table, id, field, from, to, action_id }` | live graph subtitles, "updated" badges, before/after highlights. For inserts (outbox, docs, tasks) the UI refetches `/state`. |
| `fact.added` / `fact.superseded` | Knowledge | `{ fact }` / `{ old, new }` | memory timeline (refetched) |
| `outbox.queued` | Execution | `{ item: OutboxItem }` | outbox list |
| `preempted` | Coordinator | `{ by_message, kept[], superseded[] }` | plan banner and toast |
| `verify.check` | Verification | `{ check: { id: 'V1'..'V10', label, pass, expected, actual } }` | checks tab |
| `verify.summary` | Verification | `{ passed, total }` | |
| `run.done` | Coordinator | `{ summary, passed, total }` | green banner |
| `run.waiting` | Coordinator | `{ reason, writes: 0 }` | amber banner (S2) |
| `run.quarantined` | Coordinator | `{ message_id, reasons[] }` | red banner (S4) |
| `run.escalated` | Coordinator | `{ reason, done[], not_done[] }` | red banner with a handoff summary |
| `episode` | Coordinator | `{ episode }` | memory tab |

## ID conventions the graph depends on

* Graph node ids equal DB row ids: `sp-technova`, `bl-prizes`, `oa-2`, `dl-keynote`, `cal-banner`, `p-1`, and so on. The tier node is `tier-technova`. The trigger message node is `msg`.
* `world.patch.table` is one of `sponsors | income | budget | deliverables | calendar | approvals | promo | docs | outbox | tasks`.
* Plan v2+ action ids: `a-3.v2`, `a-3.v3`. Degraded substitutes: `a-3.d1`, `a-3.d2`.

## Switching backends

```bash
npm run dev                      # auto: the API at VITE_API_TARGET (default http://localhost:8000), else the simulator
```

Open `/console?backend=mock` to force the simulator, or `/console?backend=http` to require the API.

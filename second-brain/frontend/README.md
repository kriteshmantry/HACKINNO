# Second Brain: frontend

React 19, Vite, TypeScript, Tailwind 4, Zustand, React Flow with dagre, and Motion.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check and production build
```

* `/` is the landing page. Its hero shows the real trigger email and the impact report computed from the backend's knowledge graph.
* `/console` is the live operations console. `?scenario=S1` starts a scenario; `?run=<id>` re-attaches to a run (the URL keeps it, so a refresh mid-demo lands back on it).

The console talks to the FastAPI backend in `../backend` (start both with `../run-demo.ps1`). If the API does not answer, it falls back to a built-in simulator of the same pipeline, so the demo still works offline. See [INTEGRATION.md](INTEGRATION.md) for how the backend's events are translated.

## Architecture

```
src/
  lib/types.ts            domain types + RunEvent contract (wire format, snake_case)
  lib/impact.ts           typed impact propagation, mirroring backend/knowledge/graph.py
  backend/
    Backend.ts            the one interface the UI depends on
    index.ts              AutoBackend: the API when it answers, otherwise the simulator
    http/client.ts        FastAPI over REST + SSE (replays from the start on reconnect)
    http/adapter.ts       translates backend events, rows and ids into the UI contract
    mock/seed.ts          the simulator's Innovision 2026 world: money table, messages, graph
    mock/logic.ts         impact propagation, shortfall solver, target-state planner, risk, V1–V10
    mock/engine.ts        coordinator state machine, approvals, retries, breaker, idempotency, preemption
  store/runStore.ts       event-sourced Zustand store: one reducer, every panel derives from events
  components/console/     CommandBar, InboxPanel, ImpactGraph, AgentRelay, ConfidenceMeter, ActionLog,
                          Dock (Options, Plan, Before and after, Checks, Memory), ApprovalModal,
                          TraceDrawer, ContextInspector, OutcomeBanner, Toast
  pages/Landing.tsx, pages/Console.tsx
```

## Demo script (against the backend)

1. **S1, clear cut.** Confidence 0.90 (autonomous). The graph highlights 19 affected items; click the prize pool approval to see why it is affected.
2. Choose **option B**. Approve the budget step, the prize pool amendment and the sponsor email (you can edit its cc first).
3. The run completes with **10 of 10 checks**. Open **Why?** on any plan step for the evidence chain from the email span to the check.
4. **Deliver e-19 again**: "Nothing to do", so nothing is applied twice. **Send the “3.5L final” chat**: a new run plans only the difference (TechNova ends at Silver, ₹3,50,000).
5. Set the budget tool to **Always** fail and run S1: three retries, the circuit opens, and the replan flags the lines for the treasurer instead. Sending the 3.5L chat afterwards re-sizes those pending changes.
6. While a run waits for the sponsor-email approval, press **Edit outside the system**: V3 fails, the replan re-applies the keynote removal, and the run finishes with 10 of 10.
7. **S2**: confidence 0.30, so a person must confirm the amount before anything changes. **S4**: quarantined at triage.

On the simulator (`?backend=mock`), S3 also shows mid-run preemption and the email edit is learned as a preference.

## Design notes: "the ops desk the night before print"

The product is about evidence, so the interface borrows from marked-up paperwork rather than dashboards.

* **Evidence is highlighted**, like a highlighter on the source email. **Changes read like a ledger**: the old value is struck through and the new value sits beside it.
* **Day theme by default** (cool paper grey, off-white sheets, ink), because the demo runs on a projector. The night theme is charcoal. The Day/Night toggle is saved per browser.
* **Five muted signal colours**, named by meaning in `src/styles/index.css`: `work` (ballpoint blue), `wait` (ochre), `fail` (brick), `ok` (bottle green) and `note` (highlighter).
* **Status is written, not iconed.** There is no icon library; the only drawn glyph is the close mark. Plan steps, checks and agents say "Done", "Pass" or "Waiting".
* **Tight radii** (2, 3, 5 and 8px). Shadows appear only on real overlays (dialogs, drawers, toasts). There is no blur, glass or decorative grid.
* **Motion is functional only:** the impact reveal by depth, the handoff marker, and dialogs that respond to you. It respects `prefers-reduced-motion`.
* **The landing hero is real output.** The email is seed message e-19, and the impact report is computed by the same `impacted()` traversal the console uses.
* **Accessibility:**
  - Focus rings are visible.
  - A skip link is provided.
  - Graph nodes can be focused and selected with Enter.
  - Approvals focus the primary action, and Escape closes overlays.
  - Loading states use skeletons laid out like the real panels.

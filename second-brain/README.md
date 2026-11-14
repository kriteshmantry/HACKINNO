# Second Brain: Track B (backend + frontend)

A sponsor changes their commitment (TechNova: ₹5L to ₹3L). The system:

1. triages the message and extracts the change;
2. resolves the sponsor across apps;
3. checks the change against memory;
4. scores confidence;
5. walks the knowledge graph to find every affected item;
6. computes options to cover the shortfall;
7. plans the fix, then executes it through a tool layer with retries, idempotency, preconditions and human approvals;
8. verifies ten invariants;
9. logs every step with evidence.

## Run the demo

One command starts both servers (it creates the virtualenv and installs dependencies the first time):

```powershell
powershell -ExecutionPolicy Bypass -File second-brain\run-demo.ps1
```

Then open http://localhost:5173. The script keeps the SQLite database in `%LOCALAPPDATA%SecondBrain` (set `SB_DATA_DIR` to change it), so OneDrive or Dropbox syncing this folder cannot lock it mid-write. The console talks to this backend through the Vite proxy (`/api` to port 8000). If the backend is not running, the console falls back to a built-in simulator so the demo still works offline; the header says which one you are on. See [frontend/README.md](frontend/README.md) and [frontend/INTEGRATION.md](frontend/INTEGRATION.md).

## Run the backend on its own

```bash
py -3.13 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn backend.main:app --reload --port 8000
```

Open http://localhost:8000/docs. Tests: `.venv\Scripts\python -m pytest backend/tests -q`

| Env var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | When set (and `SB_LLM_MODE=auto`), Claude does the extraction; responses are cached in `backend/seed/cache/` |
| `SB_LLM_MODE` | `auto` | `auto`: use the API if a key is set, otherwise the cache. `cache`: offline. `off`: rule-based only |
| `SB_MODEL` | `claude-opus-5-5` | Model used for extraction |
| `SB_OPTION_WAIT_S` | `0` | How long a run waits for a human to pick a shortfall option before taking the recommended one |
| `SB_APPROVAL_TIMEOUT_S` | `600` | How long an approval may wait before the run escalates |

Without an API key, extraction falls back to deterministic regex rules. Every scenario works offline.

## Demo flow (REST)

| Step | Call |
|---|---|
| Reset | `POST /api/reset` |
| Arm a fault (optional) | `POST /api/debug/fault {"tool":"budget.set_lines","mode":"once"\|"always"\|"slow"\|"off"}` |
| Run a scenario | `POST /api/scenarios/S1?reset_first=false&option_wait_seconds=30` (S1 clear cut, S2 ambiguous, S3 chat relay, S4 injection) |
| Live feed | `GET /api/runs/{id}/stream` (SSE; replays from the start, honours `Last-Event-ID`) or `GET /api/stream` for every run |
| Pick an option | `POST /api/runs/{id}/options/B` |
| Approvals | `GET /api/approvals?status=pending`, then `POST /api/approvals/{ap}` with `{"decision":"approve"\|"reject"\|"edit","args":{...},"reason":"..."}` |
| Answer a clarification (S2) | `POST /api/runs/{id}/clarify {"decision":"confirm","amount":300000}` |
| Inspect | `GET /api/runs/{id}`, `/plan`, `/log`, `/snapshots`, `/trace/{action_id}`, `GET /api/state`, `/api/graph?run_id=`, `/api/outbox`, `/api/memory/facts` |
| Verifier demo | `POST /api/debug/corrupt` (breaks invariant V3) |

## Email Trust Score, negotiation and risk radar

**Email Trust Score.** Every message gets two scores from visible signals.
- *Trust* asks whether the sender is genuine. Signals:
  - the sender is the contact on file, or uses the sponsor's domain;
  - the domain is a lookalike (`techn0va-billing.com`, `technova-io.com`);
  - the reply-to address differs from the sender;
  - it is the sender's first message;
  - pressure or secrecy wording;
  - requests for money or credentials;
  - the sender's track record from past human verdicts.
- *Certainty* asks whether the change is clear: the existing confidence signals, plus a penalty when the change is unusually large.

The run acts on the weaker of the two. Anything below the approval threshold goes to the verification queue, where a person can:
- **confirm** the change;
- **correct** the amount;
- **reject** it;
- **ask the sender**, which emails the contact on file, never the reply-to address. The run keeps waiting for the answer.

Every verdict updates the sender's track record.

**Tier-boundary negotiation.** "TechNova is ₹1,00,000 short of staying Gold." When a cut drops a sponsor a tier, the system drafts a counter-offer to the contact on file:
- top up to the old tier;
- or buy back the most valuable lost benefit, priced from `ADDON_PRICES`.

The draft includes the budget effect and the next print deadline. If the sponsor accepts, a normal run applies the increase.

**Risk radar.** Rules over the live records and the scenario clock catch trouble with no email needed:
- payments due with money outstanding;
- sponsors who have paid nothing while their logo prints tomorrow;
- unread or unverified changes before a print deadline;
- entitlement drift;
- published posters that name the wrong tier;
- pending sign-offs;
- budget gaps;
- tier boundaries.

Each item offers a one-click action: a reminder email, processing a message, or opening the counter-offer.

| Step | Call |
|---|---|
| Impostor scenario | `POST /api/scenarios/S5` (e-25 from `technova-io.com`, reply-to Gmail; trust 0.00, held) |
| Scores for every message | `GET /api/trust/inbox`, `GET /api/messages/{id}/trust` |
| Thresholds | `GET` / `PUT /api/trust/policy {"autonomous":0.8,"supervised":0.5}` |
| Verification queue | `GET /api/verifications?status=open`, `POST /api/verifications/{id} {"verdict":"confirm"\|"correct"\|"reject"\|"ask_sender","amount":..., "body":...}` |
| Demo reply from the contact | `POST /api/debug/verification-reply/{id} {"genuine":false}` |
| Track record, calibration | `GET /api/trust/senders`, `GET /api/trust/calibration` |
| Counter-offer | `GET /api/negotiation/{sponsor_id}`, `GET /api/runs/{id}/negotiation`, `POST /api/negotiation/{sponsor_id}/send` |
| Demo sponsor reply | `POST /api/debug/negotiation-reply/{neg_id} {"choice":"restore"\|"decline"}` (restore starts a run) |
| Risk radar | `GET /api/radar`, `POST /api/radar/{item_id}/act {"action":0}` |

Messages sent with one click are recorded as approved in `approvals_queue` and go through the normal tool layer, so V8 still holds and a double click cannot send twice.

## Layout

```
backend/
  main.py           FastAPI routes + SSE
  coordinator.py    persisted state machine (Coordinator agent), replan + escalation
  agents/           communication (triage, extraction), knowledge (resolve, confidence, impact),
                    planning (options, plan, risk, validation), execution, verification (V1–V10)
  knowledge/        entity resolution, versioned memory, typed-impact knowledge graph
  planning/         shortfall solver (A/B/C), template planner (plan = diff(current, target)), validator
  tools/            registry (idempotency in the write transaction, retries, breaker, faults) + mock apps
  confidence.py     amount normaliser, composite confidence score, bands
  policy.py         risk score and approval rules
  approvals.py      human-in-the-loop gates (approvals, option choice, clarification)
  llm.py            Claude structured output (messages.parse), cache, fallback
  seed/             workspace.json, messages.json
  tests/            registry, knowledge, end-to-end scenarios
frontend/           React console + landing page; src/backend/http/adapter.ts maps this API onto the UI
run-demo.ps1        starts backend and frontend together
```

## Not built yet (P1/P2 in the plan)

- LLM planner (the template planner covers the scenario)
- Context packets and the Context Inspector
- Learned preferences
- Mid-run preemption
- Compensation (saga)
- Precondition-drift demo endpoint
- Evaluation harness

## Convergence fixes

- **Budget fix sized from the live sheet.** Options and the open gap use what the budget actually lacks after the change (`planning.budget_gap`), not just old − new. A successful `budget.set_lines` supersedes any reductions an earlier fallback left pending, and a new fallback replaces the pending set instead of adding to it.
- **Repair after an outside edit.** When verification fails, the replan re-applies declarative writes whose target has drifted, under a fresh idempotency scope (`PlannedAction.idem_scope`), so the run repairs itself instead of escalating. Nothing is applied twice (V7).

Both are covered by regression tests in `backend/tests/test_e2e.py`.

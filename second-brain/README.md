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

Then open http://localhost:5173. The console talks to this backend through the Vite proxy (`/api` to port 8000). If the backend is not running, the console falls back to a built-in simulator so the demo still works offline; the header says which one you are on. See [frontend/README.md](frontend/README.md) and [frontend/INTEGRATION.md](frontend/INTEGRATION.md).

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

## Known backend edge cases (found while integrating)

- **Fallback, then a new change:** after a run that used the fallback path (budget tool failing, lines flagged as pending), a later change for the same sponsor does not clear or replace the earlier pending reductions. V4 then fails on every replan and the run escalates.
- **Repair after an outside edit:** `/api/debug/corrupt` during a run is caught by V3, but the replan skips steps already done in that run (`done_keys` and the idempotency check), so the plan is empty and the run escalates instead of re-applying the fix.

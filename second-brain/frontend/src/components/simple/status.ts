import { useMemo } from 'react'
import { useRun } from '@/store/runStore'
import type { RunStateName } from '@/lib/types'

export type StageId = 'read' | 'impact' | 'decide' | 'change' | 'check'
export type StageStatus = 'upcoming' | 'active' | 'needs' | 'done' | 'skipped' | 'stopped'

export const STAGES: { id: StageId; title: string; idle: string }[] = [
  { id: 'read', title: 'Read the message', idle: 'An agent reads the new email or chat, checks it is safe, and works out what changed and how sure it can be.' },
  { id: 'impact', title: 'Find what it affects', idle: 'The knowledge graph is followed from the sponsor to every budget line, deliverable, date, approval and person the change touches.' },
  { id: 'decide', title: 'Choose how to cover the gap', idle: 'If money is now missing, three ways to cover it are computed in code. You pick one.' },
  { id: 'change', title: 'Make the changes', idle: 'Each change is applied exactly once, with retries. Anything risky waits for your OK.' },
  { id: 'check', title: 'Check the result', idle: 'Ten checks re-read the live records to confirm everything is consistent before the run finishes.' },
]

const STAGE_OF: Partial<Record<RunStateName, number>> = {
  INGEST: 0, TRIAGE: 0, EXTRACT: 0, RESOLVE: 0, AWAIT_CLARIFICATION: 0, QUARANTINED: 0, IGNORED: 0, PREEMPTED: 0,
  ANALYZE: 1, OPTIONS: 2, PLAN: 3, VALIDATE: 3, EXECUTE: 3, AWAIT_APPROVAL: 3, REPLAN: 3, VERIFY: 4, ESCALATE: 4, DONE: 5,
}

/** Status of each of the five stages, derived from the run. */
export function useStages(): Record<StageId, StageStatus> {
  const runId = useRun((s) => s.runId)
  const state = useRun((s) => s.state)
  const impact = useRun((s) => s.impact.length)
  const options = useRun((s) => s.options.length)
  const chosen = useRun((s) => s.chosen)
  const planningWaiting = useRun((s) => s.agents.Planning.status === 'waiting')
  const approvals = useRun((s) => s.approvals)
  const clarification = useRun((s) => s.clarification)
  const plans = useRun((s) => s.plans.length)
  return useMemo(() => {
    const pending = Object.values(approvals).filter((a) => a.status === 'pending').length
    const out = {} as Record<StageId, StageStatus>
    STAGES.forEach((st, i) => {
      let v: StageStatus = 'upcoming'
      if (!runId) v = 'upcoming'
      else if (state === 'QUARANTINED') v = i === 0 ? 'stopped' : 'skipped'
      else if (state === 'IGNORED' || (state === 'DONE' && !impact)) v = i === 0 ? 'done' : 'skipped'
      else if (state === 'AWAIT_CLARIFICATION') v = i === 0 ? ((clarification && !clarification.answered) || pending ? 'needs' : 'done') : i === 3 && plans ? 'done' : 'upcoming'
      else {
        const cur = STAGE_OF[state] ?? 0
        if (i < cur) v = i === 2 && !options ? 'skipped' : 'done'
        else if (i === cur) v = state === 'ESCALATE' ? 'stopped' : 'active'
        if (i === 2 && v === 'active' && planningWaiting && options && !chosen) v = 'needs'
        if (i === 3 && pending) v = 'needs'
      }
      out[st.id] = v
    })
    return out
  }, [runId, state, impact, options, chosen, planningWaiting, approvals, clarification, plans])
}

/** One plain sentence for the header: what is happening, and whether it needs you. */
export function useRunStatus(): { text: string; tone: 'ok' | 'wait' | 'fail' | 'work' | 'faint'; busy: boolean } {
  const runId = useRun((s) => s.runId)
  const state = useRun((s) => s.state)
  const trigger = useRun((s) => s.trigger)
  const outcome = useRun((s) => s.outcome)
  const approvals = useRun((s) => s.approvals)
  const planningWaiting = useRun((s) => s.agents.Planning.status === 'waiting')
  const pending = Object.values(approvals).filter((a) => a.status === 'pending').length
  if (!runId) return { text: 'Pick a scenario to start', tone: 'faint', busy: false }
  if (pending) return { text: `Waiting for your OK on ${pending} change${pending === 1 ? '' : 's'}`, tone: 'wait', busy: false }
  switch (state) {
    case 'IDLE': case 'INGEST': case 'TRIAGE': return { text: `Reading ${trigger ?? 'the message'}`, tone: 'work', busy: true }
    case 'EXTRACT': return { text: 'Working out what changed', tone: 'work', busy: true }
    case 'RESOLVE': return { text: 'Checking memory and how sure it can be', tone: 'work', busy: true }
    case 'AWAIT_CLARIFICATION': return outcome ? { text: outcome.text, tone: 'wait', busy: false } : { text: 'Waiting for you to confirm the amount', tone: 'wait', busy: false }
    case 'ANALYZE': return { text: 'Tracing everything the change affects', tone: 'work', busy: true }
    case 'OPTIONS': return planningWaiting ? { text: 'Waiting for you to choose how to cover the gap', tone: 'wait', busy: false } : { text: 'Working out ways to cover the gap', tone: 'work', busy: true }
    case 'PLAN': case 'VALIDATE': return { text: 'Writing and checking the plan', tone: 'work', busy: true }
    case 'EXECUTE': return { text: 'Making the changes', tone: 'work', busy: true }
    case 'AWAIT_APPROVAL': return { text: 'Waiting for your OK', tone: 'wait', busy: false }
    case 'REPLAN': return { text: 'Something did not go to plan, so the plan is being redone', tone: 'wait', busy: true }
    case 'PREEMPTED': return { text: 'Newer information arrived, so the plan is being redone', tone: 'wait', busy: true }
    case 'VERIFY': return { text: 'Checking the result', tone: 'work', busy: true }
    case 'DONE': return { text: outcome?.text ?? 'Done', tone: 'ok', busy: false }
    case 'ESCALATE': return { text: outcome?.text ?? 'Handed to a person', tone: 'fail', busy: false }
    case 'QUARANTINED': return { text: 'Stopped: the message was quarantined', tone: 'fail', busy: false }
    case 'IGNORED': return { text: 'Ignored: not a sponsor change', tone: 'faint', busy: false }
    default: return { text: state, tone: 'work', busy: true }
  }
}

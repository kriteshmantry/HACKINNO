import clsx from 'clsx'
import { useMemo, useState } from 'react'
import { useRun } from '@/store/runStore'
import { AGENTS, type AgentId, type RunEvent } from '@/lib/types'
import { Panel } from '../ui'

function toneOf(e: RunEvent): string {
  switch (e.type) {
    case 'tool.retry': case 'approval.requested': case 'preempted': case 'approval.expired': case 'run.waiting': return 'var(--wait)'
    case 'tool.failed': case 'breaker.open': case 'run.quarantined': case 'run.escalated': case 'plan.rejected': return 'var(--fail)'
    case 'tool.success': case 'run.done': case 'approval.decided': return 'var(--ok)'
    case 'tool.skipped_duplicate': case 'fact.superseded': case 'preference.learned': case 'memory.contradiction': return 'var(--note)'
    case 'agent.handoff': return 'var(--text)'
    case 'verify.check': return e.payload?.check?.pass ? 'var(--ok)' : 'var(--fail)'
    default: return 'var(--faint)'
  }
}
const QUIET = new Set(['agent.status', 'world.patch', 'action.status'])

export function ActionLog() {
  const log = useRun((s) => s.log)
  const startedAt = useRun((s) => s.startedAt)
  const focusMsg = useRun((s) => s.focusMsg)
  const [agent, setAgent] = useState<AgentId | 'all'>('all')
  const [verbose, setVerbose] = useState(false)
  const rows = useMemo(() => log.filter((e) => (agent === 'all' || e.agent === agent) && (verbose || !QUIET.has(e.type))), [log, agent, verbose])
  const t0 = startedAt ? +new Date(startedAt) : 0
  const rel = (ts: string) => {
    const s = Math.max(0, (+new Date(ts) - t0) / 1000)
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`
  }
  return (
    <Panel
      title="Action log"
      aside={
        <div className="flex shrink-0 items-center gap-1">
          <select value={agent} onChange={(e) => setAgent(e.target.value as AgentId | 'all')} aria-label="Filter by agent"
            className="h-7 w-[104px] rounded-sm border border-line bg-surface px-1 text-[12px] text-muted">
            <option value="all">All agents</option>
            {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <button onClick={() => setVerbose(!verbose)} aria-pressed={verbose} className={clsx('h-7 whitespace-nowrap rounded-sm px-2 text-[12px] font-semibold', verbose ? 'bg-surface-2 text-text' : 'text-muted hover:text-text')} title="Include status changes and every field write">
            All events
          </button>
          <button onClick={() => useRun.getState().exportLog()} disabled={!log.length} className="h-7 rounded-sm px-2 text-[12px] font-semibold text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40" title="Download the full audit log as JSON">
            Export
          </button>
        </div>
      }
      bodyClass="overflow-y-auto"
    >
      {!rows.length ? (
        <p className="px-3.5 py-3 text-[12.5px] text-muted">Every step every agent takes lands here, with the evidence it relied on. Run a scenario to start.</p>
      ) : (
        <ol className="py-1">
          {rows.map((e) => (
            <li key={e.id} className="grid grid-cols-[46px_10px_minmax(0,1fr)] items-start gap-x-2 px-3.5 py-[5px] text-[12px] hover:bg-surface-2">
              <span className="pt-px font-mono text-[10.5px] text-faint">{rel(e.ts)}</span>
              <span className="mt-[5px] h-[7px] w-[7px] rounded-full" style={{ background: toneOf(e) }} />
              <span className="min-w-0">
                <span className="font-medium text-muted">{e.agent}</span>{' '}
                <span className="text-text">{e.message}</span>
                {e.evidence_refs.length > 0 && (
                  <span className="ml-1 inline-flex gap-1 align-middle">
                    {e.evidence_refs.slice(0, 2).map((r) => (
                      <button key={r} onClick={() => focusMsg(r)} className="rounded-xs bg-surface-2 px-1 font-mono text-[10.5px] text-work hover:underline" title={`Show ${r} in the inbox`}>{r}</button>
                    ))}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

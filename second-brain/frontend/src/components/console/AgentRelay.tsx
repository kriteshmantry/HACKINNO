import clsx from 'clsx'
import { motion, AnimatePresence } from 'motion/react'
import { useRun } from '@/store/runStore'
import { backend } from '@/backend'
import type { AgentId, AgentStatus } from '@/lib/types'
import { agentMeta, agentStatusColor, agentStatusWord, Panel } from '../ui'

const RELAY: AgentId[] = ['Communication', 'Knowledge', 'Planning', 'Execution', 'Verification']
const ROW = 46
const HAS_CONTEXT: AgentId[] = ['Communication', 'Knowledge', 'Planning']

export function AgentRelay() {
  const agents = useRun((s) => s.agents)
  const handoff = useRun((s) => s.handoff)
  const llmCalls = useRun((s) => s.llmCalls)
  const replans = useRun((s) => s.replans)
  const runId = useRun((s) => s.runId)
  const coord = agents.Coordinator
  const from = handoff ? RELAY.indexOf(handoff.from) : -1
  const to = handoff ? RELAY.indexOf(handoff.to) : -1

  return (
    <Panel
      title="Agents"
      aside={<span className="flex gap-3 text-[11.5px] text-faint"><span title="Model call budget per run">Model calls {llmCalls}/20</span><span title="Replan budget per run">Replans {replans}/2</span></span>}
    >
      <div className="flex items-center gap-2.5 border-b border-line-soft px-3.5 py-2">
        <Dot status={coord.status} />
        <span className="text-[13px] font-bold">Coordinator</span>
        <span className="truncate text-[12px] text-muted">{coord.note}</span>
      </div>
      {/* an ordered relay: handoffs travel down the thread between agents */}
      <ol className="relative px-3.5 py-1.5" aria-label="Agent relay">
        <span className="absolute bottom-[25px] left-[21px] top-[25px] w-px bg-line" aria-hidden />
        <AnimatePresence>
          {handoff && from >= 0 && to >= 0 && (
            <motion.span
              key={handoff.key}
              aria-hidden
              className="absolute left-[18px] z-10 h-[7px] w-[7px] rounded-xs bg-text"
              initial={{ top: 6 + from * ROW + ROW / 2 - 3.5, opacity: 0 }}
              animate={{ top: 6 + to * ROW + ROW / 2 - 3.5, opacity: [0, 1, 1, 0] }}
              transition={{ duration: 0.8, ease: 'easeInOut' }}
            />
          )}
        </AnimatePresence>
        {RELAY.map((id) => {
          const a = agents[id]
          return (
            <li key={id} className="relative flex items-center gap-2.5" style={{ height: ROW }}>
              <Dot status={a.status} />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="flex items-baseline gap-2">
                  <span className={clsx('text-[13px] font-bold', a.status === 'idle' && 'text-muted')}>{id}</span>
                  <span className="text-[10.5px] text-faint">{agentMeta[id].engine}</span>
                </div>
                <div className={clsx('truncate text-[12px]', a.status === 'error' ? 'text-fail' : a.status === 'waiting' ? 'text-wait' : 'text-muted')} title={a.note}>
                  <span className="sr-only">{agentStatusWord[a.status]}: </span>{a.note}
                </div>
              </div>
              {backend.profile.caps.context && HAS_CONTEXT.includes(id) && runId && a.status !== 'idle' && (
                <button onClick={() => useRun.getState().set('contextAgent', id)} className="shrink-0 rounded-sm px-1.5 py-1 text-[11.5px] font-semibold text-work hover:bg-work-soft">
                  What it saw
                </button>
              )}
            </li>
          )
        })}
      </ol>
      {handoff && (
        <div className="border-t border-line-soft px-3.5 py-2 text-[11.5px] text-muted">
          <span className="font-bold text-text">{handoff.from} to {handoff.to}:</span> {handoff.summary}
        </div>
      )}
    </Panel>
  )
}

function Dot({ status }: { status: AgentStatus }) {
  return (
    <span className="relative z-[1] grid h-[13px] w-[13px] shrink-0 place-items-center bg-surface" aria-hidden>
      <span className={clsx('h-[9px] w-[9px] rounded-full', status === 'working' && 'working')}
        style={{ background: status === 'idle' ? 'transparent' : agentStatusColor[status], border: `1.5px solid ${status === 'idle' ? 'var(--line)' : agentStatusColor[status]}` }} />
    </span>
  )
}

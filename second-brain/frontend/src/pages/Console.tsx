import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useRun } from '@/store/runStore'
import type { ScenarioId } from '@/lib/types'
import { CommandBar, Toolbar } from '@/components/console/CommandBar'
import { InboxPanel } from '@/components/console/InboxPanel'
import { ImpactGraph } from '@/components/console/ImpactGraph'
import { AgentRelay } from '@/components/console/AgentRelay'
import { ConfidenceMeter } from '@/components/console/ConfidenceMeter'
import { ActionLog } from '@/components/console/ActionLog'
import { Dock } from '@/components/console/Dock'
import { ApprovalModal } from '@/components/console/ApprovalModal'
import { ContextInspector, TraceDrawer } from '@/components/console/Drawers'
import { ClarifyCard, OutcomeBanner, Toast } from '@/components/console/Feedback'
import { backend } from '@/backend'
import { Button, Skeleton } from '@/components/ui'

function StartCard() {
  const state = useRun((s) => s.state)
  const runId = useRun((s) => s.runId)
  if (runId || state !== 'IDLE') return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-12 z-20 flex justify-center px-3">
      <div className="pointer-events-auto w-full max-w-[520px] rounded-md border border-line bg-surface px-4 py-3.5">
        <p className="text-[14px] font-semibold">This is {backend.profile.eventName}, the night before banner print.</p>
        <p className="mt-0.5 text-[12.5px] text-muted">TechNova is a Gold sponsor at ₹5,00,000 and the budget balances at ₹13L. Start with S1 to watch one email ripple through everything above.</p>
        <Button variant="primary" className="mt-3" onClick={() => useRun.getState().start('S1')}>Run S1: TechNova cuts to ₹3L</Button>
      </div>
    </div>
  )
}

/** Same grid as the loaded console, so nothing jumps when data arrives. */
function ConsoleSkeleton() {
  const block = (h: string, rows = 3) => (
    <div className={`${h} min-h-0 rounded-md border border-line bg-surface p-3.5 xl:h-auto`}>
      <Skeleton className="mb-4 h-3.5 w-28" />
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="mb-2.5 h-3" style={{ width: `${88 - i * 11}%` }} />)}
    </div>
  )
  return (
    <main aria-busy="true" aria-label="Loading the event workspace" className="grid flex-1 grid-cols-[minmax(0,1fr)] gap-3 p-3 xl:min-h-0 xl:grid-cols-[minmax(260px,300px)_minmax(0,1fr)_minmax(320px,360px)]">
      {block('h-[420px]', 8)}
      <div className="grid min-h-0 gap-3 xl:grid-rows-[minmax(0,1.3fr)_minmax(0,1fr)]">{block('h-[520px]', 4)}{block('h-[400px]', 4)}</div>
      <div className="grid min-h-0 gap-3 xl:grid-rows-[auto_auto_minmax(0,1fr)]">{block('h-auto', 5)}{block('h-auto', 3)}{block('h-[300px]', 5)}</div>
    </main>
  )
}

export default function Console() {
  const ready = useRun((s) => s.ready)
  const error = useRun((s) => s.error)
  const [params] = useSearchParams()
  const booted = useRef(false)

  useEffect(() => {
    if (booted.current) return // StrictMode runs effects twice in dev
    booted.current = true
    document.title = 'Second Brain console'
    useRun.getState().init().then(() => {
      const sc = params.get('scenario') as ScenarioId | null
      const run = params.get('run')
      // a reload re-attaches to the same run; the backend replays its events from the start
      if (run && backend.kind === 'http') useRun.getState().resume(run)
      else if (sc && ['S1', 'S2', 'S3', 'S4'].includes(sc)) useRun.getState().start(sc)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // keep the run in the address bar so a refresh mid-demo lands back on it
  const runId = useRun((s) => s.runId)
  useEffect(() => {
    if (!runId || backend.kind !== 'http') return
    const url = new URL(location.href)
    url.searchParams.delete('scenario')
    url.searchParams.set('run', runId)
    history.replaceState(null, '', url)
  }, [runId])

  return (
    <div className="flex min-h-screen flex-col bg-bg xl:h-screen">
      <CommandBar />
      <Toolbar />
      {error && <div className="border-b border-fail/40 bg-fail-soft px-4 py-2 text-[13px] text-fail">{error}. Start the FastAPI server, or open this page with <span className="font-mono">?backend=mock</span> to use the simulator.</div>}
      {!ready ? (
        <ConsoleSkeleton />
      ) : (
        <main className="grid flex-1 grid-cols-[minmax(0,1fr)] gap-3 p-3 xl:min-h-0 xl:grid-cols-[minmax(260px,300px)_minmax(0,1fr)_minmax(320px,360px)]">
          <div className="h-[420px] min-h-0 xl:h-auto"><InboxPanel /></div>
          <div className="relative grid min-h-0 gap-3 xl:grid-rows-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <div className="h-[520px] min-h-0 xl:h-auto"><ImpactGraph /></div>
            <div className="h-[560px] min-h-0 xl:h-auto"><Dock /></div>
            <OutcomeBanner />
            <ClarifyCard />
            <StartCard />
          </div>
          <div className="grid min-h-0 gap-3 xl:grid-rows-[auto_auto_minmax(0,1fr)]">
            <AgentRelay />
            <ConfidenceMeter />
            <div className="h-[420px] min-h-0 xl:h-auto"><ActionLog /></div>
          </div>
        </main>
      )}
      <ApprovalModal />
      <TraceDrawer />
      <ContextInspector />
      <Toast />
    </div>
  )
}

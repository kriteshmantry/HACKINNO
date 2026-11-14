import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useRun } from '@/store/runStore'
import type { ScenarioId } from '@/lib/types'
import { backend } from '@/backend'
import { Skeleton } from '@/components/ui'
import { SimpleHeader } from '@/components/simple/Header'
import { Story } from '@/components/simple/Story'
import { Panels, SideRail } from '@/components/simple/Side'
import { ApprovalModal } from '@/components/console/ApprovalModal'
import { ContextInspector, TraceDrawer } from '@/components/console/Drawers'
import { Toast } from '@/components/console/Feedback'

/** Same layout as the loaded console, so nothing jumps when data arrives. */
function ConsoleSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the event workspace" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-2.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-md border border-line-soft px-4 py-3.5">
            <Skeleton className="h-4 w-48" /><Skeleton className="mt-2 h-3" style={{ width: `${70 - i * 6}%` }} />
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <div className="h-56 rounded-md border border-line-soft p-4"><Skeleton className="h-3.5 w-28" /></div>
        <div className="h-64 rounded-md border border-line-soft p-4"><Skeleton className="h-3.5 w-24" /></div>
      </div>
    </div>
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
    const asked = params.get('scenario') as ScenarioId | null
    // a scenario link starts straight away: show it starting, never the chooser
    if (asked && ['S1', 'S2', 'S3', 'S4'].includes(asked) && !params.get('run')) useRun.getState().set('starting', asked)
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
    <div className="min-h-screen bg-bg">
      <SimpleHeader />
      {error && <div className="border-b border-fail/40 bg-fail-soft px-4 py-2 text-[13px] text-fail">{error}. Start the FastAPI server, or open this page with <span className="font-mono">?backend=mock</span> to use the simulator.</div>}
      <main className="mx-auto max-w-[1180px] px-4 py-5">
        {!ready ? <ConsoleSkeleton /> : (
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <Story />
            <SideRail />
          </div>
        )}
      </main>
      <Panels />
      <ApprovalModal />
      <TraceDrawer />
      <ContextInspector />
      <Toast />
    </div>
  )
}

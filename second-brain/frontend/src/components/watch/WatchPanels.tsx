import { useWatch } from '@/store/watchStore'
import { Drawer } from '../console/Drawers'
import { RadarList } from './Radar'
import { TrustPanel } from './TrustDrawer'

export function WatchPanels() {
  const panel = useWatch((s) => s.panel)
  const close = () => useWatch.getState().close()
  return (
    <>
      <Drawer open={panel === 'radar'} onClose={close} title="Risk radar"
        sub="Trouble the agents can see coming in the live records: payments, print deadlines, pending sign-offs, stale posters. No email needed.">
        <RadarList />
      </Drawer>
      <Drawer open={panel === 'trust'} onClose={close} title="Email trust"
        sub="Every message gets two scores from visible signals: is the sender genuine, and is the change clear. It acts on the weaker one.">
        <TrustPanel />
      </Drawer>
    </>
  )
}

/** Header buttons; hidden on the simulator, which does not have these features. */
export function WatchButtons() {
  const enabled = useWatch((s) => s.enabled)
  const radar = useWatch((s) => s.radar)
  const queue = useWatch((s) => s.queue)
  if (!enabled) return null
  const urgent = radar?.counts.high ?? 0
  const open = queue.filter((v) => v.status === 'pending' || v.status === 'awaiting_reply').length
  const cls = 'inline-flex h-9 items-center gap-1.5 rounded-sm border border-line bg-surface px-3 text-[13.5px] font-semibold hover:border-text/40'
  return (
    <>
      <button className={cls} onClick={() => useWatch.getState().open('radar')} aria-label={`Risk radar, ${urgent} urgent`}>
        <span className="hidden sm:inline">Radar</span><span className="sm:hidden">Risk</span>
        {urgent > 0 && <span className="tnum rounded-xs bg-fail px-1 text-[11px] leading-4 text-bg">{urgent}</span>}
      </button>
      <button className={cls} onClick={() => useWatch.getState().open('trust')} aria-label={`Email trust, ${open} waiting`}>
        Trust
        {open > 0 && <span className="tnum rounded-xs bg-wait px-1 text-[11px] leading-4 text-bg">{open}</span>}
      </button>
    </>
  )
}

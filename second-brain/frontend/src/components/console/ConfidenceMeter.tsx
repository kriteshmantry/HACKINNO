import clsx from 'clsx'
import { useRun } from '@/store/runStore'
import { Panel } from '../ui'

const BAND = {
  autonomous: { label: 'Autonomous', color: 'var(--ok)', text: 'Low-risk steps run on their own. Risky ones still need you.' },
  supervised: { label: 'Supervised', color: 'var(--wait)', text: 'Every write needs your approval. Facts stay proposed.' },
  clarify: { label: 'Clarify first', color: 'var(--fail)', text: 'Nothing is written. A clarifying question is drafted instead.' },
}

export function ConfidenceMeter() {
  const c = useRun((s) => s.confidence)
  const r = useRun((s) => s.resolution)
  if (!c) {
    return (
      <Panel title="Confidence">
        <p className="px-3.5 py-3 text-[12.5px] text-muted">Scored in code from the sender, a regex cross-check, hedge words and corroboration. The model’s own estimate is logged but not trusted.</p>
      </Panel>
    )
  }
  const b = BAND[c.band]
  return (
    <Panel title="Confidence" aside={<span className="text-[12px] font-semibold" style={{ color: b.color }}>{b.label}</span>}>
      <div className="px-3.5 pb-3 pt-2.5">
        <div className="flex items-end gap-3">
          <span className="text-[30px] font-bold leading-none tracking-[-0.03em]" style={{ color: b.color }}>{c.score.toFixed(2)}</span>
          <span className="pb-0.5 text-[12px] leading-snug text-muted">{b.text}</span>
        </div>
        {/* bar with band thresholds at 0.50 and 0.80 */}
        <div className="relative mt-3 h-2 rounded-full bg-surface-2">
          <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700" style={{ width: `${c.score * 100}%`, background: b.color }} />
          {[0.5, 0.8].map((t) => <span key={t} className="absolute -top-1 h-4 w-px bg-text/50" style={{ left: `${t * 100}%` }} />)}
        </div>
        <div className="relative mt-1 h-3 text-[10.5px] text-faint">
          <span className="absolute left-0">0</span>
          <span className="absolute -translate-x-1/2" style={{ left: '50%' }}>0.50</span>
          <span className="absolute -translate-x-1/2" style={{ left: '80%' }}>0.80</span>
          <span className="absolute right-0">1</span>
        </div>
        <ul className="mt-2 space-y-0.5 text-[12px]">
          <li className="flex justify-between text-muted"><span>Starting score</span><span className="font-mono text-[11.5px]">0.50</span></li>
          {c.reasons.map((x) => (
            <li key={x.label} className="flex justify-between gap-3">
              <span className="truncate text-muted" title={x.label}>{x.label}</span>
              <span className={clsx('shrink-0 font-mono text-[11.5px]', x.delta >= 0 ? 'text-ok' : 'text-fail')}>{x.delta >= 0 ? '+' : '−'}{Math.abs(x.delta).toFixed(2)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap justify-between gap-x-3 border-t border-line-soft pt-2 text-[11.5px] text-faint">
          {r && <span>Entity: {r.entity_name} by {r.method} ({r.score.toFixed(2)})</span>}
          {c.llm_self_reported !== undefined && <span>Model said {c.llm_self_reported.toFixed(2)}, not used</span>}
        </div>
      </div>
    </Panel>
  )
}

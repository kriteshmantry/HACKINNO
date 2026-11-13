import clsx from 'clsx'
import { useMemo } from 'react'
import { useRun, type DockTab } from '@/store/runStore'
import { OptionsView } from './OptionsView'
import { PlanView } from './PlanView'
import { BeforeAfter } from './BeforeAfter'
import { ChecksView } from './ChecksView'
import { MemoryView } from './MemoryView'

export function Dock() {
  const tab = useRun((s) => s.tab)
  const options = useRun((s) => s.options.length)
  const chosen = useRun((s) => s.chosen)
  const approvals = useRun((s) => s.approvals)
  const checks = useRun((s) => s.checks)
  const prefs = useRun((s) => s.preferences.length)
  const touchedCount = useRun((s) => Object.keys(s.touched).length)
  const pending = useMemo(() => Object.values(approvals).filter((a) => a.status === 'pending').length, [approvals])
  const passed = checks.filter((c) => c.pass).length

  const tabs: { id: DockTab; label: string; badge?: { text: string; tone: string } }[] = [
    { id: 'options', label: 'Options', badge: options && !chosen ? { text: 'choose', tone: 'wait' } : undefined },
    { id: 'plan', label: 'Plan', badge: pending ? { text: `${pending} waiting`, tone: 'wait' } : undefined },
    { id: 'state', label: 'Before and after', badge: touchedCount ? { text: 'changed', tone: 'ok' } : undefined },
    { id: 'checks', label: 'Checks', badge: checks.length ? { text: `${passed}/${checks.length}`, tone: passed === checks.length ? 'ok' : 'fail' } : undefined },
    { id: 'memory', label: 'Memory', badge: prefs ? { text: `${prefs} learned`, tone: 'note' } : undefined },
  ]
  return (
    <section className="flex h-full min-h-0 flex-col rounded-md border border-line-soft bg-surface">
      <div role="tablist" aria-label="Run details" className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-line-soft px-2">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => useRun.getState().set('tab', t.id)}
            className={clsx('relative flex h-9 items-center gap-1.5 whitespace-nowrap px-2.5 text-[13px] font-semibold transition-colors', tab === t.id ? 'text-text' : 'text-muted hover:text-text')}>
            {t.label}
            {t.badge && <span className="rounded px-1 text-[10.5px] font-semibold" style={{ color: `var(--${t.badge.tone})`, background: `var(--${t.badge.tone}-soft)` }}>{t.badge.text}</span>}
            {tab === t.id && <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-text" />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'options' && <OptionsView />}
        {tab === 'plan' && <PlanView />}
        {tab === 'state' && <BeforeAfter />}
        {tab === 'checks' && <ChecksView />}
        {tab === 'memory' && <MemoryView />}
      </div>
    </section>
  )
}

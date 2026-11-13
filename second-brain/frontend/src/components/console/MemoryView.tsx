import clsx from 'clsx'
import { useRun } from '@/store/runStore'
import { backend } from '@/backend'
import { rupees, shortDate } from '@/lib/format'
import { Button, Chip, Mono } from '../ui'

export function MemoryView() {
  const facts = useRun((s) => s.facts)
  const prefs = useRun((s) => s.preferences)
  const episodes = useRun((s) => s.episodes)
  const sorted = [...facts].sort((a, b) => +new Date(a.valid_from) - +new Date(b.valid_from))
  return (
    <div className="grid h-full gap-x-6 gap-y-4 overflow-y-auto p-3.5 lg:grid-cols-[1.1fr_1fr]">
      <section>
        <h3 className="text-[12px] font-semibold text-muted">What we believe TechNova committed, over time</h3>
        <p className="mb-2 text-[11.5px] text-faint">Facts are never overwritten. Old versions are superseded so you can ask what was believed on any date.</p>
        <ol className="relative ml-1.5">
          <span className="absolute bottom-2 left-0 top-2 w-px bg-line" aria-hidden />
          {sorted.map((f) => (
            <li key={f.id} className="relative pb-3 pl-4">
              <span className={clsx('absolute -left-[5px] top-1.5 h-[9px] w-[9px] rounded-full border-2', f.status === 'current' ? 'border-text bg-text' : f.status === 'proposed' ? 'border-wait bg-surface' : 'border-faint bg-surface')} />
              <div className="flex flex-wrap items-center gap-2">
                <span className={clsx('text-[15px] font-semibold', f.status === 'superseded' && 'was')}>{rupees(f.value)}</span>
                <Chip tone={f.status === 'current' ? 'ok' : f.status === 'proposed' ? 'wait' : 'muted'}>{f.status}</Chip>
                <Mono className="text-faint">{f.id}</Mono>
              </div>
              <div className="text-[11.5px] text-muted">
                From <button className="font-mono text-work hover:underline" onClick={() => useRun.getState().focusMsg(f.source_ref)}>{f.source_ref}</button>, {shortDate(f.valid_from)}
                {f.valid_to && <> until {shortDate(f.valid_to)}</>}, confidence {f.confidence.toFixed(2)}
                {f.superseded_by && <>, replaced by <Mono>{f.superseded_by}</Mono></>}
              </div>
            </li>
          ))}
        </ol>
      </section>
      {backend.profile.caps.preferences ? (
      <section className="space-y-4">
        <div>
          <div className="flex items-center justify-between">
            <h3 className="text-[12px] font-semibold text-muted">Learned from your edits</h3>
            {prefs.length > 0 && <Button size="sm" variant="ghost" onClick={() => useRun.getState().forgetPreferences()}>Forget</Button>}
          </div>
          {prefs.length ? (
            <ul className="mt-1 space-y-1.5">
              {prefs.map((p) => (
                <li key={p.id} className="rounded-sm border border-line bg-surface-2 px-2.5 py-2 text-[12.5px]">
                  <div className="font-semibold">{p.rule}</div>
                  <div className="text-[11.5px] text-muted">Applies to {p.scope}. Learned from approval {p.source_ref} in {p.learned_in_run}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[12px] text-muted">Nothing yet. Edit an approval (for example, add the treasurer to cc on the sponsor email) and the next run will do it for you.</p>
          )}
        </div>
        <div>
          <h3 className="text-[12px] font-semibold text-muted">Past runs</h3>
          {episodes.length ? (
            <ul className="mt-1 space-y-1 text-[12px]">
              {episodes.map((e) => <li key={e.run_id + e.at}><Mono className="text-faint">{e.run_id}</Mono> <span className="text-muted">{e.summary}</span></li>)}
            </ul>
          ) : <p className="mt-1 text-[12px] text-muted">Each finished run leaves a one-line summary here.</p>}
        </div>
      </section>
      ) : (
        <section className="text-[12.5px] text-muted">
          <h3 className="text-[12px] font-semibold text-muted">Learned preferences</h3>
          <p className="mt-1">Not part of this backend yet. The fact history on the left is read from its versioned memory.</p>
        </section>
      )}
    </div>
  )
}

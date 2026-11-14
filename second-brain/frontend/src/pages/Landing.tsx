import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ImpactReport, TriggerEmail, useImpactReport } from '@/components/landing/ImpactReport'
import { ThemeToggle, Wordmark } from '@/components/ui'

/** A table on wide screens; label/value stacks on phones. */
function Rows({ head, rows, caption }: { head: string[]; rows: ReactNode[][]; caption: string }) {
  return (
    <table className="mt-6 w-full border-collapse text-left text-[14px] max-md:block">
      <caption className="sr-only">{caption}</caption>
      <thead className="max-md:hidden">
        <tr className="border-b border-text/70">
          {head.map((h) => <th key={h} scope="col" className="py-2 pr-6 align-bottom text-[12.5px] font-bold text-muted">{h}</th>)}
        </tr>
      </thead>
      <tbody className="max-md:block">
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-line align-top max-md:block max-md:py-3">
            {r.map((cell, j) => (
              <td key={j} data-label={head[j]}
                className="py-3 pr-6 leading-relaxed max-md:block max-md:py-0.5 max-md:pr-0 max-md:before:block max-md:before:text-[11.5px] max-md:before:font-bold max-md:before:text-faint max-md:before:content-[attr(data-label)]">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const MEMORY: ReactNode[][] = [
  [<b>Short-term memory</b>, 'The run being worked on (the change, its impact, options, plans and approvals) is saved after every step, so a reload or a restart resumes where it stopped.', 'Refresh the console mid-run'],
  [<b>Long-term memory</b>, 'Facts are versioned, never overwritten: “TechNova committed ₹5L (e-07)” is superseded by “₹3L (e-19)” and kept as history. Every finished run leaves a summary.', 'Memory, in the console sidebar'],
  [<b>Entities</b>, 'Sponsors, amounts and deadlines are pulled out of email and chat. The amount is cross-checked against the text by a regex.', 'Step 1, and deadlines at risk in step 2'],
  [<b>One sponsor, many names</b>, '“TN” in chat, rohan.mehta@technova.io in email and “TechNova Pvt Ltd” in the tracker resolve to the same sponsor. “TN volunteers” (Tamil Nadu) does not.', 'Step 1, “Who it is about”'],
  [<b>Dependencies across apps</b>, 'A typed knowledge graph links the sponsor tracker, budget sheet, calendar, approvals, published promotions, documents and people. A change to a budget line reaches the approval that signs it off.', 'Step 2, and the map'],
  [<b>Context for each agent</b>, 'Each agent gets a curated slice: quoted evidence, the facts it needs, the affected subgraph, numbers computed in code, its tools and its rules. Quarantined messages never enter it.', '“What the agent was given” on steps 1 to 3'],
]

const AGENTS: ReactNode[][] = [
  ['All', <b>Coordinator</b>, 'Every agent’s typed result', 'The next step, at most two replans, and a handover to a person when it cannot converge', 'No. A plain state machine'],
  ['1', <b>Communication</b>, 'A raw email or chat message', 'A triage verdict and the extracted change', 'Yes when an API key is set (structured output, cached); otherwise rule-based. A regex cross-checks the amount either way'],
  ['2', <b>Knowledge</b>, 'The extracted change', 'The resolved sponsor, conflicts with memory, the impact report', 'No. Alias, domain and fuzzy matching; a typed graph traversal'],
  ['3', <b>Planning</b>, 'The change, its impact, numbers computed in code', 'Three scored ways to cover the shortfall and a validated plan', 'No. The plan is the difference between the current and the target state'],
  ['4', <b>Execution</b>, 'The validated plan', 'Tool results, approval requests, an outbox', 'No'],
  ['5', <b>Verification</b>, 'The plan and the live state', 'Ten invariant checks, or a targeted replan', 'No'],
]

const SAFEGUARDS: ReactNode[][] = [
  ['A retry or a duplicate email applies a change twice', 'Every write carries a key built from the source message, checked and stored in the same transaction.', 'Deliver e-19 again after a run: nothing is applied twice'],
  ['The message is vague', 'Confidence is scored in code from the sender, a regex cross-check, hedge words and corroboration. Below 0.50 nothing is written.', 'Scenario S2 scores 0.30 and drafts a question instead'],
  ['A tool keeps failing', 'Three retries with backoff, then the circuit opens and the replan swaps in a safe fallback: flag the lines and ask the treasurer.', 'Make the budget tool fail, set to Always'],
  ['Something leaves the organisation that should not', 'Emails and chat posts wait in an outbox and only leave with an approval that shows a dry-run diff and the evidence.', 'Any approval dialog'],
  ['Someone edits a record outside the system', 'Ten invariants are re-read from live data before a run can finish. A failure triggers a replan that re-applies only what drifted; if two replans cannot fix it, the run is handed to a person with the failing checks.', 'Edit a record outside the system, while a run waits for an approval'],
  ['A message tries to give the system orders', 'Triage quarantines it before any agent, prompt or plan sees it.', 'Scenario S4'],
  ['Newer information arrives later', 'Every step says “set X, expecting Y”, so a new run plans only what still differs from the target.', 'Finish S1, then Send the “3.5L final” chat'],
]

const SCENARIOS: { id: string; name: string; text: string }[] = [
  { id: 'S1', name: 'Clear cut', text: 'TechNova’s CFO cuts ₹5L to ₹3L. Impact, three options, approvals for every risky step, verification.' },
  { id: 'S2', name: 'Ambiguous', text: '“Probably around 3L, subject to our board.” Confidence 0.30: nothing changes until a person confirms.' },
  { id: 'S3', name: 'Chat relay', text: 'The sponsorship lead relays “TN: board approved 3.5L final” in chat. “TN” resolves to TechNova, not the Tamil Nadu volunteers.' },
  { id: 'S4', name: 'Injection', text: 'A lookalike domain asks for bank details and paid flags. Quarantined before any agent reads it.' },
]

export default function Landing() {
  useEffect(() => { document.title = 'Second Brain' }, [])
  const { report, error } = useImpactReport()
  return (
    <div className="min-h-screen bg-bg">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <nav className="border-b border-line bg-surface" aria-label="Main">
        <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between px-4 sm:px-6">
          <Wordmark className="text-[15px]" />
          <div className="flex items-center gap-1">
            <a href="#memory" className="hidden rounded-sm px-3 py-2 text-[13.5px] font-semibold text-muted hover:text-text md:block">Memory</a>
            <a href="#how" className="hidden rounded-sm px-3 py-2 text-[13.5px] font-semibold text-muted hover:text-text md:block">Agents</a>
            <a href="#safeguards" className="hidden rounded-sm px-3 py-2 text-[13.5px] font-semibold text-muted hover:text-text md:block">Reliability</a>
            <ThemeToggle />
            <Link to="/console" className="ml-2 inline-flex h-9 items-center rounded-sm bg-text px-3.5 text-[13.5px] font-semibold text-bg hover:bg-text/85">Open the console</Link>
          </div>
        </div>
      </nav>

      <main id="main">
        <header className="mx-auto max-w-[1200px] px-4 pb-14 pt-12 sm:px-6 lg:pt-16">
          <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            <div className="max-w-[34rem]">
              <h1 className="text-[clamp(36px,4.4vw,56px)] font-extrabold leading-[1.02] tracking-[-0.035em]">
                One sponsor email. {report ? report.nodes.length : <span className="skeleton inline-block h-[0.75em] w-[1.2em] align-baseline" aria-label="Counting" />} things to fix.
              </h1>
              <p className="mt-5 text-[17px] leading-relaxed text-muted">
                Second Brain is an operations agent for event teams. It reads email and chat, works out everything a sponsor’s change touches, and fixes it one approved step at a time, with the evidence for every step one click away.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link to="/console?scenario=S1" className="inline-flex h-11 items-center rounded-sm bg-text px-5 text-[15px] font-semibold text-bg hover:bg-text/85">Run the TechNova scenario</Link>
                <Link to="/console" className="inline-flex h-11 items-center rounded-sm border border-line bg-surface px-5 text-[15px] font-semibold hover:border-text/40">Open the console</Link>
              </div>
            </div>
            <TriggerEmail report={report} />
          </div>
          <div className="mt-12">
            <ImpactReport report={report} error={error} />
          </div>
        </header>

        <section id="memory" className="border-t border-line">
          <div className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6">
            <h2 className="text-[28px] font-extrabold tracking-[-0.025em]">Context and memory</h2>
            <p className="mt-3 max-w-[44rem] text-[15.5px] leading-relaxed text-muted">
              Event work is scattered across email, chat, a budget sheet, a calendar and approvals. Second Brain keeps what it learns, recognises the same sponsor wherever it appears, and links every record that depends on it.
            </p>
            <Rows caption="Context and memory" head={['What', 'How Second Brain handles it', 'See it in the console']} rows={MEMORY} />
          </div>
        </section>

        <section id="how" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6">
            <h2 className="text-[28px] font-extrabold tracking-[-0.025em]">Six agents, each with one job</h2>
            <p className="mt-3 max-w-[44rem] text-[15.5px] leading-relaxed text-muted">
              A coordinator runs a plain state machine. It hands each agent a typed result, caps replans at two and model calls at twenty, and hands over to a person when it cannot converge. When newer information arrives, a new run plans only what still differs. Amounts, tiers and risk are always computed in code; the model never does arithmetic.
            </p>
            <Rows caption="Agent contracts" head={['Step', 'Agent', 'Receives', 'Produces', 'Uses the model?']} rows={AGENTS} />
          </div>
        </section>

        <section id="safeguards" className="border-t border-line">
          <div className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6">
            <h2 className="text-[28px] font-extrabold tracking-[-0.025em]">Reliable execution and replanning</h2>
            <p className="mt-3 max-w-[44rem] text-[15.5px] leading-relaxed text-muted">
              Tools fail, messages repeat and records drift. Each safeguard below can be triggered on purpose from Demo controls in the console, so you can watch it work.
            </p>
            <Rows caption="Safeguards" head={['Risk', 'What Second Brain does', 'Try it in the console']} rows={SAFEGUARDS} />
          </div>
        </section>

        <section className="border-t border-line bg-surface">
          <div className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6">
            <h2 className="text-[28px] font-extrabold tracking-[-0.025em]">Four scenarios to run</h2>
            <ol className="mt-6 divide-y divide-line border-y border-line">
              {SCENARIOS.map((s) => (
                <li key={s.id} className="grid gap-x-6 gap-y-1 py-4 sm:grid-cols-[56px_160px_minmax(0,1fr)_auto] sm:items-baseline">
                  <span className="font-mono text-[12px] text-faint">{s.id}</span>
                  <span className="text-[16px] font-bold">{s.name}</span>
                  <span className="text-[14px] leading-relaxed text-muted">{s.text}</span>
                  <Link to={`/console?scenario=${s.id}`} className="text-[13.5px] font-semibold text-work underline-offset-4 hover:underline">Run {s.id}</Link>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1200px] flex-wrap justify-between gap-3 px-4 py-6 text-[12.5px] text-muted sm:px-6">
          <span>Built at HackInnovision 2026, Track B: agentic workflow automation and context engineering.</span>
          <span>The console talks to the FastAPI backend, and falls back to a built-in simulator when it is offline.</span>
        </div>
      </footer>
    </div>
  )
}

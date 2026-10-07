// The full guide: from a drawing to a priced bill, for someone who has never done a takeoff.
// Same steps as the in-app checklist (lib/guide/stages.ts), with the reasons spelled out.

import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/brand/Logo';
import { STAGES, GLOSSARY, FAQ } from '@/lib/guide/stages';

export const metadata: Metadata = {
  title: 'Guide: from a drawing to a priced bill',
  description: 'A step-by-step walkthrough of quantity takeoff and estimating in Foldrule: set the scale, measure, choose materials, set rates, export the bill, and handle revisions.',
  alternates: { canonical: '/guide' },
};

const WHERE = { workspace: 'In the workspace', summary: 'On the summary page', both: 'Workspace or summary page' } as const;

export default function GuidePage() {
  const main = STAGES.filter(s => !s.later);
  const later = STAGES.filter(s => s.later);
  return (
    <div className="min-h-screen bg-industrial-black text-zinc-200">
      <header className="h-16 border-b border-industrial-border bg-industrial-black/90 backdrop-blur-md px-5 md:px-8 flex items-center justify-between sticky top-0 z-50">
        <Link href="/" aria-label="Foldrule home"><Logo size={22} /></Link>
        <nav aria-label="Guide sections" className="hidden md:flex items-center gap-7 text-sm font-medium text-zinc-400">
          <a href="#idea" className="hover:text-white">The idea</a>
          <a href="#steps" className="hover:text-white">The steps</a>
          <a href="#later" className="hover:text-white">Later</a>
          <a href="#words" className="hover:text-white">Words</a>
          <a href="#faq" className="hover:text-white">Questions</a>
        </nav>
        <Link href="/dashboard" className="bg-rule hover:bg-[#F6CF55] text-black px-4 py-2 text-sm font-bold">Open my projects</Link>
      </header>

      <main className="px-4 md:px-8 max-w-4xl mx-auto pb-24">
        <section className="pt-14 md:pt-20">
          <p className="font-mono text-xs text-rule uppercase tracking-widest mb-4">Guide</p>
          <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-white text-balance">From a drawing to a priced bill</h1>
          <p className="mt-5 text-base md:text-lg text-zinc-400 leading-relaxed max-w-2xl">
            Eight steps, in the order they are done. You do not need to be a quantity surveyor to follow them.
            The same list lives inside the app as <b className="text-zinc-200">Guide</b>, where each step ticks itself off as you work.
          </p>
        </section>

        <section id="idea" className="mt-14 scroll-mt-20 border border-industrial-border bg-industrial-panel p-6 md:p-8">
          <h2 className="text-xl font-semibold text-white">The whole idea in one line</h2>
          <p className="mt-4 font-mono text-lg md:text-2xl text-center py-6">
            <span className="text-[#5B9BD5]">quantity</span> <span className="text-zinc-500">×</span> <span className="text-rule">rate</span> <span className="text-zinc-500">=</span> <span className="text-emerald-400">amount</span>
          </p>
          <div className="grid md:grid-cols-3 gap-5 text-sm leading-relaxed">
            <p><b className="text-[#5B9BD5]">Quantity</b> comes from the drawing. You measure it: 120 m² of floor, 86 m of wall, 14 doors. Steps 1 to 4.</p>
            <p><b className="text-rule">Rate</b> comes from you: what one m², one metre or one door costs, from supplier quotes or past jobs. Steps 5 to 7.</p>
            <p><b className="text-emerald-400">Amount</b> is worked out for every line and added up, with VAT, into the bill you send. Step 8.</p>
          </div>
        </section>

        <section id="steps" className="mt-16 scroll-mt-20">
          <h2 className="text-3xl font-semibold text-white tracking-tight">The eight steps</h2>
          <div className="w-14 h-1 bg-rule mt-5 mb-10" aria-hidden />
          <ol className="space-y-6">
            {main.map((s, i) => (
              <li key={s.id} id={s.id} className="scroll-mt-20 grid grid-cols-[3rem_1fr] gap-5 border border-industrial-border bg-industrial-panel p-6">
                <div className="w-12 h-12 flex items-center justify-center font-mono font-semibold border border-rule text-rule">0{i + 1}</div>
                <div>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h3 className="text-lg font-semibold text-white">{s.title}</h3>
                    <span className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">{WHERE[s.on]}</span>
                  </div>
                  <p className="mt-2 text-sm text-zinc-300 leading-relaxed"><b className="text-zinc-100">Why: </b>{s.why}</p>
                  <ol className="mt-3 list-decimal pl-5 space-y-1.5 text-sm text-zinc-400 leading-relaxed">
                    {s.how.map(h => <li key={h}>{h}</li>)}
                  </ol>
                  {s.tip && <p className="mt-3 border-l-2 border-rule pl-3 text-sm text-zinc-400"><b className="text-rule">Tip: </b>{s.tip}</p>}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section id="later" className="mt-16 scroll-mt-20">
          <h2 className="text-3xl font-semibold text-white tracking-tight">Later, when you need them</h2>
          <div className="w-14 h-1 bg-rule mt-5 mb-10" aria-hidden />
          <div className="grid md:grid-cols-2 gap-6">
            {later.map(s => (
              <div key={s.id} id={s.id} className="scroll-mt-20 border border-industrial-border bg-industrial-panel p-6">
                <h3 className="text-lg font-semibold text-white">{s.title}</h3>
                <p className="mt-2 text-sm text-zinc-300 leading-relaxed">{s.why}</p>
                <ol className="mt-3 list-decimal pl-5 space-y-1.5 text-sm text-zinc-400 leading-relaxed">
                  {s.how.map(h => <li key={h}>{h}</li>)}
                </ol>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-16 border border-industrial-border p-6 md:p-8">
          <h2 className="text-xl font-semibold text-white">What you still have to bring</h2>
          <ul className="mt-4 space-y-3 text-sm text-zinc-400 leading-relaxed list-disc pl-5">
            <li><b className="text-zinc-200">Prices.</b> No software knows what your supplier charges this month.</li>
            <li><b className="text-zinc-200">Your own percentages.</b> Preliminaries, contingency, overheads and profit are yours to judge; the Estimate page adds them once you say how much.</li>
            <li><b className="text-zinc-200">A second pair of eyes.</b> Before a bill goes out, have someone check the scale, the sections and the tax rate against your contract.</li>
          </ul>
        </section>

        <section id="words" className="mt-16 scroll-mt-20">
          <h2 className="text-3xl font-semibold text-white tracking-tight">Words you will meet</h2>
          <div className="w-14 h-1 bg-rule mt-5 mb-8" aria-hidden />
          <dl className="grid md:grid-cols-2 gap-x-10 gap-y-5 text-sm leading-relaxed">
            {GLOSSARY.map(([t, d]) => (
              <div key={t}>
                <dt className="font-semibold text-white">{t}</dt>
                <dd className="text-zinc-400 mt-1">{d}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="faq" className="mt-16 scroll-mt-20">
          <h2 className="text-3xl font-semibold text-white tracking-tight">Questions</h2>
          <div className="w-14 h-1 bg-rule mt-5 mb-8" aria-hidden />
          <div className="divide-y divide-industrial-border border-y border-industrial-border">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group py-4">
                <summary className="cursor-pointer list-none flex items-center justify-between gap-4 text-base font-semibold text-white">
                  {q}<span className="font-mono text-rule group-open:rotate-45 transition-transform" aria-hidden>+</span>
                </summary>
                <p className="mt-3 text-sm text-zinc-400 leading-relaxed max-w-3xl">{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="mt-16 border border-industrial-border bg-industrial-panel px-6 py-12 text-center">
          <h2 className="text-2xl font-semibold text-white">Try it on a real drawing</h2>
          <p className="mt-3 text-sm text-zinc-400">Open a plan and press Guide in the top bar. It will take you through these steps one at a time.</p>
          <Link href="/dashboard" className="mt-7 inline-block bg-rule hover:bg-[#F6CF55] text-black px-7 py-3.5 text-sm font-bold">Start a takeoff</Link>
        </section>
      </main>
    </div>
  );
}

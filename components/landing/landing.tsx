'use client';

// Landing page. The hero shows the product itself (a drawn workspace with a
// measured plan and its takeoff), not a stock photo. Every link goes somewhere
// real: there are no accounts, so the call to action opens the dashboard.

import React from 'react';
import Link from 'next/link';
import {
  ArrowRight, Layers, FileSpreadsheet, Maximize, Shapes, Wand2, Frame, FolderTree, Box,
  ShieldCheck, HardHat, Ruler, Calculator, Hammer, MousePointer2, Spline, Hash, Download,
  GitCompareArrows, PiggyBank, Landmark, Send, Copy, BrickWall, Stamp, Compass, ScanSearch,
} from 'lucide-react';
import { STAGES, FAQ } from '@/lib/guide/stages';
import * as motion from 'motion/react-m';
import { cn } from '@/lib/utils';
import { Logo } from '@/components/brand/Logo';
import { useAuth } from '@/context/AuthContext';

const NAV = [
  { label: 'Features',     href: '#features' },
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Gulf-ready',   href: '#gulf' },
  { label: 'Privacy',      href: '#privacy' },
  { label: 'Questions',    href: '#faq' },
  { label: 'Guide',        href: '/guide' },
];

const FEATURES = [
  { icon: Layers,          title: 'Snaps to the linework',     desc: 'Points lock onto the real geometry inside your PDF — endpoints, midpoints, corners, intersections and centres — so every measurement lands exactly on the drawing, at any zoom.' },
  { icon: Maximize,        title: 'A scale for every page',    desc: 'Calibrate each sheet from one known dimension, or pick 1:100 from the title block. Recalibrate later and everything already measured on that page updates.' },
  { icon: FileSpreadsheet, title: 'Excel BOQ with live formulas', desc: 'Amounts, group subtotals, VAT and the grand total are real Excel formulas — ready to send, check, or adjust with your own rates.' },
  { icon: Shapes,          title: 'Every measuring tool',      desc: 'Lengths, rectangles, polygons, arcs and polyarcs, counts and grid counts. Every tool has a key, and every step can be undone.' },
  { icon: Wand2,           title: 'Magic fill',                desc: 'Click inside a room and Foldrule traces its boundary for you, turning an enclosed space into a measured area in one click.' },
  { icon: Frame,           title: 'Perimeter offsets',         desc: 'Offset any outline inwards or outwards to measure skirting, edge trims, wall centrelines and set-backs without redrawing.' },
  { icon: FolderTree,      title: 'Groups, rates and materials', desc: 'Organise quantities into groups, attach unit rates and materials from your library, and watch the totals price themselves as you measure.' },
  { icon: Box,             title: 'Joinery presets',           desc: 'Reuse presets for the items you price again and again, with a live 3D preview to check the build before it goes into the takeoff.' },
  { icon: ShieldCheck,     title: 'Private by design',         desc: 'Drawings open straight in your browser and never upload. Projects save automatically on your computer — optionally into a folder you choose.' },
];

const MORE = [
  { icon: BrickWall,        title: 'Assemblies and deductions', desc: 'Draw a wall once and get blockwork, plaster, paint and skirting, with door and window openings taken off. Change the line and every quantity follows.' },
  { icon: Copy,             title: 'Multipliers',               desc: 'Six identical flats? Measure one and give the page, group or row a “× 6”. The bill shows the multiplied quantity and says so.' },
  { icon: ScanSearch,       title: 'Scale read and checked',    desc: 'Foldrule reads the scale written on the sheet and offers it. After calibrating, draw along a second printed dimension. Foldrule tells you if the two disagree before a wrong scale reaches the bill.' },
  { icon: GitCompareArrows, title: 'Drawing revisions',         desc: 'Lay a revised plan over the old one: removed in red, added in blue, unchanged in grey. Measurements that still fit carry over; the rest are flagged to check. Every version is kept.' },
  { icon: PiggyBank,        title: 'Value engineering',         desc: 'Over budget? Propose an equivalent, cheaper material and see the saving across the whole takeoff. Accept or reject it; the designed material can always be put back.' },
  { icon: Landmark,         title: 'Your own price bank',       desc: 'Prices you enter are remembered, saved in your projects folder, and offered on the next project. Where a job is priced differently, both prices are shown and you choose.' },
  { icon: Send,             title: 'Price requests',            desc: 'Download the materials and quantities as a sheet to send to suppliers, then import their reply. A supplier’s own price list can be matched by name or code.' },
  { icon: Stamp,            title: 'Marked-up PDF',             desc: 'Export the drawing with every measurement drawn on it and a legend, so anyone can see where each number came from.' },
  { icon: Calculator,       title: 'From cost to tender price', desc: 'Add preliminaries, provisional sums, contingency, overheads and profit on top of the measured work, and see the tender sum before and after VAT.' },
  { icon: Box,              title: 'Waste and pack sizes',      desc: 'Tiles sold by the box, blocks by the piece: say what one covers and how much is wasted. The rate is worked out, and a buying list tells you how many to order.' },
  { icon: ShieldCheck,      title: 'Checks and a change log',   desc: 'Unlikely numbers are flagged: a suspicious scale, a shape measured twice, a rate far from your usual. Every change is logged with who made it and when.' },
  { icon: Compass,          title: 'A guide that follows you',  desc: 'An eight-step checklist inside the app ticks itself off as you work and points at the button to press next. No training course needed.' },
];

const GULF = [
  ['Bill in POMI-style sections', 'The Bill of Quantities is arranged in the lettered work sections estimators in the region expect, with quantities rounded for billing.'],
  ['Gulf currencies', 'AED, SAR, QAR, OMR, BHD and KWD, with three decimals where the currency uses them.'],
  ['VAT suggested, never forced', 'Choosing a currency suggests that country’s usual VAT rate. Change it for zero-rated or exempt work.'],
  ['Metric throughout', 'Metres, square metres and cubic metres from calibration to export.'],
];

const AUDIENCE = [
  { icon: Calculator, name: 'Estimators' },
  { icon: Ruler,      name: 'Quantity surveyors' },
  { icon: HardHat,    name: 'Contractors' },
  { icon: Hammer,     name: 'Joinery shops' },
];

export function Landing() {
  const { status, signOut } = useAuth();
  // Signed in (or accounts not configured) → straight to the projects.
  const inApp   = status === 'signed-in' || status === 'local';
  const startHref  = inApp ? '/dashboard' : '/register';
  const startLabel = inApp ? 'Open my projects' : 'Start free';
  return (
    <div className="min-h-screen bg-industrial-black text-zinc-200 selection:bg-rule/30">
      <div className="fixed inset-0 blueprint-grid opacity-[0.07] pointer-events-none" aria-hidden />

      <header className="h-16 border-b border-industrial-border bg-industrial-black/90 backdrop-blur-md px-5 md:px-8 flex items-center justify-between sticky top-0 z-50">
        <Link href="/" aria-label="Foldrule home"><Logo size={22} /></Link>

        <nav aria-label="Page sections" className="hidden md:flex items-center gap-8 text-sm font-medium">
          {NAV.map(link => (
            <a key={link.label} href={link.href} className="text-zinc-400 hover:text-white transition-colors">
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-5">
          {!inApp && (
            <Link href="/login" className="text-sm font-semibold text-zinc-300 hover:text-white transition-colors">Log in</Link>
          )}
          {status === 'signed-in' && (
            <button type="button" onClick={() => void signOut()} className="text-sm font-semibold text-zinc-300 hover:text-white transition-colors">Log out</button>
          )}
          <Link
            href={startHref}
            className="bg-rule hover:bg-[#F6CF55] text-black px-4 py-2 text-sm font-bold transition-colors flex items-center gap-2"
          >
            {startLabel}
            <ArrowRight className="w-4 h-4" aria-hidden />
          </Link>
        </div>
      </header>

      <main className="relative z-10 px-4 md:px-8">
        {/* ── Hero ── */}
        <section className="flex flex-col items-center text-center pt-16 md:pt-24 max-w-4xl mx-auto">
          <motion.p
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2 border border-industrial-border px-3 py-1.5 mb-7 bg-industrial-panel font-mono text-xs text-zinc-400"
          >
            <span className="w-1.5 h-1.5 bg-rule" aria-hidden />
            Free account · runs in your browser · nothing to install
          </motion.p>

          <motion.h1
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
            className="text-4xl sm:text-5xl md:text-6xl font-semibold tracking-tight leading-[1.08] text-white text-balance"
          >
            Measure the drawing. <span className="text-rule">Price the job.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
            className="mt-6 text-base md:text-lg text-zinc-400 max-w-2xl leading-relaxed"
          >
            Foldrule is quantity takeoff for PDF drawings. Tools snap to the linework, every page
            keeps its own scale, and the result exports as a priced BOQ in Excel — without your
            drawings ever leaving your computer. New to estimating? A built-in guide takes you from the plan to the bill, one step at a time.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
            className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3 w-full"
          >
            <Link
              href={startHref}
              className="w-full sm:w-auto bg-rule hover:bg-[#F6CF55] text-black px-7 py-3.5 text-sm font-bold transition-colors flex items-center justify-center gap-2"
            >
              Start a takeoff
              <ArrowRight className="w-4 h-4" aria-hidden />
            </Link>
            <a
              href="#how-it-works"
              className="w-full sm:w-auto text-center border border-industrial-border hover:border-zinc-500 bg-industrial-panel px-7 py-3.5 text-sm font-semibold text-zinc-200 transition-colors"
            >
              See how it works
            </a>
          </motion.div>
        </section>

        {/* ── Product preview ── */}
        <motion.section
          initial={{ opacity: 0, y: 28 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
          className="mt-14 md:mt-20 w-full max-w-6xl mx-auto"
          aria-label="Preview of the Foldrule workspace"
        >
          <WorkspacePreview />
        </motion.section>

        {/* ── Who it's for ── */}
        <section className="mt-20 max-w-6xl mx-auto border-y border-industrial-border py-8 flex flex-col md:flex-row items-center justify-between gap-6">
          <p className="text-sm text-zinc-500">Built for the people who price the work</p>
          <ul className="flex flex-wrap justify-center gap-x-10 gap-y-3">
            {AUDIENCE.map(a => (
              <li key={a.name} className="flex items-center gap-2 text-sm font-medium text-zinc-300">
                <a.icon className="w-4 h-4 text-zinc-500" aria-hidden />
                {a.name}
              </li>
            ))}
          </ul>
        </section>

        {/* ── Features ── */}
        <section id="features" className="w-full max-w-6xl mx-auto py-20 md:py-24 scroll-mt-16">
          <h2 className="text-3xl md:text-4xl font-semibold text-white tracking-tight max-w-2xl text-balance">
            Everything between the PDF and the priced BOQ
          </h2>
          <div className="w-14 h-1 bg-rule mt-5 mb-12" aria-hidden />

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-industrial-border border border-industrial-border">
            {FEATURES.map(feat => (
              <div key={feat.title} className="p-7 bg-industrial-panel group transition-colors hover:bg-[#22272C]">
                <div className="w-10 h-10 border border-[#3A4148] flex items-center justify-center mb-5 text-rule group-hover:bg-rule group-hover:text-black transition-colors">
                  <feat.icon className="w-[18px] h-[18px]" aria-hidden />
                </div>
                <h3 className="text-base font-semibold text-white mb-2">{feat.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">{feat.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── How it works ── */}
        <section id="how-it-works" className="w-full max-w-6xl mx-auto py-20 md:py-24 border-t border-industrial-border scroll-mt-16">
          <h2 className="text-3xl md:text-4xl font-semibold text-white tracking-tight">From a drawing to a priced bill in eight steps</h2>
          <p className="mt-4 text-sm md:text-base text-zinc-400 max-w-2xl leading-relaxed">
            Quantity comes from the drawing, the rate comes from you, and the amount is worked out. The app walks you through each step and ticks it off.
          </p>
          <div className="w-14 h-1 bg-rule mt-5 mb-12" aria-hidden />

          <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-10">
            {STAGES.filter(st => !st.later).map((step, i, arr) => (
              <li key={step.id}>
                <div className={cn(
                  'w-12 h-12 flex items-center justify-center mb-5 font-mono font-semibold text-base',
                  i === arr.length - 1 ? 'bg-rule text-black' : 'border border-rule text-rule',
                )}>
                  0{i + 1}
                </div>
                <h3 className="text-base font-semibold text-white mb-2">{step.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">{step.short}</p>
              </li>
            ))}
          </ol>
          <Link href="/guide" className="mt-12 inline-flex items-center gap-2 border border-industrial-border hover:border-rule bg-industrial-panel px-6 py-3 text-sm font-semibold text-zinc-200 transition-colors">
            Read the full walkthrough
            <ArrowRight className="w-4 h-4" aria-hidden />
          </Link>
        </section>

        {/* ── Beyond the first estimate ── */}
        <section className="w-full max-w-6xl mx-auto py-20 md:py-24 border-t border-industrial-border">
          <h2 className="text-3xl md:text-4xl font-semibold text-white tracking-tight max-w-2xl text-balance">
            For the work that comes after the first measure
          </h2>
          <div className="w-14 h-1 bg-rule mt-5 mb-12" aria-hidden />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-industrial-border border border-industrial-border">
            {MORE.map(feat => (
              <div key={feat.title} className="p-7 bg-industrial-panel group transition-colors hover:bg-[#22272C]">
                <div className="w-10 h-10 border border-[#3A4148] flex items-center justify-center mb-5 text-rule group-hover:bg-rule group-hover:text-black transition-colors">
                  <feat.icon className="w-[18px] h-[18px]" aria-hidden />
                </div>
                <h3 className="text-base font-semibold text-white mb-2">{feat.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">{feat.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Gulf ── */}
        <section id="gulf" className="w-full max-w-6xl mx-auto py-20 md:py-24 border-t border-industrial-border scroll-mt-16">
          <div className="grid lg:grid-cols-[1fr_1.2fr] gap-10 items-start">
            <div>
              <h2 className="text-3xl md:text-4xl font-semibold text-white tracking-tight text-balance">Made for estimating in the Gulf</h2>
              <div className="w-14 h-1 bg-rule mt-5" aria-hidden />
              <p className="mt-6 text-sm text-zinc-500 leading-relaxed">
                Have your surveyor confirm the bill layout and tax rate against your contract before a bill is issued.
              </p>
            </div>
            <dl className="space-y-6 text-sm leading-relaxed">
              {GULF.map(([t, d]) => (
                <div key={t} className="flex gap-4">
                  <span className="w-1.5 h-1.5 bg-rule shrink-0 mt-2" aria-hidden />
                  <div>
                    <dt className="font-semibold text-white">{t}</dt>
                    <dd className="text-zinc-400 mt-1">{d}</dd>
                  </div>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ── Privacy ── */}
        <section id="privacy" className="w-full max-w-6xl mx-auto py-20 md:py-24 border-t border-industrial-border scroll-mt-16">
          <div className="grid lg:grid-cols-[1fr_1.2fr] gap-10 items-start">
            <div>
              <h2 className="text-3xl md:text-4xl font-semibold text-white tracking-tight text-balance">
                Your drawings never leave your computer
              </h2>
              <div className="w-14 h-1 bg-rule mt-5" aria-hidden />
            </div>
            <dl className="space-y-6 text-sm leading-relaxed">
              {[
                ['No upload', 'PDFs are opened and measured inside your browser. There is no server copy of your drawings or quantities.'],
                ['The account only signs you in', 'Your free account says who you are. Your drawings and quantities are not stored with it.'],
                ['Saved where you choose', 'Projects autosave in the browser. In Edge or Chrome you can also mirror them into a folder — the browser tab and the installed app share the same one.'],
                ['Yours to move', 'Download a project as a single backup file and open it on any other computer.'],
              ].map(([t, d]) => (
                <div key={t} className="flex gap-4">
                  <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" aria-hidden />
                  <div>
                    <dt className="font-semibold text-white">{t}</dt>
                    <dd className="text-zinc-400 mt-1">{d}</dd>
                  </div>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ── Questions ── */}
        <section id="faq" className="w-full max-w-6xl mx-auto py-20 md:py-24 border-t border-industrial-border scroll-mt-16">
          <h2 className="text-3xl md:text-4xl font-semibold text-white tracking-tight">Questions people ask first</h2>
          <div className="w-14 h-1 bg-rule mt-5 mb-8" aria-hidden />
          <div className="divide-y divide-industrial-border border-y border-industrial-border max-w-4xl">
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

        {/* ── Closing call to action ── */}
        <section className="w-full max-w-6xl mx-auto mb-20 border border-industrial-border bg-industrial-panel px-6 py-12 md:py-14 text-center">
          <h2 className="text-2xl md:text-3xl font-semibold text-white tracking-tight">Have a drawing to price?</h2>
          <p className="mt-3 text-sm text-zinc-400">Open it now — it takes about a minute to get your first quantity.</p>
          <Link
            href={startHref}
            className="mt-7 inline-flex items-center gap-2 bg-rule hover:bg-[#F6CF55] text-black px-7 py-3.5 text-sm font-bold transition-colors"
          >
            Start a takeoff
            <ArrowRight className="w-4 h-4" aria-hidden />
          </Link>
        </section>
      </main>

      <footer className="relative z-10 border-t border-industrial-border py-8 px-5 md:px-8 flex flex-col md:flex-row justify-between items-center gap-5">
        <div className="flex flex-col items-center md:items-start gap-2">
          <Logo size={18} />
          <span className="text-xs text-zinc-500">© {new Date().getFullYear()} Foldrule · PDF takeoff and BOQ, in your browser</span>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap justify-center items-center gap-6 text-sm text-zinc-400">
          {NAV.map(l => <a key={l.label} href={l.href} className="hover:text-white transition-colors">{l.label}</a>)}
          <Link href={inApp ? '/dashboard' : '/login'} className="hover:text-white transition-colors">{inApp ? 'My projects' : 'Log in'}</Link>
        </nav>
      </footer>
    </div>
  );
}

// ─── Hero illustration: the workspace, drawn ─────────────────────────────────

// One floor of a house at 40 units per metre: tiled living / dining / kitchen
// (with a curved bay and a column cut out), a vinyl hall, two carpeted
// bedrooms, a bathroom and a stair. It shows each kind of measuring at once:
// grouped areas, a cut-out, a curved edge, a length run, counted symbols.
const C = { tile: '#5B9BD5', hall: '#F2C230', carpet: '#6FBF8B', wet: '#C77DBA', run: '#E0875A', count: '#34D399', sock: '#F472B6' };

const ROOMS = [
  // d: outline (evenodd, so the column in Living is a hole)
  { name: 'Living',    area: '35.25', fill: C.tile,   d: 'M40 50H330V250H40ZM150 120V160H190V120Z', lx: 250, ly: 105 },
  { name: 'Dining',    area: '23.75', fill: C.tile,   d: 'M330 50H520V250H330Z',                    lx: 425, ly: 90 },
  { name: 'Kitchen',   area: '24.07', fill: C.tile,   d: 'M520 50H700V90A75 75 0 0 1 700 210V250H520Z', lx: 600, ly: 205 },
  { name: 'Hall',      area: '24.75', fill: C.hall,   d: 'M40 250H700V310H40Z',                      lx: 90, ly: 280 },
  { name: 'Bedroom 1', area: '18.38', fill: C.carpet, d: 'M40 310H250V450H40Z',                      lx: 190, ly: 420 },
  { name: 'Bath',      area: '10.50', fill: C.wet,    d: 'M250 310H370V450H250Z',                    lx: 310, ly: 425 },
  { name: 'Bedroom 2', area: '16.63', fill: C.carpet, d: 'M370 310H560V450H370Z',                    lx: 505, ly: 420 },
];

// Doors: [x, y, 'h' | 'v'] — the gap starts at (x, y) and is 40 long.
const DOORS: [number, number, 'h' | 'v'][] = [
  [200, 250, 'h'], [400, 250, 'h'], [600, 250, 'h'],
  [150, 310, 'h'], [290, 310, 'h'], [450, 310, 'h'], [610, 310, 'h'],
  [330, 140, 'v'], [520, 110, 'v'],
];
const SOCKETS: [number, number][] = [[60, 70], [310, 70], [60, 230], [350, 230], [500, 70], [540, 70], [680, 232], [60, 330], [230, 430], [390, 330], [540, 430]];

type Row = { d: string; q: string; u: string; c: string; sub?: boolean; note?: string };
const ROWS: Row[] = [
  { d: 'Floor tile — ground', q: '83.07', u: 'm²', c: C.tile, note: '3' },
  { d: 'Living (less column)',      q: '35.25', u: 'm²', c: C.tile, sub: true },
  { d: 'Dining',                    q: '23.75', u: 'm²', c: C.tile, sub: true },
  { d: 'Kitchen, curved bay',       q: '24.07', u: 'm²', c: C.tile, sub: true },
  { d: 'Carpet — bedrooms',         q: '35.01', u: 'm²', c: C.carpet, note: '2' },
  { d: 'Vinyl — hall',              q: '24.75', u: 'm²', c: C.hall },
  { d: 'Wet-area tile — bath',      q: '10.50', u: 'm²', c: C.wet },
  { d: 'Skirting — bedroom 1',      q: '17.50', u: 'm',  c: C.run },
  { d: 'Slab, 150 thick',           q: '23.00', u: 'm³', c: '#9AA4AE' },
  { d: 'Internal doors (found)',    q: '9',     u: 'nr', c: C.count },
  { d: 'Sockets',                   q: '11',    u: 'nr', c: C.sock },
];

function WorkspacePreview() {
  const mono = 'var(--font-jetbrains), monospace';
  return (
    <div className="border border-industrial-border bg-industrial-panel shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]">
      {/* title bar */}
      <div className="h-10 border-b border-industrial-border flex items-center justify-between px-4">
        <div className="flex items-center gap-3 min-w-0">
          <Logo size={14} />
          <span className="font-mono text-xs text-zinc-400 truncate">Colombo Residence — Ground floor</span>
        </div>
        <div className="hidden sm:flex items-center gap-3 font-mono text-[11px]">
          <span className="text-zinc-500">Scale <span className="text-rule font-semibold">1:100</span></span>
          <span className="flex items-center gap-1.5 text-zinc-500"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Saved</span>
          <span className="bg-rule text-black font-bold px-2 py-1 flex items-center gap-1"><Download className="w-3 h-3" aria-hidden />Excel</span>
        </div>
      </div>

      <div className="flex">
        {/* tool rail */}
        <div className="hidden sm:flex flex-col items-center gap-1 w-11 border-r border-industrial-border py-3 text-zinc-500">
          {[MousePointer2, Shapes, Ruler, Spline, Hash, Wand2].map((Icon, i) => (
            <span key={i} className={cn('w-8 h-8 flex items-center justify-center', i === 1 && 'bg-rule text-black')}>
              <Icon className="w-4 h-4" aria-hidden />
            </span>
          ))}
        </div>

        {/* drawing */}
        <div className="flex-1 min-w-0 bg-[#E6E9EC] relative">
          <svg viewBox="0 0 760 500" className="block w-full h-auto" role="img"
            aria-label="A measured floor plan: three tiled rooms grouped under one item with a column cut out and a curved bay, a hall, two carpeted bedrooms and a bathroom, a skirting run measured as a length, nine doors found and counted, and eleven sockets counted">
            <defs>
              <pattern id="lp-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M20 0H0V20" fill="none" stroke="#C9CED3" strokeWidth="0.5" />
              </pattern>
              <pattern id="lp-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <path d="M0 0V6" stroke="#56606B" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width="760" height="500" fill="url(#lp-grid)" />

            {/* measured areas (the column in Living is a cut-out) */}
            {ROOMS.map(r => (
              <path key={r.name} d={r.d} fillRule="evenodd" fill={r.fill} fillOpacity="0.4" stroke={r.fill} strokeWidth="1.5" />
            ))}
            <rect x="150" y="120" width="40" height="40" fill="url(#lp-hatch)" stroke="#1D2125" strokeWidth="1.5" />

            {/* furniture and fittings, as on a real sheet */}
            <g fill="none" stroke="#7A848F" strokeWidth="1">
              <rect x="60" y="180" width="110" height="38" rx="5" /><rect x="68" y="186" width="94" height="20" rx="3" />
              <rect x="225" y="165" width="60" height="34" /><ellipse cx="425" cy="165" rx="52" ry="30" />
              {[[380, 128], [425, 122], [470, 128], [380, 202], [425, 208], [470, 202]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="8" />)}
              <path d="M540 60H690V84H564V180H540Z" /><circle cx="640" cy="72" r="7" /><circle cx="664" cy="72" r="7" /><rect x="544" y="120" width="16" height="30" />
              <rect x="60" y="340" width="80" height="96" /><rect x="66" y="346" width="30" height="18" rx="3" /><rect x="104" y="346" width="30" height="18" rx="3" />
              <rect x="390" y="345" width="80" height="92" /><rect x="396" y="351" width="68" height="18" rx="3" />
              <rect x="262" y="392" width="46" height="48" rx="8" /><ellipse cx="344" cy="335" rx="14" ry="10" /><rect x="262" y="320" width="26" height="30" rx="4" />
              <path d="M572 450V322M584 322V450M596 322V450M608 322V450M620 322V450M632 322V450M644 322V450M656 322V450M668 322V450M680 322V450M572 386H690" />
            </g>

            {/* walls */}
            <g fill="none" stroke="#1D2125" strokeLinejoin="miter">
              <path d="M40 50H700V90A75 75 0 0 1 700 210V450H40Z" strokeWidth="5" />
              <path d="M330 50V140M330 180V250M520 50V110M520 150V250M40 250H200M240 250H400M440 250H600M640 250H700M40 310H150M190 310H290M330 310H450M490 310H610M650 310H700M250 310V450M370 310V450M560 310V450" strokeWidth="3" />
            </g>

            {/* doors: leaf + swing, each boxed and numbered by Find & count */}
            {DOORS.map(([x, y, o], i) => (
              <g key={i}>
                <path d={o === 'h' ? `M${x} ${y}V${y + 40}A40 40 0 0 0 ${x + 40} ${y}` : `M${x} ${y}H${x + 40}A40 40 0 0 1 ${x} ${y + 40}`} fill="none" stroke="#56606B" strokeWidth="1" />
                <rect x={x - 3} y={y - 3} width="46" height="46" fill="none" stroke={C.count} strokeWidth="1.5" />
                <circle cx={x - 3} cy={y - 3} r="7" fill={C.count} />
                <text x={x - 3} y={y} textAnchor="middle" fontFamily={mono} fontSize="8.5" fontWeight="700" fill="#06281C">{i + 1}</text>
              </g>
            ))}

            {/* sockets: a simple click-to-count */}
            {SOCKETS.map(([x, y], i) => (
              <g key={i}><circle cx={x} cy={y} r="5.5" fill={C.sock} fillOpacity="0.35" stroke={C.sock} strokeWidth="1.5" /><path d={`M${x - 3} ${y}H${x + 3}`} stroke="#7A1746" strokeWidth="1.2" /></g>
            ))}

            {/* a length run: skirting round Bedroom 1 */}
            <path d="M46 316H244V444H46Z" fill="none" stroke={C.run} strokeWidth="3" strokeDasharray="9 5" />
            <g fontFamily={mono}><rect x="52" y="319" width="92" height="15" fill={C.run} /><text x="98" y="329.5" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#2A1206">SKIRTING 17.50 m</text></g>

            {/* dimensions */}
            <g stroke="#56606B" strokeWidth="1" fill="#56606B" fontFamily={mono} fontSize="9">
              <path d="M40 30H700M40 24V36M700 24V36M20 50V450M14 50H26M14 450H26" fill="none" />
              <text x="370" y="24" textAnchor="middle" stroke="none">16 500</text>
              <text x="14" y="254" textAnchor="middle" stroke="none" transform="rotate(-90 14 254)">10 000</text>
            </g>

            {/* area labels */}
            {ROOMS.map(r => (
              <g key={r.name} fontFamily={mono} textAnchor="middle">
                <rect x={r.lx - 36} y={r.ly - 16} width="72" height="30" fill="#16191C" />
                <text x={r.lx} y={r.ly - 4} fontSize="8" fill="#9AA4AE">{r.name}</text>
                <text x={r.lx} y={r.ly + 9} fontSize="10" fontWeight="700" fill={r.fill}>{r.area} m²</text>
              </g>
            ))}
            {/* notes on the cut-out and the curved edge */}
            <g fontFamily={mono} fontSize="8" fill="#1D2125">
              <text x="170" y="174" textAnchor="middle">COLUMN −1.00</text>
              <text x="706" y="153" textAnchor="middle" fill="#134B7A" fontWeight="700">ARC</text>
            </g>

            {/* snapping to a corner of the drawing */}
            <g>
              <circle cx="520" cy="250" r="9" fill="none" stroke="#B8322A" strokeWidth="1.5" />
              <rect x="516.5" y="246.5" width="7" height="7" fill="#B8322A" />
              <g fontFamily={mono} fontSize="8.5"><rect x="531" y="256" width="54" height="15" fill="#B8322A" /><text x="558" y="266.5" textAnchor="middle" fill="#fff">ENDPOINT</text></g>
            </g>

            {/* what is being measured into, and the count result */}
            <g fontFamily={mono}>
              <rect x="48" y="58" width="232" height="20" fill="#16191C" stroke="#3A424B" />
              <circle cx="60" cy="68" r="4" fill={C.tile} />
              <text x="70" y="71.5" fontSize="8" fill="#9AA4AE">ADDING TO</text>
              <text x="122" y="71.5" fontSize="9" fontWeight="700" fill="#fff">Floor tile</text>
              <text x="272" y="71.5" fontSize="9" textAnchor="end" fill="#F2C230">83.07 m² · 3</text>
              <rect x="574" y="462" width="126" height="20" fill="#16191C" stroke="#3A424B" />
              <text x="582" y="475.5" fontSize="8" fill="#F2C230">FIND &amp; COUNT</text>
              <text x="692" y="475.5" fontSize="9" textAnchor="end" fontWeight="700" fill={C.count}>9 found</text>
            </g>
          </svg>
        </div>

        {/* takeoff */}
        <div className="hidden md:flex flex-col w-72 border-l border-industrial-border">
          <div className="px-4 py-3 border-b border-industrial-border flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-200">Takeoff</span>
            <span className="font-mono text-[11px] text-zinc-500">8 items</span>
          </div>
          <ul className="flex-1 divide-y divide-industrial-border/70">
            {ROWS.map(r => (
              <li key={r.d} className={cn('py-2 flex items-center gap-3', r.sub ? 'pl-9 pr-4 bg-industrial-black/40' : 'px-4')}>
                <span className={cn('shrink-0', r.sub ? 'w-1.5 h-1.5 rounded-full' : 'w-2.5 h-2.5')} style={{ background: r.c }} aria-hidden />
                <span className={cn('flex-1 truncate text-left', r.sub ? 'text-[11px] text-zinc-400' : 'text-xs text-zinc-300')}>
                  {r.d}{r.note && <span className="ml-1.5 font-mono text-[10px] text-zinc-500">({r.note})</span>}
                </span>
                <span className={cn('font-mono tabular-nums', r.sub ? 'text-[11px] text-zinc-400' : 'text-xs text-white')}>{r.q}</span>
                <span className="font-mono text-[11px] text-zinc-500 w-5 text-left">{r.u}</span>
              </li>
            ))}
          </ul>
          <div className="px-4 py-3 border-t border-industrial-border flex items-center justify-between bg-industrial-black">
            <span className="text-xs text-zinc-400">Total incl. VAT</span>
            <span className="font-mono text-sm font-bold text-rule tabular-nums">LKR 3,912,400</span>
          </div>
        </div>
      </div>
    </div>
  );
}

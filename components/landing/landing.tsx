'use client';

// Landing page. The hero shows the product itself (a drawn workspace with a
// measured plan and its takeoff), not a stock photo. Every link goes somewhere
// real: there are no accounts, so the call to action opens the dashboard.

import React from 'react';
import Link from 'next/link';
import {
  ArrowRight, Layers, FileSpreadsheet, Maximize, Shapes, Wand2, Frame, FolderTree, Box,
  ShieldCheck, HardHat, Ruler, Calculator, Hammer, MousePointer2, Spline, Hash, Download,
} from 'lucide-react';
import * as motion from 'motion/react-m';
import { cn } from '@/lib/utils';
import { Logo } from '@/components/brand/Logo';
import { useAuth } from '@/context/AuthContext';

const NAV = [
  { label: 'Features',     href: '#features' },
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Privacy',      href: '#privacy' },
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

const STEPS = [
  { title: 'Open a PDF',  desc: 'Drop in single sheets or a full multi-page set. The linework is read straight away for snapping.' },
  { title: 'Set the scale', desc: 'Click two points on a known dimension and type its length. Each page keeps its own scale.' },
  { title: 'Measure',     desc: 'Trace areas, lengths and counts. Group them and add rates — the BOQ builds as you go.' },
  { title: 'Export',      desc: 'Download a priced BOQ workbook for Excel, with live formulas, subtotals and VAT.' },
];

const AUDIENCE = [
  { icon: Calculator, name: 'Estimators' },
  { icon: Ruler,      name: 'Quantity surveyors' },
  { icon: HardHat,    name: 'Contractors' },
  { icon: Hammer,     name: 'Joinery shops' },
];

export function Landing() {
  const { status } = useAuth();
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
            drawings ever leaving your computer.
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
          <h2 className="text-3xl md:text-4xl font-semibold text-white tracking-tight">From PDF to BOQ in four steps</h2>
          <div className="w-14 h-1 bg-rule mt-5 mb-12" aria-hidden />

          <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
            {STEPS.map((step, i) => (
              <li key={step.title}>
                <div className={cn(
                  'w-12 h-12 flex items-center justify-center mb-5 font-mono font-semibold text-base',
                  i === STEPS.length - 1 ? 'bg-rule text-black' : 'border border-rule text-rule',
                )}>
                  0{i + 1}
                </div>
                <h3 className="text-base font-semibold text-white mb-2">{step.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">{step.desc}</p>
              </li>
            ))}
          </ol>
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

const ROOMS = [
  { name: 'Living',   area: '31.20', pts: '40,40 300,40 300,220 40,220',    fill: '#5B9BD5', lx: 170, ly: 130 },
  { name: 'Kitchen',  area: '14.85', pts: '300,40 470,40 470,150 300,150',  fill: '#F2C230', lx: 385, ly: 95 },
  { name: 'Bedroom',  area: '16.40', pts: '300,150 470,150 470,320 360,320 360,220 300,220', fill: '#6FBF8B', lx: 412, ly: 235 },
  { name: 'Bath',     area: '6.30',  pts: '40,220 170,220 170,320 40,320',  fill: '#C77DBA', lx: 105, ly: 270 },
  { name: 'Hall',     area: '13.30', pts: '170,220 360,220 360,320 170,320', fill: '#E0875A', lx: 265, ly: 270 },
];

const ROWS = [
  { d: 'Floor finish — Living',  q: '31.20', u: 'm²', c: '#5B9BD5' },
  { d: 'Floor finish — Kitchen', q: '14.85', u: 'm²', c: '#F2C230' },
  { d: 'Floor finish — Bedroom', q: '16.40', u: 'm²', c: '#6FBF8B' },
  { d: 'Wall tiling — Bath',     q: '6.30',  u: 'm²', c: '#C77DBA' },
  { d: 'Skirting',               q: '64.80', u: 'm',  c: '#E0875A' },
  { d: 'Internal doors',         q: '5',     u: 'nr', c: '#9AA4AE' },
];

function WorkspacePreview() {
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
          <svg viewBox="0 0 510 360" className="block w-full h-auto" role="img" aria-label="A floor plan with five measured rooms, each filled with a colour and labelled with its area">
            <defs>
              <pattern id="lp-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M20 0H0V20" fill="none" stroke="#C9CED3" strokeWidth="0.5" />
              </pattern>
            </defs>
            <rect width="510" height="360" fill="url(#lp-grid)" />
            {ROOMS.map(r => (
              <polygon key={r.name} points={r.pts} fill={r.fill} fillOpacity="0.42" stroke={r.fill} strokeWidth="1.5" />
            ))}
            {/* walls */}
            <g fill="none" stroke="#1D2125" strokeLinejoin="miter">
              <path d="M40 40H470V320H40Z" strokeWidth="5" />
              <path d="M300 40V130M300 165V220M40 220H110M150 220H300M170 220V320M360 220V250M360 290V320M300 150H400M440 150H470M300 220H360" strokeWidth="3" />
            </g>
            {/* door swings */}
            <g fill="none" stroke="#56606B" strokeWidth="1">
              <path d="M300 130A35 35 0 0 1 335 165" /><path d="M110 220A40 40 0 0 1 150 260" /><path d="M360 250A40 40 0 0 0 320 290" />
            </g>
            {/* dimension line */}
            <g stroke="#56606B" strokeWidth="1" fill="#56606B" fontFamily="var(--font-jetbrains), monospace" fontSize="9">
              <path d="M40 22H470M40 16V28M470 16V28" fill="none" />
              <text x="255" y="16" textAnchor="middle" stroke="none">12 400</text>
            </g>
            {/* area labels */}
            {ROOMS.map(r => (
              <g key={r.name} fontFamily="var(--font-jetbrains), monospace" textAnchor="middle">
                <rect x={r.lx - 34} y={r.ly - 17} width="68" height="32" fill="#16191C" />
                <text x={r.lx} y={r.ly - 4} fontSize="8.5" fill="#9AA4AE">{r.name}</text>
                <text x={r.lx} y={r.ly + 9} fontSize="10.5" fontWeight="700" fill={r.fill}>{r.area} m²</text>
              </g>
            ))}
            {/* snap marker on the polygon being traced */}
            <g>
              <circle cx="470" cy="150" r="9" fill="none" stroke="#B8322A" strokeWidth="1.5" />
              <rect x="466.5" y="146.5" width="7" height="7" fill="#B8322A" />
              <g fontFamily="var(--font-jetbrains), monospace" fontSize="8.5">
                <rect x="408" y="126" width="54" height="15" fill="#B8322A" />
                <text x="435" y="136.5" textAnchor="middle" fill="#fff">ENDPOINT</text>
              </g>
            </g>
          </svg>
        </div>

        {/* takeoff */}
        <div className="hidden md:flex flex-col w-72 border-l border-industrial-border">
          <div className="px-4 py-3 border-b border-industrial-border flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-200">Takeoff</span>
            <span className="font-mono text-[11px] text-zinc-500">6 items</span>
          </div>
          <ul className="flex-1 divide-y divide-industrial-border/70">
            {ROWS.map(r => (
              <li key={r.d} className="px-4 py-2.5 flex items-center gap-3">
                <span className="w-2.5 h-2.5 shrink-0" style={{ background: r.c }} aria-hidden />
                <span className="text-xs text-zinc-300 flex-1 truncate text-left">{r.d}</span>
                <span className="font-mono text-xs text-white tabular-nums">{r.q}</span>
                <span className="font-mono text-[11px] text-zinc-500 w-5 text-left">{r.u}</span>
              </li>
            ))}
          </ul>
          <div className="px-4 py-3 border-t border-industrial-border flex items-center justify-between bg-industrial-black">
            <span className="text-xs text-zinc-400">Total incl. VAT</span>
            <span className="font-mono text-sm font-bold text-rule tabular-nums">LKR 1,284,600</span>
          </div>
        </div>
      </div>
    </div>
  );
}

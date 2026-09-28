// Public landing page — a server component, so it ships almost no JavaScript
// and is fully indexable. Every claim here describes what the app really does.

import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Crosshair, Ruler, Layers, FileSpreadsheet, ShieldCheck, Shapes } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

const FEATURES = [
  {
    icon: Crosshair,
    title: 'Snaps to the drawing',
    body: 'Endpoints, corners and arcs are read from the PDF’s own vector geometry, so every point lands exactly on the line you meant.',
  },
  {
    icon: Shapes,
    title: 'The tools a takeoff needs',
    body: 'Lengths, arcs, rectangles, polygons, counts and grid counts, plus magic fill for rooms and perimeter offsets for skirting and edges.',
  },
  {
    icon: Ruler,
    title: 'Scale per page',
    body: 'Calibrate each sheet from a known dimension. Recalibrate later and the quantities already measured on that page update with it.',
  },
  {
    icon: Layers,
    title: 'Groups, rates and presets',
    body: 'Organise measurements into groups, attach unit rates and materials, and reuse presets for the items you price again and again.',
  },
  {
    icon: FileSpreadsheet,
    title: 'Excel BOQ with live formulas',
    body: 'Export a takeoff sheet with amounts, group subtotals, VAT and totals as real formulas, plus a BOQ matrix when you use a material library.',
  },
  {
    icon: ShieldCheck,
    title: 'Your drawings stay with you',
    body: 'PDFs never leave your computer. Projects are saved in your browser as you work, and a backup file moves them to another machine.',
  },
] as const;

const STEPS = [
  { title: 'Open a PDF',    body: 'Add one or more drawings to a project. Multi-page sets are fine.' },
  { title: 'Set the scale', body: 'Click two points on a known dimension and type its length.' },
  { title: 'Measure',       body: 'Trace lengths, areas and counts. Group them as you go.' },
  { title: 'Export',        body: 'Download a priced BOQ workbook, ready to send or adjust.' },
] as const;

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: BRAND.name,
  applicationCategory: 'BusinessApplication',
  applicationSubCategory: 'Construction quantity takeoff',
  operatingSystem: 'Web browser',
  description: BRAND.description,
  url: BRAND.siteUrl,
  image: `${BRAND.siteUrl}/opengraph-image`,
  featureList: FEATURES.map(f => f.title),
};

function PlanIllustration() {
  // A floor plan with a measured room, a measured wall and a count — drawn
  // inline so the hero needs no image download.
  return (
    <svg viewBox="0 0 720 440" className="block w-full h-auto" role="img"
      aria-label="A floor plan with one room measured as an area, a wall measured as a length, and doors counted">
      <rect width="720" height="440" fill="#F7F8F9" />
      <g stroke="#C9CFD5" strokeWidth="1">
        {Array.from({ length: 17 }).map((_, i) => <line key={`v${i}`} x1={i * 45} y1="0" x2={i * 45} y2="440" />)}
        {Array.from({ length: 10 }).map((_, i) => <line key={`h${i}`} x1="0" y1={i * 45} x2="720" y2={i * 45} />)}
      </g>
      <path d="M90 70 H430 V250 H90 Z" fill="#F2C230" fillOpacity="0.35" />
      <g fill="none" stroke="#1D2125" strokeWidth="6" strokeLinejoin="round">
        <path d="M90 70 H630 V370 H90 Z" />
        <path d="M430 70 V250 H90" />
        <path d="M430 250 V370" />
        <path d="M530 70 V200 H630" />
      </g>
      <g fill="#F7F8F9" stroke="none">
        <rect x="250" y="246" width="54" height="8" />
        <rect x="426" y="290" width="8" height="46" />
        <rect x="560" y="196" width="46" height="8" />
      </g>
      <path d="M90 70 H430 V250 H90 Z" fill="none" stroke="#1D2125" strokeWidth="2" strokeDasharray="6 5" />
      {[[90, 70], [430, 70], [430, 250], [90, 250]].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="7" fill="#F2C230" stroke="#1D2125" strokeWidth="2" />
      ))}
      <path d="M90 400 H630" stroke="#B8322A" strokeWidth="3" />
      <path d="M90 392 V408 M630 392 V408" stroke="#B8322A" strokeWidth="3" />
      {[[277, 250], [430, 313], [583, 200]].map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="14" fill="#1D2125" />
          <text x={x} y={y + 5} textAnchor="middle" fontSize="14" fontWeight="600" fill="#F2C230"
            fontFamily="var(--font-jetbrains), ui-monospace, monospace">{i + 1}</text>
        </g>
      ))}
      <g fontFamily="var(--font-jetbrains), ui-monospace, monospace" fontSize="17" fontWeight="600">
        <rect x="186" y="140" width="148" height="40" rx="3" fill="#1D2125" />
        <text x="260" y="166" textAnchor="middle" fill="#F2C230">30.60 m²</text>
        <rect x="296" y="412" width="128" height="26" rx="3" fill="#B8322A" />
        <text x="360" y="431" textAnchor="middle" fill="#FFFFFF" fontSize="15">12.00 m</text>
      </g>
    </svg>
  );
}

export default function Landing() {
  const year = new Date().getFullYear();
  return (
    <div className="min-h-screen bg-industrial-black text-zinc-200">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:bg-rule focus:px-3 focus:py-2 focus:text-graphite">
        Skip to content
      </a>

      <header className="sticky top-0 z-50 border-b border-industrial-border bg-industrial-black/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
          <Link href="/" aria-label={`${BRAND.name} home`} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-rule">
            <Logo size={22} />
          </Link>
          <nav aria-label="Page sections" className="hidden items-center gap-8 text-sm text-zinc-400 md:flex">
            <a href="#features" className="hover:text-white">Features</a>
            <a href="#how-it-works" className="hover:text-white">How it works</a>
            <a href="#privacy" className="hover:text-white">Privacy</a>
          </nav>
          <div className="flex items-center gap-5">
            <Link href="/login" className="text-sm font-semibold text-zinc-300 hover:text-white">
              Log in
            </Link>
            <Link
              href="/register"
              className="inline-flex h-11 items-center rounded bg-rule px-5 text-sm font-bold text-graphite hover:bg-[#F6CF55] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rule"
            >
              Sign up
            </Link>
          </div>
        </div>
      </header>

      <main id="main">
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-16 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:pt-24">
          <div className="fade-up">
            <p className="mb-5 font-mono text-sm text-rule">Quantity takeoff for estimators and QS</p>
            <h1 className="text-[2.6rem] font-bold leading-[1.05] tracking-tight text-white md:text-6xl">
              Measure the drawing.<br />Price the job.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-zinc-400">
              Open a PDF, set the scale, and trace lengths, areas and counts that snap to the drawing.
              Export a priced bill of quantities to Excel. It runs in your browser, with nothing to install.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/dashboard"
                className="inline-flex h-12 items-center justify-center gap-2 rounded bg-rule px-6 text-base font-bold text-graphite hover:bg-[#F6CF55] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rule"
              >
                Start a takeoff <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <a
                href="#how-it-works"
                className="inline-flex h-12 items-center justify-center rounded border border-industrial-border px-6 text-base font-semibold text-zinc-200 hover:border-zinc-500"
              >
                See how it works
              </a>
            </div>
          </div>
          <div className="fade-up overflow-hidden rounded-md border border-industrial-border shadow-2xl [animation-delay:120ms]">
            <PlanIllustration />
          </div>
        </section>

        <section id="features" aria-labelledby="features-title" className="border-t border-industrial-border">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <h2 id="features-title" className="max-w-2xl text-3xl font-bold tracking-tight text-white md:text-4xl">
              Built around how a takeoff is really done
            </h2>
            <ul className="mt-12 grid gap-px overflow-hidden rounded-md border border-industrial-border bg-industrial-border sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <li key={title} className="bg-industrial-panel p-7">
                  <Icon className="h-6 w-6 text-rule" aria-hidden />
                  <h3 className="mt-5 text-lg font-semibold text-white">{title}</h3>
                  <p className="mt-2 leading-relaxed text-zinc-400">{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="how-it-works" aria-labelledby="how-title" className="border-t border-industrial-border bg-industrial-panel">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <h2 id="how-title" className="text-3xl font-bold tracking-tight text-white md:text-4xl">
              From PDF to BOQ in four steps
            </h2>
            <ol className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s, i) => (
                <li key={s.title}>
                  <span className="font-mono text-sm text-rule">Step {i + 1}</span>
                  <h3 className="mt-2 text-xl font-semibold text-white">{s.title}</h3>
                  <p className="mt-2 leading-relaxed text-zinc-400">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="privacy" aria-labelledby="privacy-title" className="border-t border-industrial-border">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-20 md:grid-cols-2">
            <h2 id="privacy-title" className="text-3xl font-bold tracking-tight text-white md:text-4xl">
              Client drawings stay on your computer
            </h2>
            <div className="space-y-4 text-lg leading-relaxed text-zinc-400">
              <p>
                {BRAND.name} opens PDFs directly in your browser. They aren’t uploaded, and projects are saved on this device as you work.
              </p>
              <p>
                To move a project to another computer, or keep a copy, download a backup file from your projects page.
                Clearing your browser’s site data removes local projects, so keep backups of anything important.
              </p>
            </div>
          </div>
        </section>

        <section className="border-t border-industrial-border">
          <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-6 py-16 md:flex-row md:items-center">
            <p className="text-2xl font-bold text-white md:text-3xl">
              Your next takeoff starts with a PDF.
            </p>
            <Link
              href="/dashboard"
              className="inline-flex h-12 items-center gap-2 rounded bg-rule px-6 text-base font-bold text-graphite hover:bg-[#F6CF55] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rule"
            >
              Start a takeoff <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-industrial-border">
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-4 px-6 py-8 text-sm text-zinc-500 md:flex-row md:items-center">
          <Logo size={18} />
          <p>© {year} {BRAND.name}. {BRAND.tagline}.</p>
        </div>
      </footer>
    </div>
  );
}

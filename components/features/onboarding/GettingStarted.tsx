'use client';

// Getting started: a checklist that ticks itself off from the project (nothing to tick by
// hand), explains each step in plain words, and can point at the control to use.
// Open it from its own button, or from anywhere with openGuide().

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronDown, Compass, ExternalLink, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { guideProgress, type GuideProject, type Stage } from '@/lib/guide/stages';

const OPEN_EVENT = 'foldrule:open-guide';
export const EXPORTED_EVENT = 'foldrule:exported';
export const openGuide = () => window.dispatchEvent(new Event(OPEN_EVENT));
const exportedKey = (id: string) => `foldrule:exported:${id}`;
const seenKey = (id: string) => `foldrule:guide-seen:${id}`;

/** Called after a successful export, so the last step can tick. */
export function markExported() {
  try {
    const id = new URLSearchParams(window.location.search).get('project') ?? '';
    localStorage.setItem(exportedKey(id), '1');
  } catch { /* storage blocked: the step just stays open */ }
  window.dispatchEvent(new Event(EXPORTED_EVENT));
}

/** Ring the control a step is about, for a few seconds. Returns false when it is not on screen. */
function pointAt(target: string): boolean {
  const el = [...document.querySelectorAll<HTMLElement>(`[data-guide="${target}"]`)].find(e => e.offsetParent !== null);
  if (!el) return false;
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  const ring = document.createElement('div');
  ring.setAttribute('aria-hidden', 'true');
  Object.assign(ring.style, {
    position: 'fixed', left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px`,
    border: '2px solid #F2C230', boxShadow: '0 0 0 9999px rgba(0,0,0,0.55), 0 0 24px 4px rgba(242,194,48,0.6)',
    pointerEvents: 'none', zIndex: '9999', transition: 'opacity .4s', opacity: '1',
  } as CSSStyleDeclaration);
  document.body.appendChild(ring);
  const off = () => { ring.style.opacity = '0'; setTimeout(() => ring.remove(), 400); window.removeEventListener('pointerdown', off, true); };
  window.addEventListener('pointerdown', off, true);
  setTimeout(off, 4000);
  return true;
}

interface Props {
  project: GuideProject;
  projectId?: string | null;
  page: 'workspace' | 'summary';
  /** Hide the button: the panel is opened with openGuide() from elsewhere. */
  noButton?: boolean;
}

export function GettingStarted({ project, projectId, page, noButton }: Props) {
  const [open, setOpen] = useState(false);
  const [exported, setExported] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [id, setId] = useState(projectId ?? '');
  useEffect(() => { if (!projectId) setId(new URLSearchParams(window.location.search).get('project') ?? ''); }, [projectId]);

  useEffect(() => {
    const read = () => { try { setExported(localStorage.getItem(exportedKey(id)) === '1'); } catch { /* ignore */ } };
    read();
    const show = () => setOpen(true);
    window.addEventListener(EXPORTED_EVENT, read);
    window.addEventListener(OPEN_EVENT, show);
    return () => { window.removeEventListener(EXPORTED_EVENT, read); window.removeEventListener(OPEN_EVENT, show); };
  }, [id]);

  const progress = useMemo(() => guideProgress(project, exported), [project, exported]);
  const main = progress.filter(s => !s.stage.later);
  const later = progress.filter(s => s.stage.later);
  const doneCount = main.filter(s => s.done).length;
  const current = main.find(s => !s.done);
  const shown = expanded ?? current?.stage.id ?? null;

  // A new project opens the guide once, on its own.
  useEffect(() => {
    if (!id || page !== 'workspace') return;
    try {
      if (localStorage.getItem(seenKey(id))) return;
      localStorage.setItem(seenKey(id), '1');
      if (project.measurements.length === 0) setOpen(true);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const show = useCallback((stage: Stage) => {
    if (!stage.target) return;
    setOpen(false);
    // Let the panel close before measuring where the control is.
    requestAnimationFrame(() => {
      if (!pointAt(stage.target!)) { setOpen(true); setMissing(stage.id); }
    });
  }, []);

  const otherPage = (stage: Stage) => stage.on !== 'both' && stage.on !== page;
  const href = (to: 'workspace' | 'summary') => `${to === 'workspace' ? '/workspace' : '/takeoff-full'}?project=${id}`;

  const row = (s: typeof progress[number], n?: number) => {
    const isOpen = shown === s.stage.id;
    const isCurrent = current?.stage.id === s.stage.id;
    return (
      <li key={s.stage.id} className={cn('border-b border-zinc-800', isOpen && 'bg-zinc-900/60')}>
        <button
          type="button" aria-expanded={isOpen}
          onClick={() => { setMissing(null); setExpanded(isOpen ? '' : s.stage.id); }}
          className="w-full flex items-center gap-3 px-4 py-2.5 text-left"
        >
          <span className={cn('w-6 h-6 shrink-0 flex items-center justify-center text-[11px] font-bold',
            s.done ? 'bg-emerald-600 text-white' : isCurrent ? 'bg-amber-accent text-black' : 'border border-zinc-600 text-zinc-400')}>
            {s.done ? <Check className="w-3.5 h-3.5" aria-label="Done" /> : n ?? '+'}
          </span>
          <span className="flex-1 min-w-0">
            <span className={cn('block text-xs font-bold', s.done ? 'text-zinc-400' : 'text-zinc-100')}>{s.stage.title}</span>
            {!isOpen && <span className="block text-[11px] text-zinc-500 truncate">{s.detail && !s.done ? s.detail : s.stage.short}</span>}
          </span>
          <ChevronDown className={cn('w-3.5 h-3.5 text-zinc-500 transition-transform', isOpen && 'rotate-180')} />
        </button>
        {isOpen && (
          <div className="px-4 pb-4 pl-[52px] space-y-2 text-[12px] leading-relaxed">
            <p className="text-zinc-300">{s.stage.why}</p>
            <ol className="list-decimal pl-4 space-y-1 text-zinc-400">
              {s.stage.how.map(h => <li key={h}>{h}</li>)}
            </ol>
            {s.stage.tip && <p className="border-l-2 border-amber-accent/60 pl-2 text-zinc-400"><b className="text-amber-accent">Tip:</b> {s.stage.tip}</p>}
            {s.detail && <p className="text-zinc-500">Now: {s.detail}.</p>}
            <div className="flex items-center gap-2 pt-1">
              {otherPage(s.stage) ? (
                <Link href={href(s.stage.on as 'workspace' | 'summary')} className="px-3 py-1.5 bg-amber-accent text-black text-[11px] font-bold uppercase tracking-widest hover:bg-amber-400">
                  Go to the {s.stage.on === 'summary' ? 'summary page' : 'workspace'}
                </Link>
              ) : s.stage.target ? (
                <button type="button" onClick={() => show(s.stage)} className="px-3 py-1.5 bg-amber-accent text-black text-[11px] font-bold uppercase tracking-widest hover:bg-amber-400">
                  Show me where
                </button>
              ) : null}
              {missing === s.stage.id && <span className="text-[11px] text-zinc-500">That control is not on screen right now (a panel may be closed).</span>}
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <>
      {!noButton && (
        <button
          type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          title="Getting started: the steps from a drawing to a priced bill"
          aria-label="Getting started guide"
          className={cn('flex items-center gap-1.5 px-2 py-1.5 border whitespace-nowrap text-[11px] font-mono font-bold uppercase tracking-widest transition-colors shrink-0',
            doneCount === main.length ? 'border-zinc-700 text-zinc-500 hover:text-zinc-200' : 'border-amber-accent/60 text-amber-accent hover:bg-amber-accent/10')}
        >
          <Compass className="w-3.5 h-3.5" /> <span className="hidden min-[1700px]:inline">Guide</span> {doneCount}/{main.length}
        </button>
      )}
      {open && (
        <div role="dialog" aria-label="Getting started" onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setOpen(false); }}
          className="fixed top-16 right-4 z-[130] w-[400px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-5rem)] flex flex-col bg-[#16191C] border border-amber-accent/50 shadow-2xl shadow-black font-mono">
          <div className="px-4 py-3 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <Compass className="w-4 h-4 text-amber-accent" />
              <span className="flex-1 text-xs font-bold uppercase tracking-widest text-amber-accent">Getting started</span>
              <span className="text-[11px] text-zinc-400">{doneCount} of {main.length} done</span>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close the guide" className="text-zinc-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="mt-2 h-1 bg-zinc-800" aria-hidden><div className="h-1 bg-amber-accent transition-all" style={{ width: `${(doneCount / main.length) * 100}%` }} /></div>
            <p className="mt-2 text-[11px] text-zinc-500 leading-relaxed">
              {doneCount === main.length
                ? 'Every step is done. This list stays here if you want to look something up.'
                : 'From a drawing to a priced bill. Steps tick themselves as you work; do them in order the first time.'}
            </p>
          </div>
          <ol className="flex-1 overflow-y-auto custom-scrollbar">
            {main.map((s, i) => row(s, i + 1))}
            <li className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-zinc-600">Later, when you need them</li>
            {later.map(s => row(s))}
          </ol>
          <div className="px-4 py-2.5 border-t border-zinc-800 flex items-center gap-3 text-[11px]">
            <Link href="/guide" target="_blank" className="flex items-center gap-1 text-zinc-300 hover:text-amber-accent">
              Read the full guide <ExternalLink className="w-3 h-3" />
            </Link>
            <span className="flex-1" />
            <span className="text-zinc-600">Esc closes</span>
          </div>
        </div>
      )}
    </>
  );
}

'use client';
// Find & count: drag a box round one symbol and every matching symbol on the
// page is found (OpenCV template matching, in a worker, on this device).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScanSearch, Plus, RotateCcw, Check, X } from 'lucide-react';
import { useOpenCVMatcher } from '@/hooks/detection/useOpenCVMatcher';

type Pt = { x: number; y: number };
const LONG_EDGE = 2800;                 // px the page is rendered at for matching
const ALL_TURNS = [0, 90, 180, 270];

export function AutoCount({ pageRef, pageKey, spaceHeld, onCommit, onClose }: {
  pageRef:  React.RefObject<any>;
  pageKey:  string;
  spaceHeld: boolean;
  onCommit: (points: Pt[], name: string) => void;
  onClose:  () => void;
}) {
  const cv = useOpenCVMatcher();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderedFor = useRef<unknown>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ a: Pt; b: Pt } | null>(null);
  const [adding, setAdding] = useState(false);          // next box is an extra sample
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [threshold, setThreshold] = useState(0.7);
  const [turned, setTurned] = useState(true);
  const [mirrored, setMirrored] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rotations = useMemo(() => (turned ? ALL_TURNS : [0]), [turned]);
  const flips = useMemo(() => (mirrored ? [false, true] : [false]), [mirrored]);

  // New page → start again.
  useEffect(() => { cv.clearAll(); setExcluded(new Set()); setAdding(false); renderedFor.current = null; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pageKey]);

  /** The page as a bitmap at a fixed size (independent of the zoom on screen). */
  const pageBitmap = useCallback(async (): Promise<HTMLCanvasElement | null> => {
    const page = pageRef.current;
    if (!page) return null;
    if (canvasRef.current && renderedFor.current === page) return canvasRef.current;
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(4, LONG_EDGE / Math.max(base.width, base.height)) });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
    canvasRef.current = c; renderedFor.current = page;
    return c;
  }, [pageRef]);

  const norm = (e: React.PointerEvent): Pt => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };

  const search = useCallback(async (a: Pt, b: Pt) => {
    setError(null); setBusy(true);
    try {
      const c = await pageBitmap();
      if (!c) throw new Error('The page is not ready yet.');
      const box = { x: Math.min(a.x, b.x) * c.width, y: Math.min(a.y, b.y) * c.height, w: Math.abs(b.x - a.x) * c.width, h: Math.abs(b.y - a.y) * c.height };
      if (box.w < 6 || box.h < 6) throw new Error('Drag a slightly bigger box round the symbol.');
      const first = !adding || cv.templates.length === 0;
      if (first) { cv.clearAll(); setExcluded(new Set()); }
      const idx = cv.buildTemplate(c, box, 1, { x: 0, y: 0 }, first ? 'Sample' : `Sample ${cv.templates.length + 1}`);
      if (idx < 0) throw new Error('Drag a slightly bigger box round the symbol.');
      if (first) await cv.findMatches(c, threshold, rotations, flips, false, [1], 3);
      else await cv.findMatchesForTemplate(c, idx, threshold, rotations, flips, false, [1], 3);
      setAdding(false);
    } catch (err) {
      setError((err as Error).message || 'The search failed.');
    } finally { setBusy(false); }
  }, [pageBitmap, adding, cv, threshold, rotations, flips]);

  const rerun = useCallback(async (t: number, rot: number[], fl: boolean[]) => {
    const c = canvasRef.current;
    if (!c || !cv.templates.length) return;
    setError(null);
    try { await cv.refindMatches(c, t, rot, fl, false, [1], 3); }
    catch (err) { setError((err as Error).message || 'The search failed.'); }
  }, [cv]);

  const size = canvasRef.current ? { w: canvasRef.current.width, h: canvasRef.current.height } : null;
  const kept = cv.matches.filter(m => !excluded.has(m.id));
  const hasSample = cv.templates.length > 0;
  const working = busy || cv.isSearching;
  const sampling = !hasSample || adding;

  const add = () => {
    if (!size || !kept.length) return;
    onCommit(kept.map(m => ({ x: m.cx / size.w, y: m.cy / size.h })), name.trim() || 'Counted symbols');
    cv.clearAll(); setExcluded(new Set()); setName('');
  };

  return (
    <>
      {/* Over the page: sample box + the matches */}
      <div
        ref={boxRef}
        className="absolute inset-0 z-[66]"
        style={{ cursor: sampling ? 'crosshair' : 'default', pointerEvents: spaceHeld ? 'none' : 'auto', touchAction: 'none' }}
        onPointerDown={e => {
          if (e.button !== 0 || !sampling || working || !cv.isReady) return;
          e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId);
          const p = norm(e); setDrag({ a: p, b: p });
        }}
        onPointerMove={e => { if (drag) setDrag({ a: drag.a, b: norm(e) }); }}
        onPointerUp={e => {
          if (!drag) return;
          const d = { a: drag.a, b: norm(e) }; setDrag(null);
          void search(d.a, d.b);
        }}
        onClick={e => e.stopPropagation()}
        onContextMenu={e => e.preventDefault()}
      >
        {drag && (
          <div className="absolute border-2 border-sky-400 bg-sky-400/10" style={{
            left: `${Math.min(drag.a.x, drag.b.x) * 100}%`, top: `${Math.min(drag.a.y, drag.b.y) * 100}%`,
            width: `${Math.abs(drag.b.x - drag.a.x) * 100}%`, height: `${Math.abs(drag.b.y - drag.a.y) * 100}%`,
          }} />
        )}
        {size && cv.matches.map(m => {
          const off = excluded.has(m.id);
          return (
            <button
              key={m.id}
              title={off ? 'Left out — click to count it again' : `Match ${Math.round(m.score * 100)}% — click to leave it out`}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => {
                e.stopPropagation();
                setExcluded(s => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; });
              }}
              className={`absolute border-2 ${off ? 'border-zinc-400/70 border-dashed bg-transparent' : 'border-emerald-500 bg-emerald-400/20 hover:bg-red-400/30 hover:border-red-500'}`}
              style={{
                left: `${(m.bbox.x / size.w) * 100}%`, top: `${(m.bbox.y / size.h) * 100}%`,
                width: `${(m.bbox.w / size.w) * 100}%`, height: `${(m.bbox.h / size.h) * 100}%`,
                pointerEvents: sampling ? 'none' : 'auto',
              }}
            />
          );
        })}
      </div>

      {/* Control panel (fixed to the window, so it stays put while you pan) */}
      <div
        className="fixed bottom-16 left-1/2 -translate-x-1/2 z-[80] w-[34rem] max-w-[94vw] bg-zinc-900 border border-zinc-600 shadow-2xl text-zinc-100"
        onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700">
          <ScanSearch className="w-4 h-4 text-amber-400" />
          <span className="text-[11px] font-mono uppercase tracking-widest text-amber-400">Find &amp; count</span>
          <span className="text-xs text-zinc-300 truncate">
            {!cv.isReady ? (cv.workerPhase.startsWith('Error') ? 'Could not load the matcher' : 'Getting ready…')
              : working ? `Searching… ${cv.workerDetail || cv.workerPhase}`
              : !hasSample ? 'Drag a box round ONE symbol on the drawing'
              : adding ? 'Drag a box round a symbol that was missed'
              : `${kept.length} found${excluded.size ? ` · ${excluded.size} left out` : ''}`}
          </span>
          <button onClick={onClose} title="Close (Esc)" className="ml-auto text-zinc-500 hover:text-zinc-200"><X className="w-4 h-4" /></button>
        </div>
        {(error || cv.workerPhase.startsWith('Error')) && (
          <div className="px-3 py-1.5 text-xs text-red-300 bg-red-950/40 border-b border-zinc-700">{error || cv.workerPhase}</div>
        )}
        {hasSample && (
          <div className="px-3 py-2 space-y-2">
            <div className="flex items-center gap-3 text-[11px] text-zinc-300 flex-wrap">
              <label className="flex items-center gap-2">
                Fewer
                <input
                  type="range" min={0.5} max={0.95} step={0.01} value={1.45 - threshold} disabled={working}
                  aria-label="How loosely to match: left finds fewer, right finds more"
                  onChange={e => setThreshold(+(1.45 - parseFloat(e.target.value)).toFixed(2))}
                  onPointerUp={() => void rerun(threshold, rotations, flips)}
                  onKeyUp={() => void rerun(threshold, rotations, flips)}
                  className="w-32 accent-amber-400"
                />
                More
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={turned} disabled={working} className="accent-amber-400"
                  onChange={e => { setTurned(e.target.checked); void rerun(threshold, e.target.checked ? ALL_TURNS : [0], flips); }} />
                turned ones too
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={mirrored} disabled={working} className="accent-amber-400"
                  onChange={e => { setMirrored(e.target.checked); void rerun(threshold, rotations, e.target.checked ? [false, true] : [false]); }} />
                mirrored ones too
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={name} onChange={e => setName(e.target.value)} placeholder="Name, e.g. Doors"
                aria-label="Name for this count"
                onKeyDown={e => { if (e.key === 'Enter') add(); }}
                className="flex-1 min-w-0 bg-zinc-800 border border-zinc-600 px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-amber-400"
              />
              <button disabled={working} onClick={() => setAdding(a => !a)} title="Some were missed? Box one of them as a second sample."
                className={`flex items-center gap-1 text-[10px] font-mono font-bold uppercase tracking-widest px-2 py-1.5 border ${adding ? 'border-sky-400 text-sky-300' : 'border-zinc-600 text-zinc-200 hover:bg-zinc-800'} disabled:opacity-40`}>
                <Plus className="w-3 h-3" /> Missed some
              </button>
              <button disabled={working} onClick={() => { cv.clearAll(); setExcluded(new Set()); setAdding(false); }} title="Start again with a new sample"
                className="flex items-center gap-1 text-[10px] font-mono font-bold uppercase tracking-widest px-2 py-1.5 border border-zinc-600 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
                <RotateCcw className="w-3 h-3" /> Restart
              </button>
              <button disabled={working || !kept.length} onClick={add}
                className="flex items-center gap-1 text-[10px] font-mono font-bold uppercase tracking-widest px-2.5 py-1.5 bg-amber-400 text-black hover:bg-amber-300 disabled:opacity-40">
                <Check className="w-3 h-3" /> Add {kept.length}
              </button>
            </div>
            <div className="text-[11px] text-zinc-500">Click a green box to leave it out. Check the result before you rely on it — similar-looking symbols can be picked up.</div>
          </div>
        )}
      </div>
    </>
  );
}

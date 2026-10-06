'use client';
// Find & count: drag a box round one symbol and every matching symbol on the
// page is found (OpenCV template matching, in a worker, on this device).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScanSearch, Plus, RotateCcw, Check, X } from 'lucide-react';
import { useOpenCVMatcher } from '@/hooks/detection/useOpenCVMatcher';

type Pt = { x: number; y: number };
const LONG_EDGE = 2800;                 // px the page is rendered at for matching

export interface CountArea { id: string; name: string; outer: Pt[]; holes: Pt[][] }
const inRing = (r: Pt[], p: Pt) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i].y > p.y) !== (r[j].y > p.y) && p.x < ((r[j].x - r[i].x) * (p.y - r[i].y)) / (r[j].y - r[i].y) + r[i].x) c = !c;
  }
  return c;
};
const SEARCH_FLOOR = 0.55;              // searched once this loosely; the slider then only filters
type Turn = 'none' | 'quarter' | 'any';
const TURNS: Record<Turn, number[]> = {
  none: [0], quarter: [0, 90, 180, 270],
  any: Array.from({ length: 24 }, (_, i) => i * 15),      // every 15°, refined to 3° around each hit
};

/** Small picture of a sample. */
function Thumb({ data }: { data: ImageData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    c.width = data.width; c.height = data.height;
    c.getContext('2d')?.putImageData(data, 0, 0);
  }, [data]);
  return <canvas ref={ref} className="h-9 w-9 object-contain bg-white border border-zinc-600" style={{ imageRendering: 'auto' }} />;
}

export function AutoCount({ pageRef, pageKey, spaceHeld, areas, onCommit, onClose }: {
  areas:    CountArea[];
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
  const [turn, setTurn] = useState<Turn>('quarter');
  const [areaId, setAreaId] = useState('');
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);     // panel moved by dragging its title
  const inkRef = useRef<Record<number, { w: number; h: number }>>({});     // drawn size of each sample, px
  const dragPanel = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [mirrored, setMirrored] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rotations = TURNS[turn];
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
      const first = !adding || cv.templates.length === 0;
      // Shrink the box to the drawn lines inside it, so matches are boxed tightly.
      {
        const x = Math.max(0, Math.round(box.x)), y = Math.max(0, Math.round(box.y));
        const w = Math.min(c.width - x, Math.round(box.w)), h = Math.min(c.height - y, Math.round(box.h));
        if (w > 4 && h > 4) {
          const d = c.getContext('2d')!.getImageData(x, y, w, h).data;
          let x0 = w, y0 = h, x1 = -1, y1 = -1;
          for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
            const i = (yy * w + xx) * 4;
            if (d[i] + d[i + 1] + d[i + 2] < 690) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
          }
          if (x1 < 0) throw new Error('There is nothing drawn inside that box.');
          // Same white margin every time, however loosely the box was dragged.
          const pad = Math.max(6, Math.round(Math.max(x1 - x0, y1 - y0) * 0.18));
          inkRef.current[first ? 0 : cv.templates.length] = { w: x1 - x0 + 11, h: y1 - y0 + 11 };
          box.x = Math.max(0, x + x0 - pad); box.y = Math.max(0, y + y0 - pad);
          box.w = Math.min(c.width - box.x, x1 - x0 + 1 + pad * 2); box.h = Math.min(c.height - box.y, y1 - y0 + 1 + pad * 2);
        }
      }
      if (box.w < 6 || box.h < 6) throw new Error('Drag a slightly bigger box round the symbol.');
      if (first) { cv.clearAll(); setExcluded(new Set()); }
      const idx = cv.buildTemplate(c, box, 1, { x: 0, y: 0 }, first ? 'Sample' : `Sample ${cv.templates.length + 1}`);
      if (idx < 0) throw new Error('Drag a slightly bigger box round the symbol.');
      if (first) await cv.findMatches(c, SEARCH_FLOOR, rotations, flips, false, [1], 3);
      else await cv.findMatchesForTemplate(c, idx, SEARCH_FLOOR, rotations, flips, false, [1], 3);
      setAdding(false);
    } catch (err) {
      setError((err as Error).message || 'The search failed.');
    } finally { setBusy(false); }
  }, [pageBitmap, adding, cv, rotations, flips]);

  const rerun = useCallback(async (rot: number[], fl: boolean[]) => {
    const c = canvasRef.current;
    if (!c || !cv.templates.length) return;
    setError(null);
    try { await cv.refindMatches(c, SEARCH_FLOOR, rot, fl, false, [1], 3); }
    catch (err) { setError((err as Error).message || 'The search failed.'); }
  }, [cv]);

  const size = canvasRef.current ? { w: canvasRef.current.width, h: canvasRef.current.height } : null;
  /** Box round the drawn symbol itself (its size turned with the match), not round the sample's margin. */
  const fit = (m: (typeof cv.matches)[number]): React.CSSProperties => {
    const ink = inkRef.current[m.templateIndex];
    if (!ink || !size) return {
      left: `${(m.bbox.x / size!.w) * 100}%`, top: `${(m.bbox.y / size!.h) * 100}%`,
      width: `${(m.bbox.w / size!.w) * 100}%`, height: `${(m.bbox.h / size!.h) * 100}%`,
    };
    const r = (m.rotation * Math.PI) / 180, c = Math.abs(Math.cos(r)), s2 = Math.abs(Math.sin(r));
    const w = ink.w * c + ink.h * s2, h = ink.w * s2 + ink.h * c;
    return {
      left: `${((m.cx - w / 2) / size.w) * 100}%`, top: `${((m.cy - h / 2) / size.h) * 100}%`,
      width: `${(w / size.w) * 100}%`, height: `${(h / size.h) * 100}%`,
    };
  };
  const area = areas.find(a => a.id === areaId) ?? null;
  // Strict enough for the slider, and (when an area is chosen) inside it.
  const shown = cv.matches.filter(m => {
    if (m.score < threshold) return false;
    if (!area || !size) return true;
    const p = { x: m.cx / size.w, y: m.cy / size.h };
    return inRing(area.outer, p) && !area.holes.some(h => inRing(h, p));
  });
  const kept = shown.filter(m => !excluded.has(m.id));
  const weakBelow = Math.min(0.97, threshold + 0.08);
  const hasSample = cv.templates.length > 0;
  const working = busy || cv.isSearching;
  const sampling = !hasSample || adding;

  const add = () => {
    if (!size || !kept.length) return;
    onCommit(kept.map(m => ({ x: m.cx / size.w, y: m.cy / size.h })), (name.trim() || 'Counted symbols') + (area ? ` – ${area.name}` : ''));
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
        {size && shown.map((m, n) => {
          const off = excluded.has(m.id);
          const weak = m.score < weakBelow;
          const tone = off ? 'border-zinc-400/80 border-dashed' : weak ? 'border-amber-500 hover:border-red-500' : 'border-emerald-500 hover:border-red-500';
          return (
            <button
              key={m.id}
              title={off ? 'Left out — click to count it again' : `${weak ? 'Weaker match' : 'Match'} ${Math.round(m.score * 100)}% — click to leave it out`}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => {
                e.stopPropagation();
                setExcluded(s => { const k = new Set(s); if (k.has(m.id)) k.delete(m.id); else k.add(m.id); return k; });
              }}
              className={`absolute border-2 bg-transparent ${tone}`}
              style={{
                ...fit(m),
                pointerEvents: sampling ? 'none' : 'auto',
              }}
            >
              {!off && (
                <span className={`absolute -top-2.5 -left-2.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] leading-[18px] font-bold text-center text-black ${weak ? 'bg-amber-400' : 'bg-emerald-400'}`}>
                  {kept.indexOf(m) + 1 || n + 1}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Control panel (fixed to the window, so it stays put while you pan) */}
      <div
        ref={panelRef}
        className={`fixed z-[80] w-[34rem] max-w-[94vw] bg-zinc-900 border border-zinc-600 shadow-2xl text-zinc-100 ${pos ? '' : 'bottom-16 left-24'}`}
        style={pos ? { left: pos.x, top: pos.y } : undefined}
        onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 cursor-move select-none"
          title="Drag to move this panel"
          onPointerDown={e => {
            if ((e.target as HTMLElement).closest('button')) return;
            const r = panelRef.current!.getBoundingClientRect();
            dragPanel.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={e => {
            const d = dragPanel.current; if (!d) return;
            setPos({
              x: Math.max(0, Math.min(window.innerWidth - 120, d.ox + e.clientX - d.sx)),
              y: Math.max(0, Math.min(window.innerHeight - 40, d.oy + e.clientY - d.sy)),
            });
          }}
          onPointerUp={() => { dragPanel.current = null; }}
        >
          <ScanSearch className="w-4 h-4 text-amber-400" />
          <span className="text-[11px] font-mono uppercase tracking-widest text-amber-400">Find &amp; count</span>
          <span className="text-xs text-zinc-300 truncate">
            {!cv.isReady ? (cv.workerPhase.startsWith('Error') ? 'Could not load the matcher' : 'Getting ready…')
              : working ? `Searching… ${cv.workerDetail || cv.workerPhase}`
              : !hasSample ? 'Drag a box round ONE symbol on the drawing'
              : adding ? 'Drag a box round a symbol that was missed'
              : `${kept.length} found${area ? ` in ${area.name}` : ''}${shown.length - kept.length ? ` · ${shown.length - kept.length} left out` : ''}`}
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
                  type="range" min={0} max={0.4} step={0.01} value={0.95 - threshold}
                  aria-label="How loosely to match: left finds fewer, right finds more"
                  onChange={e => setThreshold(+(0.95 - parseFloat(e.target.value)).toFixed(2))}
                  className="w-28 accent-amber-400"
                />
                More
              </label>
              <label className="flex items-center gap-1.5">
                Turned
                <select
                  value={turn} disabled={working} aria-label="Which rotations to look for"
                  onChange={e => { const t = e.target.value as Turn; setTurn(t); void rerun(TURNS[t], flips); }}
                  className="bg-zinc-800 border border-zinc-600 px-1.5 py-1 text-[11px] text-zinc-100"
                >
                  <option value="none">as drawn only</option>
                  <option value="quarter">quarter turns</option>
                  <option value="any">any angle (slower)</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={mirrored} disabled={working} className="accent-amber-400"
                  onChange={e => { setMirrored(e.target.checked); void rerun(rotations, e.target.checked ? [false, true] : [false]); }} />
                mirrored
              </label>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-zinc-300">
              <span className="text-zinc-500">Looking for</span>
              {cv.templates.map((t, i) => <Thumb key={i} data={t.imageData} />)}
              {areas.length > 0 && (
                <label className="ml-auto flex items-center gap-1.5">
                  Count in
                  <select value={areaId} onChange={e => setAreaId(e.target.value)} aria-label="Where to count"
                    className="max-w-[11rem] bg-zinc-800 border border-zinc-600 px-1.5 py-1 text-[11px] text-zinc-100">
                    <option value="">the whole page</option>
                    {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
              )}
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
            <div className="text-[11px] text-zinc-500">Click a box to leave it out. Amber boxes are weaker matches — check those first. Saved as a count group in the takeoff.</div>
          </div>
        )}
      </div>
    </>
  );
}

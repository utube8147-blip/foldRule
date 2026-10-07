'use client';
// Compare two revisions of a sheet: what was removed (red), what was added (blue),
// and which existing measurements sit on a change and need re-measuring.

import { rowOutlinePx } from '@/lib/takeoff/rowOutline';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, GitCompareArrows, Loader2 } from 'lucide-react';
import type { Drawing, TakeoffRow } from '@/types';
import pdfjsLib from '@/lib/pdf/pdfClient';
import { checkBySnap, refineOffset, shiftGeometry, type PageGeometry, type SnapCheck } from '@/lib/takeoff/snapRevision';
import { extractPageGeometry } from '@/hooks/snapEngine/usePdfDocument';
import { inkMask, diffMasks, autoAlign, paintDiff, affectedRows, shift, type AffectedRow } from '@/lib/takeoff/revisionCompare';

const MAX_SIDE = 1800;   // pixels on the long side: fine enough for linework, quick to compare

interface Props {
  drawings: Drawing[];
  measurements: TakeoffRow[];
  activeDrawingId: string | null;
  activePage: number;
  onClose: () => void;
  onFocus: (id: string) => void;
  /** Keep the page and everything loaded in it, but out of sight (so closing does not lose the comparison). */
  hidden?: boolean;
  /** Replace the old sheet with the new one and carry the measurements across. */
  onAccept?: (a: AcceptRevisionRequest) => void;
}

export interface AcceptRevisionRequest {
  from: { drawingId: string; page: number };
  to: { drawingId?: string; newFile?: File; page: number };
  shift: { x: number; y: number };
  flaggedIds: string[];
  /** Proposed outlines from the snap check, by measurement id (old sheet's frame). */
  suggestions?: Record<string, { points: Array<{ x: number; y: number }>; quantity: number }>;
  /** Old page width ÷ new page width, in PDF points: corrects the scale if the sheet size changed. */
  sizeRatio: number;
}

type Rendered = { mask: Uint8Array; w: number; h: number; pages: number; ptW: number; geom: (PageGeometry & { w: number; h: number }) | null };

/** Fewer lines than this and the page is treated as a scan (no linework to check against). */
const MIN_VECTOR_LINES = 30;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function renderPage(src: string | ArrayBuffer, pageNo: number, size?: { w: number; h: number }): Promise<Rendered> {
  const doc = await (pdfjsLib as any).getDocument(typeof src === 'string' ? src : { data: new Uint8Array(src.slice(0)) }).promise;
  try {
    const page = await doc.getPage(Math.min(Math.max(1, pageNo), doc.numPages));
    const base = page.getViewport({ scale: 1 });
    // Revision B is drawn at revision A's pixel size so the two can be laid over each other.
    const scale = size ? size.w / base.width : MAX_SIDE / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = size?.w ?? Math.round(vp.width);
    canvas.height = size?.h ?? Math.round(vp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas } as any).promise;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // The page's own linework, for checking snapped measurements; a scan simply has none.
    const geom = await extractPageGeometry(page).catch(() => null);
    return { mask: inkMask(data, canvas.width, canvas.height), w: canvas.width, h: canvas.height, pages: doc.numPages, ptW: base.width, geom };
  } finally {
    void doc.destroy?.();
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const field = 'bg-[#16191C] border border-zinc-700 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-amber-accent';

export function RevisionCompareDialog({ drawings, measurements, activeDrawingId, activePage, onClose, onAccept, hidden }: Props) {
  /** One measurement looked at on its own: the new plan, its old outline and the suggested one. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [aId, setAId] = useState(activeDrawingId ?? drawings[0]?.id ?? '');
  const [aPage, setAPage] = useState(activePage || 1);
  const [bId, setBId] = useState(drawings.find(d => d.id !== (activeDrawingId ?? drawings[0]?.id))?.id ?? '');
  const [bPage, setBPage] = useState(activePage || 1);
  const [upload, setUpload] = useState<{ name: string; data: ArrayBuffer; file: File } | null>(null);
  const [pair, setPair] = useState<{ a: Rendered; b: Rendered } | null>(null);
  const [move, setMove] = useState({ dx: 0, dy: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  // Layers the user can switch on and off independently.
  const [showOld, setShowOld] = useState(true);
  const [showNew, setShowNew] = useState(true);
  const [showShapes, setShowShapes] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);

  const a = drawings.find(d => d.id === aId);
  const b = drawings.find(d => d.id === bId);
  const hasB = bId === '__upload__' ? !!upload : !!b;
  /** A drawing's PDF: the file kept with the project, else its address. */
  const sourceOf = async (d: Drawing): Promise<string | ArrayBuffer> => {
    if (d.file) return d.file.arrayBuffer();
    if (d.fileUrl) return d.fileUrl;
    throw new Error(`The PDF for “${d.name}” is not available. Open that drawing once, then try again.`);
  };

  const compare = async () => {
    if (!a || !hasB) return;
    setBusy(true); setError(null);
    try {
      const ra = await renderPage(await sourceOf(a), aPage);
      const rb = await renderPage(bId === '__upload__' ? upload!.data : await sourceOf(b!), bPage, { w: ra.w, h: ra.h });
      setMove(autoAlign(ra.mask, rb.mask, ra.w, ra.h));
      setPair({ a: ra, b: rb });
      // Start with the whole sheet fitted to the page.
      const box = areaRef.current?.getBoundingClientRect();
      if (box) setZoom(Math.max(0.3, Math.min(3, Math.min((box.width - 40) / (ra.w * 0.5), (box.height - 90) / (ra.h * 0.5)))));
    } catch (e) {
      setPair(null);
      setError(e instanceof Error ? e.message : 'Could not read one of the drawings.');
    } finally {
      setBusy(false);
    }
  };

  const diff = useMemo(() => (pair ? diffMasks(pair.a.mask, pair.b.mask, pair.a.w, pair.a.h, move) : null), [pair, move]);
  const pixelAffected: AffectedRow[] = useMemo(() => {
    if (!pair || !diff) return [];
    const rows = measurements.filter(m => m.drawingId === aId && (m.pageNumber ?? 1) === aPage);
    return affectedRows(rows, diff, pair.a.w, pair.a.h);
  }, [pair, diff, measurements, aId, aPage]);

  // Check by snap: corners that were on the old linework must still be on the new one.
  const snap = useMemo(() => {
    const ga = pair?.a.geom, gb = pair?.b.geom;
    if (!pair || !ga || !gb || ga.lines.length < MIN_VECTOR_LINES || gb.lines.length < MIN_VECTOR_LINES) return null;
    const scale = ga.w / gb.w;                         // new sheet drawn at the old sheet's size
    const ptPerPx = ga.w / pair.a.w;
    const scaled = shiftGeometry(gb, { x: 0, y: 0 }, scale);
    const guess = { x: move.dx * ptPerPx, y: move.dy * ptPerPx };
    const offset = refineOffset(ga, scaled, guess) ?? guess;
    const rows = measurements.filter(m => m.drawingId === aId && (m.pageNumber ?? 1) === aPage);
    const checks = checkBySnap(rows, ga, shiftGeometry(scaled, offset), { pageW: ga.w, pageH: ga.h });
    return { byId: new Map(checks.map(c => [c.id, c])), shift: { x: offset.x / ga.w, y: offset.y / ga.h } };
  }, [pair, move, measurements, aId, aPage]);

  /** What needs a look: moved by snap, or (where snap cannot tell) changed nearby in the picture. */
  const affected = useMemo(() => {
    const names = new Map(measurements.map(m => [m.id, m.label || m.description || 'Untitled']));
    const out: Array<AffectedRow & { how: 'fix' | 'moved' | 'near' }> = [];
    const seen = new Set<string>();
    for (const c of snap?.byId.values() ?? []) {
      if (c.verdict !== 'moved') continue;
      seen.add(c.id);
      out.push({ id: c.id, name: names.get(c.id) ?? 'Untitled', changed: 0, how: c.suggestion ? 'fix' : 'moved' });
    }
    for (const r of pixelAffected) {
      if (seen.has(r.id) || snap?.byId.get(r.id)?.verdict === 'confirmed') continue;
      out.push({ ...r, how: 'near' });
    }
    return out;
  }, [snap, pixelAffected, measurements]);
  const confirmed = useMemo(() => [...(snap?.byId.values() ?? [])].filter((c: SnapCheck) => c.verdict === 'confirmed').length, [snap]);
  const onPage = useMemo(
    () => measurements.filter(m => m.drawingId === aId && (m.pageNumber ?? 1) === aPage && !m.isGroupHeader && m.points?.length).length,
    [measurements, aId, aPage],
  );

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !pair || !diff) return;
    c.width = pair.a.w; c.height = pair.a.h;
    // Old plan in red, new plan in blue; where both are on and the linework is the same, grey.
    let px: Uint8ClampedArray;
    if (focusId) {
      // Looking at one measurement: just the new plan underneath, in blue.
      const mask = shift(pair.b.mask, pair.a.w, pair.a.h, move.dx, move.dy);
      px = new Uint8ClampedArray(pair.a.w * pair.a.h * 4).fill(255);
      for (let i = 0, q = 0; i < mask.length; i++, q += 4) if (mask[i]) { px[q] = 37; px[q + 1] = 99; px[q + 2] = 235; }
    } else if (showOld && showNew) px = paintDiff(pair.a.mask, pair.b.mask, diff, pair.a.w, pair.a.h, move);
    else {
      const mask = showOld ? pair.a.mask : showNew ? shift(pair.b.mask, pair.a.w, pair.a.h, move.dx, move.dy) : null;
      const [r, g, bl] = showOld ? [220, 38, 38] : [37, 99, 235];
      px = new Uint8ClampedArray(pair.a.w * pair.a.h * 4).fill(255);
      if (mask) for (let i = 0, q = 0; i < mask.length; i++, q += 4) if (mask[i]) { px[q] = r; px[q + 1] = g; px[q + 2] = bl; }
    }
    const ctx = c.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px), pair.a.w, pair.a.h), 0, 0);
    if (!showShapes && !focusId) return;
    // The measurements taken on revision A, in their own colours; the ones on a change get a dashed ring.
    const W = pair.a.w, H = pair.a.h;
    const hit = new Set(affected.map(r => r.id));
    for (const m of measurements) {
      if (focusId && m.id !== focusId) continue;
      if (m.drawingId !== aId || (m.pageNumber ?? 1) !== aPage || m.isGroupHeader || m.isVisible === false || !m.points?.length) continue;
      // Curves are followed properly (an arc is stored as just three points).
      const outline = rowOutlinePx(m, W, H);
      const pts = outline.pts;
      if (!pts.length) continue;
      const isArea = outline.closed;
      const colour = m.color || '#EF9F27';
      ctx.save();
      ctx.strokeStyle = colour; ctx.fillStyle = colour; ctx.lineWidth = 4; ctx.lineJoin = 'round';
      if (pts.length === 1) {
        ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 9, 0, Math.PI * 2); ctx.fill();
      } else {
        const path = () => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); if (isArea) ctx.closePath(); };
        path();
        if (isArea) { ctx.globalAlpha = 0.22; ctx.fill(); ctx.globalAlpha = 1; }
        ctx.stroke();
        if (hit.has(m.id)) { path(); ctx.setLineDash([14, 10]); ctx.lineWidth = 12; ctx.globalAlpha = 0.45; ctx.stroke(); }
      }
      if (pts.length === 1 && hit.has(m.id)) { ctx.globalAlpha = 0.45; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 18, 0, Math.PI * 2); ctx.stroke(); }
      ctx.restore();
      const sug = snap?.byId.get(m.id)?.suggestion;
      if (sug) {
        ctx.save();
        ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 5; ctx.setLineDash([6, 6]); ctx.lineJoin = 'round';
        ctx.beginPath();
        sug.points.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
        if (isArea) ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
    }
  }, [pair, diff, move, showOld, showNew, showShapes, affected, snap, measurements, aId, aPage, focusId]);

  const focusRow = focusId ? measurements.find(m => m.id === focusId) : undefined;
  const focusFix = focusId ? snap?.byId.get(focusId)?.suggestion : undefined;
  // Bring the measurement being looked at to the middle of the page, large enough to read.
  useEffect(() => {
    const area = areaRef.current;
    if (!focusRow || !pair || !area) return;
    const W = pair.a.w, H = pair.a.h;
    const pts = [...rowOutlinePx(focusRow, W, H).pts, ...(focusFix?.points ?? []).map(p => ({ x: p.x * W, y: p.y * H }))];
    if (!pts.length) return;
    const x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x));
    const y0 = Math.min(...pts.map(p => p.y)), y1 = Math.max(...pts.map(p => p.y));
    const box = area.getBoundingClientRect();
    const z = Math.max(0.3, Math.min(6, 0.6 * Math.min(box.width / (Math.max(x1 - x0, 40) * 0.5), box.height / (Math.max(y1 - y0, 40) * 0.5))));
    setZoom(z);
    const raf = requestAnimationFrame(() => {
      const c = canvasRef.current;
      if (!c) return;
      area.scrollLeft = c.offsetLeft + ((x0 + x1) / 2) * z * 0.5 - box.width / 2;
      area.scrollTop  = c.offsetTop  + ((y0 + y1) / 2) * z * 0.5 - box.height / 2;
    });
    return () => cancelAnimationFrame(raf);
  }, [focusRow, focusFix, pair]);

  const nudge = (k: 'dx' | 'dy') => (
    <input
      aria-label={k === 'dx' ? 'Move revision B right, in pixels' : 'Move revision B down, in pixels'}
      type="number" value={move[k]} onChange={e => setMove(m => ({ ...m, [k]: Math.round(Number(e.target.value) || 0) }))}
      className={`w-14 ${field}`}
    />
  );
  const pct = diff ? diff.changedShare * 100 : 0;

  return (
    <div className="fixed inset-0 z-[160] flex bg-[#1D2125] font-mono" style={hidden ? { display: 'none' } : undefined}>
      <div className="w-full h-full flex flex-col">
        <div className="bg-[#1a1a1a] border-b border-amber-accent px-5 py-3 flex items-center gap-3">
          <GitCompareArrows className="w-4 h-4 text-amber-accent" />
          <h2 className="text-amber-accent text-sm uppercase tracking-widest font-black flex-1">Compare revisions</h2>
          <button onClick={onClose} className="flex items-center gap-2 border border-zinc-600 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-zinc-200 hover:border-amber-accent hover:text-amber-accent">
            <X className="w-4 h-4" />Back to takeoff
          </button>
        </div>

        <div className="px-5 py-3 border-b border-zinc-800 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-widest text-zinc-500">
            Revision A (measured)
            <span className="flex gap-1">
              <select value={aId} onChange={e => { setAId(e.target.value); setPair(null); setFocusId(null); }} className={`w-48 ${field}`}>
                {drawings.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <input aria-label="Page of revision A" type="number" min={1} max={a?.pageCount ?? 1} value={aPage}
                onChange={e => { setAPage(Math.max(1, Number(e.target.value) || 1)); setPair(null); setFocusId(null); }} className={`w-14 ${field}`} />
            </span>
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-widest text-zinc-500">
            Revision B (new)
            <span className="flex gap-1">
              <select value={bId} onChange={e => { setBId(e.target.value); setPair(null); setFocusId(null); }} className={`w-48 ${field}`}>
                <option value="">Choose…</option>
                {drawings.filter(d => d.id !== aId).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                <option value="__upload__">{upload ? `File: ${upload.name}` : 'A PDF from this computer…'}</option>
              </select>
              <input aria-label="Page of revision B" type="number" min={1} value={bPage}
                onChange={e => { setBPage(Math.max(1, Number(e.target.value) || 1)); setPair(null); setFocusId(null); }} className={`w-14 ${field}`} />
            </span>
          </label>
          {bId === '__upload__' && (
            <input
              aria-label="Revision B PDF file" type="file" accept="application/pdf"
              onChange={async e => {
                const f = e.target.files?.[0];
                setPair(null);
                setUpload(f ? { name: f.name, data: await f.arrayBuffer(), file: f } : null);
              }}
              className="text-[11px] text-zinc-400 max-w-[14rem]"
            />
          )}
          <button
            onClick={compare} disabled={!a || !hasB || busy}
            className="bg-amber-accent text-black font-black text-[11px] uppercase tracking-widest px-4 py-2 disabled:opacity-40 flex items-center gap-2"
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Compare
          </button>
          {pair && (
            <div className="flex items-end gap-2 ml-auto text-[10px] uppercase tracking-widest text-zinc-500">
              <span className="flex flex-col gap-1">Move B right / down (px)<span className="flex gap-1">{nudge('dx')}{nudge('dy')}</span></span>
              <button onClick={() => setMove(autoAlign(pair.a.mask, pair.b.mask, pair.a.w, pair.a.h))} className={`${field} hover:border-amber-accent`}>Auto-align</button>
              <span className="flex flex-col gap-1">Zoom
                <input aria-label="Zoom" type="range" min={0.3} max={6} step={0.05} value={zoom} onChange={e => setZoom(Number(e.target.value))} className="w-24" />
              </span>
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 flex">
          <div ref={areaRef} className="flex-1 min-w-0 overflow-auto bg-zinc-700 p-3">
            {error && <p role="alert" className="text-red-400 text-xs">{error}</p>}
            {!pair && !error && (
              <p className="text-zinc-300 text-xs max-w-md leading-relaxed">
                Pick the sheet you measured and its new revision, then Compare. The old plan is drawn in red and the new plan in blue;
                where they are the same the line turns grey. Each layer can be switched off. The two sheets should be the same size and scale.
              </p>
            )}
            {pair && (
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <div className="flex gap-2">
                  {([
                    ['Old plan', showOld, setShowOld, '#dc2626'],
                    ['New plan', showNew, setShowNew, '#2563eb'],
                    [`Old measurements (${onPage})`, showShapes, setShowShapes, '#F2C230'],
                  ] as const).map(([label, on, set, colour]) => (
                    <button
                      key={label} type="button" role="switch" aria-checked={on} onClick={() => set(!on)}
                      className={`flex items-center gap-2 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border bg-[#1D2125] ${on ? 'border-zinc-300 text-zinc-100' : 'border-zinc-600 text-zinc-500'}`}
                    >
                      <span className="w-3 h-3 border" style={{ background: on ? colour : 'transparent', borderColor: colour }} />
                      {label}
                    </button>
                  ))}
                </div>
                {showOld && showNew && <span className="text-[11px] text-zinc-300">Grey = the same in both</span>}
                {diff && pct < 0.05 && showOld && showNew && (
                  <p role="status" className="border border-green-500/60 bg-green-900/60 text-green-200 text-xs px-3 py-1.5">
                    These two sheets are identical. Grey means “same in both”, so there is nothing in red or blue.
                  </p>
                )}
              </div>
            )}
            {pair && focusRow && (
              <div className="mb-3 flex flex-wrap items-center gap-3 border border-amber-accent/70 bg-[#1D2125] px-3 py-2 text-[11px] text-zinc-200 sticky left-0">
                <span className="font-bold text-amber-accent uppercase tracking-widest text-[10px]">{focusRow.label || focusRow.description || 'Measurement'}</span>
                <span className="flex items-center gap-1.5"><span className="w-4 h-1" style={{ background: focusRow.color || '#EF9F27' }} />as measured on the old plan: {focusRow.quantity.toFixed(2)} {focusRow.unit}</span>
                {focusFix
                  ? <span className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-green-500" />suggested on the new plan: {focusFix.quantity.toFixed(2)} {focusRow.unit}</span>
                  : <span className="text-zinc-400">no suggestion: adjust it by hand after accepting</span>}
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 bg-[#2563eb]" />new plan</span>
                <button onClick={() => setFocusId(null)} className="ml-auto border border-zinc-600 px-2 py-1 text-[10px] font-bold uppercase tracking-widest hover:border-amber-accent hover:text-amber-accent">Show everything</button>
              </div>
            )}
            {pair && <canvas ref={canvasRef} style={{ width: pair.a.w * zoom * 0.5, height: pair.a.h * zoom * 0.5 }} className="bg-white shadow-xl" />}
          </div>
          {pair && diff && (
            <aside className="w-72 shrink-0 border-l border-zinc-800 flex flex-col">
              <div className="p-3 border-b border-zinc-800 space-y-1.5 text-[11px] text-zinc-300">
                <div className="flex items-center gap-2"><span className="w-3 h-3 bg-[#dc2626]" />Old plan only (removed)</div>
                <div className="flex items-center gap-2"><span className="w-3 h-3 bg-[#2563eb]" />New plan only (added)</div>
                <div className="flex items-center gap-2"><span className="w-3 h-3 bg-[#969696]" />Same in both</div>
                <p className="text-zinc-500 pt-1">
                  {pct < 0.05 ? 'No differences found: the two sheets are the same, so everything is grey.' : `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}% of the linework changed.`}
                  {pct > 60 && ' That is a lot: check these are the same sheet, at the same size.'}
                </p>
              </div>
              <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-800">
                {affected.length} of {onPage} measurements need a look
              </div>
              <div className="px-3 py-2 text-[11px] text-zinc-400 border-b border-zinc-800 leading-relaxed">
                {snap
                  ? <><span className="text-green-400 font-bold">{confirmed}</span> confirmed by snap: their corners still sit on the new plan’s lines.
                      {affected.some(r => r.how === 'fix') && <> A <span className="text-green-400">green dashed</span> outline is a suggested fix.</>}</>
                  : 'This drawing has no linework to snap to (a scan), so measurements are judged by the picture only.'}
              </div>
              <div className="flex-1 overflow-y-auto">
                {affected.map(r => (
                  <button
                    key={r.id} onClick={() => setFocusId(id => (id === r.id ? null : r.id))}
                    aria-pressed={focusId === r.id}
                    title="Show this change here, on the new plan"
                    className={`w-full flex items-center gap-2 text-left px-3 py-2 border-b border-zinc-800 text-xs hover:bg-zinc-800 hover:text-amber-accent ${focusId === r.id ? 'bg-zinc-800 text-amber-accent shadow-[inset_3px_0_0_#F2C230]' : 'text-zinc-200'}`}
                  >
                    <span className="flex-1 min-w-0 truncate">{r.name}</span>
                    <span className={`shrink-0 text-[9px] font-bold uppercase tracking-widest px-1 py-0.5 border ${r.how === 'fix' ? 'border-green-600 text-green-400' : r.how === 'moved' ? 'border-red-500 text-red-400' : 'border-zinc-600 text-zinc-400'}`}>
                      {r.how === 'fix' ? 'Fix ready' : r.how === 'moved' ? 'Moved' : 'Change nearby'}
                    </span>
                  </button>
                ))}
                {affected.length === 0 && <p className="p-3 text-[11px] text-zinc-500">None of the measurements on this page need a look.</p>}
              </div>
              {onAccept && a && (
                <div className="p-3 border-t border-amber-accent/60 bg-[#16191C] space-y-2">
                  {!confirming ? (
                    <>
                      <button
                        onClick={() => setConfirming(true)}
                        className="w-full bg-amber-accent text-black font-black text-[11px] uppercase tracking-widest px-3 py-2.5 hover:bg-amber-400"
                      >Accept the new plan</button>
                      <p className="text-[11px] text-zinc-500 leading-relaxed">
                        Moves your {onPage} measurements onto the new plan and marks the {affected.length} that need a look for checking.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-[11px] text-zinc-200 leading-relaxed">
                        The new plan becomes the working sheet. All {onPage} measurements move onto it, {affected.length} are marked
                        “check”, and today’s quantities are saved for the change report. The old plan stays in the project, empty.
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => onAccept({
                            from: { drawingId: a.id, page: aPage },
                            to: bId === '__upload__' ? { newFile: upload!.file, page: bPage } : { drawingId: bId, page: bPage },
                            shift: snap?.shift ?? { x: move.dx / pair.a.w, y: move.dy / pair.a.h },
                            flaggedIds: affected.map(r => r.id),
                            suggestions: Object.fromEntries([...(snap?.byId.values() ?? [])].filter(c => c.suggestion).map(c => [c.id, c.suggestion!])),
                            sizeRatio: pair.b.ptW > 0 ? pair.a.ptW / pair.b.ptW : 1,
                          })}
                          className="flex-1 bg-amber-accent text-black font-black text-[11px] uppercase tracking-widest px-3 py-2 hover:bg-amber-400"
                        >Yes, accept</button>
                        <button onClick={() => setConfirming(false)} className="flex-1 border border-zinc-600 text-zinc-300 text-[11px] font-bold uppercase tracking-widest px-3 py-2 hover:border-zinc-400">Not yet</button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

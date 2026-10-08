'use client';

// EXPERIMENTS: the page picture with things drawn over it, and (optionally) a box the user drags.

import React, { useEffect, useRef, useState } from 'react';
import type { Box } from '@/lib/demo/symbolCount';

export interface Mark { key: string; box?: Box; point?: { x: number; y: number }; label?: string; tone: 'gold' | 'green' | 'red' }

const TONE = { gold: '#F2C230', green: '#34D399', red: '#F87171' };

export function PageStage({ url, width, height, marks, onBox, sample }: {
  url: string; width: number; height: number; marks: Mark[];
  /** Called with the dragged box, in picture pixels. */
  onBox?: (b: Box) => void;
  sample?: Box | null;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // View: zoom 1 fits the page to the frame's width; tx/ty move it, in screen pixels.
  const [view, setView] = useState({ zoom: 1, tx: 0, ty: 0 });
  const [panMode, setPanMode] = useState(!onBox);
  const [space, setSpace] = useState(false);
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) { e.preventDefault(); setSpace(true); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpace(false); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  /** Zoom about a point of the frame (so what is under the cursor stays there). */
  const zoomAt = (factor: number, cx?: number, cy?: number) => setView(v => {
    const r = frame.current?.getBoundingClientRect();
    const px = cx ?? (r ? r.width / 2 : 0), py = cy ?? (r ? r.height / 2 : 0);
    const zoom = Math.min(12, Math.max(0.4, v.zoom * factor));
    const k = zoom / v.zoom;
    return { zoom, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
  });
  // A non-passive wheel listener, so the page itself does not scroll while zooming.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * width, y: ((e.clientY - r.top) / r.height) * height };
  };
  const pct = (b: Box) => ({ left: `${(b.x / width) * 100}%`, top: `${(b.y / height) * 100}%`, width: `${(b.w / width) * 100}%`, height: `${(b.h / height) * 100}%` });
  const live = drag ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) } : null;
  const panning = panMode || space || !onBox;
  const btn = 'w-7 h-7 flex items-center justify-center border border-zinc-700 bg-zinc-950/90 text-zinc-200 text-sm hover:border-amber-accent hover:text-amber-accent';
  // Outlines keep the same thickness on screen whatever the zoom.
  const line = 2 / view.zoom;

  return (
    <div className="relative">
      <div className="absolute z-10 top-2 left-2 flex items-center gap-1 font-mono">
        <button type="button" className={btn} aria-label="Zoom out" title="Zoom out" onClick={() => zoomAt(1 / 1.3)}>−</button>
        <span className="px-2 h-7 flex items-center border border-zinc-700 bg-zinc-950/90 text-[10px] text-zinc-300 tabular-nums">{Math.round(view.zoom * 100)}%</span>
        <button type="button" className={btn} aria-label="Zoom in" title="Zoom in" onClick={() => zoomAt(1.3)}>+</button>
        <button type="button" className={`${btn} w-auto px-2 text-[10px] uppercase tracking-widest`} title="Fit the page" onClick={() => setView({ zoom: 1, tx: 0, ty: 0 })}>Fit</button>
        {onBox && (
          <button type="button" aria-pressed={panMode} title="Drag to move the page instead of drawing a box (or hold Space, or use the middle mouse button)"
            className={`${btn} w-auto px-2 text-[10px] uppercase tracking-widest ${panMode ? 'border-amber-accent text-amber-accent' : ''}`} onClick={() => setPanMode(m => !m)}>
            {panMode ? 'Moving' : 'Move'}
          </button>
        )}
      </div>
      <div className="absolute z-10 bottom-2 left-2 px-2 py-1 bg-zinc-950/90 border border-zinc-800 text-[10px] text-zinc-500 font-mono pointer-events-none">
        Scroll to zoom · {onBox ? 'hold Space or middle button to move' : 'drag to move'}
      </div>
      <div ref={frame} className="overflow-hidden border border-zinc-800 bg-zinc-800 h-[calc(100vh-15rem)] min-h-[360px]" style={{ touchAction: 'none' }}
        onPointerDown={e => {
          if (e.button === 1 || (e.button === 0 && panning)) {
            e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
            pan.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
          }
        }}
        onPointerMove={e => { const p = pan.current; if (p) setView(v => ({ ...v, tx: p.tx + e.clientX - p.x, ty: p.ty + e.clientY - p.y })); }}
        onPointerUp={() => { pan.current = null; }}
        onPointerCancel={() => { pan.current = null; }}
      >
        <div
          ref={ref} className="relative select-none origin-top-left"
          style={{ width: '100%', aspectRatio: `${width} / ${height}`, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.zoom})`, cursor: panning ? (pan.current ? 'grabbing' : 'grab') : 'crosshair' }}
          onPointerDown={e => { if (!onBox || panning || e.button !== 0) return; e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); const p = at(e); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }}
          onPointerMove={e => { if (drag) { const p = at(e); setDrag({ ...drag, x1: p.x, y1: p.y }); } }}
          onPointerUp={() => { if (live && live.w > 4 && live.h > 4) onBox?.(live); setDrag(null); }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Drawing page" draggable={false} className="absolute inset-0 w-full h-full" />
          {marks.map(m => m.box ? (
            <div key={m.key} className="absolute pointer-events-none" style={{ ...pct(m.box), outline: `${line}px solid ${TONE[m.tone]}`, background: `${TONE[m.tone]}22` }} />
          ) : m.point ? (
            <div key={m.key} className="absolute pointer-events-none whitespace-nowrap px-1 text-[10px] font-bold text-black origin-center"
              style={{ left: `${(m.point.x / width) * 100}%`, top: `${(m.point.y / height) * 100}%`, background: TONE[m.tone], transform: `translate(-50%, -50%) scale(${1 / view.zoom})` }}>{m.label}</div>
          ) : null)}
          {sample && <div className="absolute pointer-events-none" style={{ ...pct(sample), outline: `${line}px dashed #fff` }} />}
          {live && <div className="absolute pointer-events-none" style={{ ...pct(live), outline: `${line}px dashed #F2C230`, background: '#F2C23022' }} />}
        </div>
      </div>
    </div>
  );
}

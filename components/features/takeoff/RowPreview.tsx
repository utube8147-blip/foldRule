'use client';
// Visual reference: where a takeoff row sits on its drawing. Shows the part of the page
// around the measurement, with the measurement highlighted.

import React, { useEffect, useRef, useState } from 'react';
import type { Drawing, TakeoffRow } from '@/types';
import pdfjsLib from '@/lib/pdf/pdfClient';
import { rowOutlinePx } from '@/lib/takeoff/rowOutline';

const SIDE = 1600;            // pixels on the long side of the rendered page
const OUT_W = 640, OUT_H = 360;

// A few rendered pages are kept so moving between rows of one sheet is instant.
const pages = new Map<string, Promise<HTMLCanvasElement>>();
async function renderPage(d: Drawing, pageNo: number): Promise<HTMLCanvasElement> {
  const key = `${d.id}:${pageNo}`;
  let hit = pages.get(key);
  if (!hit) {
    hit = (async () => {
      const data = d.file ? await d.file.arrayBuffer() : await (await fetch(d.fileUrl)).arrayBuffer();
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const doc = await (pdfjsLib as any).getDocument({ data: new Uint8Array(data) }).promise;
      try {
        const page = await doc.getPage(Math.min(Math.max(1, pageNo), doc.numPages));
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: SIDE / Math.max(base.width, base.height) });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        await page.render({ canvasContext: ctx, viewport: vp, canvas: c } as any).promise;
        return c;
      } finally { void doc.destroy?.(); }
    })();
    pages.set(key, hit);
    hit.catch(() => pages.delete(key));
    while (pages.size > 4) pages.delete(pages.keys().next().value as string);
  }
  return hit;
}

export function RowPreview({ row, measurements, drawings }: { row?: TakeoffRow; measurements: TakeoffRow[]; drawings: Drawing[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'empty' | 'loading' | 'ready' | 'none' | 'error'>('empty');

  // A row worked out from another shape (plaster from a wall) is shown where that shape is.
  // A group is shown by its rows.
  const shapes: TakeoffRow[] = !row ? []
    : row.isGroupHeader ? measurements.filter(m => row.childIds?.includes(m.id) && m.points?.length)
    : row.points?.length ? [row]
    : row.derived ? measurements.filter(m => m.id === row.derived!.sourceId && m.points?.length) : [];
  const first = shapes[0];
  const drawing = first ? drawings.find(d => d.id === first.drawingId) : undefined;
  const pageNo = first?.pageNumber ?? 1;
  const key = shapes.map(s => s.id).join(',');

  useEffect(() => {
    let live = true;
    if (!row) { setState('empty'); return; }
    if (!first || !drawing) { setState('none'); return; }
    setState('loading');
    renderPage(drawing, pageNo).then(page => {
      const c = ref.current;
      if (!live || !c) return;
      const W = page.width, H = page.height;
      const outlines = shapes.filter(s => (s.pageNumber ?? 1) === pageNo && s.drawingId === drawing.id).map(s => ({ s, o: rowOutlinePx(s, W, H) }));
      const pts = outlines.flatMap(x => x.o.pts);
      if (!pts.length) { setState('none'); return; }
      // Frame the measurement with some of the drawing around it, in the box's proportions.
      const x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x));
      const y0 = Math.min(...pts.map(p => p.y)), y1 = Math.max(...pts.map(p => p.y));
      let w = Math.max((x1 - x0) * 1.6, W * 0.12), h = Math.max((y1 - y0) * 1.6, H * 0.12);
      if (w / h > OUT_W / OUT_H) h = w * OUT_H / OUT_W; else w = h * OUT_W / OUT_H;
      const sx = (x0 + x1) / 2 - w / 2, sy = (y0 + y1) / 2 - h / 2, k = OUT_W / w;
      c.width = OUT_W; c.height = OUT_H;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, OUT_W, OUT_H);
      ctx.drawImage(page, sx, sy, w, h, 0, 0, OUT_W, OUT_H);
      for (const { s, o } of outlines) {
        ctx.save();
        ctx.strokeStyle = ctx.fillStyle = s.color || '#F2C230';
        ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        if (o.pts.length === 1) {
          ctx.beginPath(); ctx.arc((o.pts[0].x - sx) * k, (o.pts[0].y - sy) * k, 9, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.beginPath();
          o.pts.forEach((p, i) => (i ? ctx.lineTo((p.x - sx) * k, (p.y - sy) * k) : ctx.moveTo((p.x - sx) * k, (p.y - sy) * k)));
          if (o.closed) { ctx.closePath(); ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1; }
          ctx.stroke();
        }
        ctx.restore();
      }
      setState('ready');
    }).catch(() => { if (live) setState('error'); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, drawing?.id, pageNo, row?.id]);

  const label = !row ? 'Select a row to see it on the drawing'
    : state === 'loading' ? 'Opening the drawing…'
    : state === 'none' ? 'This row was typed in: it has no place on a drawing'
    : state === 'error' ? 'The drawing could not be opened'
    : `${drawing?.name ?? ''} · page ${pageNo}`;

  return (
    <div className="aspect-video bg-zinc-900 border border-zinc-800 relative overflow-hidden">
      <div className="absolute inset-0" style={{
        backgroundImage: 'linear-gradient(#3f3f46 1px, transparent 1px), linear-gradient(90deg, #3f3f46 1px, transparent 1px)',
        backgroundSize: '16px 16px', opacity: 0.3,
      }} />
      <canvas ref={ref} className={`absolute inset-0 w-full h-full ${state === 'ready' ? '' : 'hidden'}`} />
      <div className={`absolute inset-x-0 flex justify-center ${state === 'ready' ? 'bottom-1.5' : 'inset-y-0 items-center'}`}>
        <div className="text-[10px] font-bold bg-zinc-950/85 px-2 py-1 border border-zinc-800 text-zinc-300 uppercase tracking-widest max-w-[94%] truncate">{label}</div>
      </div>
    </div>
  );
}

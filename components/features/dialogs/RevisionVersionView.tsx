'use client';
// One superseded version of a sheet: the old plan with the takeoff exactly as it stood
// when the next revision was accepted. Read-only; nothing here counts towards totals.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, RotateCcw } from 'lucide-react';
import type { Drawing, TakeoffRow } from '@/types';
import pdfjsLib from '@/lib/pdf/pdfClient';
import { rowOutlinePx } from '@/lib/takeoff/rowOutline';
import { billedQuantities } from '@/lib/takeoff/timesing';
import type { VersionNode } from '@/lib/takeoff/revisions';
import { downloadBlob } from '@/lib/storage/projectDb';

const MAX_SIDE = 1800;
const q = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function bytesOf(d: Drawing): Promise<ArrayBuffer> {
  if (d.file) return d.file.arrayBuffer();
  if (d.fileUrl) return (await fetch(d.fileUrl)).arrayBuffer();
  throw new Error('The PDF of the old plan is not available on this computer.');
}

interface Props {
  node: VersionNode;
  drawings: Drawing[];
  projectName: string;
  /** Rows measured on the newer sheet that restoring would set aside (0 = nothing to ask about). */
  newWork: number;
  onRestore?: (keepNew: boolean) => void;
}

export function RevisionVersionView({ node, drawings, projectName, newWork, onRestore }: Props) {
  const [asking, setAsking] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const archive = useMemo(() => node.rows ?? [], [node]);
  const old = drawings.find(d => d.id === node.drawingId);
  const v = { from: node.version };
  const rows = archive.filter(m => !m.isGroupHeader);
  const billed = useMemo(() => billedQuantities(archive, old ? [old] : []), [archive, old]);
  const groupOf = (m: TakeoffRow) => {
    const h = m.parentId ? archive.find(x => x.id === m.parentId) : undefined;
    return h?.isGroupHeader ? h.groupName || h.description || h.label : undefined;
  };

  useEffect(() => {
    let live = true;
    (async () => {
      setState('loading');
      try {
        if (!old) throw new Error('The old plan has been removed from the project. The quantities on the right are still the record.');
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        const doc = await (pdfjsLib as any).getDocument({ data: new Uint8Array(await bytesOf(old)) }).promise;
        try {
          const page = await doc.getPage(Math.min(node.page, doc.numPages));
          const base = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: MAX_SIDE / Math.max(base.width, base.height) });
          const c = canvasRef.current;
          if (!live || !c) return;
          c.width = Math.round(vp.width); c.height = Math.round(vp.height);
          const ctx = c.getContext('2d')!;
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
          await page.render({ canvasContext: ctx, viewport: vp, canvas: c } as any).promise;
          if (!live) return;
          const W = c.width, H = c.height;
          for (const m of archive) {
            if (m.isGroupHeader || m.isVisible === false || !m.points?.length || m.drawingId !== node.drawingId) continue;
            ctx.save();
            ctx.strokeStyle = ctx.fillStyle = m.color || '#EF9F27';
            ctx.lineWidth = 4; ctx.lineJoin = 'round';
            if (m.type === 'Count' || m.type === 'Point') {
              for (const p of m.points) { if (p.x < 0) continue; ctx.beginPath(); ctx.arc(p.x * W, p.y * H, 8, 0, Math.PI * 2); ctx.fill(); }
            } else {
              const { pts, closed } = rowOutlinePx(m, W, H);
              if (pts.length >= 2) {
                ctx.beginPath();
                pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
                if (closed) {
                  ctx.closePath();
                  for (const h of m.holes ?? []) { h.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H))); ctx.closePath(); }
                  ctx.globalAlpha = 0.2; ctx.fill('evenodd'); ctx.globalAlpha = 1;
                }
                ctx.stroke();
              }
            }
            ctx.restore();
          }
          setState('ready');
        } finally { void doc.destroy?.(); }
      } catch (e) {
        if (live) { setError(e instanceof Error ? e.message : 'Could not open the old plan.'); setState('error'); }
      }
    })();
    return () => { live = false; };
  }, [node, old, archive]);

  const downloadPdf = async () => {
    if (!old) return;
    setBusy(true);
    try {
      const { buildMarkedUpPdf } = await import('@/lib/export/markupPdf');
      const pdf = await buildMarkedUpPdf({ pdfBytes: await bytesOf(old), drawing: old, measurements: archive, projectName: `${projectName} (version ${v.from}, ${node.status})` });
      downloadBlob(new Blob([pdf as BlobPart], { type: 'application/pdf' }), `${old.name.replace(/\.pdf$/i, '')}-version-${v.from}-marked-up.pdf`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the PDF.');
    } finally { setBusy(false); }
  };

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 overflow-auto bg-zinc-700 p-3">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span className="border border-zinc-400 bg-[#1D2125] px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-100">
            Version {v.from} · {node.name} · {node.status}
          </span>
          <span className="text-[11px] text-zinc-300">Frozen record: it cannot be edited and is not counted in any total.</span>
        </div>
        {state === 'loading' && <p className="flex items-center gap-2 text-xs text-zinc-200"><Loader2 className="w-4 h-4 animate-spin" />Opening the old plan…</p>}
        {error && <p role="alert" className="text-xs text-amber-300 max-w-xl mb-3">{error}</p>}
        <canvas ref={canvasRef} className={`bg-white shadow-xl max-w-full h-auto ${state === 'ready' ? '' : 'hidden'}`} />
      </div>
      <aside className="w-96 shrink-0 border-l border-zinc-800 flex flex-col">
        <div className="p-3 border-b border-zinc-800 space-y-2">
          {onRestore && !asking && (
            <button
              onClick={() => (node.restore?.target === 'from' && newWork > 0 ? setAsking(true) : onRestore(false))}
              className="w-full flex items-center justify-center gap-2 bg-amber-accent text-black font-black text-[11px] uppercase tracking-widest px-3 py-2.5 hover:bg-amber-400"
            ><RotateCcw className="w-4 h-4" />Restore version {v.from}</button>
          )}
          {onRestore && asking && (
            <div className="border border-amber-accent/60 p-2 space-y-2">
              <p className="text-[11px] text-zinc-200 leading-relaxed">
                You measured {newWork} new {newWork === 1 ? 'item' : 'items'} on the newer plan. What should happen to {newWork === 1 ? 'it' : 'them'}?
              </p>
              <button onClick={() => onRestore(false)} className="w-full text-left border border-zinc-600 px-2 py-1.5 text-[11px] text-zinc-100 hover:border-amber-accent">
                <b>Set aside with that version.</b> <span className="text-zinc-400">They come back if you return to it.</span>
              </button>
              <button onClick={() => onRestore(true)} className="w-full text-left border border-zinc-600 px-2 py-1.5 text-[11px] text-zinc-100 hover:border-amber-accent">
                <b>Keep them in the takeoff.</b> <span className="text-zinc-400">They stay on the newer plan and are still counted.</span>
              </button>
              <button onClick={() => setAsking(false)} className="text-[11px] text-zinc-500 hover:text-zinc-300">Cancel</button>
            </div>
          )}
          {!onRestore && node.blocked && <p className="text-[11px] text-zinc-400 leading-relaxed">{node.blocked}</p>}
          <button
            onClick={downloadPdf} disabled={!old || busy}
            className="w-full flex items-center justify-center gap-2 border border-zinc-500 text-zinc-100 font-black text-[11px] uppercase tracking-widest px-3 py-2.5 hover:border-amber-accent hover:text-amber-accent disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}Marked-up PDF of version {v.from}
          </button>
        </div>
        <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-800">{rows.length} items as measured on version {v.from}</div>
        <div className="flex-1 overflow-y-auto">
          {rows.map(m => (
            <div key={m.id} className="flex items-baseline gap-2 px-3 py-2 border-b border-zinc-800 text-xs">
              <span className="w-2.5 h-2.5 shrink-0 self-center" style={{ background: m.color || '#EF9F27' }} />
              <span className="flex-1 min-w-0 truncate text-zinc-200" title={m.description}>
                {m.description || m.label || 'Untitled'}{groupOf(m) && <span className="text-zinc-500"> · {groupOf(m)}</span>}
              </span>
              <span className="tabular-nums text-zinc-100">{q(billed.get(m.id) ?? m.quantity)}</span>
              <span className="w-9 text-zinc-500">{m.unit}</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

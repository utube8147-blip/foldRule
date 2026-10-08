'use client';

// EXPERIMENT 3 UI: rooms and stated areas read from the drawing's text.

import React, { useMemo, useState } from 'react';
import type { DemoPage } from '@/hooks/demo/useDemoPage';
import { findRooms } from '@/lib/demo/rooms';
import { PageStage, type Mark } from './PageStage';

export function RoomsPanel({ page, onAdd }: { page: DemoPage; onAdd?: (rooms: { name: string; area: number; x: number; y: number }[]) => void }) {
  const rooms = useMemo(() => findRooms(page.texts), [page.texts]);
  const [off, setOff] = useState<Set<number>>(new Set());
  const [added, setAdded] = useState<string | null>(null);
  const marks: Mark[] = rooms.map((r, i) => ({ key: String(i), point: { x: r.x, y: r.y }, label: `${i + 1}`, tone: r.statedArea ? (off.has(i) ? 'red' : 'green') : 'gold' }));
  const usable = rooms.map((r, i) => ({ r, i })).filter(x => x.r.statedArea && !off.has(x.i));
  const total = usable.reduce((s, x) => s + (x.r.statedArea ?? 0), 0);

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_340px] items-start">
      <PageStage url={page.url!} width={page.width} height={page.height} marks={marks} />
      <aside className="space-y-4 text-xs">
        <p className="text-zinc-400 leading-relaxed">
          Room names and the areas or sizes <b className="text-zinc-200">printed on the drawing</b>. Green has an area, gold is a name only. These are the architect’s figures, not measurements: use them to check your own takeoff or as a first pass.
        </p>
        {page.texts.length === 0 ? (
          <p className="border border-amber-accent/50 bg-amber-accent/10 px-3 py-2 text-amber-200">This page has no readable text. It is probably a scan or the text was converted to outlines, so there is nothing to read.</p>
        ) : rooms.length === 0 ? (
          <p className="border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-400">No room names were recognised among {page.texts.length} pieces of text on this page.</p>
        ) : (
          <>
            <ul className="max-h-[50vh] overflow-y-auto border border-zinc-800 divide-y divide-zinc-800">
              {rooms.map((r, i) => (
                <li key={i} className="flex items-center gap-2 px-2 py-1.5">
                  <span className="w-5 h-5 shrink-0 flex items-center justify-center text-[10px] font-bold text-black" style={{ background: r.statedArea ? '#34D399' : '#F2C230' }}>{i + 1}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-zinc-100 truncate">{r.name}</span>
                    {r.evidence && <span className="block text-[10px] text-zinc-600 truncate" title={r.evidence}>{r.from === 'dimensions' ? 'from size ' : 'reads '}“{r.evidence}”</span>}
                  </span>
                  <span className="tabular-nums text-zinc-200 whitespace-nowrap">{r.statedArea ? `${r.statedArea.toFixed(2)} m²` : <span className="text-zinc-600">no area</span>}</span>
                  {r.statedArea ? <input type="checkbox" aria-label={`Include ${r.name}`} checked={!off.has(i)} onChange={() => setOff(s => { const t = new Set(s); if (t.has(i)) t.delete(i); else t.add(i); return t; })} className="accent-[#F2C230]" /> : <span className="w-[13px]" />}
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border border-zinc-800 bg-zinc-900 px-3 py-2">
              <span className="text-[10px] uppercase tracking-widest text-zinc-500">{usable.length} rooms with an area</span>
              <span className="text-sm font-black text-amber-accent tabular-nums">{total.toFixed(2)} m²</span>
            </div>
            <button type="button" disabled={!usable.length || !onAdd}
              onClick={() => { onAdd?.(usable.map(x => ({ name: x.r.name, area: x.r.statedArea!, x: x.r.x / page.width, y: x.r.y / page.height }))); setAdded(`${usable.length} rooms added to the takeoff in a group called “Rooms (as stated on the drawing)”.`); }}
              className="w-full px-3 py-2 bg-amber-accent text-black text-[11px] font-bold uppercase tracking-widest hover:bg-amber-400 disabled:opacity-40">
              Add {usable.length || ''} rooms to the takeoff
            </button>
            {!onAdd && <p className="text-zinc-500">This PDF was opened only to try the experiment and is not part of the project, so nothing can be added from it.</p>}
            {added && <p role="status" className="text-emerald-400">{added}</p>}
          </>
        )}
      </aside>
    </div>
  );
}

'use client';

// EXPERIMENT 2 UI: drag a box round one symbol, find the rest, add them as a count row.

import React, { useMemo, useState } from 'react';
import type { DemoPage } from '@/hooks/demo/useDemoPage';
import { findSymbols, type Box, type Match } from '@/lib/demo/symbolCount';
import { PageStage, type Mark } from './PageStage';

export function SymbolCountPanel({ page, onAdd }: { page: DemoPage; onAdd?: (points: { x: number; y: number }[], name: string) => void }) {
  const [sample, setSample] = useState<Box | null>(null);
  const [found, setFound] = useState<Match[]>([]);
  const [minScore, setMinScore] = useState(0.8);
  const [turns, setTurns] = useState(true);
  const [off, setOff] = useState<Set<number>>(new Set());
  const [name, setName] = useState('');
  const [ms, setMs] = useState<number | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const search = (box: Box, score = minScore, t = turns) => {
    if (!page.ink) return;
    setSample(box); setOff(new Set()); setAdded(null);
    const t0 = performance.now();
    // Searched loosely once; the slider then only filters, so moving it is instant.
    setFound(findSymbols(page.ink, box, { minScore: Math.min(score, 0.6), turns: t }));
    setMs(Math.round(performance.now() - t0));
  };
  const shown = useMemo(() => found.map((m, i) => ({ m, i })).filter(x => x.m.score >= minScore - 0.1), [found, minScore]);
  const kept = shown.filter(x => !off.has(x.i));
  const marks: Mark[] = shown.map(x => ({ key: String(x.i), box: x.m, tone: off.has(x.i) ? 'red' : 'green' }));

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_300px] items-start">
      <PageStage url={page.url!} width={page.width} height={page.height} marks={marks} sample={sample} onBox={b => search(b)} />
      <aside className="space-y-4 text-xs">
        <p className="text-zinc-400 leading-relaxed">
          <b className="text-zinc-200">Drag a tight box round one symbol</b> (a door, a socket, a chair). Every place on this page with the same ink is outlined in green.
        </p>
        <div className="border border-zinc-800 bg-zinc-900 px-3 py-3">
          <div className="text-[10px] uppercase tracking-widest text-zinc-500">Found</div>
          <div className="text-2xl font-black text-amber-accent">{sample ? kept.length : '—'}</div>
          {ms !== null && sample && <div className="text-[10px] text-zinc-600">searched in {ms} ms{shown.length !== kept.length ? ` · ${shown.length - kept.length} excluded by you` : ''}</div>}
        </div>
        <label className="block">
          <span className="flex justify-between text-[10px] uppercase tracking-widest text-zinc-500"><span>How alike</span><span>{Math.round(minScore * 100)}%</span></span>
          <input type="range" min={0.6} max={0.98} step={0.01} value={minScore} aria-label="How alike a match must be" onChange={e => setMinScore(parseFloat(e.target.value))} className="w-full accent-[#F2C230]" />
          <span className="block text-[10px] text-zinc-600">Lower finds more (and more wrong ones); higher finds only near-identical copies.</span>
        </label>
        <label className="flex items-center gap-2 text-zinc-300">
          <input type="checkbox" checked={turns} onChange={e => { setTurns(e.target.checked); if (sample) search(sample, minScore, e.target.checked); }} className="accent-[#F2C230]" />
          Also find copies turned 90°, 180°, 270°
        </label>
        {shown.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">Untick the wrong ones</div>
            <ul className="max-h-40 overflow-y-auto border border-zinc-800 divide-y divide-zinc-800">
              {shown.map((x, n) => (
                <li key={x.i}>
                  <label className="flex items-center gap-2 px-2 py-1 text-zinc-300">
                    <input type="checkbox" checked={!off.has(x.i)} onChange={() => setOff(s => { const t = new Set(s); if (t.has(x.i)) t.delete(x.i); else t.add(x.i); return t; })} className="accent-[#F2C230]" />
                    <span className="flex-1">#{n + 1}{x.m.turn ? ` · turned ${x.m.turn}°` : ''}</span>
                    <span className="text-zinc-600">{Math.round(x.m.score * 100)}%</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="space-y-2 border-t border-zinc-800 pt-3">
          <input aria-label="Name for the count" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Doors D1" className="w-full bg-zinc-950 border border-zinc-700 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-amber-accent" />
          <button type="button" disabled={!kept.length || !onAdd}
            onClick={() => { const n = name.trim() || 'Counted symbols'; onAdd?.(kept.map(x => ({ x: (x.m.x + x.m.w / 2) / page.width, y: (x.m.y + x.m.h / 2) / page.height })), n); setAdded(`${kept.length} added to the takeoff as “${n}”.`); }}
            className="w-full px-3 py-2 bg-amber-accent text-black text-[11px] font-bold uppercase tracking-widest hover:bg-amber-400 disabled:opacity-40">
            Add {kept.length || ''} to the takeoff as a count
          </button>
          {!onAdd && <p className="text-zinc-500">This PDF was opened only to try the experiment and is not part of the project, so nothing can be added from it.</p>}
          {added && <p role="status" className="text-emerald-400">{added}</p>}
        </div>
        <p className="text-[10px] text-zinc-600 leading-relaxed">
          Limits: it does not find copies drawn at another size or mirrored, and symbols touching a wall line may be missed. The workspace’s own “Find &amp; count” tool handles any angle.
        </p>
      </aside>
    </div>
  );
}

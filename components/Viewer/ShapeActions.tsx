'use client';
// What you can do with the shape(s) you have selected: a small bar at the
// bottom of the drawing, and the same actions on right-click.

import React, { useEffect, useRef, useState } from 'react';
import {
  SquaresUnite, SquaresSubtract, SquaresIntersect, SquaresExclude, Scissors, Slice, Copy, Trash2,
  Plus, Minus, Calculator, ArrowRightLeft, X, SquareDashed, Ruler, TriangleAlert, FolderInput,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { isAreaRow, hasPlainPoints, type ShapeActionsApi, type ConvertKind } from '@/hooks/shapes/useShapeActions';
import {
  BUILT_IN_ASSEMBLIES, STANDARD_OPENINGS, DEFAULT_MIN_VOID_M2, assemblyFits, type Opening, type OpeningDeduction,
} from '@/lib/takeoff/assemblies';

export interface ShapeMenuState { x: number; y: number; at: { x: number; y: number }; tol: number }

interface Item { key: string; label: string; hint: string; icon: LucideIcon; run: () => void; danger?: boolean }

function useItems(api: ShapeActionsApi, menu: ShapeMenuState | null, openConvert: () => void, openCopy: () => void, openGroup: () => void): Item[] {
  const { selectedRows, primary } = api;
  const areas = selectedRows.filter(isAreaRow);
  const items: Item[] = [];
  if (!primary) return items;

  if (selectedRows.length >= 2) {
    if (selectedRows.filter(m => !m.isGroupHeader && m.type === 'Length').length >= 2) {
      items.push({ key: 'join', label: 'Join lines', hint: 'Make the selected lines one continuous line (they must meet end to end)', icon: SquaresUnite, run: api.joinLines });
    }
    if (areas.length >= 2) {
      items.push(
        { key: 'merge', label: 'Merge', hint: 'Join the selected areas into one', icon: SquaresUnite, run: api.merge },
        { key: 'subtract', label: 'Subtract', hint: 'Take the other area(s) away from the first one you selected, and remove them', icon: SquaresSubtract, run: () => api.subtract(false) },
        { key: 'trim', label: 'Trim overlap', hint: 'Remove the overlap from the first area, keep the others — so nothing is counted twice', icon: SquaresExclude, run: () => api.subtract(true) },
        { key: 'intersect', label: 'Intersect', hint: 'Keep only the part the areas share', icon: SquaresIntersect, run: api.intersect },
      );
    }
  } else {
    const hit = menu ? api.probe(menu.at, menu.tol) : null;
    if (hit?.vertex) items.push({ key: 'delpt', label: 'Delete this point', hint: 'Remove the corner under the cursor', icon: Minus, run: () => api.deletePoint(menu!.at, menu!.tol) });
    else if (hit?.edge) items.push(
      { key: 'addpt', label: 'Add a point here', hint: 'Add a corner on this edge, then drag it', icon: Plus, run: () => api.addPoint(menu!.at, menu!.tol) },
      { key: 'edge', label: 'Measure this edge', hint: 'Add just this edge as a length row (part of the perimeter)', icon: Ruler, run: () => api.edgeLength(menu!.at, menu!.tol) },
    );
    if (isAreaRow(primary)) {
      items.push(
        { key: 'cutout', label: 'Cut out', hint: 'Draw a shape inside this area to deduct it (column, shaft, opening)', icon: Scissors, run: api.beginCutout },
        { key: 'split', label: 'Split', hint: 'Draw a line across this area to make two areas', icon: Slice, run: api.beginSplit },
      );
      if (primary.holes?.length) items.push({ key: 'fill', label: 'Remove cut-outs', hint: 'Fill the cut-outs back in', icon: SquareDashed, run: api.removeCutouts });
    }
    if (isAreaRow(primary) || primary.type === 'Length') {
      items.push({ key: 'convert', label: 'Convert', hint: 'Work out other quantities from this shape: perimeter, volume, wall area, or a whole assembly', icon: Calculator, run: openConvert });
    }
    if (hasPlainPoints(primary) && !primary.parentId && !primary.holes?.length) {
      items.push(primary.type === 'Length'
        ? { key: 'close', label: 'Close into area', hint: 'Join the last point to the first and measure the area', icon: ArrowRightLeft, run: api.toggleClosed }
        : { key: 'open', label: 'Open into line', hint: 'Measure this outline as a length instead of an area', icon: ArrowRightLeft, run: api.toggleClosed });
    }
  }
  if (selectedRows.some(m => !m.isGroupHeader && m.points?.length)) {
    items.push({ key: 'copy', label: 'Copy', hint: 'Duplicate, mirror, or repeat at a spacing', icon: Copy, run: openCopy });
  }
  if (selectedRows.some(m => !m.isGroupHeader && m.type === 'Length' && (m.points?.length ?? 0) >= 2)) {
    items.splice(Math.min(items.length, 1), 0, { key: 'gap', label: 'Remove a part', hint: 'Click the two ends of a stretch to take out of the line (a doorway, an opening)', icon: Scissors, run: api.beginGap });
  }
  if (api.groupTargets.length > 0 || api.inGroup || api.canMakeGroup) {
    items.push({ key: 'group', label: 'Move to group', hint: 'Put it in another group — it takes that group’s name, colour and material', icon: FolderInput, run: openGroup });
  }
  items.push({ key: 'del', label: 'Delete', hint: 'Remove from the takeoff (Ctrl+Z brings it back)', icon: Trash2, run: api.remove, danger: true });
  return items;
}

const fieldCls = 'bg-zinc-800 border border-zinc-600 px-2 py-1 text-xs font-mono text-zinc-100 focus:outline-none focus:border-amber-400';

/** Several BOQ rows from one shape (wall → blockwork, plaster, paint, skirting), less counted openings. */
function AssemblyPanel({ api, onDone }: { api: ShapeActionsApi; onDone: () => void }) {
  const m = api.primary;
  const fits = BUILT_IN_ASSEMBLIES.filter(a => m && assemblyFits(a, m));
  const [id, setId] = useState(fits[0]?.id ?? '');
  const [params, setParams] = useState<Record<string, string>>({});
  /** Count row id → opening id ('' = not an opening, 'custom' = typed size). */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, { w: string; h: string }>>({});
  const [minVoid, setMinVoid] = useState(String(DEFAULT_MIN_VOID_M2));
  const a = fits.find(x => x.id === id) ?? fits[0];
  if (!m || !a) return <div className="w-80 p-3 text-[11px] text-zinc-500">No assembly starts from this kind of shape.</div>;

  const num = (v: string | undefined, fallback: number) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) && n > 0 ? n : fallback; };
  const values = Object.fromEntries(a.params.map(p => [p.key, num(params[p.key], p.value)]));
  const canDeduct = a.lines.some(l => l.deduct);
  const deductions: OpeningDeduction[] = [];
  for (const c of api.countRows) {
    const pick = picked[c.id];
    if (!pick) continue;
    let o: Opening | undefined = STANDARD_OPENINGS.find(x => x.id === pick);
    if (pick === 'custom') {
      const w = num(custom[c.id]?.w, 0), h = num(custom[c.id]?.h, 0);
      o = w && h ? { id: 'custom', name: `Opening ${w} × ${h}`, kind: 'door', width: w, height: h } : undefined;
    }
    if (o) deductions.push({ sourceId: c.id, opening: o });
  }
  const opts = { params: values, deductions, minVoid: num(minVoid, 0) };
  const rows = api.assemblyRows(a, opts);

  return (
    <div className="space-y-2">
      <select aria-label="Assembly" value={a.id} onChange={e => setId(e.target.value)} className={`w-full ${fieldCls}`}>
        {fits.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      {a.params.map(p => (
        <label key={p.key} className="flex items-center gap-2 text-[11px] text-zinc-400">
          <span className="flex-1">{p.label}</span>
          <input
            inputMode="decimal" value={params[p.key] ?? String(p.value)}
            onChange={e => setParams(s => ({ ...s, [p.key]: e.target.value }))}
            onKeyDown={e => e.stopPropagation()} className={`w-20 ${fieldCls}`}
          />
          <span className="w-6">{p.unit}</span>
        </label>
      ))}
      {canDeduct && (
        <div className="border border-zinc-700 p-2 space-y-1.5">
          <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-400">Deduct counted openings</div>
          {api.countRows.length === 0 && (
            <div className="text-[11px] text-zinc-500">Count the doors and windows in this wall first, then pick their size here.</div>
          )}
          {api.countRows.map(c => (
            <div key={c.id} className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate text-[11px] text-zinc-200" title={c.name}>{c.quantity} nr {c.name}</span>
                <select
                  aria-label={`Opening size for ${c.name}`} value={picked[c.id] ?? ''}
                  onChange={e => setPicked(s => ({ ...s, [c.id]: e.target.value }))} className={`w-36 ${fieldCls}`}
                >
                  <option value="">Not in this wall</option>
                  {STANDARD_OPENINGS.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  <option value="custom">Other size…</option>
                </select>
              </div>
              {picked[c.id] === 'custom' && (
                <div className="flex items-center justify-end gap-1 text-[11px] text-zinc-400">
                  <input aria-label="Opening width in metres" placeholder="width" inputMode="decimal" value={custom[c.id]?.w ?? ''}
                    onChange={e => setCustom(s => ({ ...s, [c.id]: { w: e.target.value, h: s[c.id]?.h ?? '' } }))}
                    onKeyDown={e => e.stopPropagation()} className={`w-16 ${fieldCls}`} />
                  ×
                  <input aria-label="Opening height in metres" placeholder="height" inputMode="decimal" value={custom[c.id]?.h ?? ''}
                    onChange={e => setCustom(s => ({ ...s, [c.id]: { w: s[c.id]?.w ?? '', h: e.target.value } }))}
                    onKeyDown={e => e.stopPropagation()} className={`w-16 ${fieldCls}`} />
                  m
                </div>
              )}
            </div>
          ))}
          <label className="flex items-center gap-2 text-[11px] text-zinc-500 pt-1">
            <span className="flex-1">Ignore voids smaller than</span>
            <input aria-label="Minimum void in square metres" inputMode="decimal" value={minVoid} onChange={e => setMinVoid(e.target.value)}
              onKeyDown={e => e.stopPropagation()} className={`w-16 ${fieldCls}`} />
            <span>sq m</span>
          </label>
        </div>
      )}
      <div className="border border-zinc-700 divide-y divide-zinc-800">
        {rows.map(r => (
          <div key={r.id} className="flex items-baseline gap-2 px-2 py-1 text-[11px]">
            <span className="flex-1 min-w-0 truncate text-zinc-300">{r.description.split(' – ').pop()}</span>
            <span className="font-mono text-zinc-100 tabular-nums">{r.quantity.toFixed(2)}</span>
            <span className="w-8 text-zinc-500">{r.unit}</span>
          </div>
        ))}
      </div>
      <button
        disabled={!rows.length}
        onClick={() => { api.applyAssembly(a, opts); onDone(); }}
        className="w-full text-[10px] font-mono font-bold uppercase tracking-widest px-2.5 py-1.5 bg-amber-400 text-black hover:bg-amber-300 disabled:opacity-40"
      >Add {rows.length} rows</button>
      <div className="text-[11px] text-zinc-500">These rows follow the shape and the counts: change either and they update.</div>
    </div>
  );
}

function ConvertPanel({ api, onDone }: { api: ShapeActionsApi; onDone: () => void }) {
  const m = api.primary;
  const [mode, setMode] = useState<'row' | 'assembly'>('row');
  const [vals, setVals] = useState<Record<string, string>>({ volume: '0.15', wallArea: '2.7', stripArea: '0.6', waste: '10', slope: '25' });
  if (!m) return null;
  const area = isAreaRow(m);
  const rows: { kind: ConvertKind; title: string; unit?: string; out: string }[] = area
    ? [{ kind: 'perimeter', title: 'Perimeter', out: 'm — skirting, edge formwork' },
       { kind: 'volume', title: 'Volume = area × depth', unit: 'm deep', out: 'cu m — slab, screed, excavation' }]
    : [{ kind: 'wallArea', title: 'Area = length × height', unit: 'm high', out: 'sq m — wall, plaster, paint' },
       { kind: 'stripArea', title: 'Area = length × width', unit: 'm wide', out: 'sq m — footing, path, strip' }];
  rows.push(
    { kind: 'waste', title: 'Add waste', unit: '% extra', out: 'order quantity — cuts, breakage, laps' },
    { kind: 'slope', title: 'On a slope', unit: '% slope (rise ÷ run)', out: 'true size of a roof or ramp drawn in plan' },
  );
  return (
    <div className="w-80 p-3 space-y-2 max-h-[60vh] overflow-y-auto custom-scrollbar" onPointerDown={e => e.stopPropagation()}>
      <div role="tablist" className="flex border border-zinc-700">
        {([['row', 'One row'], ['assembly', 'Assembly']] as const).map(([k, label]) => (
          <button
            key={k} role="tab" aria-selected={mode === k} onClick={() => setMode(k)}
            className={`flex-1 text-[10px] font-mono font-bold uppercase tracking-widest py-1.5 ${mode === k ? 'bg-amber-400 text-black' : 'text-zinc-400 hover:bg-zinc-800'}`}
          >{label}</button>
        ))}
      </div>
      {mode === 'assembly' && <AssemblyPanel api={api} onDone={onDone} />}
      {mode === 'row' && <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-400">Add a row worked out from this shape</div>}
      {mode === 'row' && rows.map(r => {
        const v = parseFloat(vals[r.kind] ?? '');
        const ok = !r.unit || (Number.isFinite(v) && v > 0);
        return (
          <div key={r.kind} className="border border-zinc-700 p-2">
            <div className="text-xs text-zinc-100">{r.title}</div>
            <div className="text-[11px] text-zinc-500 mb-2">{r.out}</div>
            <div className="flex items-center gap-2">
              {r.unit && (
                <>
                  <input
                    aria-label={r.unit} inputMode="decimal" value={vals[r.kind] ?? ''}
                    onChange={e => setVals(s => ({ ...s, [r.kind]: e.target.value }))}
                    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && ok) { api.convert(r.kind, v); onDone(); } }}
                    className="w-20 bg-zinc-800 border border-zinc-600 px-2 py-1 text-xs font-mono text-zinc-100 focus:outline-none focus:border-amber-400"
                  />
                  <span className="text-[11px] text-zinc-400">{r.unit}</span>
                </>
              )}
              <button
                disabled={!ok}
                onClick={() => { api.convert(r.kind, v); onDone(); }}
                className="ml-auto text-[10px] font-mono font-bold uppercase tracking-widest px-2.5 py-1 bg-amber-400 text-black hover:bg-amber-300 disabled:opacity-40"
              >Add row</button>
            </div>
          </div>
        );
      })}
      {mode === 'row' && <div className="text-[11px] text-zinc-500">Volume and area rows follow the shape: edit the shape and they update.</div>}
    </div>
  );
}

function CopyPanel({ api, onDone }: { api: ShapeActionsApi; onDone: () => void }) {
  const [n, setN] = useState('3'), [dx, setDx] = useState('3'), [dy, setDy] = useState('0');
  const count = parseInt(n, 10), x = parseFloat(dx) || 0, y = parseFloat(dy) || 0;
  const ok = count >= 1 && (x !== 0 || y !== 0);
  const btn = 'text-[10px] font-mono font-bold uppercase tracking-widest px-2.5 py-1.5 border border-zinc-600 text-zinc-100 hover:bg-zinc-800';
  const inp = 'w-14 bg-zinc-800 border border-zinc-600 px-2 py-1 text-xs font-mono text-zinc-100 focus:outline-none focus:border-amber-400';
  return (
    <div className="w-80 p-3 space-y-3" onPointerDown={e => e.stopPropagation()}>
      <div className="flex gap-2">
        <button className={btn} onClick={() => { api.duplicate(); onDone(); }}>Duplicate</button>
        <button className={btn} title="Flipped copy to the right" onClick={() => { api.mirror('h'); onDone(); }}>Mirror ↔</button>
        <button className={btn} title="Flipped copy below" onClick={() => { api.mirror('v'); onDone(); }}>Mirror ↕</button>
      </div>
      <div className="border border-zinc-700 p-2 space-y-2">
        <div className="text-xs text-zinc-100">Repeat at a spacing</div>
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 flex-wrap" onKeyDown={e => e.stopPropagation()}>
          <input aria-label="Number of copies" className={inp} inputMode="numeric" value={n} onChange={e => setN(e.target.value)} /> more, every
          <input aria-label="Spacing across in metres" className={inp} inputMode="decimal" value={dx} onChange={e => setDx(e.target.value)} /> m across
          <input aria-label="Spacing down in metres" className={inp} inputMode="decimal" value={dy} onChange={e => setDy(e.target.value)} /> m down
        </div>
        <button disabled={!ok} onClick={() => { api.repeat(count, x, y); onDone(); }}
          className="text-[10px] font-mono font-bold uppercase tracking-widest px-2.5 py-1 bg-amber-400 text-black hover:bg-amber-300 disabled:opacity-40">Add copies</button>
      </div>
      <div className="text-[11px] text-zinc-500">Copies stay selected — drag them, or nudge with the arrow keys.</div>
    </div>
  );
}

function GroupPanel({ api, onDone }: { api: ShapeActionsApi; onDone: () => void }) {
  return (
    <div className="w-72 py-1 max-h-72 overflow-y-auto custom-scrollbar" onPointerDown={e => e.stopPropagation()}>
      <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-widest text-zinc-400">Move to</div>
      {api.groupTargets.length === 0 && <div className="px-3 py-1.5 text-xs text-zinc-500">No other group of the same kind yet.</div>}
      {api.groupTargets.map(g => (
        <button key={g.id} onClick={() => { api.moveToGroup(g.id); onDone(); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-100 hover:bg-zinc-800">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: g.color }} />
          <span className="truncate">{g.groupName || g.label || g.description}</span>
        </button>
      ))}
      {api.canMakeGroup && (
        <button onClick={() => { api.makeGroup(); onDone(); }}
          className="w-full px-3 py-1.5 text-left text-xs text-amber-300 hover:bg-zinc-800 border-t border-zinc-700 mt-1">Make it a new group</button>
      )}
      {api.inGroup && (
        <button onClick={() => { api.moveToGroup(null); onDone(); }}
          className="w-full px-3 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-800 border-t border-zinc-700 mt-1">Take it out of its group</button>
      )}
    </div>
  );
}

export function ShapeActions({ api, visible, menu, onCloseMenu, hasShapes }: {
  api: ShapeActionsApi; visible: boolean; menu: ShapeMenuState | null; onCloseMenu: () => void; hasShapes: boolean;
}) {
  const [convertOpen, setConvertOpen] = useState<'bar' | 'menu' | null>(null);
  const [panel, setPanel] = useState<'convert' | 'copy' | 'group'>('convert');
  const barItems  = useItems(api, null, () => { setPanel('convert'); setConvertOpen(c => (c === 'bar' && panel === 'convert' ? null : 'bar')); }, () => { setPanel('copy'); setConvertOpen(c => (c === 'bar' && panel === 'copy' ? null : 'bar')); }, () => { setPanel('group'); setConvertOpen(c => (c === 'bar' && panel === 'group' ? null : 'bar')); });
  const menuItems = useItems(api, menu, () => { setPanel('convert'); setConvertOpen('menu'); }, () => { setPanel('copy'); setConvertOpen('menu'); }, () => { setPanel('group'); setConvertOpen('menu'); });
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!api.primary) setConvertOpen(null); }, [api.primary]);
  useEffect(() => { if (!menu) setConvertOpen(c => (c === 'menu' ? null : c)); }, [menu]);
  useEffect(() => {
    if (!menu && !convertOpen) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof PointerEvent && (e.target as HTMLElement | null)?.closest?.('[data-shape-actions]')) return;
      onCloseMenu(); setConvertOpen(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', close, true); };
  }, [menu, convertOpen, onCloseMenu]);

  const n = api.selectedRows.length;
  const name = api.primary ? (api.primary.label || api.primary.description || 'Shape') : '';

  return (
    <>
      {/* Cut-out / split in progress */}
      {api.pending && (
        <div data-shape-actions className="absolute top-16 left-1/2 -translate-x-1/2 z-[75] flex items-center gap-3 bg-amber-400 text-black px-3 py-2 shadow-xl max-w-[90%]">
          {api.pending.kind === 'cutout' ? <Scissors className="w-4 h-4 shrink-0" /> : <Slice className="w-4 h-4 shrink-0" />}
          <span className="text-xs font-medium">
            {api.pending.kind === 'cutout'
              ? <>Draw the part to cut out of <b>{api.pending.label}</b> — click round it and back on the first point.</>
              : api.pending.kind === 'gap'
              ? <>Click the two ends of the part to remove from <b>{api.pending.label}</b>, then press Enter.</>
              : <>Draw a line across <b>{api.pending.label}</b> where it should split, then press Enter.</>}
          </span>
          <button onClick={api.cancelPending} className="text-[10px] font-mono font-bold uppercase tracking-widest border border-black/40 px-2 py-0.5 hover:bg-black/10">Cancel</button>
        </div>
      )}

      {api.message && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-[75] bg-zinc-900 border border-zinc-600 text-zinc-100 text-xs px-3 py-2 shadow-xl max-w-[80%]" role="status">
          {api.message}
        </div>
      )}

      {/* Areas that overlap are counted twice — offer to look at them */}
      {visible && !api.pending && api.overlaps.length > 0 && (
        <button
          data-shape-actions
          title="These areas share ground, so it is counted twice. Click to select the pair, then use Trim overlap or Merge."
          onClick={() => api.selectPair(api.overlaps[0].a.id, api.overlaps[0].b.id)}
          className="absolute top-16 left-3 z-[70] flex items-center gap-1.5 bg-zinc-900 border border-amber-500/70 text-amber-300 text-[11px] px-2.5 py-1.5 shadow-xl hover:bg-zinc-800"
        >
          <TriangleAlert className="w-3.5 h-3.5" />
          {api.overlaps.length} overlap{api.overlaps.length === 1 ? '' : 's'} · {api.overlaps[0].area} sq m counted twice
        </button>
      )}

      {/* Nothing selected yet: say where the tools are */}
      {visible && !api.primary && !api.pending && hasShapes && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 bg-zinc-900/95 border border-zinc-700 text-zinc-300 text-[11px] px-3 py-1.5 shadow-xl whitespace-nowrap pointer-events-none max-w-[96%] overflow-hidden">
          <span className="text-amber-400 font-mono uppercase tracking-widest text-[10px]">Edit tools</span>
          Click a shape for Cut out · Split · Convert · Copy
          <span className="text-zinc-600">|</span>
          Shift-click a second area for Merge · Subtract · Intersect
          <span className="text-zinc-600">|</span>
          Right-click for more
        </div>
      )}

      {/* Bar for the current selection */}
      {visible && api.primary && !api.pending && (
        <div data-shape-actions className="absolute bottom-3 left-1/2 -translate-x-1/2 z-[70] max-w-[96%]" onPointerDown={e => e.stopPropagation()}>
          {convertOpen === 'bar' && (
            <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-zinc-900 border border-zinc-600 shadow-2xl">
              {panel === 'convert' ? <ConvertPanel api={api} onDone={() => setConvertOpen(null)} /> : panel === 'copy' ? <CopyPanel api={api} onDone={() => setConvertOpen(null)} /> : <GroupPanel api={api} onDone={() => setConvertOpen(null)} />}
            </div>
          )}
          <div className="flex items-stretch bg-zinc-900 border border-zinc-600 shadow-2xl">
            <div className="px-3 py-1.5 border-r border-zinc-700 flex flex-col justify-center min-w-0">
              <span className="text-[10px] font-mono uppercase tracking-widest text-amber-400 truncate max-w-[11rem]">{n > 1 ? `${n} selected` : name}</span>
              <span className="text-[10px] text-zinc-500 whitespace-nowrap">{n > 1 ? 'first picked stays' : 'drag to move · Shift-click adds'}</span>
            </div>
            {barItems.map(it => (
              <button
                key={it.key} title={it.hint} onClick={it.run}
                className={`flex flex-col items-center justify-center gap-0.5 px-2.5 py-1.5 min-w-[3.6rem] text-[10px] font-mono uppercase tracking-wide whitespace-nowrap border-r border-zinc-800 last:border-r-0 hover:bg-zinc-800 ${it.danger ? 'text-red-400' : 'text-zinc-200'}`}
              >
                <it.icon className="w-4 h-4" />
                {it.label}
              </button>
            ))}
            <button title="Clear the selection (Esc)" onClick={() => api.clearSelection()} className="px-2 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Right-click menu */}
      {menu && api.primary && (
        <div
          ref={menuRef} data-shape-actions role="menu"
          className="fixed z-[90] bg-zinc-900 border border-zinc-600 shadow-2xl py-1 min-w-[15rem]"
          style={{ left: Math.min(menu.x, (typeof window !== 'undefined' ? window.innerWidth : 2000) - 300), top: Math.min(menu.y, (typeof window !== 'undefined' ? window.innerHeight : 2000) - 60 - menuItems.length * 40) }}
          onContextMenu={e => e.preventDefault()}
        >
          {convertOpen === 'menu'
            ? (panel === 'convert'
                ? <ConvertPanel api={api} onDone={() => { setConvertOpen(null); onCloseMenu(); }} />
                : panel === 'copy' ? <CopyPanel api={api} onDone={() => { setConvertOpen(null); onCloseMenu(); }} />
                : <GroupPanel api={api} onDone={() => { setConvertOpen(null); onCloseMenu(); }} />)
            : menuItems.map(it => (
              <button
                key={it.key} role="menuitem"
                onClick={() => { it.run(); if (it.key !== 'convert' && it.key !== 'copy' && it.key !== 'group') onCloseMenu(); }}
                className={`w-full flex items-start gap-2.5 px-3 py-1.5 text-left hover:bg-zinc-800 ${it.danger ? 'text-red-400' : 'text-zinc-100'}`}
              >
                <it.icon className="w-4 h-4 mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-xs">{it.label}</span>
                  <span className="block text-[11px] text-zinc-500 leading-snug">{it.hint}</span>
                </span>
              </button>
            ))}
        </div>
      )}
    </>
  );
}

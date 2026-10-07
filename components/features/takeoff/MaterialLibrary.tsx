'use client';

// ─── components/features/takeoff/MaterialLibrary.tsx ─────────────────────────
//
//  The project's material bank: browse by MasterFormat division, search, sort,
//  edit rates, add your own items, and pull items in from the built-in
//  catalogue (data/materials.ts). Changes save with the project automatically.
//  Rate edits can be pushed to the takeoff rows that use the material.
// ─────────────────────────────────────────────────────────────────────────────

import { DEFAULT_CURRENCY } from '@/lib/takeoff/currency';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X, Search, ArrowUpDown, Plus, Trash2, Check, Library, FolderOpen, Info,
  ClipboardList, Hammer, Box, BrickWall, Wrench, Layers, Droplet, DoorOpen, PaintRoller, Signpost,
  Refrigerator, Armchair, Waves, MoveVertical, Flame, ShowerHead, Fan, Zap, Network, ShieldCheck,
  Shovel, Trees, Cable, type LucideIcon,
} from 'lucide-react';
import * as motion from 'motion/react-m';
import type { Material } from '@/types';
import { cn, formatCurrency } from '@/lib/utils';
import { MATERIAL_CATEGORIES, DEFAULT_MATERIALS, categoryLabel } from '@/data/materials';
import { useTakeoffData } from '@/context/TakeoffContext';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Logo } from '@/components/brand/Logo';

interface MaterialLibraryProps {
  materials: Material[];
  onUpdateMaterials: (materials: Material[]) => void;
  onClose: () => void;
}

type View = 'project' | 'catalogue';
type SortKey = 'code' | 'name' | 'rate';

const ICONS: Record<string, LucideIcon> = {
  '01': ClipboardList, '02': Hammer, '03': Box, '04': BrickWall, '05': Wrench, '06': Layers,
  '07': Droplet, '08': DoorOpen, '09': PaintRoller, '10': Signpost, '11': Refrigerator,
  '12': Armchair, '13': Waves, '14': MoveVertical, '21': Flame, '22': ShowerHead, '23': Fan,
  '26': Zap, '27': Network, '28': ShieldCheck, '31': Shovel, '32': Trees, '33': Cable,
};
const UNITS = ['m', 'm²', 'm³', 'kg', 't', 'EA', 'set', 'sum', 'kW', 'L'];

const divisionOf = (m: Material) => m.division || (m.category || '').slice(0, 2);
const totalRate  = (m: Material) =>
  (m.materialCost ?? 0) + (m.laborCost ?? 0) + (m.equipmentCost ?? 0) || m.unitRate || 0;

/** Keep unitRate equal to the breakdown total so every consumer agrees. */
function withRate(m: Material): Material {
  const breakdown = (m.materialCost ?? 0) + (m.laborCost ?? 0) + (m.equipmentCost ?? 0);
  return { ...m, unitRate: breakdown > 0 ? breakdown : m.unitRate ?? 0 };
}

export function MaterialLibrary({ materials, onUpdateMaterials, onClose }: MaterialLibraryProps) {
  const { projectState, updateMeasurement } = useTakeoffData();
  const { confirm } = useConfirm();

  const [view,        setView]        = useState<View>('project');
  const [division,    setDivision]    = useState('06');
  const [query,       setQuery]       = useState('');
  const [sortBy,      setSortBy]      = useState<SortKey>('code');
  const [unratedOnly, setUnratedOnly] = useState(false);
  const [selectedId,  setSelectedId]  = useState<string | null>(null);

  // Keyboard stays inside the bank (so e.g. "P" doesn't switch drawing tools
  // behind it); Esc closes it. A confirm dialog on top handles its own Esc first.
  const rootRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => { rootRef.current?.focus(); }, []);
  const onRootKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  const projectIds = useMemo(() => new Set(materials.map(m => m.id)), [materials]);

  // Rows in the takeoff that use each material.
  const usage = useMemo(() => {
    const u = new Map<string, { id: string; unitRate: number }[]>();
    for (const r of projectState.measurements) {
      if (!r.materialId || r.isGroupHeader) continue;
      const list = u.get(r.materialId) ?? [];
      list.push({ id: r.id, unitRate: r.unitRate });
      u.set(r.materialId, list);
    }
    return u;
  }, [projectState.measurements]);

  const source = view === 'project' ? materials : DEFAULT_MATERIALS;

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const m of source) c.set(divisionOf(m), (c.get(divisionOf(m)) ?? 0) + 1);
    return c;
  }, [source]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = source.filter(m =>
      divisionOf(m) === division &&
      (!q || m.name.toLowerCase().includes(q) || (m.code || '').toLowerCase().includes(q)) &&
      (!unratedOnly || view === 'catalogue' || totalRate(m) === 0));
    const cmp: Record<SortKey, (a: Material, b: Material) => number> = {
      code: (a, b) => (a.code || '').localeCompare(b.code || '') || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      rate: (a, b) => totalRate(b) - totalRate(a),
    };
    return list.sort(cmp[sortBy]);
  }, [source, division, query, unratedOnly, sortBy, view]);

  const unratedCount = useMemo(() => materials.filter(m => totalRate(m) === 0).length, [materials]);

  const selected = view === 'project' ? materials.find(m => m.id === selectedId) ?? null : null;

  // Keep a sensible selection when the division / view changes.
  useEffect(() => {
    if (view !== 'project') return;
    if (!selectedId || !rows.some(r => r.id === selectedId)) setSelectedId(rows[0]?.id ?? null);
  }, [rows, selectedId, view]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const update = useCallback((id: string, patch: Partial<Material>) => {
    onUpdateMaterials(materials.map(m => (m.id === id ? withRate({ ...m, ...patch }) : m)));
  }, [materials, onUpdateMaterials]);

  const addNew = () => {
    const cat = MATERIAL_CATEGORIES.find(c => c.code === division) ?? MATERIAL_CATEGORIES[0];
    const m: Material = {
      id: crypto.randomUUID(), code: `${cat.code} 00 00`, name: 'New material',
      category: categoryLabel(cat), division: cat.code, unit: 'EA',
      unitRate: 0, materialCost: 0, laborCost: 0, equipmentCost: 0,
    };
    onUpdateMaterials([m, ...materials]);
    setView('project');
    setQuery('');
    setUnratedOnly(false);
    setSelectedId(m.id);
  };

  const addFromCatalogue = (items: Material[]) => {
    const missing = items.filter(m => !projectIds.has(m.id)).map(m => ({ ...m }));
    if (missing.length) onUpdateMaterials([...materials, ...missing]);
  };

  const remove = async (m: Material) => {
    const used = usage.get(m.id)?.length ?? 0;
    const ok = await confirm({
      title: 'Delete material',
      message: <>Delete <span className="text-zinc-100 font-bold">{m.name}</span> from this project’s material bank?</>,
      detail: used
        ? `${used} takeoff row${used === 1 ? ' uses' : 's use'} it. ${used === 1 ? 'It keeps' : 'They keep'} the current rate but will no longer be linked.`
        : m.builtIn ? 'You can add it back from the catalogue later.' : 'This can’t be undone.',
      confirmText: 'Delete',
    });
    if (!ok) return;
    onUpdateMaterials(materials.filter(x => x.id !== m.id));
    if (used) for (const r of usage.get(m.id)!) updateMeasurement(r.id, { materialId: undefined });
  };

  const applyRateToRows = (m: Material) => {
    const rate = totalRate(m);
    for (const r of usage.get(m.id) ?? []) if (r.unitRate !== rate) updateMeasurement(r.id, { unitRate: rate });
  };

  const catalogueMissingInDivision = view === 'catalogue' ? rows.filter(m => !projectIds.has(m.id)).length : 0;
  const catalogueMissingAll = useMemo(() => DEFAULT_MATERIALS.filter(m => !projectIds.has(m.id)).length, [projectIds]);
  const cat = MATERIAL_CATEGORIES.find(c => c.code === division);
  const staleRows = selected ? (usage.get(selected.id) ?? []).filter(r => r.unitRate !== totalRate(selected)).length : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 16 }}
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onRootKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Material bank"
      className="fixed inset-0 z-[100] bg-industrial-black text-zinc-200 font-mono flex flex-col outline-none"
    >
      {/* ── Top bar ── */}
      <header className="h-14 shrink-0 border-b border-industrial-border bg-industrial-panel flex items-center justify-between gap-4 px-6">
        <div className="flex items-center gap-5 min-w-0">
          <Logo size={18} />
          <span className="w-px h-6 bg-industrial-border" aria-hidden />
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-500">Material bank</p>
            <p className="text-sm font-bold text-zinc-100 truncate" title={projectState.projectName}>{projectState.projectName}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden md:block text-[11px] text-zinc-600 uppercase tracking-widest">Changes save automatically</span>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="flex items-center gap-2 border border-industrial-border px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-zinc-300 hover:text-amber-accent hover:border-amber-accent/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
          >
            <X className="w-3.5 h-3.5" /> Close
            <kbd className="border border-zinc-700 px-1 text-[10px] text-zinc-500">Esc</kbd>
          </button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* ── Divisions ── */}
        <aside className="w-64 shrink-0 border-r border-industrial-border bg-industrial-panel flex flex-col">
          <div className="px-4 py-3 border-b border-industrial-border text-[11px] text-zinc-500 uppercase tracking-widest">
            {view === 'project' ? `${materials.length} in this project` : `${DEFAULT_MATERIALS.length} in catalogue`}
          </div>
          <nav aria-label="Divisions" className="flex-1 overflow-y-auto custom-scrollbar py-2 text-xs font-bold uppercase tracking-tight">
            {MATERIAL_CATEGORIES.map(c => {
              const Icon = ICONS[c.code] ?? Info;
              const active = c.code === division;
              return (
                <button
                  key={c.code}
                  type="button"
                  onClick={() => setDivision(c.code)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-2.5 text-left border-l-2 transition-colors',
                    active ? 'bg-zinc-800/50 text-amber-accent border-amber-accent' : 'text-zinc-500 border-transparent hover:bg-zinc-800/40 hover:text-zinc-200',
                  )}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1 min-w-0 truncate">{c.code} {c.name}</span>
                  <span className="text-[10px] text-zinc-600 tabular-nums">{counts.get(c.code) ?? 0}</span>
                </button>
              );
            })}
          </nav>
          {view === 'project' && catalogueMissingAll > 0 && (
            <div className="p-4 border-t border-industrial-border">
              <button
                type="button"
                onClick={() => addFromCatalogue(DEFAULT_MATERIALS)}
                className="w-full border border-industrial-border py-2 text-[11px] font-bold uppercase tracking-widest text-zinc-400 hover:text-amber-accent hover:border-amber-accent/60"
              >
                Add {catalogueMissingAll} missing catalogue items
              </button>
            </div>
          )}
        </aside>

        {/* ── Main ── */}
        <main className="flex-1 min-w-0 flex flex-col gap-5 p-6 lg:p-8">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-industrial-border pb-4">
            <div>
              <h1 className="text-2xl font-bold text-amber-accent uppercase tracking-widest">
                Division {cat ? categoryLabel(cat) : division}
              </h1>
              <p className="text-[11px] text-zinc-500 font-bold uppercase tracking-widest mt-1">
                {view === 'project' ? 'Rates used in this project' : 'Built-in catalogue — add items to use them'}
              </p>
            </div>
            <div className="flex bg-industrial-panel p-1 border border-industrial-border text-[11px] font-bold uppercase tracking-widest" role="tablist">
              {([['project', 'This project', FolderOpen], ['catalogue', 'Catalogue', Library]] as const).map(([v, label, Icon]) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={cn('flex items-center gap-2 px-4 py-2 transition-colors', view === v ? 'bg-amber-accent text-black' : 'text-zinc-500 hover:text-zinc-200')}
                >
                  <Icon className="w-3.5 h-3.5" /> {label}
                </button>
              ))}
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[240px] max-w-xl">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" aria-hidden />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by code or name…"
                aria-label="Search materials"
                className="w-full bg-industrial-panel border border-industrial-border py-2.5 pl-10 pr-4 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-amber-accent"
              />
            </div>
            <button
              type="button"
              onClick={() => setSortBy(s => (s === 'code' ? 'name' : s === 'name' ? 'rate' : 'code'))}
              className="flex items-center gap-2 px-4 py-2.5 border border-industrial-border text-[11px] font-bold uppercase tracking-widest text-zinc-400 hover:text-zinc-100"
              title="Change sort order"
            >
              <ArrowUpDown className="w-3.5 h-3.5" /> Sort: {sortBy === 'code' ? 'Code' : sortBy === 'name' ? 'Name' : 'Rate'}
            </button>
            {view === 'project' && (
              <button
                type="button"
                onClick={() => setUnratedOnly(v => !v)}
                aria-pressed={unratedOnly}
                className={cn('px-4 py-2.5 border text-[11px] font-bold uppercase tracking-widest',
                  unratedOnly ? 'border-amber-accent/60 text-amber-accent bg-amber-accent/10' : 'border-industrial-border text-zinc-400 hover:text-zinc-100')}
              >
                Rate not set ({unratedCount})
              </button>
            )}
            <div className="flex-1" />
            {view === 'project' ? (
              <button
                type="button"
                onClick={addNew}
                className="flex items-center gap-2 bg-amber-accent hover:bg-amber-400 text-black px-4 py-2.5 text-[11px] font-bold uppercase tracking-widest"
              >
                <Plus className="w-3.5 h-3.5" /> New material
              </button>
            ) : catalogueMissingInDivision > 0 && (
              <button
                type="button"
                onClick={() => addFromCatalogue(rows)}
                className="flex items-center gap-2 bg-amber-accent hover:bg-amber-400 text-black px-4 py-2.5 text-[11px] font-bold uppercase tracking-widest"
              >
                <Plus className="w-3.5 h-3.5" /> Add {catalogueMissingInDivision} to project
              </button>
            )}
          </div>

          <div className="flex flex-1 min-h-0 gap-6">
            {/* Table */}
            <div className="flex-1 min-w-0 bg-industrial-panel border border-industrial-border flex flex-col">
              <div className="flex-1 overflow-auto custom-scrollbar">
                <table className="w-full text-left border-collapse whitespace-nowrap">
                  <thead className="sticky top-0 bg-industrial-panel z-10 text-[11px] uppercase tracking-widest text-zinc-500 font-bold">
                    <tr className="border-b border-industrial-border">
                      <th className="p-3 pl-4">Code</th>
                      <th className="p-3">Description</th>
                      <th className="p-3">Unit</th>
                      {view === 'project' ? (
                        <>
                          <th className="p-3 text-right">Material</th>
                          <th className="p-3 text-right">Labour</th>
                          <th className="p-3 text-right">Equip.</th>
                          <th className="p-3 pr-4 text-right text-amber-accent">Total rate</th>
                        </>
                      ) : (
                        <th className="p-3 pr-4 text-right">In project</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="text-xs">
                    {rows.map(m => {
                      const rate = totalRate(m);
                      const inProject = projectIds.has(m.id);
                      const used = usage.get(m.id)?.length ?? 0;
                      return (
                        <tr
                          key={m.id}
                          onClick={() => view === 'project' && setSelectedId(m.id)}
                          className={cn(
                            'border-b border-industrial-border/40 border-l-2 transition-colors',
                            view === 'project' && 'cursor-pointer',
                            selected?.id === m.id ? 'bg-industrial-black border-l-amber-accent' : 'border-l-transparent hover:bg-zinc-800/30',
                          )}
                        >
                          <td className="p-3 pl-4 text-zinc-500 font-bold">{m.code}</td>
                          <td className="p-3 text-zinc-200 max-w-[360px] truncate" title={m.name}>
                            {m.name}
                            {used > 0 && view === 'project' && (
                              <span className="ml-2 text-[10px] text-zinc-500 border border-industrial-border px-1">{used} row{used === 1 ? '' : 's'}</span>
                            )}
                          </td>
                          <td className="p-3 text-zinc-500">{m.unit}</td>
                          {view === 'project' ? (
                            <>
                              <td className="p-3 text-right text-zinc-400">{m.materialCost ? formatCurrency(m.materialCost) : '—'}</td>
                              <td className="p-3 text-right text-zinc-400">{m.laborCost ? formatCurrency(m.laborCost) : '—'}</td>
                              <td className="p-3 text-right text-zinc-400">{m.equipmentCost ? formatCurrency(m.equipmentCost) : '—'}</td>
                              <td className={cn('p-3 pr-4 text-right font-bold', rate ? 'text-amber-accent' : 'text-zinc-600 font-normal italic')}>
                                {rate ? formatCurrency(rate) : 'rate not set'}
                              </td>
                            </>
                          ) : (
                            <td className="p-3 pr-4 text-right">
                              {inProject ? (
                                <span className="inline-flex items-center gap-1 text-emerald-400 text-[11px] font-bold uppercase tracking-widest">
                                  <Check className="w-3.5 h-3.5" /> Added
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => addFromCatalogue([m])}
                                  className="inline-flex items-center gap-1 border border-industrial-border px-2 py-1 text-[11px] font-bold uppercase tracking-widest text-zinc-400 hover:text-amber-accent hover:border-amber-accent/60"
                                >
                                  <Plus className="w-3 h-3" /> Add
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={7} className="p-12 text-center">
                          <p className="text-xs text-zinc-500 uppercase tracking-widest">
                            {query ? 'Nothing matches your search.'
                              : unratedOnly ? 'Every material in this division has a rate.'
                              : view === 'project' ? 'No materials in this division yet.' : 'The catalogue has nothing in this division.'}
                          </p>
                          {view === 'project' && !query && !unratedOnly && (
                            <div className="mt-4 flex justify-center gap-2">
                              <button type="button" onClick={() => setView('catalogue')}
                                className="border border-industrial-border px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-zinc-300 hover:text-amber-accent">
                                Browse catalogue
                              </button>
                              <button type="button" onClick={addNew}
                                className="bg-amber-accent hover:bg-amber-400 text-black px-3 py-2 text-[11px] font-bold uppercase tracking-widest">
                                New material
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2.5 border-t border-industrial-border text-[10px] text-zinc-600 uppercase tracking-widest flex justify-between">
                <span>{rows.length} item{rows.length === 1 ? '' : 's'} shown</span>
                <span>Rates in {projectState.currency || DEFAULT_CURRENCY}</span>
              </div>
            </div>

            {/* Detail / editor */}
            {view === 'project' && selected && (
              <aside className="w-80 shrink-0 bg-industrial-panel border border-industrial-border flex flex-col overflow-y-auto custom-scrollbar">
                <div className="flex items-center justify-between px-4 py-3 border-b border-industrial-border">
                  <span className="text-amber-accent font-bold uppercase tracking-widest text-xs">Edit material</span>
                  <button type="button" onClick={() => void remove(selected)} title="Delete material" aria-label="Delete material"
                    className="p-1 text-zinc-600 hover:text-red-400">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <div className="p-4 space-y-4 text-xs">
                  <Field label="Description">
                    <textarea
                      value={selected.name}
                      onChange={e => update(selected.id, { name: e.target.value })}
                      rows={2}
                      className="w-full bg-industrial-black border border-industrial-border p-2 text-zinc-100 outline-none focus:border-amber-accent resize-none"
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Code">
                      <input value={selected.code} onChange={e => update(selected.id, { code: e.target.value })}
                        className="w-full bg-industrial-black border border-industrial-border p-2 text-zinc-100 outline-none focus:border-amber-accent" />
                    </Field>
                    <Field label="Unit">
                      <input list="material-units" value={selected.unit} onChange={e => update(selected.id, { unit: e.target.value })}
                        className="w-full bg-industrial-black border border-industrial-border p-2 text-zinc-100 outline-none focus:border-amber-accent" />
                    </Field>
                  </div>
                  <datalist id="material-units">{UNITS.map(u => <option key={u} value={u} />)}</datalist>

                  <div className="border-t border-industrial-border pt-4 space-y-2">
                    <h3 className="text-[11px] text-amber-accent font-bold uppercase tracking-widest">Rate per {selected.unit || 'unit'}</h3>
                    {([['materialCost', 'Material'], ['laborCost', 'Labour'], ['equipmentCost', 'Equipment']] as const).map(([k, label]) => (
                      <label key={k} className="flex items-center justify-between gap-3 bg-industrial-black border border-industrial-border px-3 py-2">
                        <span className="text-[11px] uppercase tracking-widest text-zinc-500">{label}</span>
                        <span className="flex items-center gap-1.5">
                          <span className="text-[11px] text-zinc-600">{projectState.currency || DEFAULT_CURRENCY}</span>
                          <input
                            type="number" min={0} step="0.01" inputMode="decimal"
                            value={selected[k] || ''}
                            placeholder="0"
                            onChange={e => update(selected.id, { [k]: Math.max(0, parseFloat(e.target.value) || 0) } as Partial<Material>)}
                            className="w-24 bg-transparent text-right text-zinc-100 outline-none"
                          />
                        </span>
                      </label>
                    ))}
                    <div className="flex items-center justify-between border-l-2 border-amber-accent bg-industrial-black px-3 py-2">
                      <span className="text-[11px] uppercase tracking-widest text-amber-accent font-bold">Total rate</span>
                      <span className="text-sm font-bold text-amber-accent">{formatCurrency(totalRate(selected))}</span>
                    </div>
                  </div>

                  {(usage.get(selected.id)?.length ?? 0) > 0 && (
                    <div className="border-t border-industrial-border pt-4 space-y-2">
                      <p className="text-zinc-400">
                        Used by {usage.get(selected.id)!.length} takeoff row{usage.get(selected.id)!.length === 1 ? '' : 's'}.
                      </p>
                      {staleRows > 0 && (
                        <button
                          type="button"
                          onClick={() => applyRateToRows(selected)}
                          className="w-full border border-amber-accent/60 text-amber-accent hover:bg-amber-accent/10 py-2 text-[11px] font-bold uppercase tracking-widest"
                        >
                          Apply this rate to {staleRows} row{staleRows === 1 ? '' : 's'}
                        </button>
                      )}
                    </div>
                  )}

                  <div className="border-t border-industrial-border pt-4 grid grid-cols-2 gap-3">
                    <Field label="Supplier">
                      <input value={selected.supplier ?? ''} onChange={e => update(selected.id, { supplier: e.target.value || undefined })}
                        className="w-full bg-industrial-black border border-industrial-border p-2 text-zinc-100 outline-none focus:border-amber-accent" />
                    </Field>
                    <Field label="Supplier code / SKU">
                      <input value={selected.sku ?? ''} onChange={e => update(selected.id, { sku: e.target.value || undefined })}
                        className="w-full bg-industrial-black border border-industrial-border p-2 text-zinc-100 outline-none focus:border-amber-accent" />
                    </Field>
                  </div>
                  {selected.builtIn && (
                    <p className="text-[11px] text-zinc-600">From the built-in catalogue. Your edits apply to this project only.</p>
                  )}
                </div>
              </aside>
            )}
          </div>
        </main>
      </div>
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-zinc-500 uppercase tracking-widest font-bold mb-1">{label}</span>
      {children}
    </label>
  );
}

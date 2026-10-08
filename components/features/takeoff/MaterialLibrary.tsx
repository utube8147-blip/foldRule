'use client';
import { unitRateOf, materialPart, orderFor } from '@/lib/takeoff/materialRate';

// ─── components/features/takeoff/MaterialLibrary.tsx ─────────────────────────
//
//  Two price lists side by side:
//    • Master bank — your own default prices, kept on this computer and shared by
//      every project in the same currency (the built-in catalogue plus your items).
//    • This project — the materials the takeoff actually uses, with this job's prices.
//  An empty price is filled from the other side; two different prices are never
//  overwritten for you, only flagged, and you choose which to keep.
//  Rate edits can be pushed to the takeoff rows that use the material.
// ─────────────────────────────────────────────────────────────────────────────

import { DEFAULT_CURRENCY } from '@/lib/takeoff/currency';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X, Search, ArrowUpDown, Plus, Upload, Send, Trash2, Library, FolderOpen, Info, TriangleAlert, ArrowRight, ArrowLeft,
  ClipboardList, Hammer, Box, BrickWall, Wrench, Layers, Droplet, DoorOpen, PaintRoller, Signpost,
  Refrigerator, Armchair, Waves, MoveVertical, Flame, ShowerHead, Fan, Zap, Network, ShieldCheck,
  Shovel, Trees, Cable, type LucideIcon,
} from 'lucide-react';
import * as motion from 'motion/react-m';
import type { Material } from '@/types';
import { cn, formatCurrency } from '@/lib/utils';
import { MATERIAL_CATEGORIES, DEFAULT_MATERIALS, categoryLabel } from '@/data/materials';
import { useTakeoffData } from '@/context/TakeoffContext';
import {
  loadMasterBank, saveMasterBank, reconcile, masterMaterials, priceState, pricesOf, setMaster, removeFromMaster, type MasterBank, type PriceState,
} from '@/lib/takeoff/masterBank';
import { matchRates, type RateLine, type RateMatching } from '@/lib/takeoff/rateSheet';
import { billedQuantities } from '@/lib/takeoff/timesing';
import { useFolderStatus } from '@/components/pwa/hooks';
import { syncMasterBank } from '@/lib/storage/folderSync';
import { MASTER_BANK_PULLED } from '@/lib/takeoff/masterBank';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Logo } from '@/components/brand/Logo';

interface MaterialLibraryProps {
  materials: Material[];
  onUpdateMaterials: (materials: Material[]) => void;
  onClose: () => void;
  /** Open on this project's materials that still have no rate. */
  initialUnrated?: boolean;
}

type View = 'master' | 'project';
const PRICE_FIELDS = ['materialCost', 'laborCost', 'equipmentCost', 'unitRate'];
type SortKey = 'code' | 'name' | 'rate';

const ICONS: Record<string, LucideIcon> = {
  '01': ClipboardList, '02': Hammer, '03': Box, '04': BrickWall, '05': Wrench, '06': Layers,
  '07': Droplet, '08': DoorOpen, '09': PaintRoller, '10': Signpost, '11': Refrigerator,
  '12': Armchair, '13': Waves, '14': MoveVertical, '21': Flame, '22': ShowerHead, '23': Fan,
  '26': Zap, '27': Network, '28': ShieldCheck, '31': Shovel, '32': Trees, '33': Cable,
};
const UNITS = ['m', 'm²', 'm³', 'kg', 't', 'EA', 'set', 'sum', 'kW', 'L'];

const divisionOf = (m: Material) => m.division || (m.category || '').slice(0, 2);
const totalRate  = (m: Material) => unitRateOf(m);

/** A price typed straight into the table. Saved on Enter, Tab or clicking away; Esc puts it back. */
function RateCell({ value, label, onCommit, onFocus }: { value: number; label: string; onCommit: (n: number) => void; onFocus: () => void }) {
  return (
    <input
      key={value}
      defaultValue={value ? String(value) : ''}
      placeholder="—"
      inputMode="decimal"
      aria-label={label}
      onFocus={e => { onFocus(); e.currentTarget.select(); }}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.value = value ? String(value) : ''; e.currentTarget.blur(); }
      }}
      onBlur={e => {
        const n = parseFloat(e.currentTarget.value.replace(/,/g, ''));
        const next = Number.isFinite(n) && n > 0 ? n : 0;
        if (next !== (value || 0)) onCommit(next);
      }}
      className="w-[72px] bg-transparent border border-transparent hover:border-industrial-border focus:border-amber-accent focus:bg-industrial-black px-2 py-1 text-right text-zinc-200 placeholder:text-zinc-600 tabular-nums focus:outline-none"
    />
  );
}

/** Keep unitRate equal to the breakdown total so every consumer agrees. */
function withRate(m: Material): Material {
  return { ...m, unitRate: unitRateOf(m) };
}

export function MaterialLibrary({ materials, onUpdateMaterials, onClose, initialUnrated }: MaterialLibraryProps) {
  const { projectState, updateMeasurement } = useTakeoffData();
  const { confirm } = useConfirm();

  const currency = projectState.currency || DEFAULT_CURRENCY;
  const usedSomething = projectState.measurements.some(r => !r.isGroupHeader && r.materialId);
  const [view,        setView]        = useState<View>(usedSomething || initialUnrated ? 'project' : 'master');
  const [division,    setDivision]    = useState('06');
  const [query,       setQuery]       = useState('');
  const [sortBy,      setSortBy]      = useState<SortKey>('code');
  const [unratedOnly, setUnratedOnly] = useState(!!initialUnrated);
  const [differsOnly, setDiffersOnly] = useState(false);
  const [selectedId,  setSelectedId]  = useState<string | null>(null);
  // Rows being priced stay on screen while “Rate not set” is on.
  const kept = React.useRef(new Set<string>());
  const [notice,      setNotice]      = useState<string | null>(null);
  // Prices typed in are held here and go nowhere (project, master bank, takeoff) until “Update prices”.
  const [draft, setDraft] = useState<Record<string, Partial<Material>>>({});
  const draftCount = Object.keys(draft).length;
  const eff = useCallback((m: Material): Material => (draft[m.id] ? withRate({ ...m, unitRate: 0, ...draft[m.id] }) : m), [draft]);
  const stage = useCallback((m: Material, patch: Partial<Material>) => {
    setDraft(d => {
      const next = { ...(d[m.id] ?? {}), ...patch };
      // Typed back to what is saved: no longer a change.
      const changed = (Object.keys(next) as (keyof Material)[]).some(k => JSON.stringify(next[k] ?? 0) !== JSON.stringify(m[k] ?? 0));
      const out = { ...d };
      if (changed) out[m.id] = next; else delete out[m.id];
      return out;
    });
  }, []);

  // ── Master bank (this computer, per currency) ──────────────────────────
  const [bank, setBank] = useState<MasterBank>(() => loadMasterBank(currency));
  const saveBank = useCallback((next: MasterBank) => {
    setBank(next);
    if (!saveMasterBank(next, currency)) setNotice('The master bank could not be saved on this computer (browser storage is full or blocked).');
  }, [currency]);

  // The bank is also kept as master-bank.json in the project folder (when one is connected),
  // so it survives a cleared browser and follows the folder to another computer.
  const folder = useFolderStatus();
  const inFolder = !!folder.folderName && folder.permission === 'granted';
  useEffect(() => {
    const reload = () => setBank(loadMasterBank(currency));
    window.addEventListener(MASTER_BANK_PULLED, reload);
    if (inFolder) void syncMasterBank();
    return () => window.removeEventListener(MASTER_BANK_PULLED, reload);
  }, [currency, inFolder]);

  // On opening: empty prices are filled from the other side, and your own materials are shared both ways.
  const reconciled = React.useRef(false);
  useEffect(() => {
    if (reconciled.current) return;
    reconciled.current = true;
    const r = reconcile(materials, loadMasterBank(currency), DEFAULT_MATERIALS);
    if (r.project !== materials) onUpdateMaterials(r.project);
    saveBank(r.bank);
    const parts = [
      r.filledProject.length ? `${r.filledProject.length} price${r.filledProject.length === 1 ? '' : 's'} taken from the master bank` : '',
      r.filledMaster.length ? `${r.filledMaster.length} price${r.filledMaster.length === 1 ? '' : 's'} saved to the master bank` : '',
      r.differs.length ? `${r.differs.length} differ and need your decision` : '',
    ].filter(Boolean);
    if (parts.length) setNotice(`${parts.join(' · ')}.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard stays inside the bank (so e.g. "P" doesn't switch drawing tools
  // behind it); Esc closes it. A confirm dialog on top handles its own Esc first.
  const rootRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => { rootRef.current?.focus(); }, []);
  const onRootKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); void tryCloseRef.current(); }
  };

  const projectIds = useMemo(() => new Set(materials.map(m => m.id)), [materials]);
  const master = useMemo(() => masterMaterials(bank, DEFAULT_MATERIALS), [bank]);
  const masterById = useMemo(() => new Map(master.map(m => [m.id, m])), [master]);
  const projectById = useMemo(() => new Map(materials.map(m => [m.id, m])), [materials]);
  /** How this material's two prices compare. */
  const stateOf = useCallback((id: string): PriceState => priceState(projectById.get(id), masterById.get(id)), [projectById, masterById]);

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

  // "This project" is only what the takeoff uses; the master is everything.
  const used = useMemo(() => materials.filter(m => usage.has(m.id)), [materials, usage]);
  const source = view === 'project' ? used : master;

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
      (!unratedOnly || totalRate(m) === 0 || kept.current.has(m.id)) &&
      (!differsOnly || stateOf(m.id) === 'differs'));
    const cmp: Record<SortKey, (a: Material, b: Material) => number> = {
      code: (a, b) => (a.code || '').localeCompare(b.code || '') || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      rate: (a, b) => totalRate(b) - totalRate(a),
    };
    return list.sort(cmp[sortBy]);
  }, [source, division, query, unratedOnly, differsOnly, sortBy, stateOf]);

  const unratedCount = useMemo(() => source.filter(m => totalRate(m) === 0).length, [source]);
  const differsCount = useMemo(() => source.filter(m => stateOf(m.id) === 'differs').length, [source, stateOf]);
  const differsByDivision = useMemo(() => {
    const c = new Map<string, number>();
    for (const m of source) if (stateOf(m.id) === 'differs') c.set(divisionOf(m), (c.get(divisionOf(m)) ?? 0) + 1);
    return c;
  }, [source, stateOf]);

  const saved = source.find(m => m.id === selectedId) ?? null;      // as stored
  const selected = saved ? eff(saved) : null;                        // with unsaved prices on top
  const other = selected ? (view === 'project' ? masterById.get(selected.id) : projectById.get(selected.id)) : undefined;

  // While a material is being edited, the other side follows only if it had no price when the
  // edit began. Once both have a price they are independent, and a difference is yours to settle.
  const follow = React.useRef<{ key: string; fill: boolean }>({ key: '', fill: false });
  const followKey = `${view}:${selectedId ?? ''}`;
  if (follow.current.key !== followKey) {
    const st = selectedId ? stateOf(selectedId) : 'same';
    follow.current = { key: followKey, fill: view === 'project' ? st === 'master-empty' || st === 'both-empty' : st === 'project-empty' || st === 'both-empty' };
  }

  // Sections with nothing in them are hidden unless asked for, and the open
  // section jumps to one that has something.
  const [showEmpty, setShowEmpty] = useState(false);
  const emptySections = MATERIAL_CATEGORIES.filter(c => !(counts.get(c.code) ?? 0)).length;
  const shownSections = showEmpty ? MATERIAL_CATEGORIES : MATERIAL_CATEGORIES.filter(c => (counts.get(c.code) ?? 0) > 0 || c.code === division);
  useEffect(() => {
    if (showEmpty || (counts.get(division) ?? 0) > 0) return;
    const first = MATERIAL_CATEGORIES.find(c => (counts.get(c.code) ?? 0) > 0);
    if (first) setDivision(first.code);
  }, [counts, division, showEmpty, view]);

  // Keep a sensible selection when the division / view changes.
  useEffect(() => {
    if (!selectedId || !rows.some(r => r.id === selectedId)) setSelectedId(rows[0]?.id ?? null);
  }, [rows, selectedId, view]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const update = useCallback((id: string, patch: Partial<Material>) => {
    const pricing = Object.keys(patch).some(k => PRICE_FIELDS.includes(k));
    const mirror = pricing ? follow.current.fill : true;       // names, codes and units are one description
    if (view === 'project') {
      const cur = projectById.get(id);
      if (!cur) return;
      const next = withRate({ ...cur, ...patch });
      onUpdateMaterials(materials.map(m => (m.id === id ? next : m)));
      // Takeoff rows that were on the old price (or had none) follow the new one; hand-set rates are left alone.
      if (pricing) {
        const was = totalRate(cur), now = totalRate(next);
        for (const r of usage.get(id) ?? []) if (r.unitRate !== now && (!r.unitRate || Math.abs(r.unitRate - was) < 0.005)) updateMeasurement(r.id, { unitRate: now });
      }
      const m = masterById.get(id);
      if (mirror && (pricing || !next.builtIn)) saveBank(setMaster(bank, pricing ? { ...(m ?? next), ...pricesOf(next) } : { ...(m ?? next), ...patch }));
    } else {
      const cur = masterById.get(id);
      if (!cur) return;
      const next = withRate({ ...cur, ...patch });
      saveBank(setMaster(bank, next));
      const p = projectById.get(id);
      if (p && mirror && (pricing || !next.builtIn)) {
        onUpdateMaterials(materials.map(m => (m.id === id ? withRate(pricing ? { ...m, ...pricesOf(next) } : { ...m, ...patch }) : m)));
      }
    }
  }, [view, materials, onUpdateMaterials, projectById, masterById, bank, saveBank, usage, updateMeasurement]);

  /** Push every held price: to this side, to the other side where it is empty, and to the takeoff rows. */
  const applyDraft = () => {
    let nextBank = bank;
    const projectPatch = new Map<string, Material>();
    const rowWas = new Map<string, number>();
    for (const [id, patch] of Object.entries(draft)) {
      const p = projectById.get(id), m = masterById.get(id);
      if (view === 'project') {
        if (!p) continue;
        const next = withRate({ ...p, unitRate: 0, ...patch });
        projectPatch.set(id, next);
        rowWas.set(id, totalRate(p));
        if (!m || totalRate(m) === 0) nextBank = setMaster(nextBank, { ...(m ?? next), ...pricesOf(next) });
      } else {
        if (!m) continue;
        const next = withRate({ ...m, unitRate: 0, ...patch });
        nextBank = setMaster(nextBank, next);
        if (p && totalRate(p) === 0) { projectPatch.set(id, withRate({ ...p, ...pricesOf(next) })); rowWas.set(id, 0); }
      }
    }
    if (projectPatch.size) onUpdateMaterials(materials.map(x => projectPatch.get(x.id) ?? x));
    if (nextBank !== bank) saveBank(nextBank);
    // Takeoff rows on the old price (or none) follow; rates set by hand on a row are left alone.
    let rowsUpdated = 0;
    for (const [id, next] of projectPatch) {
      const now = totalRate(next), was = rowWas.get(id) ?? 0;
      for (const r of usage.get(id) ?? []) if (r.unitRate !== now && (!r.unitRate || Math.abs(r.unitRate - was) < 0.005)) { updateMeasurement(r.id, { unitRate: now }); rowsUpdated++; }
    }
    const n = Object.keys(draft).length;
    setDraft({});
    setNotice(`${n} price${n === 1 ? '' : 's'} updated${rowsUpdated ? ` · ${rowsUpdated} takeoff row${rowsUpdated === 1 ? '' : 's'} re-priced` : ''}.`);
  };

  const tryClose = async () => {
    if (draftCount > 0) {
      const ok = await confirm({
        title: 'Prices not updated',
        message: <>You changed {draftCount} price{draftCount === 1 ? '' : 's'} without pressing <span className="text-zinc-100 font-bold">Update prices</span>.</>,
        detail: 'Closing now throws those changes away.',
        confirmText: 'Discard and close',
      });
      if (!ok) return;
    }
    onClose();
  };
  const tryCloseRef = React.useRef(tryClose);
  tryCloseRef.current = tryClose;

  /** Settle a difference: the project takes the master's price… */
  const takeMasterPrice = (id: string) => {
    const m = masterById.get(id);
    if (m) onUpdateMaterials(materials.map(x => (x.id === id ? withRate({ ...x, ...pricesOf(m) }) : x)));
  };
  /** …or the master takes the project's. */
  const saveToMaster = (id: string) => {
    const p = projectById.get(id);
    if (p) saveBank(setMaster(bank, { ...(masterById.get(id) ?? p), ...pricesOf(p) }));
  };

  const addNew = () => {
    const cat = MATERIAL_CATEGORIES.find(c => c.code === division) ?? MATERIAL_CATEGORIES[0];
    const m: Material = {
      id: crypto.randomUUID(), code: `${cat.code} 00 00`, name: 'New material',
      category: categoryLabel(cat), division: cat.code, unit: 'EA',
      unitRate: 0, materialCost: 0, laborCost: 0, equipmentCost: 0,
    };
    // Your own materials live in the master and are available to the project.
    onUpdateMaterials([m, ...materials]);
    saveBank(setMaster(bank, m));
    setView('master');
    setQuery('');
    setUnratedOnly(false);
    setDiffersOnly(false);
    setSelectedId(m.id);
  };

  // ── Price lists in and out ─────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [incoming, setIncoming] = useState<(RateMatching & { file: string }) | null>(null);
  const [replacePriced, setReplacePriced] = useState(true);
  const [addUnmatched, setAddUnmatched] = useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  /** Download the materials on screen (with this project's quantities) as a sheet to fill in or send to a supplier. */
  const downloadRequest = async () => {
    setBusy(true);
    try {
      const billed = billedQuantities(projectState.measurements, projectState.drawings);
      const qty = new Map<string, number>();
      for (const r of projectState.measurements) {
        if (!r.materialId || r.isGroupHeader) continue;
        qty.set(r.materialId, (qty.get(r.materialId) ?? 0) + (billed.get(r.id) ?? r.quantity));
      }
      const list = (unratedOnly ? source.filter(m => totalRate(m) === 0) : source);
      const res = await fetch('/api/rates/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: projectState.projectName || 'Project', currency,
          items: list.map(m => ({ id: m.id, code: m.code, name: m.name,
            // Sold by the box or bag: ask for the price of one, and how many are needed.
            unit: m.purchase ? `${m.purchase.unit} (${m.purchase.covers} ${m.unit})` : m.unit,
            quantity: qty.has(m.id) ? orderFor(m, qty.get(m.id)!).orderQty : undefined, materialCost: m.materialCost, laborCost: m.laborCost, equipmentCost: m.equipmentCost, supplier: m.supplier })),
        }),
      });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = `${(projectState.projectName || 'project').replace(/[^\w\- ]+/g, '')}-price-request.xlsx`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setNotice(`Price request for ${list.length} material${list.length === 1 ? '' : 's'} downloaded. Fill in the yellow columns (or send it to a supplier), then use “Import prices”.`);
    } catch { setNotice('The price request could not be made.'); }
    setBusy(false);
  };

  const readPriceList = async (file: File) => {
    setBusy(true);
    try {
      const body = new FormData(); body.append('file', file);
      const res = await fetch('/api/rates/parse', { method: 'POST', body });
      const data = await res.json() as { lines?: RateLine[]; error?: string };
      if (!res.ok || !data.lines) setNotice(data.error ?? 'That file could not be read.');
      else {
        // The project's own names win where both sides have the material.
        const pool = master.map(m => projectById.get(m.id) ?? m);
        setAddUnmatched(false); setReplacePriced(true);
        setIncoming({ ...matchRates(data.lines, pool), file: file.name });
      }
    } catch { setNotice('That file could not be read.'); }
    setBusy(false);
  };

  /** Matched lines whose material already has a different price where the import would write it. */
  const importWould = useMemo(() => {
    if (!incoming) return { fresh: 0, changed: 0, same: 0 };
    let fresh = 0, changed = 0, same = 0;
    for (const x of incoming.matched) {
      const p = projectById.get(x.material.id), m = masterById.get(x.material.id);
      const cur = view === 'project' && p ? totalRate(p) : m ? totalRate(m) : 0;
      if (!cur) fresh++; else if (Math.abs(cur - x.prices.unitRate) < 0.005) same++; else changed++;
    }
    return { fresh, changed, same };
  }, [incoming, projectById, masterById, view]);

  const applyImport = () => {
    if (!incoming) return;
    let nextBank = bank;
    const projectPatch = new Map<string, Partial<Material>>();
    let written = 0;
    for (const x of incoming.matched) {
      const id = x.material.id;
      const p = projectById.get(id), m = masterById.get(id);
      const extra = x.line.supplier ? { supplier: x.line.supplier } : {};
      const may = (cur: Material | undefined) => !cur || totalRate(cur) === 0 || replacePriced;
      // The side you are looking at takes the price; the other side only when it is empty.
      const toProject = !!p && (view === 'project' ? may(p) : totalRate(p) === 0);
      const toMaster = !!m && (view === 'master' || !p ? may(m) : totalRate(m) === 0);
      if (toProject) projectPatch.set(id, { ...x.prices, ...extra });
      if (toMaster) nextBank = setMaster(nextBank, { ...m!, ...x.prices, ...extra });
      if (toProject || toMaster) written++;
    }
    let nextMaterials = projectPatch.size ? materials.map(mm => (projectPatch.has(mm.id) ? { ...mm, ...projectPatch.get(mm.id) } : mm)) : materials;
    let added = 0;
    if (addUnmatched) {
      for (const l of incoming.unmatched) {
        const prices = { materialCost: l.material ?? l.rate ?? 0, laborCost: l.labour ?? 0, equipmentCost: l.equipment ?? 0 };
        const div = MATERIAL_CATEGORIES.find(c => c.code === (l.code ?? '').trim().slice(0, 2)) ?? MATERIAL_CATEGORIES.find(c => c.code === division) ?? MATERIAL_CATEGORIES[0];
        const nm: Material = withRate({
          id: crypto.randomUUID(), code: l.code ?? `${div.code} 00 00`, name: l.name ?? l.code ?? 'Imported material',
          category: categoryLabel(div), division: div.code, unit: l.unit || 'EA', supplier: l.supplier, unitRate: 0, ...prices,
        });
        nextMaterials = [nm, ...nextMaterials];
        nextBank = setMaster(nextBank, nm);
        added++;
      }
    }
    if (nextMaterials !== materials) onUpdateMaterials(nextMaterials);
    if (nextBank !== bank) saveBank(nextBank);
    // Takeoff rows on a re-priced project material follow it.
    let rowsUpdated = 0;
    for (const [id, patch] of projectPatch) {
      for (const r of usage.get(id) ?? []) if (r.unitRate !== patch.unitRate) { updateMeasurement(r.id, { unitRate: patch.unitRate }); rowsUpdated++; }
    }
    setNotice([
      `${written} price${written === 1 ? '' : 's'} imported from ${incoming.file}`,
      rowsUpdated ? `${rowsUpdated} takeoff row${rowsUpdated === 1 ? '' : 's'} re-priced` : '',
      added ? `${added} new material${added === 1 ? '' : 's'} added` : '',
    ].filter(Boolean).join(' · ') + '.');
    setUnratedOnly(false);
    setIncoming(null);
  };

  const addFromCatalogue = (items: Material[]) => {
    const missing = items.filter(m => !projectIds.has(m.id)).map(m => ({ ...m }));
    if (missing.length) onUpdateMaterials([...materials, ...missing]);
  };

  const remove = async (m: Material) => {
    if (view === 'master') {
      if (m.builtIn) { saveBank(removeFromMaster(bank, m.id)); return; }      // a catalogue item only loses your price
      const ok = await confirm({
        title: 'Delete from the master bank',
        message: <>Delete <span className="text-zinc-100 font-bold">{m.name}</span> from your master bank?</>,
        detail: 'Projects that already use it keep their own copy and price.',
        confirmText: 'Delete',
      });
      if (ok) saveBank(removeFromMaster(bank, m.id));
      return;
    }
    const used = usage.get(m.id)?.length ?? 0;
    const ok = await confirm({
      title: 'Delete material',
      message: <>Delete <span className="text-zinc-100 font-bold">{m.name}</span> from this project’s material bank?</>,
      detail: used
        ? `${used} takeoff row${used === 1 ? ' uses' : 's use'} it. ${used === 1 ? 'It keeps' : 'They keep'} the current rate but will no longer be linked.`
        : 'It stays in the master bank.',
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

  const catalogueMissingAll = useMemo(() => DEFAULT_MATERIALS.filter(m => !projectIds.has(m.id)).length, [projectIds]);
  const cat = MATERIAL_CATEGORIES.find(c => c.code === division);
  const projectCopy = selected ? projectById.get(selected.id) : undefined;
  const staleRows = projectCopy ? (usage.get(projectCopy.id) ?? []).filter(r => r.unitRate !== totalRate(projectCopy)).length : 0;
  const selState = selected ? stateOf(selected.id) : 'same';

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
          <span className="hidden lg:block text-[11px] uppercase tracking-widest text-right leading-relaxed">
            <span className="block text-zinc-600">Prices are saved when you press Update</span>
            {inFolder
              ? <span className="block text-emerald-500" title="master-bank.json, beside your projects">Master bank kept in folder “{folder.folderName}”</span>
              : folder.folderName
                ? <span className="block text-amber-400" title="Allow access to the folder from the dashboard">Folder access paused: master bank is in this browser only</span>
                : <span className="block text-amber-400" title="Connect a folder from the dashboard to keep your prices safe">Master bank is in this browser only (no folder connected)</span>}
          </span>
          <button
            type="button"
            onClick={() => void tryClose()}
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
            {view === 'project' ? `${used.length} used in this project` : `${master.length} in your master bank`}
          </div>
          <nav aria-label="Divisions" className="flex-1 overflow-y-auto custom-scrollbar py-2 text-xs font-bold uppercase tracking-tight">
            {shownSections.map(c => {
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
                  {(differsByDivision.get(c.code) ?? 0) > 0 && (
                    <span className="text-[10px] text-amber-400 tabular-nums" title="Prices that differ between this project and the master bank">⚠ {differsByDivision.get(c.code)}</span>
                  )}
                  <span className="text-[10px] text-zinc-600 tabular-nums">{counts.get(c.code) ?? 0}</span>
                </button>
              );
            })}
            {emptySections > 0 && (
              <button
                type="button"
                onClick={() => setShowEmpty(v => !v)}
                className="w-full px-4 py-2.5 mt-1 text-left text-[10px] tracking-widest text-zinc-600 hover:text-amber-accent border-t border-industrial-border"
              >
                {showEmpty ? 'Hide empty sections' : `Show ${emptySections} empty sections`}
              </button>
            )}
          </nav>
          {catalogueMissingAll > 0 && (
            <div className="p-4 border-t border-industrial-border">
              <button
                type="button"
                onClick={() => addFromCatalogue(DEFAULT_MATERIALS)}
                className="w-full border border-industrial-border py-2 text-[11px] font-bold uppercase tracking-widest text-zinc-400 hover:text-amber-accent hover:border-amber-accent/60"
              >
                Make {catalogueMissingAll} removed catalogue items pickable again
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
                {view === 'project' ? `Materials this project’s takeoff uses, at this job’s prices (${currency})` : `Your default prices for every project in ${currency}, kept on this computer`}
              </p>
            </div>
            <div className="flex bg-industrial-panel p-1 border border-industrial-border text-[11px] font-bold uppercase tracking-widest" role="tablist">
              {([['master', 'Master bank', Library], ['project', `This project (${used.length})`, FolderOpen]] as const).map(([v, label, Icon]) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  disabled={draftCount > 0 && view !== v}
                  title={draftCount > 0 && view !== v ? 'Update or discard your price changes first' : undefined}
                  onClick={() => setView(v)}
                  className={cn('flex items-center gap-2 px-4 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed', view === v ? 'bg-amber-accent text-black' : 'text-zinc-500 hover:text-zinc-200')}
                >
                  <Icon className="w-3.5 h-3.5" /> {label}
                </button>
              ))}
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[140px] max-w-xl">
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
            <button
              type="button"
              onClick={() => { kept.current.clear(); setUnratedOnly(v => !v); }}
              aria-pressed={unratedOnly}
              className={cn('px-4 py-2.5 border text-[11px] font-bold uppercase tracking-widest',
                unratedOnly ? 'border-amber-accent/60 text-amber-accent bg-amber-accent/10' : 'border-industrial-border text-zinc-400 hover:text-zinc-100')}
            >
              Rate not set ({unratedCount})
            </button>
            <button
              type="button"
              onClick={() => setDiffersOnly(v => !v)}
              aria-pressed={differsOnly}
              title="Materials priced differently in this project and in the master bank"
              className={cn('flex items-center gap-1.5 px-4 py-2.5 border text-[11px] font-bold uppercase tracking-widest',
                differsOnly ? 'border-amber-accent/60 text-amber-accent bg-amber-accent/10'
                  : differsCount > 0 ? 'border-amber-600/60 text-amber-400 hover:text-amber-300' : 'border-industrial-border text-zinc-400 hover:text-zinc-100')}
            >
              <TriangleAlert className="w-3.5 h-3.5" /> Price differs ({differsCount})
            </button>
            <div className="flex-1" />
            <button
              type="button" onClick={downloadRequest} disabled={busy || source.length === 0}
              title="Download these materials and quantities as an Excel sheet with blank price columns, to fill in or send to a supplier"
              className="flex items-center gap-1.5 px-4 py-2.5 border border-industrial-border text-[11px] font-bold uppercase tracking-widest text-zinc-400 hover:text-amber-accent hover:border-amber-accent/60 disabled:opacity-40"
            >
              <Send className="w-3.5 h-3.5" /> Price request
            </button>
            <button
              type="button" onClick={() => fileRef.current?.click()} disabled={busy}
              title="Read prices from an Excel or CSV price list: the filled-in price request, a supplier quotation or your company rate sheet"
              className="flex items-center gap-1.5 px-4 py-2.5 border border-industrial-border text-[11px] font-bold uppercase tracking-widest text-zinc-400 hover:text-amber-accent hover:border-amber-accent/60 disabled:opacity-40"
            >
              <Upload className="w-3.5 h-3.5" /> Import prices
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.csv" aria-label="Price list file" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readPriceList(f); }} />
            <button
              type="button"
              onClick={addNew}
              className="flex items-center gap-2 bg-amber-accent hover:bg-amber-400 text-black px-4 py-2.5 text-[11px] font-bold uppercase tracking-widest"
            >
              <Plus className="w-3.5 h-3.5" /> New material
            </button>
          </div>
          {incoming && (
            <div role="dialog" aria-label="Import prices" className="border border-amber-accent/60 bg-industrial-panel p-4 space-y-3 text-xs">
              <div className="flex items-center gap-3">
                <span className="text-amber-accent font-bold uppercase tracking-widest text-[11px]">Import prices</span>
                <span className="text-zinc-500 truncate">{incoming.file}</span>
                <span className="flex-1" />
                <span className="text-zinc-500">into {view === 'project' ? 'this project' : 'the master bank'}</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  ['New prices', importWould.fresh, 'text-emerald-400'],
                  ['Change an existing price', importWould.changed, importWould.changed ? 'text-amber-400' : 'text-zinc-400'],
                  ['Already the same', importWould.same, 'text-zinc-400'],
                  ['Not found in the bank', incoming.unmatched.length, incoming.unmatched.length ? 'text-amber-400' : 'text-zinc-400'],
                ].map(([label, n, tone]) => (
                  <div key={label as string} className="border border-industrial-border px-3 py-2">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500">{label}</div>
                    <div className={cn('text-lg font-bold tabular-nums', tone as string)}>{n}</div>
                  </div>
                ))}
              </div>
              {incoming.matched.length > 0 && (
                <div className="max-h-40 overflow-y-auto custom-scrollbar border border-industrial-border divide-y divide-industrial-border">
                  {incoming.matched.slice(0, 200).map(x => {
                    const p = projectById.get(x.material.id), m = masterById.get(x.material.id);
                    const cur = view === 'project' && p ? totalRate(p) : m ? totalRate(m) : 0;
                    const changes = cur > 0 && Math.abs(cur - x.prices.unitRate) >= 0.005;
                    return (
                      <div key={x.material.id} className="flex items-baseline gap-3 px-3 py-1.5">
                        <span className="flex-1 min-w-0 truncate text-zinc-200">{x.material.name}</span>
                        <span className="text-[10px] text-zinc-600">matched by {x.by === 'ref' ? 'reference' : x.by}</span>
                        <span className={cn('tabular-nums w-28 text-right', changes ? 'text-zinc-500 line-through' : 'text-zinc-600')}>{cur ? formatCurrency(cur) : '—'}</span>
                        <span className={cn('tabular-nums w-28 text-right font-bold', changes ? 'text-amber-400' : 'text-zinc-100')}>{formatCurrency(x.prices.unitRate)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {incoming.unmatched.length > 0 && (
                <p className="text-zinc-500">
                  Not found: {incoming.unmatched.slice(0, 6).map(l => l.name ?? l.code).join(' · ')}{incoming.unmatched.length > 6 ? ` · and ${incoming.unmatched.length - 6} more` : ''}
                </p>
              )}
              {incoming.blank > 0 && <p className="text-zinc-600">{incoming.blank} line{incoming.blank === 1 ? ' has' : 's have'} no price and {incoming.blank === 1 ? 'is' : 'are'} skipped.</p>}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                {importWould.changed > 0 && (
                  <label className="flex items-center gap-2 text-zinc-300">
                    <input type="checkbox" checked={replacePriced} onChange={e => setReplacePriced(e.target.checked)} className="accent-[#F2C230]" />
                    Replace the {importWould.changed} existing price{importWould.changed === 1 ? '' : 's'}
                  </label>
                )}
                {incoming.unmatched.length > 0 && (
                  <label className="flex items-center gap-2 text-zinc-300">
                    <input type="checkbox" checked={addUnmatched} onChange={e => setAddUnmatched(e.target.checked)} className="accent-[#F2C230]" />
                    Add the {incoming.unmatched.length} not found as new materials
                  </label>
                )}
                <span className="flex-1" />
                <button type="button" onClick={() => setIncoming(null)} className="px-4 py-2 border border-industrial-border text-[11px] font-bold uppercase tracking-widest text-zinc-400 hover:text-zinc-100">Cancel</button>
                <button
                  type="button" onClick={applyImport}
                  disabled={importWould.fresh + (replacePriced ? importWould.changed : 0) + (addUnmatched ? incoming.unmatched.length : 0) === 0}
                  className="px-4 py-2 bg-amber-accent text-black text-[11px] font-bold uppercase tracking-widest hover:bg-amber-400 disabled:opacity-40"
                >
                  Import {importWould.fresh + (replacePriced ? importWould.changed : 0) + (addUnmatched ? incoming.unmatched.length : 0)} price{importWould.fresh + (replacePriced ? importWould.changed : 0) + (addUnmatched ? incoming.unmatched.length : 0) === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          )}
          {draftCount > 0 && (
            <div role="status" className="flex flex-wrap items-center gap-3 border border-amber-accent bg-amber-accent/15 px-4 py-2.5 text-xs text-amber-100">
              <TriangleAlert className="w-4 h-4 text-amber-accent shrink-0" />
              <span className="flex-1 min-w-0">
                <b>{draftCount} price change{draftCount === 1 ? '' : 's'} not updated yet.</b> Nothing has been saved to {view === 'project' ? 'the project, the estimate' : 'the master bank'} or anywhere else.
              </span>
              <button type="button" onClick={() => setDraft({})} className="px-4 py-2 border border-industrial-border text-[11px] font-bold uppercase tracking-widest text-zinc-300 hover:text-white">Discard</button>
              <button type="button" onClick={applyDraft} className="px-4 py-2 bg-amber-accent text-black text-[11px] font-bold uppercase tracking-widest hover:bg-amber-400">
                Update {draftCount} price{draftCount === 1 ? '' : 's'}
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="flex items-center gap-3 border border-amber-600/50 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
              <span className="flex-1">{notice}</span>
              <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="text-amber-300 hover:text-white"><X className="w-3.5 h-3.5" /></button>
            </div>
          )}

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
                      <th className="p-3 text-right">Material</th>
                      <th className="p-3 text-right">Labour</th>
                      <th className="p-3 text-right">Equip.</th>
                      <th className="p-3 text-right text-amber-accent">{view === 'project' ? 'Project rate' : 'Master rate'}</th>
                      <th className="p-3 pr-4 text-right">{view === 'project' ? 'Master bank' : 'This project'}</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs">
                    {rows.map(m0 => {
                      const m = eff(m0);
                      const pending = !!draft[m0.id];
                      const rate = totalRate(m);
                      const used = usage.get(m.id)?.length ?? 0;
                      const st = stateOf(m.id);
                      const there = view === 'project' ? masterById.get(m.id) : projectById.get(m.id);
                      const thereRate = there ? totalRate(there) : 0;
                      return (
                        <tr
                          key={m.id}
                          onClick={() => setSelectedId(m.id)}
                          className={cn(
                            'border-b border-industrial-border/40 border-l-2 transition-colors cursor-pointer',
                            selected?.id === m.id ? 'bg-industrial-black border-l-amber-accent' : 'border-l-transparent hover:bg-zinc-800/30',
                            st === 'differs' && 'bg-amber-500/[0.07]',
                          )}
                        >
                          <td className="p-3 pl-4 text-zinc-500 font-bold">{m.code}</td>
                          <td className="p-3 text-zinc-200 max-w-[300px] truncate" title={m.name}>
                            {m.name}
                            {pending && <span className="ml-2 text-[10px] font-bold text-black bg-amber-accent px-1">not updated</span>}
                            {used > 0 && (
                              <span className="ml-2 text-[10px] text-zinc-500 border border-industrial-border px-1">{used} row{used === 1 ? '' : 's'}</span>
                            )}
                          </td>
                          <td className="p-3 text-zinc-500">{m.unit}</td>
                          <td className="p-1 text-right"><RateCell value={m.materialCost ?? 0} label={`Material rate for ${m.name}`} onFocus={() => { setSelectedId(m.id); kept.current.add(m.id); }} onCommit={n => stage(m0, { materialCost: n })} /></td>
                          <td className="p-1 text-right"><RateCell value={m.laborCost ?? 0} label={`Labour rate for ${m.name}`} onFocus={() => { setSelectedId(m.id); kept.current.add(m.id); }} onCommit={n => stage(m0, { laborCost: n })} /></td>
                          <td className="p-1 text-right"><RateCell value={m.equipmentCost ?? 0} label={`Equipment rate for ${m.name}`} onFocus={() => { setSelectedId(m.id); kept.current.add(m.id); }} onCommit={n => stage(m0, { equipmentCost: n })} /></td>
                          <td className={cn('p-3 text-right font-bold', rate ? 'text-amber-accent' : 'text-zinc-600 font-normal italic')}>
                            {rate ? formatCurrency(rate) : 'rate not set'}
                          </td>
                          <td className="p-3 pr-4 text-right">
                            {st === 'differs' ? (
                              <span className="inline-flex items-center gap-1 text-amber-400 font-bold" title="Priced differently here and there: open it to choose">
                                <TriangleAlert className="w-3.5 h-3.5" /> {formatCurrency(thereRate)}
                              </span>
                            ) : st === 'same' ? (
                              <span className="text-emerald-500" title="Same price in both">same</span>
                            ) : !there ? (
                              <span className="text-zinc-600">{view === 'master' ? 'not in project' : '—'}</span>
                            ) : (
                              <span className="text-zinc-600">{thereRate ? formatCurrency(thereRate) : '—'}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={8} className="p-12 text-center">
                          <p className="text-xs text-zinc-500 uppercase tracking-widest">
                            {query ? 'Nothing matches your search.'
                              : differsOnly ? 'No prices differ in this division.'
                              : unratedOnly ? 'Every material in this division has a rate.'
                              : view === 'project' ? 'The takeoff uses no material from this division yet.' : 'Nothing in this division.'}
                          </p>
                          {view === 'project' && !query && !unratedOnly && !differsOnly && (
                            <p className="mt-3 text-[11px] text-zinc-600 normal-case tracking-normal max-w-md mx-auto leading-relaxed">
                              Only materials assigned to takeoff rows are listed here. Prices for everything else are in the Master bank.
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2.5 border-t border-industrial-border text-[10px] text-zinc-600 uppercase tracking-widest flex justify-between">
                <span>{rows.length} item{rows.length === 1 ? '' : 's'} shown</span>
                <span>Rates in {currency}</span>
              </div>
            </div>

            {/* Detail / editor */}
            {selected && (
              <aside className="w-80 shrink-0 bg-industrial-panel border border-industrial-border flex flex-col overflow-y-auto custom-scrollbar">
                <div className="flex items-center justify-between px-4 py-3 border-b border-industrial-border">
                  <span className="text-amber-accent font-bold uppercase tracking-widest text-xs">{view === 'project' ? 'Project price' : 'Master price'}</span>
                  <button type="button" onClick={() => void remove(selected)}
                    title={view === 'project' ? 'Remove from this project' : selected.builtIn ? 'Clear your master price' : 'Delete from the master bank'}
                    aria-label={view === 'project' ? 'Remove from this project' : selected.builtIn ? 'Clear your master price' : 'Delete from the master bank'}
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
                      <select
                        value={selected.unit}
                        onChange={e => update(selected.id, { unit: e.target.value })}
                        aria-label={`Unit for ${selected.name}`}
                        className="w-full bg-industrial-black border border-industrial-border p-2 text-zinc-100 outline-none focus:border-amber-accent"
                      >
                        {[...new Set([selected.unit, ...UNITS])].map(unit => (
                          <option key={unit} value={unit}>{unit}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <datalist id="material-units">{UNITS.map(u => <option key={u} value={u} />)}</datalist>

                  <div className="border-t border-industrial-border pt-4 space-y-2">
                    <h3 className="text-[11px] text-amber-accent font-bold uppercase tracking-widest">{view === 'project' ? 'This project' : 'Master bank'}: rate per {selected.unit || 'unit'}</h3>
                    {([['materialCost', 'Material'], ['laborCost', 'Labour'], ['equipmentCost', 'Equipment']] as const).map(([k, label]) => (
                      <label key={k} className="flex items-center justify-between gap-3 bg-industrial-black border border-industrial-border px-3 py-2">
                        <span className="text-[11px] uppercase tracking-widest text-zinc-500">{label}{k === 'materialCost' && selected.purchase ? <span className="normal-case tracking-normal text-amber-300"> per {selected.purchase.unit || 'unit'}</span> : null}</span>
                        <span className="flex items-center gap-1.5">
                          <span className="text-[11px] text-zinc-600">{currency}</span>
                          <input
                            type="number" min={0} step="0.01" inputMode="decimal"
                            value={selected[k] || ''}
                            placeholder="0"
                            onChange={e => saved && stage(saved, { [k]: Math.max(0, parseFloat(e.target.value) || 0) } as Partial<Material>)}
                            className="w-24 bg-transparent text-right text-zinc-100 outline-none"
                          />
                        </span>
                      </label>
                    ))}
                    {/* Waste: bought but not billed. */}
                    <label className="flex items-center justify-between gap-3 bg-industrial-black border border-industrial-border px-3 py-2"
                      title="Material you buy but cannot bill: offcuts, breakage. It is added to the material part of the rate; bill quantities stay as measured.">
                      <span className="text-[11px] uppercase tracking-widest text-zinc-500">Waste</span>
                      <span className="flex items-center gap-1.5">
                        <input type="number" min={0} max={100} step="0.5" inputMode="decimal" aria-label="Waste percent"
                          value={selected.wastePercent || ''} placeholder="0"
                          onChange={e => saved && stage(saved, { wastePercent: Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)) || undefined })}
                          className="w-24 bg-transparent text-right text-zinc-100 outline-none" />
                        <span className="text-[11px] text-zinc-600">%</span>
                      </span>
                    </label>
                    {/* Sold in a different unit from the one it is measured in. */}
                    <div className="bg-industrial-black border border-industrial-border px-3 py-2 space-y-1.5"
                      title="Tiles are measured in m² but sold by the box; blocks by the piece. Say how it is sold and the price above becomes the price of one of those.">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[11px] uppercase tracking-widest text-zinc-500">Bought by the</span>
                        <input list="buy-units" aria-label="Buying unit" placeholder={selected.unit || 'same unit'}
                          value={selected.purchase?.unit ?? ''}
                          onChange={e => saved && stage(saved, { purchase: e.target.value.trim() ? { unit: e.target.value, covers: selected.purchase?.covers ?? 1 } : undefined })}
                          className="w-24 bg-transparent text-right text-zinc-100 outline-none placeholder:text-zinc-600" />
                        <datalist id="buy-units">{['box', 'bag', 'sheet', 'roll', 'nr', 'pack', 'drum', 'tonne', 'length'].map(u => <option key={u} value={u} />)}</datalist>
                      </div>
                      {selected.purchase && (
                        <label className="flex items-center justify-between gap-3">
                          <span className="text-[11px] text-zinc-400">One {selected.purchase.unit || 'unit'} covers</span>
                          <span className="flex items-center gap-1.5">
                            <input type="number" min={0} step="0.01" inputMode="decimal" aria-label="Coverage of one buying unit"
                              value={selected.purchase.covers || ''} placeholder="1"
                              onChange={e => saved && stage(saved, { purchase: { unit: selected.purchase!.unit, covers: Math.max(0, parseFloat(e.target.value) || 0) } })}
                              className="w-20 bg-transparent text-right text-zinc-100 outline-none" />
                            <span className="text-[11px] text-zinc-600">{selected.unit}</span>
                          </span>
                        </label>
                      )}
                    </div>
                    <div className="flex items-center justify-between border-l-2 border-amber-accent bg-industrial-black px-3 py-2">
                      <span className="text-[11px] uppercase tracking-widest text-amber-accent font-bold">Total rate <span className="normal-case tracking-normal font-normal text-zinc-500">per {selected.unit || 'unit'}</span></span>
                      <span className="text-sm font-bold text-amber-accent">{formatCurrency(totalRate(selected))}</span>
                    </div>
                    {(selected.purchase || (selected.wastePercent ?? 0) > 0) && (selected.materialCost ?? 0) > 0 && (
                      <p className="text-[11px] text-zinc-500 leading-relaxed">
                        Material: {formatCurrency(selected.materialCost)}{selected.purchase ? ` ÷ ${selected.purchase.covers || 1} ${selected.unit}` : ''}{(selected.wastePercent ?? 0) > 0 ? ` × ${(1 + (selected.wastePercent ?? 0) / 100).toFixed(2)} waste` : ''} = {formatCurrency(materialPart(selected))} per {selected.unit}
                      </p>
                    )}
                  </div>

                  {/* The other price list, and what to do when they disagree */}
                  <div className={cn('border px-3 py-2.5 space-y-2', selState === 'differs' ? 'border-amber-500/70 bg-amber-500/10' : 'border-industrial-border')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] uppercase tracking-widest text-zinc-500">{view === 'project' ? 'Master bank' : 'This project'}</span>
                      <span className={cn('font-bold', selState === 'differs' ? 'text-amber-300' : 'text-zinc-300')}>
                        {!other ? 'not in this project' : totalRate(other) ? formatCurrency(totalRate(other)) : 'no price yet'}
                      </span>
                    </div>
                    {selState === 'differs' && (
                      <>
                        <p className="flex gap-1.5 text-amber-200 leading-relaxed">
                          <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          Priced differently in this project and in your master bank. Neither is changed until you choose.
                        </p>
                        <button type="button" onClick={() => takeMasterPrice(selected.id)}
                          className="w-full flex items-center justify-center gap-2 border border-amber-accent/60 text-amber-accent hover:bg-amber-accent/10 py-2 text-[11px] font-bold uppercase tracking-widest">
                          <ArrowRight className="w-3.5 h-3.5" /> Use the master price in this project
                        </button>
                        <button type="button" onClick={() => saveToMaster(selected.id)}
                          className="w-full flex items-center justify-center gap-2 border border-amber-accent/60 text-amber-accent hover:bg-amber-accent/10 py-2 text-[11px] font-bold uppercase tracking-widest">
                          <ArrowLeft className="w-3.5 h-3.5" /> Save the project price to the master
                        </button>
                      </>
                    )}
                    {selState === 'same' && <p className="text-emerald-500">Same price in both.</p>}
                    {selState !== 'differs' && selState !== 'same' && other && (
                      <p className="text-zinc-500 leading-relaxed">
                        {view === 'project'
                          ? 'The master has no price for this yet: what you enter here is saved to it as well.'
                          : 'This project has no price for this yet: what you enter here is used there as well.'}
                      </p>
                    )}
                  </div>

                  {(usage.get(selected.id)?.length ?? 0) > 0 && (
                    <div className="border-t border-industrial-border pt-4 space-y-2">
                      <p className="text-zinc-400">
                        Used by {usage.get(selected.id)!.length} takeoff row{usage.get(selected.id)!.length === 1 ? '' : 's'}.
                      </p>
                      {staleRows > 0 && (
                        <button
                          type="button"
                          onClick={() => projectCopy && applyRateToRows(projectCopy)}
                          className="w-full border border-amber-accent/60 text-amber-accent hover:bg-amber-accent/10 py-2 text-[11px] font-bold uppercase tracking-widest"
                        >
                          Apply the project rate to {staleRows} row{staleRows === 1 ? '' : 's'}
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
                    <p className="text-[11px] text-zinc-600">From the built-in catalogue. Its name and unit are kept per project; the price you set in the master is shared by every project in {currency}.</p>
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

'use client';
// Value engineering: for each material in use, propose alternatives, see the saving
// across the whole takeoff, and accept or reject them. The designed material is kept.

import React, { useMemo, useState } from 'react';
import { X, Scale } from 'lucide-react';
import type { Drawing, Material, TakeoffRow } from '@/types';
import {
  materialsInUse, veSummary, acceptProposal, restoreDesigned, setProposalStatus, materialRate, type VeProposal,
} from '@/lib/takeoff/valueEngineering';
import { formatCurrency } from '@/lib/utils';
import { rememberInMaster } from '@/lib/takeoff/masterBank';
import { getDisplayCurrency } from '@/lib/takeoff/currency';
import { DEFAULT_MATERIALS } from '@/data/materials';

interface Props {
  measurements: TakeoffRow[];
  drawings: Drawing[];
  materials: Material[];
  proposals: VeProposal[];
  /** Apply a change to the project (any of the three may be given). */
  onChange: (next: { measurements?: TakeoffRow[]; materials?: Material[]; proposals: VeProposal[] }) => void;
  onClose: () => void;
  /** Render as a section of a page instead of a full page of its own. */
  embedded?: boolean;
  /** Material to start an alternative for. */
  initialMaterialId?: string | null;
}

const q = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `ve-${Date.now()}-${Math.random()}`);
const field = 'w-full bg-[#16191C] border border-zinc-700 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-amber-accent';
const TAG: Record<string, string> = {
  proposed: 'border-amber-600 text-amber-400', accepted: 'border-green-700 text-green-400', rejected: 'border-zinc-600 text-zinc-500',
};
const act = 'px-2 py-1 text-[10px] font-bold uppercase tracking-widest border border-zinc-600 text-zinc-200 hover:border-amber-accent hover:text-amber-accent';

export function ValueEngineeringDialog({ measurements, drawings, materials, proposals, onChange, onClose, embedded, initialMaterialId }: Props) {
  const inUse = useMemo(() => materialsInUse(measurements, drawings, materials), [measurements, drawings, materials]);
  const summary = useMemo(() => veSummary(proposals, measurements, drawings, materials), [proposals, measurements, drawings, materials]);
  const [fromId, setFromId] = useState<string | null>(initialMaterialId ?? null);
  const [toId, setToId] = useState('');
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [note, setNote] = useState('');
  const from = inUse.find(u => u.materialId === fromId);
  const fromMat = materials.find(m => m.id === fromId);
  const noMaterial = measurements.filter(m => !m.isGroupHeader && !m.materialId).length;

  // Every material in the bank can be an alternative. Same unit first (those are the likely
  // substitutes), priced ones before unpriced, then by name.
  const [search, setSearch] = useState('');
  const [allUnits, setAllUnits] = useState(false);
  const pool = useMemo(() => materials.filter(m => m.id !== fromId), [materials, fromId]);
  const sameUnit = useMemo(() => pool.filter(m => m.unit === (fromMat?.unit ?? from?.unit)), [pool, fromMat, from]);
  const candidates = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const base = allUnits || sameUnit.length === 0 || words.length > 0 ? pool : sameUnit;
    return base
      .filter(m => words.every(w => `${m.name} ${m.code ?? ''}`.toLowerCase().includes(w)))
      .sort((a, b) =>
        Number(b.unit === fromMat?.unit) - Number(a.unit === fromMat?.unit)
        || Number(materialRate(b) > 0) - Number(materialRate(a) > 0)
        || a.name.localeCompare(b.name))
      .slice(0, 80);
  }, [pool, sameUnit, search, allUnits, fromMat]);
  const picked = toId && toId !== '__new__' ? materials.find(m => m.id === toId) : undefined;
  const pickedRate = picked ? materialRate(picked) : 0;

  const newRate = parseFloat(rate);
  // A bank material with no price yet needs one before the saving can be worked out.
  const canAdd = !!from && (toId === '__new__' ? name.trim().length > 0 && newRate > 0 : !!picked && (pickedRate > 0 || newRate > 0));
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const add = () => {
    if (!from || !canAdd) return;
    let mats: Material[] | undefined;
    let target = toId;
    if (toId === '__new__') {
      target = uid();
      mats = [...materials, {
        ...(fromMat ?? {} as Material), id: target, name: name.trim(), code: '', sku: undefined, supplier: undefined, builtIn: false,
        unit: fromMat?.unit ?? from.unit, category: fromMat?.category ?? '', unitRate: newRate, materialCost: newRate, laborCost: 0, equipmentCost: 0,
      }];
    } else if (picked && pickedRate === 0) {
      // The price typed here becomes that material's price in this project (and in the master bank, if it has none).
      mats = materials.map(m => (m.id === picked.id ? { ...m, unitRate: newRate, materialCost: newRate, laborCost: 0, equipmentCost: 0 } : m));
    }
    // The project now holds the price; the master bank learns it by the usual rule
    // (a new material is added, an empty price is filled, an existing price is left alone).
    const changed = mats?.find(m => m.id === target);
    if (changed) {
      const how = rememberInMaster(changed, getDisplayCurrency(), DEFAULT_MATERIALS);
      setSavedNote(how === 'added' ? `“${changed.name}” was added to this project and to your master bank.`
        : how === 'priced' ? `The price of “${changed.name}” was saved to this project and to your master bank.`
        : `The price of “${changed.name}” was saved to this project. Your master bank already has its own price, which was left alone.`);
    } else setSavedNote(null);
    onChange({
      ...(mats ? { materials: mats } : {}),
      proposals: [...proposals, { id: uid(), fromMaterialId: from.materialId, toMaterialId: target, note: note.trim() || undefined, status: 'proposed', createdAt: new Date().toISOString() }],
    });
    setToId(''); setName(''); setRate(''); setNote(''); setSearch('');
  };

  return (
    <div className={embedded ? 'flex-1 min-h-0 flex bg-[#1D2125] font-mono' : 'fixed inset-0 z-[160] flex bg-[#1D2125] font-mono'}>
      <div className="w-full h-full flex flex-col min-h-0">
        <div className={embedded ? 'hidden' : 'bg-[#1a1a1a] border-b border-amber-accent px-5 py-3 flex items-center gap-3'}>
          <Scale className="w-4 h-4 text-amber-accent" />
          <h2 className="text-amber-accent text-sm uppercase tracking-widest font-black flex-1">Value engineering</h2>
          <button onClick={onClose} className="flex items-center gap-2 border border-zinc-600 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-zinc-200 hover:border-amber-accent hover:text-amber-accent">
            <X className="w-4 h-4" />Back to takeoff
          </button>
        </div>

        <div className="px-5 py-3 border-b border-zinc-800 flex flex-wrap gap-8 text-xs">
          <div><div className="text-[10px] uppercase tracking-widest text-zinc-500">Saving accepted</div><div className="text-lg font-bold text-green-400">{formatCurrency(summary.accepted)}</div></div>
          <div><div className="text-[10px] uppercase tracking-widest text-zinc-500">Saving still on offer</div><div className="text-lg font-bold text-amber-accent">{formatCurrency(summary.pending)}</div></div>
          <div><div className="text-[10px] uppercase tracking-widest text-zinc-500">Affected items as designed</div><div className="text-lg font-bold text-zinc-200">{formatCurrency(summary.designedCost)}</div></div>
          <p className="ml-auto max-w-md text-[11px] text-zinc-500 leading-relaxed">
            Quantities stay as measured; only the material and its rate change. Accepting an alternative updates every row on that material. The designed material is kept and can be put back.
          </p>
        </div>

        <div className="flex-1 min-h-0 flex">
          <aside className="w-80 shrink-0 border-r border-zinc-800 flex flex-col">
            <div className="px-4 py-2 text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-800">Materials in the takeoff, dearest first</div>
            <div className="flex-1 min-h-12 overflow-y-auto">
              {inUse.map(u => (
                <button
                  key={u.materialId} onClick={() => { setFromId(u.materialId); setToId(''); }} aria-pressed={fromId === u.materialId}
                  className={`w-full text-left px-4 py-2.5 border-b border-zinc-800 hover:bg-zinc-800 ${fromId === u.materialId ? 'bg-zinc-800 shadow-[inset_3px_0_0_#F2C230]' : ''}`}
                >
                  <span className="block text-xs text-zinc-100 truncate" title={u.name}>{u.name}</span>
                  <span className="flex justify-between text-[11px] text-zinc-500">
                    <span>{q(u.quantity)} {u.unit} · {u.rows} {u.rows === 1 ? 'row' : 'rows'}</span>
                    <span className="text-zinc-300">{formatCurrency(u.cost)}</span>
                  </span>
                </button>
              ))}
              {inUse.length === 0 && (
                <p className="p-4 text-[11px] text-zinc-400 leading-relaxed">
                  No row has a material yet. Give the takeoff rows a material from the material bank first: alternatives are proposed per material.
                </p>
              )}
              {inUse.length > 0 && noMaterial > 0 && (
                <p className="p-4 text-[11px] text-zinc-600 leading-relaxed">{noMaterial} rows have no material and are not shown here.</p>
              )}
            </div>
            {from && (
              <div className="p-4 border-t border-amber-accent/60 bg-[#16191C] space-y-2 max-h-[75%] overflow-y-auto shrink-0">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] uppercase tracking-widest text-zinc-400">Alternative to</div>
                  <button type="button" aria-label="Close the alternative picker" title="Close" onClick={() => { setFromId(null); setToId(''); setSearch(''); }}
                    className="text-zinc-500 hover:text-amber-accent text-base leading-none px-1">×</button>
                </div>
                <div className="text-xs text-zinc-100">{from.name} <span className="text-zinc-500">at {q(from.rate)} / {from.unit}</span></div>
                {!toId && (
                  <>
                    <input aria-label="Search the material bank" placeholder="Search your material bank…" value={search} onChange={e => setSearch(e.target.value)} className={field} />
                    <div className="max-h-40 overflow-y-auto border border-zinc-700 divide-y divide-zinc-800" role="listbox" aria-label="Alternative material">
                      {candidates.map(m => (
                        <button key={m.id} type="button" role="option" aria-selected={false} onClick={() => { setToId(m.id); setRate(''); }}
                          className="w-full flex items-baseline gap-2 px-2 py-1.5 text-left hover:bg-zinc-800">
                          <span className="flex-1 min-w-0 truncate text-xs text-zinc-100" title={m.name}>{m.name}</span>
                          <span className={`shrink-0 text-[11px] tabular-nums ${materialRate(m) > 0 ? 'text-zinc-300' : 'text-zinc-600 italic'}`}>
                            {materialRate(m) > 0 ? q(materialRate(m)) : 'no price'} / {m.unit}
                          </span>
                        </button>
                      ))}
                      {candidates.length === 0 && <p className="px-2 py-3 text-[11px] text-zinc-500">Nothing in the bank matches.</p>}
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      {sameUnit.length > 0 && !search ? (
                        <button type="button" onClick={() => setAllUnits(v => !v)} className="text-zinc-400 hover:text-amber-accent underline underline-offset-2">
                          {allUnits ? `Only materials priced per ${fromMat?.unit ?? from.unit}` : 'Show all units'}
                        </button>
                      ) : <span />}
                      <button type="button" onClick={() => setToId('__new__')} className="text-zinc-400 hover:text-amber-accent underline underline-offset-2">Not in the bank? Add one</button>
                    </div>
                  </>
                )}
                {picked && (
                  <div className="border border-zinc-700 px-2 py-1.5 space-y-1.5">
                    <div className="flex items-baseline gap-2">
                      <span className="flex-1 min-w-0 truncate text-xs text-zinc-100" title={picked.name}>{picked.name}</span>
                      <button type="button" onClick={() => setToId('')} className="text-[11px] text-zinc-400 hover:text-amber-accent underline underline-offset-2">change</button>
                    </div>
                    {pickedRate > 0 ? (
                      <div className="text-[11px] text-zinc-400">{q(pickedRate)} / {picked.unit}</div>
                    ) : (
                      <label className="block space-y-1 text-[11px] text-amber-300">
                        <span className="block">It has no price yet. Price per {picked.unit}:</span>
                        <input aria-label={`Price per ${picked.unit}`} inputMode="decimal" autoFocus value={rate} onChange={e => setRate(e.target.value)} className={field} />
                      </label>
                    )}
                    {picked.unit !== (fromMat?.unit ?? from.unit) && (
                      <p className="text-[11px] text-amber-300">Priced per {picked.unit}, but the designed material is per {fromMat?.unit ?? from.unit}: check the saving makes sense.</p>
                    )}
                  </div>
                )}
                {toId === '__new__' && (
                  <div className="space-y-1.5">
                    <div className="flex gap-2">
                      <input aria-label="Name of the alternative" placeholder="Name" autoFocus value={name} onChange={e => setName(e.target.value)} className={field} />
                      <input aria-label={`Rate per ${from.unit}`} placeholder={`Rate / ${from.unit}`} inputMode="decimal" value={rate} onChange={e => setRate(e.target.value)} className={`${field} w-28`} />
                    </div>
                    <button type="button" onClick={() => setToId('')} className="text-[11px] text-zinc-400 hover:text-amber-accent underline underline-offset-2">Pick from the bank instead</button>
                  </div>
                )}
                <input aria-label="Note" placeholder="Note (why it is equivalent, lead time…)" value={note} onChange={e => setNote(e.target.value)} className={field} />
                <button onClick={add} disabled={!canAdd} className="w-full bg-amber-accent text-black font-black text-[11px] uppercase tracking-widest px-3 py-2 hover:bg-amber-400 disabled:opacity-40">Add alternative</button>
                {savedNote && <p role="status" className="text-[11px] text-emerald-400 leading-relaxed">{savedNote}</p>}
              </div>
            )}
          </aside>

          <div className="flex-1 min-w-0 overflow-auto">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-stone-900 text-[10px] uppercase tracking-widest text-zinc-500">
                <tr>
                  <th className="text-left px-5 py-2">As designed</th><th className="text-left px-3 py-2">Alternative</th>
                  <th className="text-right px-3 py-2">Quantity</th><th className="text-right px-3 py-2">Designed cost</th>
                  <th className="text-right px-3 py-2">Alternative cost</th><th className="text-right px-3 py-2">Saving</th>
                  <th className="text-left px-3 py-2">Status</th><th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody>
                {summary.lines.map(l => {
                  const p = l.proposal;
                  return (
                    <tr key={p.id} className={`border-b border-zinc-800 align-top ${p.status === 'rejected' ? 'text-zinc-500' : 'text-zinc-200'}`}>
                      <td className="px-5 py-2.5">{l.designed}<div className="text-[11px] text-zinc-500">{q(l.designedRate)} / {l.unit}</div></td>
                      <td className="px-3 py-2.5">{l.alternative}<div className="text-[11px] text-zinc-500">{q(l.alternativeRate)} / {l.unit}{p.note ? ` · ${p.note}` : ''}</div></td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{q(l.quantity)} <span className="text-zinc-500">{l.unit}</span><div className="text-[11px] text-zinc-500">{l.rows} {l.rows === 1 ? 'row' : 'rows'}</div></td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{q(l.designedCost)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{q(l.alternativeCost)}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums font-bold ${l.saving > 0 ? 'text-green-400' : l.saving < 0 ? 'text-red-400' : ''}`}>
                        {l.saving < 0 ? '−' : ''}{q(Math.abs(l.saving))}<div className="text-[11px] font-normal text-zinc-500">{l.saving < 0 ? 'dearer' : `${l.savingPercent}%`}</div>
                      </td>
                      <td className="px-3 py-2.5"><span className={`text-[9px] font-bold uppercase tracking-widest px-1 py-0.5 border ${TAG[p.status]}`}>{p.status}</span></td>
                      <td className="px-5 py-2.5">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {p.status === 'proposed' && <>
                            <button className={`${act} !border-green-700 !text-green-400`} disabled={l.rows === 0} onClick={() => onChange(acceptProposal(p.id, proposals, measurements, materials))}>Accept</button>
                            <button className={act} onClick={() => onChange({ proposals: setProposalStatus(p.id, 'rejected', proposals) })}>Reject</button>
                          </>}
                          {p.status === 'accepted' && <button className={act} onClick={() => onChange(restoreDesigned(p.id, proposals, measurements))}>Put designed back</button>}
                          {p.status === 'rejected' && <button className={act} onClick={() => onChange({ proposals: setProposalStatus(p.id, 'proposed', proposals) })}>Reopen</button>}
                          {p.status !== 'accepted' && <button className={act} onClick={() => onChange({ proposals: proposals.filter(x => x.id !== p.id) })}>Delete</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {summary.lines.length === 0 && (
                  <tr><td colSpan={8} className="px-5 py-10 text-zinc-500 leading-relaxed">
                    No alternatives yet. Pick a material on the left and add a cheaper or better-value option; the saving across the whole takeoff shows here.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <p className="px-5 py-2 border-t border-zinc-800 text-[11px] text-zinc-500">
          The same table is on the “Value engineering” sheet of the Excel export. Several pending alternatives for one material are either/or: only the best counts in “still on offer”.
        </p>
      </div>
    </div>
  );
}

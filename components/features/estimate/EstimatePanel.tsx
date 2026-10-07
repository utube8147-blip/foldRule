'use client';

// The estimate section of the summary page: the build-up from measured work to the
// tender sum (editable percentages and provisional sums), and the buying list.

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';
import { buildUp, type Markups, type BuildUpLine } from '@/lib/takeoff/estimate';
import type { OrderLine } from '@/lib/takeoff/materialRate';

interface Props {
  measured: number;
  markups: Markups | undefined;
  vatPercent: number | undefined;
  unpricedRows: number;
  order: OrderLine[];
  onChange: (m: Markups) => void;
  onOpenBank: () => void;
}

const EDIT: Partial<Record<BuildUpLine['key'], keyof Markups>> = {
  prelims: 'prelimsPercent', contingency: 'contingencyPercent', overheads: 'overheadPercent', profit: 'profitPercent',
};
const field = 'bg-zinc-950 border border-zinc-700 px-2 py-1 text-right text-xs text-zinc-100 outline-none focus:border-amber-accent';
const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

export function EstimatePanel({ measured, markups, vatPercent, unpricedRows, order, onChange, onOpenBank }: Props) {
  const m = markups ?? {};
  const lines = buildUp(measured, m, vatPercent);
  const set = (patch: Partial<Markups>) => onChange({ ...m, ...patch });
  const num = (v: string) => Math.max(0, parseFloat(v) || 0);
  const prov = m.provisional ?? [];
  const lump = (m.prelimsSum ?? 0) > 0;
  const orderTotal = order.reduce((s, o) => s + o.cost, 0);

  return (
    <div className="flex-1 overflow-auto p-6 bg-[#0d0d0d] font-mono" style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
      <div className="grid gap-6 xl:grid-cols-[minmax(420px,520px)_1fr] items-start">
        {/* ── Build-up ── */}
        <section aria-label="Estimate build-up" className="border border-zinc-800 bg-zinc-900/60">
          <header className="px-4 py-3 border-b border-zinc-800">
            <h2 className="text-xs font-bold uppercase tracking-widest text-amber-accent">From measured work to the tender sum</h2>
            <p className="mt-1 text-[11px] text-zinc-500 leading-relaxed">
              The takeoff prices what is drawn. These lines add what is not: running the site, risk, your head office and your profit.
            </p>
          </header>
          {unpricedRows > 0 && (
            <p className="px-4 py-2 border-b border-amber-accent/40 bg-amber-accent/10 text-[11px] text-amber-200">
              {unpricedRows} item{unpricedRows === 1 ? ' has' : 's have'} no rate yet, so the measured work is understated and every line below with it.
            </p>
          )}
          <table className="w-full text-xs">
            <tbody>
              {lines.map(l => {
                const key = EDIT[l.key];
                return (
                  <React.Fragment key={l.key}>
                    <tr className={cn('border-b border-zinc-800', l.total && 'bg-zinc-950', l.key === 'total' && 'border-t-2 border-t-amber-accent')}>
                      <td className="px-4 py-2.5">
                        <div className={cn(l.total ? 'font-bold text-zinc-100 uppercase tracking-wider text-[11px]' : 'text-zinc-200')}>{l.label}</div>
                        {l.note && <div className="text-[10px] text-zinc-600 mt-0.5">{l.note}</div>}
                      </td>
                      <td className="px-2 py-2.5 text-right whitespace-nowrap w-40">
                        {key ? (
                          l.key === 'prelims' && lump ? (
                            <button type="button" onClick={() => set({ prelimsSum: undefined })} className="text-[10px] text-zinc-500 underline underline-offset-2 hover:text-amber-accent">use a %</button>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <input type="number" min={0} max={100} step="0.5" inputMode="decimal" aria-label={`${l.label} percent`}
                                value={(m[key] as number | undefined) || ''} placeholder="0"
                                onChange={e => set({ [key]: num(e.target.value) || undefined } as Partial<Markups>)}
                                className={cn(field, 'w-16')} />
                              <span className="text-zinc-500">%</span>
                            </span>
                          )
                        ) : l.key === 'vat' ? <span className="text-zinc-500">{l.percent ?? 0}%</span> : null}
                      </td>
                      <td className={cn('px-4 py-2.5 text-right tabular-nums whitespace-nowrap', l.total ? 'font-bold text-amber-accent' : 'text-zinc-200', l.key === 'total' && 'text-sm')}>
                        {l.key === 'prelims' && lump ? (
                          <input type="number" min={0} step="1" inputMode="decimal" aria-label="Preliminaries as a sum"
                            value={m.prelimsSum || ''} onChange={e => set({ prelimsSum: num(e.target.value) || undefined })} className={cn(field, 'w-32')} />
                        ) : formatCurrency(l.amount)}
                      </td>
                    </tr>
                    {l.key === 'prelims' && !lump && (
                      <tr className="border-b border-zinc-800">
                        <td colSpan={3} className="px-4 py-1.5 text-right">
                          <button type="button" onClick={() => set({ prelimsSum: Math.round(l.amount) || 1 })} className="text-[10px] text-zinc-500 underline underline-offset-2 hover:text-amber-accent">
                            priced the preliminaries item by item? enter a sum instead
                          </button>
                        </td>
                      </tr>
                    )}
                    {l.key === 'provisional' && (
                      <tr className="border-b border-zinc-800">
                        <td colSpan={3} className="px-4 py-2 space-y-1.5">
                          {prov.map(p => (
                            <div key={p.id} className="flex items-center gap-2">
                              <input aria-label="Provisional sum name" value={p.name} placeholder="e.g. Signage allowance"
                                onChange={e => set({ provisional: prov.map(x => (x.id === p.id ? { ...x, name: e.target.value } : x)) })}
                                className={cn(field, 'flex-1 text-left')} />
                              <input type="number" min={0} step="1" inputMode="decimal" aria-label={`Amount for ${p.name || 'provisional sum'}`} value={p.amount || ''} placeholder="0"
                                onChange={e => set({ provisional: prov.map(x => (x.id === p.id ? { ...x, amount: num(e.target.value) } : x)) })}
                                className={cn(field, 'w-32')} />
                              <button type="button" aria-label={`Remove ${p.name || 'provisional sum'}`} onClick={() => set({ provisional: prov.filter(x => x.id !== p.id) })} className="text-zinc-600 hover:text-red-400">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                          <button type="button" onClick={() => set({ provisional: [...prov, { id: crypto.randomUUID(), name: '', amount: 0 }] })}
                            className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-amber-accent">
                            <Plus className="w-3 h-3" /> Add a provisional sum
                          </button>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          <p className="px-4 py-3 text-[10px] text-zinc-600 leading-relaxed">
            Contingency is taken on the works cost, overheads on works + contingency, and profit on everything above it. The same table is the “Estimate summary” sheet of the Excel export.
          </p>
        </section>

        {/* ── Buying list ── */}
        <section aria-label="Materials to order" className="border border-zinc-800 bg-zinc-900/60 min-w-0">
          <header className="px-4 py-3 border-b border-zinc-800 flex items-start gap-4">
            <div className="flex-1">
              <h2 className="text-xs font-bold uppercase tracking-widest text-amber-accent">Materials to order</h2>
              <p className="mt-1 text-[11px] text-zinc-500 leading-relaxed">
                Net quantity from the takeoff, plus waste, in the unit each material is bought in. Whole packs are rounded up. Set waste and pack size on the material in the bank.
              </p>
            </div>
            <button type="button" onClick={onOpenBank} className="shrink-0 px-3 py-1.5 border border-zinc-700 text-[11px] font-bold uppercase tracking-widest text-zinc-300 hover:border-amber-accent hover:text-amber-accent">Material bank</button>
          </header>
          {order.length === 0 ? (
            <p className="p-6 text-xs text-zinc-500">Nothing to order yet: choose a material for the groups in the takeoff first.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[640px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-800">
                    <th className="px-4 py-2 text-left">Material</th>
                    <th className="px-2 py-2 text-right">Net</th>
                    <th className="px-2 py-2 text-right">Waste</th>
                    <th className="px-2 py-2 text-right text-amber-accent">Order</th>
                    <th className="px-2 py-2 text-right">Price each</th>
                    <th className="px-4 py-2 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {order.map(o => (
                    <tr key={o.materialId} className="border-b border-zinc-800/70">
                      <td className="px-4 py-2 text-zinc-200">
                        {o.name}
                        {o.covers !== 1 && <span className="block text-[10px] text-zinc-600">one {o.buyUnit} covers {qty(o.covers)} {o.unit}</span>}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-zinc-400 whitespace-nowrap">{qty(o.net)} {o.unit}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-zinc-500">{o.wastePercent ? `${o.wastePercent}%` : '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums font-bold text-amber-accent whitespace-nowrap">{qty(o.orderQty)} {o.buyUnit}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-zinc-400">{o.price ? formatCurrency(o.price) : <span className="italic text-zinc-600">no price</span>}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-zinc-200">{o.cost ? formatCurrency(o.cost) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-zinc-950">
                    <td colSpan={5} className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-zinc-300">Materials to buy <span className="normal-case tracking-normal font-normal text-zinc-600">(no labour or equipment)</span></td>
                    <td className="px-4 py-2.5 text-right font-bold text-amber-accent tabular-nums">{formatCurrency(orderTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

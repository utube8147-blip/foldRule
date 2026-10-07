'use client';
// What each accepted revision did to the quantities: before, after, difference and cost.

import React, { useMemo, useState } from 'react';
import { X, GitBranch } from 'lucide-react';
import type { Drawing, Material, TakeoffRow } from '@/types';
import { revisionChanges, versionNodes, newWorkSince, type RevisionRecord } from '@/lib/takeoff/revisions';
import { RevisionVersionView } from './RevisionVersionView';
import { formatCurrency } from '@/lib/utils';

interface Props {
  log: RevisionRecord[];
  measurements: TakeoffRow[];
  drawings: Drawing[];
  materials: Material[];
  onClose: () => void;
  onFocus: (id: string) => void;
  projectName: string;
  /** Make another version the live one; returns a message when it cannot be done. */
  onSwitch: (recordId: string, target: 'from' | 'to', keepNew: boolean) => string | null;
}

const q = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${q(Math.abs(n))}`;
const STATUS: Record<string, { label: string; cls: string }> = {
  changed: { label: 'Changed', cls: 'text-amber-300' },
  added:   { label: 'Added',   cls: 'text-blue-300' },
  removed: { label: 'Removed', cls: 'text-red-300' },
  same:    { label: 'Same',    cls: 'text-zinc-500' },
};

const DOT: Record<string, string> = { current: 'bg-green-500 border-green-500', superseded: 'bg-transparent border-zinc-500', 'set aside': 'bg-transparent border-amber-500 border-dashed' };

export function RevisionChangesDialog({ log, measurements, drawings, materials, onClose, onFocus, projectName, onSwitch }: Props) {
  const nodes = useMemo(() => versionNodes(log), [log]);
  // Newest first, like a commit list.
  const list = useMemo(() => [...nodes].reverse(), [nodes]);
  const [key, setKey] = useState(() => (list.find(n => n.status === 'current') ?? list[0])?.key ?? '');
  const [all, setAll] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const node = list.find(n => n.key === key) ?? list[0];
  const record = node?.record;
  // "What changed" belongs to the version a revision produced, while that version is live.
  const showChanges = !!node && node.status === 'current' && node.side === 'to';
  const changes = useMemo(() => (record && showChanges ? revisionChanges(record, measurements, drawings, materials) : null), [record, showChanges, measurements, drawings, materials]);
  if (!node || !record) return null;
  const lines = changes ? changes.lines.filter(l => all || l.status !== 'same') : [];
  const live = new Set(measurements.map(m => m.id));
  const restoreRecord = node.restore ? log.find(r => r.id === node.restore!.recordId) : undefined;
  const newWork = node.restore?.target === 'from' && restoreRecord ? newWorkSince(restoreRecord, measurements).filter(m => !m.isGroupHeader).length : 0;

  return (
    <div className="fixed inset-0 z-[160] flex bg-[#1D2125] font-mono">
      <div className="w-full h-full flex flex-col">
        <div className="bg-[#1a1a1a] border-b border-amber-accent px-5 py-3 flex items-center gap-3">
          <GitBranch className="w-4 h-4 text-amber-accent" />
          <h2 className="text-amber-accent text-sm uppercase tracking-widest font-black flex-1">Revision history</h2>
          <button onClick={onClose} className="flex items-center gap-2 border border-zinc-600 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-zinc-200 hover:border-amber-accent hover:text-amber-accent">
            <X className="w-4 h-4" />Back to takeoff
          </button>
        </div>
        <div className="flex-1 min-h-0 flex">
          {/* Versions, newest at the top */}
          <nav aria-label="Versions" className="w-72 shrink-0 border-r border-zinc-800 overflow-y-auto py-3">
            <div className="px-4 pb-2 text-[10px] uppercase tracking-widest text-zinc-500">Versions</div>
            {list.map((n, i) => (
              <button
                key={n.key} onClick={() => { setKey(n.key); setMessage(null); }} aria-current={n.key === node.key}
                className={`relative w-full text-left pl-10 pr-3 py-2.5 hover:bg-zinc-800 ${n.key === node.key ? 'bg-zinc-800' : ''}`}
              >
                {i < list.length - 1 && <span className="absolute left-[21px] top-6 bottom-[-10px] w-px bg-zinc-700" />}
                <span className={`absolute left-4 top-3.5 w-3 h-3 rounded-full border-2 ${DOT[n.status]}`} />
                <span className="flex items-center gap-2">
                  <span className="text-xs font-bold text-zinc-100">Version {n.version}</span>
                  <span className={`text-[9px] font-bold uppercase tracking-widest px-1 border ${n.status === 'current' ? 'border-green-700 text-green-400' : n.status === 'set aside' ? 'border-amber-600 text-amber-400' : 'border-zinc-600 text-zinc-500'}`}>{n.status}</span>
                </span>
                <span className="block text-[11px] text-zinc-400 truncate" title={n.name}>{n.name}</span>
                <span className="block text-[10px] text-zinc-600">
                  {n.date ? `accepted ${n.date.slice(0, 10)}` : 'first issue'}{n.rows ? ` · ${n.rows.filter(m => !m.isGroupHeader).length} items kept` : ''}
                </span>
              </button>
            ))}
            <p className="px-4 pt-4 text-[10px] text-zinc-600 leading-relaxed">
              Every version keeps its full takeoff. Only the current one is counted in totals and exports.
            </p>
          </nav>

          <div className="flex-1 min-w-0 flex flex-col">
            {message && <p role="alert" className="px-5 py-2 text-xs text-amber-300 border-b border-zinc-800">{message}</p>}
            {node.status !== 'current' && (
              node.rows
                ? <RevisionVersionView
                    key={node.key} node={node} drawings={drawings} projectName={projectName} newWork={newWork}
                    onRestore={node.restore ? keepNew => {
                      const err = onSwitch(node.restore!.recordId, node.restore!.target, keepNew);
                      if (err) setMessage(err); else onClose();
                    } : undefined}
                  />
                : <p className="p-5 text-xs text-zinc-400 max-w-xl leading-relaxed">
                    This revision was accepted before versions were kept, so only its quantities were saved and it cannot be restored. Revisions accepted from now on keep the full takeoff.
                  </p>
            )}
            {node.status === 'current' && !showChanges && (
              <p className="p-5 text-xs text-zinc-300 max-w-xl leading-relaxed">
                Version {node.version} ({node.name}) is the one you are working on. It is the first issue of this sheet, so there is no earlier version to compare it with.
                Pick another version on the left to see its takeoff or to go back to it.
              </p>
            )}
            {showChanges && changes && <>
              <div className="px-5 py-3 border-b border-zinc-800 flex flex-wrap items-center gap-4 text-xs text-zinc-300">
                <span className="font-bold text-zinc-100">Version {node.version - 1} → {node.version}: what changed</span>
                <span>{changes.counts.changed} changed · {changes.counts.added} added · {changes.counts.removed} removed · {changes.counts.same} the same</span>
                <label className="flex items-center gap-2 text-zinc-400">
                  <input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} />Show unchanged rows
                </label>
                <span className="ml-auto text-sm font-bold text-amber-accent">Net change {changes.cost < 0 ? '−' : changes.cost > 0 ? '+' : ''}{formatCurrency(Math.abs(changes.cost))}</span>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 bg-stone-900 text-[10px] uppercase tracking-widest text-zinc-500">
                    <tr>
                      <th className="text-left px-5 py-2">Item</th><th className="text-left px-3 py-2">Change</th>
                      <th className="text-right px-3 py-2">Before</th><th className="text-right px-3 py-2">After</th>
                      <th className="text-right px-3 py-2">Difference</th><th className="text-left px-3 py-2">Unit</th>
                      <th className="text-right px-3 py-2">Rate</th><th className="text-right px-5 py-2">Cost of change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map(l => (
                      <tr
                        key={l.id}
                        onClick={live.has(l.id) ? () => { onFocus(l.id); onClose(); } : undefined}
                        title={live.has(l.id) ? 'Show on the drawing' : undefined}
                        className={`border-b border-zinc-800 text-zinc-200 ${live.has(l.id) ? 'cursor-pointer hover:bg-zinc-800' : ''}`}
                      >
                        <td className="px-5 py-2">{l.description}{l.group && <span className="text-zinc-500"> · {l.group}</span>}</td>
                        <td className={`px-3 py-2 ${STATUS[l.status].cls}`}>{STATUS[l.status].label}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{q(l.before)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{q(l.after)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-bold">{signed(l.diff)}</td>
                        <td className="px-3 py-2 text-zinc-400">{l.unit}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{l.rate ? q(l.rate) : <span className="text-zinc-600">no rate</span>}</td>
                        <td className="px-5 py-2 text-right tabular-nums">{l.rate ? signed(l.cost) : '—'}</td>
                      </tr>
                    ))}
                    {lines.length === 0 && (
                      <tr><td colSpan={8} className="px-5 py-8 text-zinc-500">
                        No quantities have changed since this version was accepted. Adjust the measurements marked “check” and the differences appear here.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="px-5 py-2 border-t border-zinc-800 text-[11px] text-zinc-500">
                Quantities are as billed (timesing included). The same figures are on the “Revision changes” sheet of the Excel export.
              </p>
            </>}
          </div>
        </div>
      </div>
    </div>
  );
}

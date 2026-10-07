'use client';

// "Things to check": unlikely numbers found in the takeoff, and the activity log.

import React, { useState } from 'react';
import { ChevronDown, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SanityWarning } from '@/lib/takeoff/sanity';
import { AUDIT_LABEL, type AuditEntry } from '@/lib/takeoff/audit';

export function ChecksStrip({ warnings, onShow }: { warnings: SanityWarning[]; onShow: (rowId: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!warnings.length) return null;
  const serious = warnings.filter(w => w.level === 'likely-wrong').length;
  return (
    <div role="status" aria-label="Things to check" className={cn('border-b text-xs', serious ? 'border-red-500/40 bg-red-500/[0.07]' : 'border-zinc-700 bg-zinc-900/60')}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="w-full flex items-center gap-3 px-6 py-2 text-left">
        <ShieldAlert className={cn('w-4 h-4 shrink-0', serious ? 'text-red-400' : 'text-zinc-400')} />
        <span className="flex-1 min-w-0 truncate">
          <b className={serious ? 'text-red-300' : 'text-zinc-200'}>{warnings.length} thing{warnings.length === 1 ? '' : 's'} to check</b>
          <span className="text-zinc-500"> · {warnings[0].title}{warnings.length > 1 ? ` and ${warnings.length - 1} more` : ''}</span>
        </span>
        <ChevronDown className={cn('w-4 h-4 text-zinc-500 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="px-6 pb-3 space-y-2 max-h-56 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          {warnings.map(w => (
            <li key={w.id} className="flex items-start gap-3">
              <span className={cn('mt-1 w-2 h-2 shrink-0 rounded-full', w.level === 'likely-wrong' ? 'bg-red-400' : 'bg-amber-accent')} title={w.level === 'likely-wrong' ? 'Probably a mistake' : 'Worth a look'} />
              <span className="flex-1 min-w-0">
                <span className="block font-bold text-zinc-100">{w.title}</span>
                <span className="block text-zinc-400 leading-relaxed">{w.detail}</span>
              </span>
              {w.rowId && (
                <button type="button" onClick={() => onShow(w.rowId!)} className="shrink-0 px-2 py-1 border border-zinc-700 text-[10px] font-bold uppercase tracking-widest text-zinc-300 hover:border-amber-accent hover:text-amber-accent">Show</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export function ActivityList({ log, onShow }: { log: AuditEntry[]; onShow: (rowId: string) => void }) {
  if (!log.length) return <p className="text-zinc-500 text-xs leading-relaxed">Nothing yet. Changes to quantities, rates, materials, prices and estimate settings are listed here with who made them and when.</p>;
  return (
    <ol className="space-y-2">
      {[...log].reverse().slice(0, 300).map((e, i) => (
        <li key={`${e.at}-${i}`} className="p-2.5 border border-zinc-800 bg-zinc-900">
          <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-widest">
            <span className="font-bold text-amber-accent">{AUDIT_LABEL[e.what] ?? e.what}</span>
            <span className="text-zinc-600 normal-case tracking-normal">{when(e.at)}</span>
          </div>
          <button type="button" disabled={!e.targetId || e.what === 'removed' || e.what === 'price'} onClick={() => e.targetId && onShow(e.targetId)}
            className="mt-1 block w-full text-left text-xs text-zinc-200 truncate enabled:hover:text-amber-accent" title={e.target}>{e.target}</button>
          {(e.from !== undefined || e.to !== undefined) && (
            <div className="mt-0.5 text-[11px] text-zinc-400 break-words">
              {e.from !== undefined && <span className="line-through text-zinc-600">{e.from}</span>}
              {e.from !== undefined && e.to !== undefined && ' → '}
              {e.to !== undefined && <span className="text-zinc-200">{e.to}</span>}
            </div>
          )}
          <div className="mt-1 text-[10px] text-zinc-600">{e.by}</div>
        </li>
      ))}
    </ol>
  );
}

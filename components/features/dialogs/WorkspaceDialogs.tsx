'use client';

// Project analysis and keyboard-shortcut dialogs. Both are only mounted while
// open, and the analysis is computed once per open (useMemo), so they add no
// cost to the workspace while closed.

import React, { useEffect, useMemo } from 'react';
import { X, AlertTriangle, CheckCircle2, ArrowRight } from 'lucide-react';
import type { Drawing, Material, TakeoffRow } from '@/types';
import { getPageScale } from '@/lib/takeoff/scale';
import { formatCurrency } from '@/lib/utils';

function Shell({ title, onClose, children, wide = false }: {
  title: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 px-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} max-h-[85vh] flex flex-col bg-industrial-panel border border-industrial-border font-mono text-zinc-300`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-industrial-border shrink-0">
          <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-100">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto custom-scrollbar p-6 space-y-7 text-xs">{children}</div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[11px] font-bold uppercase tracking-widest text-zinc-500 mb-3">{title}</h3>
      {children}
    </section>
  );
}

const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

// ── Analysis ─────────────────────────────────────────────────────────────────

export function AnalysisDialog({ measurements, drawings, materials, onClose, onFocus, onGoToPage }: {
  measurements: TakeoffRow[];
  drawings: Drawing[];
  materials: Material[];
  onClose: () => void;
  onFocus: (id: string) => void;
  onGoToPage: (drawingId: string, page: number) => void;
}) {
  const a = useMemo(() => {
    const items   = measurements.filter(m => !m.isGroupHeader);
    const matRate = new Map(materials.map(m => [m.id, m.unitRate]));
    const rateOf  = (m: TakeoffRow) => (m.unitRate > 0 ? m.unitRate : (m.materialId && matRate.get(m.materialId)) || 0);

    const byType = new Map<string, { type: string; unit: string; qty: number; rows: number }>();
    for (const m of items) {
      const k = `${m.type}|${m.unit}`;
      const e = byType.get(k) ?? { type: m.type, unit: m.unit, qty: 0, rows: 0 };
      e.qty += Number.isFinite(m.quantity) ? m.quantity : 0;
      e.rows += 1;
      byType.set(k, e);
    }

    const headers = measurements.filter(m => m.isGroupHeader);
    const inGroup = new Set<string>();
    const groups = headers.map(h => {
      const kids = items.filter(m => m.parentId === h.id || h.childIds?.includes(m.id));
      kids.forEach(k => inGroup.add(k.id));
      return { id: h.id, name: h.groupName || h.description || 'Group', cost: kids.reduce((s, k) => s + k.quantity * rateOf(k), 0), rows: kids.length };
    });
    const loose = items.filter(m => !inGroup.has(m.id));
    if (loose.length) groups.push({ id: '', name: 'Not in a group', cost: loose.reduce((s, k) => s + k.quantity * rateOf(k), 0), rows: loose.length });
    groups.sort((x, y) => y.cost - x.cost);

    const unpriced = items.filter(m => rateOf(m) === 0);
    const manual   = items.filter(m => m.isOverridden).length;
    const hidden   = items.filter(m => m.isVisible === false).length;

    const pagesNoScale: { drawingId: string; name: string; page: number; rows: number }[] = [];
    for (const d of drawings) {
      for (let p = 1; p <= Math.max(1, d.pageCount || 1); p++) {
        if (getPageScale(d, p) === null) {
          pagesNoScale.push({
            drawingId: d.id, name: d.name, page: p,
            rows: items.filter(m => m.drawingId === d.id && (m.pageNumber ?? 1) === p && m.points?.length).length,
          });
        }
      }
    }
    const total = items.reduce((s, m) => s + m.quantity * rateOf(m), 0);
    return { items, byType: [...byType.values()], groups, unpriced, manual, hidden, pagesNoScale, total };
  }, [measurements, drawings, materials]);

  const issues = a.unpriced.length + a.pagesNoScale.filter(p => p.rows > 0).length;

  return (
    <Shell title="Project analysis" onClose={onClose} wide>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ['Total cost', formatCurrency(a.total)],
          ['Measurements', String(a.items.length)],
          ['Unpriced rows', String(a.unpriced.length)],
          ['Pages without scale', String(a.pagesNoScale.length)],
        ].map(([k, v]) => (
          <div key={k} className="border border-industrial-border bg-industrial-black/40 p-3">
            <p className="text-[10px] uppercase tracking-widest text-zinc-500">{k}</p>
            <p className="mt-1 text-base font-bold text-zinc-100 truncate">{v}</p>
          </div>
        ))}
      </div>

      <p className={`flex items-start gap-2 ${issues ? 'text-amber-300' : 'text-emerald-400'}`}>
        {issues ? <AlertTriangle className="w-4 h-4 shrink-0" /> : <CheckCircle2 className="w-4 h-4 shrink-0" />}
        {issues
          ? 'Some quantities or prices are incomplete — see the items below before sending this BOQ.'
          : 'Every row is priced and every measured page has a scale.'}
      </p>

      <Section title="Quantities by type">
        {a.byType.length === 0 ? <p className="text-zinc-500">Nothing measured yet.</p> : (
          <table className="w-full">
            <tbody>
              {a.byType.map(t => (
                <tr key={`${t.type}|${t.unit}`} className="border-t border-industrial-border/60">
                  <td className="py-2 text-zinc-300">{t.type}</td>
                  <td className="py-2 text-zinc-500">{t.rows} row{t.rows === 1 ? '' : 's'}</td>
                  <td className="py-2 text-right font-bold text-zinc-100">{fmt(t.qty, t.type === 'Count' ? 0 : 2)} {t.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Cost by group">
        {a.groups.length === 0 ? <p className="text-zinc-500">No groups yet.</p> : (
          <table className="w-full">
            <tbody>
              {a.groups.map(g => (
                <tr key={g.id || 'loose'} className="border-t border-industrial-border/60">
                  <td className="py-2 text-zinc-300">{g.name}</td>
                  <td className="py-2 text-zinc-500">{g.rows} row{g.rows === 1 ? '' : 's'}</td>
                  <td className="py-2 text-right font-bold text-amber-accent">{formatCurrency(g.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {a.unpriced.length > 0 && (
        <Section title={`Rows without a rate (${a.unpriced.length})`}>
          <ul className="divide-y divide-industrial-border/60 border-y border-industrial-border/60">
            {a.unpriced.slice(0, 40).map(m => (
              <li key={m.id}>
                <button type="button" onClick={() => { onFocus(m.id); onClose(); }}
                  className="w-full flex items-center justify-between gap-3 py-2 text-left hover:text-amber-accent">
                  <span className="truncate">{m.description || m.label || 'Untitled'}</span>
                  <span className="shrink-0 text-zinc-500 flex items-center gap-1">
                    {fmt(m.quantity, m.type === 'Count' ? 0 : 2)} {m.unit} <ArrowRight className="w-3 h-3" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {a.unpriced.length > 40 && <p className="mt-2 text-zinc-500">…and {a.unpriced.length - 40} more.</p>}
        </Section>
      )}

      {a.pagesNoScale.length > 0 && (
        <Section title="Pages without a scale">
          <ul className="divide-y divide-industrial-border/60 border-y border-industrial-border/60">
            {a.pagesNoScale.map(p => (
              <li key={`${p.drawingId}-${p.page}`}>
                <button type="button" onClick={() => { onGoToPage(p.drawingId, p.page); onClose(); }}
                  className="w-full flex items-center justify-between gap-3 py-2 text-left hover:text-amber-accent">
                  <span className="truncate">{p.name} · page {p.page}</span>
                  <span className={`shrink-0 flex items-center gap-1 ${p.rows ? 'text-amber-300' : 'text-zinc-500'}`}>
                    {p.rows ? `${p.rows} measured in drawing units` : 'nothing measured'} <ArrowRight className="w-3 h-3" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(a.manual > 0 || a.hidden > 0) && (
        <Section title="Also worth knowing">
          <ul className="space-y-1 text-zinc-400">
            {a.manual > 0 && <li>{a.manual} row{a.manual === 1 ? ' has' : 's have'} a manually typed quantity.</li>}
            {a.hidden > 0 && <li>{a.hidden} row{a.hidden === 1 ? ' is' : 's are'} hidden on the drawing (still included in totals).</li>}
          </ul>
        </Section>
      )}
    </Shell>
  );
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

const SHORTCUTS: [string, [string, string][]][] = [
  ['Tools', [
    ['V', 'Select / pan'], ['L', 'Linear'], ['P', 'Polygon'], ['R', 'Rectangle'], ['M', 'Magic fill'],
    ['B', 'Arc'], ['Y', 'Polyarc (A toggles line / arc)'], ['C', 'Circle'], ['N', 'Count'], ['T', 'Point'],
    ['G', 'Grid count'], ['O', 'Perimeter offset'], ['K', 'Set scale'],
  ]],
  ['Drawing', [
    ['Enter / double-click', 'Finish shape'], ['Esc', 'Cancel, then back to Select'],
    ['Ctrl Z', 'Undo'], ['Ctrl Y / Ctrl Shift Z', 'Redo'], ['S', 'Snap on / off'], ['F8', 'Angle lock (0° / 45° / 90°)'],
  ]],
  ['View', [
    ['Ctrl + / Ctrl −', 'Zoom in / out'], ['Ctrl 0', 'Fit to screen'],
    ['Drag (Select tool)', 'Pan'], ['Space + drag, middle mouse', 'Pan with any tool'],
    ['[', 'Open / close drawings & project details'], [']', 'Show / hide takeoff panel'], ['?', 'This list'],
  ]],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Shell title="Keyboard shortcuts" onClose={onClose}>
      {SHORTCUTS.map(([group, rows]) => (
        <Section key={group} title={group}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            {rows.map(([k, d]) => (
              <React.Fragment key={k}>
                <dt>
                  <kbd className="inline-block min-w-[24px] text-center border border-zinc-600 bg-industrial-black px-1.5 py-0.5 text-[11px] font-bold text-amber-accent">{k}</kbd>
                </dt>
                <dd className="text-zinc-400 self-center">{d}</dd>
              </React.Fragment>
            ))}
          </dl>
        </Section>
      ))}
    </Shell>
  );
}

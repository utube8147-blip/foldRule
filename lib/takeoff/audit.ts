// Who changed what, and when. A bill gets disputed; "the software says so" is not an answer.
// Entries are worked out by comparing the project before and after each change, so every
// way of editing is covered without each one having to remember to log.

import type { Material, TakeoffRow } from '@/types';
import type { Markups } from './estimate';
import { unitRateOf } from './materialRate';

export interface AuditEntry {
  at: string;
  /** Who was signed in. */
  by: string;
  /** What kind of thing changed. */
  what: 'quantity' | 'rate' | 'material' | 'name' | 'added' | 'removed' | 'price' | 'markup' | 'money' | 'multiplier';
  /** The row, material or setting. */
  target: string;
  targetId?: string;
  from?: string;
  to?: string;
}

interface Snapshot {
  measurements: TakeoffRow[];
  materials?: Material[];
  currency?: string;
  vatPercent?: number;
  markups?: Markups;
}

const MAX = 3000;
/** Edits to the same thing within this time are one entry (typing a name is not twelve changes). */
const MERGE_MS = 90_000;
const num = (n: number) => String(Math.round(n * 1000) / 1000);
const label = (r: TakeoffRow) => r.description || r.label || (r.isGroupHeader ? 'Group' : 'Unnamed');

/** Entries for the difference between two states of a project. */
export function diffAudit(prev: Snapshot, next: Snapshot, by: string, at = new Date().toISOString()): AuditEntry[] {
  const out: AuditEntry[] = [];
  const e = (what: AuditEntry['what'], target: string, targetId: string | undefined, from?: string, to?: string) => out.push({ at, by, what, target, targetId, from, to });
  if (prev.measurements !== next.measurements) {
    const before = new Map(prev.measurements.map(m => [m.id, m]));
    const mats = new Map((next.materials ?? []).map(m => [m.id, m]));
    const matName = (id?: string) => (id ? mats.get(id)?.name ?? 'a material' : 'none');
    for (const n of next.measurements) {
      const p = before.get(n.id);
      before.delete(n.id);
      if (!p) { e('added', label(n), n.id, undefined, n.isGroupHeader ? 'group' : `${num(n.quantity)} ${n.unit}`); continue; }
      if (p === n) continue;
      // Quantities that follow another row change on their own; the source row's entry explains them.
      if (!n.isGroupHeader && !n.derived && Math.abs(p.quantity - n.quantity) > 1e-6) e('quantity', label(n), n.id, `${num(p.quantity)} ${p.unit}`, `${num(n.quantity)} ${n.unit}`);
      if (!n.isGroupHeader && Math.abs((p.unitRate || 0) - (n.unitRate || 0)) > 1e-6) e('rate', label(n), n.id, num(p.unitRate || 0), num(n.unitRate || 0));
      if (!n.isGroupHeader && (p.materialId ?? '') !== (n.materialId ?? '')) e('material', label(n), n.id, matName(p.materialId), matName(n.materialId));
      if (label(p) !== label(n)) e('name', label(n), n.id, label(p), label(n));
      if ((p.times ?? 1) !== (n.times ?? 1)) e('multiplier', label(n), n.id, `× ${p.times ?? 1}`, `× ${n.times ?? 1}`);
    }
    for (const gone of before.values()) e('removed', label(gone), gone.id, gone.isGroupHeader ? 'group' : `${num(gone.quantity)} ${gone.unit}`);
  }
  if (prev.materials && next.materials && prev.materials !== next.materials) {
    const before = new Map(prev.materials.map(m => [m.id, m]));
    for (const n of next.materials) {
      const p = before.get(n.id);
      if (!p || p === n) continue;
      const a = unitRateOf(p), b = unitRateOf(n);
      if (Math.abs(a - b) > 1e-6) e('price', n.name, n.id, num(a), num(b));
    }
  }
  if ((prev.currency ?? '') !== (next.currency ?? '')) e('money', 'Currency', undefined, prev.currency ?? 'not set', next.currency ?? 'not set');
  if (prev.vatPercent !== next.vatPercent) e('money', 'VAT', undefined, prev.vatPercent === undefined ? 'not set' : `${prev.vatPercent}%`, next.vatPercent === undefined ? 'not set' : `${next.vatPercent}%`);
  if (prev.markups !== next.markups) {
    const a = prev.markups ?? {}, b = next.markups ?? {};
    const pairs: [string, number | undefined, number | undefined, string][] = [
      ['Preliminaries', a.prelimsPercent, b.prelimsPercent, '%'], ['Preliminaries (sum)', a.prelimsSum, b.prelimsSum, ''],
      ['Contingency', a.contingencyPercent, b.contingencyPercent, '%'], ['Overheads', a.overheadPercent, b.overheadPercent, '%'], ['Profit', a.profitPercent, b.profitPercent, '%'],
    ];
    for (const [t, x, y, u] of pairs) if ((x ?? 0) !== (y ?? 0)) e('markup', t, undefined, `${num(x ?? 0)}${u}`, `${num(y ?? 0)}${u}`);
    const ps = (m: Markups) => (m.provisional ?? []).map(p => `${p.name}: ${num(p.amount)}`).join('; ') || 'none';
    if (ps(a) !== ps(b)) e('markup', 'Provisional sums', undefined, ps(a), ps(b));
  }
  return out;
}

/** Add entries to a log: repeated edits of one thing in a short time become a single from → to. */
export function appendAudit(log: AuditEntry[] | undefined, entries: AuditEntry[]): AuditEntry[] | undefined {
  if (!entries.length) return log;
  const out = [...(log ?? [])];
  for (const n of entries) {
    const i = out.length - 1 - [...out].reverse().findIndex(o => o.what === n.what && o.targetId === n.targetId && o.target === (n.what === 'name' ? o.target : n.target) && o.by === n.by);
    const last = i >= 0 && i < out.length ? out[i] : undefined;
    const mergeable = last && n.what !== 'added' && n.what !== 'removed' && (n.targetId ? last.targetId === n.targetId : last.target === n.target) && last.what === n.what
      && out.length - 1 - i < 12 && Date.parse(n.at) - Date.parse(last.at) < MERGE_MS;
    if (mergeable) {
      if (last!.from === n.to) out.splice(i, 1);                     // changed and changed back: nothing happened
      else out[i] = { ...last!, at: n.at, to: n.to, target: n.target };
    } else out.push(n);
  }
  return out.length > MAX ? out.slice(out.length - MAX) : out;
}

export const AUDIT_LABEL: Record<AuditEntry['what'], string> = {
  quantity: 'Quantity', rate: 'Rate', material: 'Material', name: 'Renamed', added: 'Added', removed: 'Removed',
  price: 'Material price', markup: 'Markup', money: 'Setting', multiplier: 'Multiplier',
};

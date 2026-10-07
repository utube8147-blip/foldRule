// Timesing: "measure one typical floor, × 12". A multiplier can sit on a page of a
// drawing, on a group, or on a single row. Stored quantities stay as measured; the
// multiplier is applied to what is billed (totals, costs, exports).

import type { Drawing, TakeoffRow } from '@/types';

export const cleanTimes = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 1;

type PageTimesSource = Pick<Drawing, 'id' | 'pageTimes'>;

export const pageTimesOf = (drawings: PageTimesSource[], drawingId: string, page: number): number =>
  cleanTimes(drawings.find(d => d.id === drawingId)?.pageTimes?.[page]);

export interface Timesing {
  /** Multiplier of the page the row was measured on. */
  page: number;
  /** Multiplier of the group the row is in. */
  group: number;
  /** The row's own multiplier. */
  own: number;
  /** Everything multiplied together: billed quantity = quantity × total. */
  total: number;
}

/** Returns a lookup giving the multipliers that apply to any row. */
export function timesIndex(measurements: TakeoffRow[], drawings: PageTimesSource[]) {
  const byId = new Map(measurements.map(m => [m.id, m]));
  const headerByGroup = new Map<string, TakeoffRow>();
  for (const m of measurements) if (m.isGroupHeader && m.groupId) headerByGroup.set(m.groupId, m);
  const headerOf = (m: TakeoffRow) =>
    (m.parentId && byId.get(m.parentId)) || (m.groupId && !m.isGroupHeader && headerByGroup.get(m.groupId)) || undefined;

  const of = (m: TakeoffRow, depth = 0): Timesing => {
    const own = cleanTimes(m.times);
    // A row worked out from another shape is billed as many times as that shape.
    const src = m.derived && depth < 8 ? byId.get(m.derived.sourceId) : undefined;
    if (src) {
      const s = of(src, depth + 1);
      return { page: s.page, group: s.group * s.own, own, total: s.total * own };
    }
    // Only rows drawn on a page take the page's multiplier (typed-in rows do not).
    const page = m.points?.length ? pageTimesOf(drawings, m.drawingId, m.pageNumber ?? 1) : 1;
    const h = headerOf(m);
    const group = h && h.id !== m.id ? cleanTimes(h.times) : 1;
    return { page, group, own, total: page * group * own };
  };
  return (m: TakeoffRow) => of(m);
}

const round4 = (n: number) => parseFloat(n.toFixed(4));

/** Billed quantity of every row, by id. A group's is the sum of its rows. */
export function billedQuantities(measurements: TakeoffRow[], drawings: PageTimesSource[]): Map<string, number> {
  const times = timesIndex(measurements, drawings);
  const out = new Map<string, number>();
  for (const m of measurements) if (!m.isGroupHeader) out.set(m.id, round4((m.quantity || 0) * times(m).total));
  for (const m of measurements) {
    if (!m.isGroupHeader) continue;
    out.set(m.id, m.childIds?.length
      ? round4(m.childIds.reduce((t, id) => t + (out.get(id) ?? 0), 0))
      : round4((m.quantity || 0) * cleanTimes(m.times)));
  }
  return out;
}

export const timesLabel = (n: number) => `× ${parseFloat(n.toFixed(3))}`;

/** Rows as they should be billed and exported: quantities multiplied, with a note saying so. */
export function billedRows(measurements: TakeoffRow[], drawings: PageTimesSource[]): TakeoffRow[] {
  const times = timesIndex(measurements, drawings);
  const billed = billedQuantities(measurements, drawings);
  if (!measurements.some(m => !m.isGroupHeader && times(m).total !== 1)) return measurements;
  return measurements.map(m => {
    const q = billed.get(m.id) ?? m.quantity;
    if (m.isGroupHeader) return q === m.quantity ? m : { ...m, quantity: q };
    const t = times(m);
    if (t.total === 1) return m;
    const note = `${parseFloat((m.quantity || 0).toFixed(4))} ${m.unit} ${timesLabel(t.total)}`;
    return { ...m, quantity: q, notes: [note, m.notes].filter(Boolean).join(' — ') };
  });
}

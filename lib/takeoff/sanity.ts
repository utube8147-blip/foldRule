// Checks a careful surveyor runs by eye: numbers that are possible but unlikely.
// Nothing is blocked; each warning says what looks odd and what usually causes it.

import type { Drawing, Material, TakeoffRow } from '@/types';
import { unitRateOf } from './materialRate';

export interface SanityWarning {
  id: string;
  level: 'check' | 'likely-wrong';
  title: string;
  detail: string;
  /** Row to show, when the warning is about one. */
  rowId?: string;
  kind: 'scale' | 'size' | 'rate' | 'unit' | 'duplicate';
}

const norm = (u: string) => {
  const s = (u || '').trim().toLowerCase();
  if (['sq m', 'm²', 'm2', 'sqm'].includes(s)) return 'm2';
  if (['cu m', 'm³', 'm3', 'cum'].includes(s)) return 'm3';
  if (['ea', 'each', 'nr', 'no', 'no.', 'pcs', 'pc'].includes(s)) return 'nr';
  if (['m', 'lm', 'lin m', 'rm'].includes(s)) return 'm';
  return s;
};
const name = (r: TakeoffRow) => r.description || r.label || 'Unnamed';
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

export interface SanityInput {
  measurements: TakeoffRow[];
  materials: Material[];
  /** Master-bank prices, to notice a rate far from your usual. */
  usual?: Material[];
  /** Scale of each calibrated page: metres of building per PDF point of paper. */
  pages?: { drawing: Pick<Drawing, 'id' | 'name'>; page: number; metresPerPoint: number }[];
}

export function sanityWarnings({ measurements, materials, usual = [], pages = [] }: SanityInput): SanityWarning[] {
  const out: SanityWarning[] = [];
  const mats = new Map(materials.map(m => [m.id, m]));
  const usualById = new Map(usual.map(m => [m.id, m]));

  // Paper comes in known sizes (A4 is 842 points long, A0 3370). A scale that makes even an A4
  // sheet show hundreds of metres, or an A0 sheet show less than a room, is nearly always wrong.
  for (const p of pages) {
    const a4 = p.metresPerPoint * 842, a0 = p.metresPerPoint * 3370;
    if (a4 > 300 || a0 < 3) {
      out.push({
        id: `scale:${p.drawing.id}:${p.page}`, level: 'likely-wrong', kind: 'scale',
        title: `Scale of ${p.drawing.name}, page ${p.page}, looks wrong`,
        detail: a4 > 300
          ? `At this scale even a small A4 sheet would show ${fmt(a4)} m of building (about 1:${fmt(Math.round(p.metresPerPoint / 0.0003528))}). Floor plans are usually 1:50 to 1:200. Re-calibrate from a printed dimension: every quantity on the page depends on it.`
          : `At this scale the largest sheet (A0) would show only ${fmt(a0)} m. Re-calibrate from a printed dimension: every quantity on the page depends on it.`,
      });
    }
  }

  const items = measurements.filter(m => !m.isGroupHeader);
  const seen = new Map<string, TakeoffRow>();
  for (const r of items) {
    const u = norm(r.unit), q = r.quantity;
    if (q > 0) {
      const big = u === 'm2' ? 20000 : u === 'm' ? 2000 : u === 'm3' ? 5000 : u === 'nr' ? 5000 : Infinity;
      const tiny = u === 'm2' ? 0.05 : u === 'm' ? 0.05 : u === 'm3' ? 0.005 : 0;
      if (q > big) out.push({ id: `size:${r.id}`, level: 'check', kind: 'size', rowId: r.id, title: `${name(r)} is very large`, detail: `${fmt(q)} ${r.unit} in one measurement. If the scale is right this may be real; otherwise check the scale of its page.` });
      else if (q < tiny) out.push({ id: `size:${r.id}`, level: 'check', kind: 'size', rowId: r.id, title: `${name(r)} is very small`, detail: `${q.toFixed(3)} ${r.unit}. It may be a stray click, or the page scale may be wrong.` });
    } else if (q === 0 && !r.derived && (r.points?.length ?? 0) > 0) {
      out.push({ id: `size:${r.id}`, level: 'check', kind: 'size', rowId: r.id, title: `${name(r)} measures nothing`, detail: 'It has a shape on the drawing but a quantity of zero.' });
    }

    const mat = r.materialId ? mats.get(r.materialId) : undefined;
    if (mat) {
      // Tiles are per m²; a length priced per m² is a mistake that multiplies quietly.
      if (norm(mat.unit) !== u && u && norm(mat.unit)) {
        out.push({ id: `unit:${r.id}`, level: 'likely-wrong', kind: 'unit', rowId: r.id, title: `${name(r)} and its material use different units`, detail: `It is measured in ${r.unit} but “${mat.name}” is priced per ${mat.unit}, so quantity × rate does not mean anything. Choose another material or measure it the other way.` });
      }
      const u0 = unitRateOf(usualById.get(mat.id));
      if (r.unitRate > 0 && u0 > 0 && (r.unitRate > u0 * 5 || r.unitRate < u0 / 5)) {
        out.push({ id: `rate:${r.id}`, level: 'check', kind: 'rate', rowId: r.id, title: `Rate of ${name(r)} is far from your usual`, detail: `${fmt(r.unitRate)} per ${r.unit} here; your master bank has ${fmt(u0)} for “${mat.name}”. A slipped decimal point is the usual cause.` });
      }
    }

    // The same shape measured twice bills the same work twice.
    if ((r.points?.length ?? 0) >= 2 && !r.derived) {
      const key = `${r.drawingId}:${r.pageNumber ?? 1}:${r.type}:${r.points.map(p => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(';')}`;
      const first = seen.get(key);
      if (first) out.push({ id: `dup:${r.id}`, level: 'likely-wrong', kind: 'duplicate', rowId: r.id, title: `${name(r)} is measured twice`, detail: `It has exactly the same shape as “${name(first)}”. Unless that is intended (two layers), one of them double-counts.` });
      else seen.set(key, r);
    }
  }
  const order = { 'likely-wrong': 0, check: 1 } as const;
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

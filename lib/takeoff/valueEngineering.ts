import { unitRateOf } from '@/lib/takeoff/materialRate';
// Value engineering: propose a cheaper (or better-value) material in place of the
// designed one, see what it saves across every row that uses it, and accept or reject it.
// Quantities do not change; the material and its rate do. The designed material is always
// kept, so an accepted alternative can be taken back.

import type { Drawing, Material, TakeoffRow } from '@/types';
import { billedQuantities } from './timesing';

export interface VeProposal {
  id: string;
  /** Material as designed. */
  fromMaterialId: string;
  /** Proposed material (always one from the project's material bank). */
  toMaterialId: string;
  note?: string;
  status: 'proposed' | 'accepted' | 'rejected';
  /** When accepted: what each row had before, so the designed material can be put back. */
  applied?: Record<string, { materialId?: string; unitRate: number }>;
  createdAt: string;
  decidedAt?: string;
}

type DrawingLite = Pick<Drawing, 'id' | 'pageTimes'>;
const round2 = (n: number) => Math.round(n * 100) / 100;
const matRate = (m?: Material) => unitRateOf(m);
export const materialRate = matRate;

export interface MaterialUse {
  materialId: string;
  name: string;
  unit: string;
  /** Billed quantity of every row using it (rows of other units are counted in `rows` only). */
  quantity: number;
  rows: number;
  cost: number;
  rate: number;
}

/** Materials in use on the takeoff, with billed quantity and cost: the things an alternative can be proposed for. */
export function materialsInUse(measurements: TakeoffRow[], drawings: DrawingLite[], materials: Material[]): MaterialUse[] {
  const billed = billedQuantities(measurements, drawings);
  const mats = new Map(materials.map(m => [m.id, m]));
  const out = new Map<string, MaterialUse>();
  for (const m of measurements) {
    if (m.isGroupHeader || !m.materialId) continue;
    const mat = mats.get(m.materialId);
    if (!mat) continue;
    const u = out.get(m.materialId) ?? { materialId: m.materialId, name: mat.name, unit: m.unit, quantity: 0, rows: 0, cost: 0, rate: 0 };
    const q = billed.get(m.id) ?? m.quantity;
    const rate = m.unitRate || matRate(mat);
    if (m.unit === u.unit) u.quantity += q;
    u.rows += 1;
    u.cost += q * rate;
    out.set(m.materialId, u);
  }
  return [...out.values()].map(u => ({ ...u, quantity: round2(u.quantity), cost: round2(u.cost), rate: u.quantity ? round2(u.cost / u.quantity) : 0 }))
    .sort((a, b) => b.cost - a.cost);
}

export interface VeLine {
  proposal: VeProposal;
  designed: string;
  alternative: string;
  unit: string;
  quantity: number;
  rows: number;
  designedRate: number;
  alternativeRate: number;
  designedCost: number;
  alternativeCost: number;
  /** Positive = cheaper than designed. */
  saving: number;
  savingPercent: number;
}

export interface VeSummary {
  lines: VeLine[];
  /** Saving already in the takeoff (accepted alternatives). */
  accepted: number;
  /** Further saving on the table (best pending alternative per material). */
  pending: number;
  /** Cost of the affected items as designed. */
  designedCost: number;
}

/** Every proposal priced against the takeoff as it stands. */
export function veSummary(proposals: VeProposal[], measurements: TakeoffRow[], drawings: DrawingLite[], materials: Material[]): VeSummary {
  const billed = billedQuantities(measurements, drawings);
  const mats = new Map(materials.map(m => [m.id, m]));
  const lines: VeLine[] = [];
  for (const p of proposals) {
    const from = mats.get(p.fromMaterialId), to = mats.get(p.toMaterialId);
    const altRate = matRate(to);
    // Accepted: the rows are the ones it was applied to (they now carry the alternative).
    const rows = p.status === 'accepted' && p.applied
      ? measurements.filter(m => !m.isGroupHeader && p.applied![m.id])
      : measurements.filter(m => !m.isGroupHeader && m.materialId === p.fromMaterialId);
    let quantity = 0, designedCost = 0, alternativeCost = 0;
    const unit = rows[0]?.unit ?? from?.unit ?? '';
    for (const m of rows) {
      const q = billed.get(m.id) ?? m.quantity;
      const was = p.status === 'accepted' ? p.applied?.[m.id] : undefined;
      const designedRate = was ? was.unitRate || matRate(mats.get(was.materialId ?? '')) : m.unitRate || matRate(from);
      if (m.unit === unit) quantity += q;
      designedCost += q * designedRate;
      alternativeCost += q * altRate;
    }
    const saving = designedCost - alternativeCost;
    lines.push({
      proposal: p, designed: from?.name ?? 'Removed material', alternative: to?.name ?? 'Removed material', unit,
      quantity: round2(quantity), rows: rows.length,
      designedRate: quantity ? round2(designedCost / quantity) : matRate(from), alternativeRate: altRate,
      designedCost: round2(designedCost), alternativeCost: round2(alternativeCost),
      saving: round2(saving), savingPercent: designedCost ? round2((saving / designedCost) * 100) : 0,
    });
  }
  const accepted = lines.filter(l => l.proposal.status === 'accepted').reduce((t, l) => t + l.saving, 0);
  // Several pending alternatives for one material are either/or: count the best.
  const best = new Map<string, number>();
  for (const l of lines) {
    if (l.proposal.status !== 'proposed') continue;
    best.set(l.proposal.fromMaterialId, Math.max(best.get(l.proposal.fromMaterialId) ?? -Infinity, l.saving));
  }
  const designedCost = [...new Map(lines.map(l => [l.proposal.status === 'accepted' ? l.proposal.id : l.proposal.fromMaterialId, l.designedCost])).values()].reduce((t, c) => t + c, 0);
  return { lines, accepted: round2(accepted), pending: round2([...best.values()].reduce((t, s) => t + Math.max(0, s), 0)), designedCost: round2(designedCost) };
}

export interface VeChange { measurements: TakeoffRow[]; proposals: VeProposal[] }

/** Accept an alternative: every row on the designed material takes the alternative and its rate. */
export function acceptProposal(id: string, proposals: VeProposal[], measurements: TakeoffRow[], materials: Material[], now = new Date().toISOString()): VeChange {
  const p = proposals.find(x => x.id === id);
  if (!p || p.status === 'accepted') return { measurements, proposals };
  const to = materials.find(m => m.id === p.toMaterialId);
  if (!to) return { measurements, proposals };
  const applied: NonNullable<VeProposal['applied']> = {};
  const next = measurements.map(m => {
    if (m.isGroupHeader || m.materialId !== p.fromMaterialId) return m;
    applied[m.id] = { materialId: m.materialId, unitRate: m.unitRate };
    return { ...m, materialId: to.id, unitRate: matRate(to) };
  });
  return {
    measurements: next,
    proposals: proposals.map(x =>
      x.id === id ? { ...x, status: 'accepted' as const, applied, decidedAt: now }
      // The other options for the same material were not chosen.
      : x.fromMaterialId === p.fromMaterialId && x.status === 'proposed' ? { ...x, status: 'rejected' as const, decidedAt: now } : x),
  };
}

/** Take an accepted alternative back: the rows return to the designed material and rate. */
export function restoreDesigned(id: string, proposals: VeProposal[], measurements: TakeoffRow[]): VeChange {
  const p = proposals.find(x => x.id === id);
  if (!p || p.status !== 'accepted' || !p.applied) return { measurements, proposals };
  const was = p.applied;
  return {
    // Only rows still on the alternative are put back; anything re-assigned since is left alone.
    measurements: measurements.map(m => (was[m.id] && m.materialId === p.toMaterialId ? { ...m, materialId: was[m.id].materialId, unitRate: was[m.id].unitRate } : m)),
    proposals: proposals.map(x => (x.id === id ? { ...x, status: 'proposed' as const, applied: undefined, decidedAt: undefined } : x)),
  };
}

export const setProposalStatus = (id: string, status: 'proposed' | 'rejected', proposals: VeProposal[], now = new Date().toISOString()): VeProposal[] =>
  proposals.map(x => (x.id === id && x.status !== 'accepted' ? { ...x, status, decidedAt: status === 'rejected' ? now : undefined } : x));

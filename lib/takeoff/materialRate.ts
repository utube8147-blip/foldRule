// What one takeoff unit of a material costs. The single place this is worked out.
//
//   rate = (price per buying unit ÷ how much one buying unit covers) × (1 + waste) + labour + equipment
//
// • Waste is material you buy but cannot bill: tile offcuts, broken blocks. It belongs in the
//   rate, because bill quantities stay net (as measured on the drawing).
// • Buying unit: tiles are measured in m² but sold by the box, blocks by the piece. When set,
//   `materialCost` is the price of ONE buying unit and `covers` says how many takeoff units it does.

import type { Material } from '@/types';

type RateParts = Pick<Material, 'materialCost' | 'laborCost' | 'equipmentCost' | 'unitRate' | 'wastePercent' | 'purchase'>;

export const wasteFactor = (m?: Pick<Material, 'wastePercent'> | null) => 1 + Math.max(0, m?.wastePercent ?? 0) / 100;
export const coverage = (m?: Pick<Material, 'purchase'> | null) => (m?.purchase && m.purchase.covers > 0 ? m.purchase.covers : 1);

/** Material part of the rate, per takeoff unit, with waste. */
export const materialPart = (m: RateParts) => ((m.materialCost ?? 0) / coverage(m)) * wasteFactor(m);

/** Full rate per takeoff unit. Falls back to a bare `unitRate` when there is no breakdown. */
export function unitRateOf(m?: RateParts | null): number {
  if (!m) return 0;
  const built = materialPart(m) + (m.laborCost ?? 0) + (m.equipmentCost ?? 0);
  return built > 0 ? Math.round(built * 10000) / 10000 : m.unitRate || 0;
}

export interface OrderLine {
  materialId: string; code: string; name: string;
  /** Net quantity as billed, in the takeoff unit. */
  net: number; unit: string;
  wastePercent: number;
  /** What to order, in the buying unit, rounded up to whole units when it is sold in pieces. */
  orderQty: number; buyUnit: string; covers: number;
  /** Price of one buying unit, and the purchase cost. */
  price: number; cost: number;
  supplier?: string;
}

/** What to buy for a net quantity: add waste, convert to the buying unit, round up whole packs. */
export function orderFor(m: Material, net: number): OrderLine {
  const gross = net * wasteFactor(m);
  const sold = !!m.purchase && m.purchase.covers > 0;
  const raw = gross / coverage(m);
  const orderQty = sold ? Math.ceil(raw - 1e-9) : Math.round(raw * 100) / 100;
  return {
    materialId: m.id, code: m.code, name: m.name, net: Math.round(net * 100) / 100, unit: m.unit,
    wastePercent: Math.max(0, m.wastePercent ?? 0), orderQty, buyUnit: sold ? m.purchase!.unit || 'unit' : m.unit, covers: coverage(m),
    price: m.materialCost ?? 0, cost: Math.round(orderQty * (m.materialCost ?? 0) * 100) / 100, supplier: m.supplier,
  };
}

/** The buying list for a takeoff: one line per material in use, dearest first. */
export function orderSchedule(rows: { materialId?: string; isGroupHeader?: boolean; quantity: number }[], materials: Material[]): OrderLine[] {
  const net = new Map<string, number>();
  for (const r of rows) if (r.materialId && !r.isGroupHeader) net.set(r.materialId, (net.get(r.materialId) ?? 0) + r.quantity);
  const byId = new Map(materials.map(m => [m.id, m]));
  return [...net].filter(([id]) => byId.has(id)).map(([id, q]) => orderFor(byId.get(id)!, q)).sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
}

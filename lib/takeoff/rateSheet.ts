// Price lists in and out of the material bank.
//
//  • Out: a "request for prices" sheet — the materials with their quantities and blank
//    price columns, to send to a supplier or fill in yourself.
//  • In: any price list (that sheet filled in, a supplier quote, a company rate sheet)
//    read back and matched to the bank by reference, then code, then name.

import type { Material } from '@/types';

export type Cell = string | number | null | undefined;

export interface RateLine {
  ref?: string;
  code?: string;
  name?: string;
  unit?: string;
  material?: number;
  labour?: number;
  equipment?: number;
  /** A single all-in rate, when the list has no breakdown. */
  rate?: number;
  supplier?: string;
}

export const RFQ_HEADERS = ['Ref', 'Code', 'Description', 'Unit', 'Quantity', 'Material rate', 'Labour rate', 'Equipment rate', 'Total rate', 'Supplier / remarks'] as const;

const norm = (s: Cell) => String(s ?? '').toLowerCase().replace(/[^a-z0-9²³]+/g, ' ').trim();

/** Which field a column heading means. Order matters: the specific ones are tried first. */
const HEADINGS: [keyof RateLine, RegExp][] = [
  ['ref', /^(ref|reference|id|foldrule ref)$/],
  ['code', /^(code|item code|item no|item|sku|part no|cost code)$/],
  ['name', /^(description|name|material|item description|material name|particulars)$/],
  ['unit', /^(unit|uom|units)$/],
  ['material', /^(material rate|material cost|material price|supply rate|supply|material)$/],
  ['labour', /^(labou?r rate|labou?r cost|labou?r|install rate|installation)$/],
  ['equipment', /^(equipment rate|equipment cost|equipment|plant rate|plant)$/],
  ['rate', /^(total rate|rate|unit rate|unit price|price|unit cost|cost|all in rate)( [a-z]{3})?$/],
  ['supplier', /^(supplier|supplier remarks|remarks|vendor|notes?)$/],
];

/** "1,250.50", "AED 35", 35 → number; blank or text → undefined. */
export function toNumber(v: Cell): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined;
  const s = String(v ?? '').replace(/[^0-9.,-]/g, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (!s) return undefined;
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Read a table (rows of cells) into price lines. The heading row is found in the first 20 rows. */
export function readRateTable(rows: Cell[][]): RateLine[] {
  let headAt = -1;
  let cols: Partial<Record<keyof RateLine, number>> = {};
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const found: Partial<Record<keyof RateLine, number>> = {};
    (rows[r] ?? []).forEach((cell, c) => {
      const h = norm(cell);
      if (!h) return;
      for (const [key, re] of HEADINGS) {
        if (found[key] !== undefined) continue;
        // "Material" alone is the description when no other description column exists.
        if (key === 'name' && h === 'material' && (rows[r] ?? []).some(x => /^(description|name|particulars)$/.test(norm(x)))) continue;
        if (key === 'material' && h === 'material' && found.name === c) continue;
        if (re.test(h)) { found[key] = c; break; }
      }
    });
    const priced = found.material !== undefined || found.rate !== undefined || found.labour !== undefined;
    const named = found.name !== undefined || found.code !== undefined || found.ref !== undefined;
    if (priced && named) { headAt = r; cols = found; break; }
  }
  if (headAt < 0) return [];

  const out: RateLine[] = [];
  const text = (row: Cell[], k: keyof RateLine) => (cols[k] === undefined ? undefined : String(row[cols[k]!] ?? '').trim() || undefined);
  const numb = (row: Cell[], k: keyof RateLine) => (cols[k] === undefined ? undefined : toNumber(row[cols[k]!]));
  for (const row of rows.slice(headAt + 1)) {
    if (!row) continue;
    const line: RateLine = {
      ref: text(row, 'ref'), code: text(row, 'code'), name: text(row, 'name'), unit: text(row, 'unit'),
      material: numb(row, 'material'), labour: numb(row, 'labour'), equipment: numb(row, 'equipment'), rate: numb(row, 'rate'),
      supplier: text(row, 'supplier'),
    };
    if (!line.ref && !line.code && !line.name) continue;
    out.push(line);
  }
  return out;
}

export interface LinePrices { materialCost: number; laborCost: number; equipmentCost: number; unitRate: number }

/** The prices a line carries, or null when it has none. A breakdown wins over a single rate. */
export function pricesOfLine(l: RateLine): LinePrices | null {
  const m = l.material ?? 0, lab = l.labour ?? 0, eq = l.equipment ?? 0;
  if (m + lab + eq > 0) return { materialCost: m, laborCost: lab, equipmentCost: eq, unitRate: m + lab + eq };
  if ((l.rate ?? 0) > 0) return { materialCost: l.rate!, laborCost: 0, equipmentCost: 0, unitRate: l.rate! };
  return null;
}

export interface RateMatch { material: Material; line: RateLine; prices: LinePrices; by: 'ref' | 'code' | 'name' }
export interface RateMatching {
  matched: RateMatch[];
  /** Priced lines that fit nothing in the bank. */
  unmatched: RateLine[];
  /** Lines left blank. */
  blank: number;
}

/** Match price lines to materials: by reference, then by code, then by name. Ambiguous codes and names are skipped. */
export function matchRates(lines: RateLine[], materials: Material[]): RateMatching {
  const byId = new Map(materials.map(m => [m.id, m]));
  const index = (key: (m: Material) => string) => {
    const map = new Map<string, Material | null>();
    for (const m of materials) { const k = key(m); if (k) map.set(k, map.has(k) ? null : m); }
    return map;
  };
  const byCode = index(m => norm(m.code)), byName = index(m => norm(m.name));
  const matched: RateMatch[] = [], unmatched: RateLine[] = [];
  const taken = new Set<string>();
  let blank = 0;
  for (const line of lines) {
    const prices = pricesOfLine(line);
    if (!prices) { blank++; continue; }
    let material: Material | null | undefined, by: RateMatch['by'] = 'ref';
    if (line.ref) material = byId.get(line.ref);
    if (!material && line.name) { material = byName.get(norm(line.name)); by = 'name'; }
    // A code alone is trusted only when the list gives no name to contradict it.
    if (!material && line.code && !line.name) { material = byCode.get(norm(line.code)); by = 'code'; }
    if (!material && line.code && line.name) {
      const c = byCode.get(norm(line.code));
      if (c && (norm(c.name).includes(norm(line.name)) || norm(line.name).includes(norm(c.name)))) { material = c; by = 'code'; }
    }
    if (material && !taken.has(material.id)) { taken.add(material.id); matched.push({ material, line, prices, by }); }
    else unmatched.push(line);
  }
  return { matched, unmatched, blank };
}

export interface RfqItem { id: string; code: string; name: string; unit: string; quantity?: number; materialCost?: number; laborCost?: number; equipmentCost?: number; supplier?: string }

/** The request sheet as rows of cells (heading row first). Prices already known are filled in. */
export function rfqTable(items: RfqItem[]): Cell[][] {
  const blankIfZero = (n?: number) => (n ? n : null);
  return [
    [...RFQ_HEADERS],
    ...items.map(i => {
      const total = (i.materialCost ?? 0) + (i.laborCost ?? 0) + (i.equipmentCost ?? 0);
      return [i.id, i.code, i.name, i.unit, i.quantity ? Math.round(i.quantity * 100) / 100 : null,
        blankIfZero(i.materialCost), blankIfZero(i.laborCost), blankIfZero(i.equipmentCost), blankIfZero(total), i.supplier ?? null] as Cell[];
    }),
  ];
}

/** Plain CSV text → rows of cells (quotes and commas inside quotes handled). */
export function parseCsv(text: string): Cell[][] {
  const rows: Cell[][] = []; let row: string[] = [], cur = '', q = false;
  const s = text.replace(/^﻿/, '');
  const sep = (s.split('\n')[0].match(/;/g)?.length ?? 0) > (s.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

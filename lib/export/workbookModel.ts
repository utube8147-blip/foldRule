// ─── lib/export/workbookModel.ts ─────────────────────────────────────────────
//
//  Everything the sheets need, worked out once from the takeoff rows:
//    • the rows in takeoff order with their item numbers (1, 1.1, 1.2, M1 …)
//    • one material column per material AND unit in use — a material measured
//      in m² and in m gets two columns, so lengths are never added to areas
//    • BOQ matrix sections (work sections) → components (groups) → rows
//    • rows with no material (still priced in the Cost_Breakdown)
//
//  Pure functions, no ExcelJS — easy to test.
// ─────────────────────────────────────────────────────────────────────────────

import type { Material, TakeoffRow } from '@/types';
import { billUnit, classify, POMI_SECTIONS, UNCLASSIFIED } from '@/lib/takeoff/pomi';

/** Single-line display name ("Wrapping\nVeneer\nWD002\n" → "Wrapping Veneer WD002"). */
export const cleanName = (s?: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

/** How a row was measured, in words an estimator uses. */
export function shapeLabel(type?: string): string {
  switch (type) {
    case 'Polygon': case 'Rectangle': case 'Area': return 'Area';
    case 'Length': return 'Length';
    case 'Count': case 'Point': return 'Count';
    case 'Volume': return 'Volume';
    default: return type || '';
  }
}

/** Orders rows as: [group header, ...its children], ..., then ungrouped rows. Each row appears once. */
export function orderRowsForExport(measurements: TakeoffRow[]): { row: TakeoffRow; level: 0 | 1 }[] {
  const byId    = new Map(measurements.map(m => [m.id, m]));
  const headers = measurements.filter(m => m.isGroupHeader);
  const used    = new Set<string>();
  const out: { row: TakeoffRow; level: 0 | 1 }[] = [];

  for (const h of headers) {
    out.push({ row: h, level: 0 });
    used.add(h.id);
    const childIds = new Set(h.childIds ?? []);
    const children = measurements.filter(m =>
      !m.isGroupHeader && (m.parentId === h.id || childIds.has(m.id)));
    for (const c of children) {
      if (used.has(c.id)) continue;
      out.push({ row: c, level: 1 });
      used.add(c.id);
    }
  }
  for (const m of measurements) {
    if (used.has(m.id) || m.isGroupHeader) continue;
    // Child of a header that still exists but was already placed elsewhere → skip; orphan → standalone.
    if (m.parentId && byId.has(m.parentId) && byId.get(m.parentId)!.isGroupHeader) continue;
    out.push({ row: m, level: 0 });
  }
  return out;
}

export interface ExportRow {
  row: TakeoffRow;
  level: 0 | 1;
  /** Item number as printed: "1", "1.2", "M3". */
  item: string;
  /** Header row this row sits under (level 1 only). */
  headerId?: string;
}

export interface MaterialColumn {
  key: string;
  material: Material;
  /** Unit of the rows in this column, as billed (m², m, nr …). */
  unit: string;
  /** Unit the material is priced / bought in. */
  materialUnit: string;
  /** The rows are measured in a different unit than the material is sold in. */
  unitMismatch: boolean;
  /** Clean single-line name. */
  name: string;
  /** Header text, with the unit when it is needed to tell columns apart. */
  label: string;
  /** Net quantity (sum of rows, already timesed). */
  net: number;
  /** Sum of quantity × rate of its rows. */
  amount: number;
  rowIds: string[];
  /** Some rows carry a rate that differs from the material's own. */
  rateOverridden: boolean;
}

export interface MatrixComponent {
  name: string;
  /** Drawing(s) the rows were measured on. */
  drawing: string;
  rows: TakeoffRow[];
}

export interface MatrixSection {
  code: string;
  title: string;
  components: MatrixComponent[];
}

export interface WorkbookModel {
  rows: ExportRow[];
  materials: Map<string, Material>;
  columns: MaterialColumn[];
  columnOf: (row: TakeoffRow) => MaterialColumn | undefined;
  sections: MatrixSection[];
  /** Measured rows with no material: priced on their own. */
  unassigned: TakeoffRow[];
  /** Rate of a row: its own, else its material's. */
  rateOf: (row: TakeoffRow) => number;
  drawingName: (id: string) => string;
}


export function buildWorkbookModel(input: {
  measurements: TakeoffRow[];
  materials: Material[];
  drawings: Array<{ id: string; name: string }>;
}): WorkbookModel {
  const materials = new Map(input.materials.map(m => [m.id, m]));
  const drawings = new Map(input.drawings.map(d => [d.id, d.name]));
  const drawingName = (id: string) => drawings.get(id) ?? '';
  // Same rule as the bill (lib/takeoff/pomi.ts), so every sheet adds up to the same total.
  const rateOf = (r: TakeoffRow) => r.unitRate || (r.materialId ? materials.get(r.materialId)?.unitRate ?? 0 : 0) || 0;

  // ── Rows with item numbers ───────────────────────────────────────────────
  const ordered = orderRowsForExport(input.measurements);
  const rows: ExportRow[] = [];
  let groupNo = 0, childNo = 0, looseNo = 0, header: TakeoffRow | undefined;
  for (const { row, level } of ordered) {
    if (row.isGroupHeader) { groupNo += 1; childNo = 0; header = row; rows.push({ row, level: 0, item: String(groupNo) }); continue; }
    if (level === 1) { childNo += 1; rows.push({ row, level, item: `${groupNo}.${childNo}`, headerId: header?.id }); }
    else { looseNo += 1; header = undefined; rows.push({ row, level, item: `M${looseNo}` }); }
  }
  const measured = rows.filter(r => !r.row.isGroupHeader);

  // ── Material columns: one per material + unit ────────────────────────────
  const columns: MaterialColumn[] = [];
  const byKey = new Map<string, MaterialColumn>();
  for (const { row } of measured) {
    const mat = row.materialId ? materials.get(row.materialId) : undefined;
    if (!mat) continue;
    const unit = billUnit(row.unit);
    const key = `${mat.id}|${unit}`;
    let c = byKey.get(key);
    if (!c) {
      const materialUnit = billUnit(mat.unit);
      c = {
        key, material: mat, unit, materialUnit, unitMismatch: !!materialUnit && materialUnit !== unit,
        name: cleanName(mat.name) || 'Material', label: '', net: 0, amount: 0, rowIds: [], rateOverridden: false,
      };
      byKey.set(key, c);
      columns.push(c);
    }
    const q = Number.isFinite(row.quantity) ? row.quantity : 0;
    c.net += q;
    c.amount += q * rateOf(row);
    c.rowIds.push(row.id);
    if (row.unitRate && Math.abs(row.unitRate - (mat.unitRate ?? 0)) > 1e-6) c.rateOverridden = true;
  }
  // Labels: add the unit when a name is shared (two "Solid Wood"s, or one material in m² and m).
  const nameCount = new Map<string, number>();
  for (const c of columns) nameCount.set(c.name.toLowerCase(), (nameCount.get(c.name.toLowerCase()) ?? 0) + 1);
  for (const c of columns) {
    const shared = (nameCount.get(c.name.toLowerCase()) ?? 0) > 1;
    c.label = shared || c.unitMismatch ? `${c.name} (${c.unit || '—'})` : c.name;
  }
  const columnOf = (row: TakeoffRow) => row.materialId ? byKey.get(`${row.materialId}|${billUnit(row.unit)}`) : undefined;

  // ── Matrix: work sections → groups → rows ────────────────────────────────
  const sectionOf = new Map<string, MatrixComponent[]>();
  const push = (code: string, comp: MatrixComponent) => sectionOf.set(code, [...(sectionOf.get(code) ?? []), comp]);
  const loose = new Map<string, TakeoffRow[]>();
  for (let i = 0; i < rows.length; i++) {
    const { row } = rows[i];
    if (row.isGroupHeader) {
      const kids = rows.filter(r => r.headerId === row.id).map(r => r.row);
      if (!kids.length) continue;
      const code = classify(row, materials) || kids.map(k => classify(k, materials)).find(Boolean) || '';
      const names = [...new Set(kids.map(k => drawingName(k.drawingId)).filter(Boolean))];
      push(code, { name: cleanName(row.groupName || row.description || row.label) || 'Group', drawing: names.join(', '), rows: kids });
    } else if (rows[i].level === 0) {
      const code = classify(row, materials);
      loose.set(code, [...(loose.get(code) ?? []), row]);
    }
  }
  for (const [code, list] of loose) push(code, { name: 'Other items', drawing: '', rows: list });
  const sections: MatrixSection[] = [...POMI_SECTIONS, UNCLASSIFIED]
    .filter(s => sectionOf.has(s.code))
    .map(s => ({ code: s.code, title: s.title, components: sectionOf.get(s.code)! }));

  const unassigned = measured.map(r => r.row).filter(r => !(r.materialId && materials.has(r.materialId)));

  return { rows, materials, columns, columnOf, sections, unassigned, rateOf, drawingName };
}

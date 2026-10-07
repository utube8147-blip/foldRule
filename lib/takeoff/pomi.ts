// Bill of quantities laid out to the work sections of the Principles of Measurement
// (International) for Works of Construction (POMI), the usual basis for building
// bills in the Gulf.

import type { Material, TakeoffRow } from '@/types';

export interface PomiSection { code: string; title: string }

export const POMI_SECTIONS: PomiSection[] = [
  { code: 'A', title: 'General requirements' },
  { code: 'B', title: 'Site work' },
  { code: 'C', title: 'Concrete work' },
  { code: 'D', title: 'Masonry' },
  { code: 'E', title: 'Metalwork' },
  { code: 'F', title: 'Woodwork' },
  { code: 'G', title: 'Thermal and moisture protection' },
  { code: 'H', title: 'Doors and windows' },
  { code: 'J', title: 'Finishes' },
  { code: 'K', title: 'Accessories' },
  { code: 'L', title: 'Equipment' },
  { code: 'M', title: 'Furnishings' },
  { code: 'N', title: 'Special construction' },
  { code: 'P', title: 'Conveying systems' },
  { code: 'Q', title: 'Mechanical engineering installations' },
  { code: 'R', title: 'Electrical engineering installations' },
];
export const UNCLASSIFIED: PomiSection = { code: '', title: 'Not yet classified' };

/** MasterFormat division of the material bank → POMI section. */
const DIVISION_TO_SECTION: Record<string, string> = {
  '00': 'A', '01': 'A', '02': 'B', '03': 'C', '04': 'D', '05': 'E', '06': 'F', '07': 'G', '08': 'H', '09': 'J',
  '10': 'K', '11': 'L', '12': 'M', '13': 'N', '14': 'P',
  '21': 'Q', '22': 'Q', '23': 'Q', '25': 'R', '26': 'R', '27': 'R', '28': 'R',
  '31': 'B', '32': 'B', '33': 'B',
};

/** Words in a description that place it in a section when no material says so. Order matters. */
const KEYWORDS: [RegExp, string][] = [
  [/\b(door|window|ironmongery|glazing|shutter|curtain wall)/i, 'H'],
  [/\b(waterproof|membrane|damp.?proof|dpm|dpc|insulation|roofing|sealant)/i, 'G'],
  [/\b(plaster|render|paint|til(e|es|ing)|screed|skirting|ceiling|gypsum|drywall|partition|floor finish|carpet|vinyl|marble|granite|cladding|power float)/i, 'J'],
  [/\b(block|blockwork|brick|masonry|stonework)/i, 'D'],
  [/\b(concrete|slab|blinding|reinforcement|rebar|mesh|formwork|footing|column|beam|precast)/i, 'C'],
  [/\b(excavat|earthwork|fill(ing)?|backfill|piling|paving|kerb|landscap|demoli|site clear)/i, 'B'],
  [/\b(steel|metal|handrail|balustrade|stud framing)/i, 'E'],
  [/\b(timber|wood|joinery|cabinet|carcass|wardrobe|counter)/i, 'F'],
  [/\b(duct|pipe|plumb|drain|sanitary|hvac|chiller|sprinkler|fire fighting|valve)/i, 'Q'],
  [/\b(cable|socket|light|lighting|switch|conduit|panel board|db\b|electrical|data point|cctv)/i, 'R'],
  [/\b(lift|elevator|escalator)/i, 'P'],
];

const divisionOf = (m?: Material) => (m ? m.division || (m.category || '').slice(0, 2) : '');

/** Section a row belongs to: chosen by hand, else from its material, else from its wording. */
export function classify(row: TakeoffRow, materials: Map<string, Material>): string {
  if (row.section && POMI_SECTIONS.some(s => s.code === row.section)) return row.section;
  const fromMaterial = DIVISION_TO_SECTION[divisionOf(row.materialId ? materials.get(row.materialId) : undefined)];
  if (fromMaterial) return fromMaterial;
  const text = `${row.groupName ?? ''} ${row.label ?? ''} ${row.description ?? ''}`;
  for (const [re, code] of KEYWORDS) if (re.test(text)) return code;
  return '';
}

/** Units as written in a bill. */
export function billUnit(unit: string): string {
  const u = (unit || '').trim().toLowerCase();
  if (['sq m', 'm²', 'm2', 'sqm'].includes(u)) return 'm²';
  if (['cu m', 'm³', 'm3', 'cum'].includes(u)) return 'm³';
  if (['ea', 'each', 'nr', 'no', 'no.', 'pcs', 'pc'].includes(u)) return 'nr';
  if (['t', 'tonne', 'tonnes', 'ton'].includes(u)) return 't';
  return unit || '';
}

/**
 * Billed quantities are whole units: half or more rounds up, less is dropped, and anything
 * that would vanish is given as one. Tonnes are given to two decimal places.
 */
export function roundBillQuantity(quantity: number, unit: string): number {
  if (!(quantity > 0)) return 0;
  if (billUnit(unit) === 't') return Math.max(0.01, Math.round(quantity * 100) / 100);
  return Math.max(1, Math.floor(quantity + 0.5));
}

export interface BillItem {
  ref: string;
  description: string;
  quantity: number;
  /** Quantity before rounding. */
  measured: number;
  unit: string;
  rate: number;
  /** Rows of the takeoff this line is made from. */
  rowIds: string[];
}
export interface BillSection extends PomiSection { items: BillItem[] }

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // bills skip I and O
export const itemRef = (i: number): string =>
  (i < LETTERS.length ? '' : itemRef(Math.floor(i / LETTERS.length) - 1)) + LETTERS[i % LETTERS.length];

export interface BuildBillOptions { round?: boolean }

/**
 * Turn takeoff rows (already timesed) into bill items by section. A group whose rows share
 * a unit is one item; other rows are an item each. Rows with no quantity are left out.
 */
export function buildBill(measurements: TakeoffRow[], materialList: Material[], { round = true }: BuildBillOptions = {}): BillSection[] {
  const materials = new Map(materialList.map(m => [m.id, m]));
  const rateOf = (r: TakeoffRow) => r.unitRate || (r.materialId ? materials.get(r.materialId)?.unitRate ?? 0 : 0);
  const byId = new Map(measurements.map(m => [m.id, m]));
  const headerByGroup = new Map<string, TakeoffRow>();
  for (const m of measurements) if (m.isGroupHeader) headerByGroup.set(m.groupId || m.id, m);
  const headerOf = (m: TakeoffRow) =>
    (m.parentId && byId.get(m.parentId)?.isGroupHeader && byId.get(m.parentId)) || (m.groupId && headerByGroup.get(m.groupId)) || undefined;

  // A shape that only exists to work other rows out from (a wall centre line under an
  // assembly) is not an item itself, unless it has been priced or placed in a section.
  const sources = new Set(measurements.map(m => m.derived?.sourceId).filter(Boolean) as string[]);
  const workingOnly = (m: TakeoffRow) => sources.has(m.id) && !rateOf(m) && !m.materialId && !m.section;

  const children = new Map<string, TakeoffRow[]>();
  const loose: TakeoffRow[] = [];
  for (const m of measurements) {
    if (m.isGroupHeader || workingOnly(m)) continue;
    const h = headerOf(m);
    if (h) children.set(h.id, [...(children.get(h.id) ?? []), m]); else loose.push(m);
  }

  type Raw = { section: string; description: string; measured: number; unit: string; amount: number; rowIds: string[] };
  const raw: Raw[] = [];
  const single = (m: TakeoffRow, section?: string) => raw.push({
    section: section || classify(m, materials), description: m.description || m.label || 'Untitled',
    measured: m.quantity || 0, unit: billUnit(m.unit), amount: (m.quantity || 0) * rateOf(m), rowIds: [m.id],
  });

  for (const m of measurements) {
    if (m.isGroupHeader) {
      const kids = children.get(m.id) ?? [];
      if (!kids.length) continue;
      const section = classify(m, materials) || kids.map(k => classify(k, materials)).find(Boolean) || '';
      const units = new Set(kids.map(k => billUnit(k.unit)));
      if (units.size === 1) {
        raw.push({
          section, description: m.groupName || m.description || m.label || 'Group',
          measured: kids.reduce((t, k) => t + (k.quantity || 0), 0), unit: [...units][0],
          amount: kids.reduce((t, k) => t + (k.quantity || 0) * rateOf(k), 0), rowIds: kids.map(k => k.id),
        });
      } else {
        for (const k of kids) single(k, m.section ? section : undefined);
      }
    } else if (loose.includes(m)) single(m);
  }

  const order = [...POMI_SECTIONS, UNCLASSIFIED];
  return order.map(s => {
    const items = raw.filter(r => r.section === s.code && r.measured > 0).map((r, i): BillItem => ({
      ref: itemRef(i), description: r.description, measured: parseFloat(r.measured.toFixed(4)),
      quantity: round ? roundBillQuantity(r.measured, r.unit) : parseFloat(r.measured.toFixed(2)),
      unit: r.unit, rate: parseFloat((r.amount / r.measured).toFixed(4)), rowIds: r.rowIds,
    }));
    return { ...s, items };
  }).filter(s => s.items.length > 0);
}

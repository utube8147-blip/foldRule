// Assemblies: one measured shape produces several BOQ lines (a wall length gives
// blockwork, plaster, paint and skirting). Each line is a `derived` row, so it follows
// the shape, and can carry deductions for counted openings (doors, windows).

import type { TakeoffRow } from '@/types';

export type OpeningKind = 'door' | 'window';

export interface Opening {
  id: string;
  name: string;
  kind: OpeningKind;
  /** Structural opening size in metres. */
  width: number;
  height: number;
}

const opening = (kind: OpeningKind, w: number, h: number, note = ''): Opening => ({
  id: `${kind}-${w}x${h}`,
  name: `${kind === 'door' ? 'Door' : 'Window'} ${w} × ${h}${note ? ` ${note}` : ''}`,
  kind, width: w / 1000, height: h / 1000,
});

/** Common structural opening sizes (mm). Anything else can be typed in. */
export const STANDARD_OPENINGS: Opening[] = [
  opening('door', 800, 2100),
  opening('door', 900, 2100),
  opening('door', 1000, 2100),
  opening('door', 1200, 2100),
  opening('door', 1500, 2100, '(double)'),
  opening('door', 1800, 2100, '(double)'),
  opening('door', 900, 2400),
  opening('window', 600, 600),
  opening('window', 900, 1200),
  opening('window', 1200, 1200),
  opening('window', 1500, 1200),
  opening('window', 1800, 1500),
  opening('window', 2400, 1500),
];

/**
 * POMI general principle: voids smaller than this are not deducted from items measured
 * by area. Editable per assembly, because other methods of measurement use other limits.
 */
export const DEFAULT_MIN_VOID_M2 = 1.0;

export interface AssemblyParam { key: string; label: string; unit: string; value: number }

export interface AssemblyLine {
  description: string;
  type: TakeoffRow['type'];
  unit: string;
  /** Quantity = source quantity × times × (value of `param`, when given). */
  times: number;
  param?: string;
  /**
   * How a counted opening reduces this line:
   *  - area:  opening width × height × times (subject to the minimum void)
   *  - width: opening width × times (doors only: skirting stops at a door, not a window)
   */
  deduct?: { by: 'area' | 'width'; times: number };
}

export interface Assembly {
  id: string;
  name: string;
  /** Kind of measured shape it starts from. */
  from: 'length' | 'area';
  params: AssemblyParam[];
  lines: AssemblyLine[];
}

const HEIGHT: AssemblyParam = { key: 'height', label: 'Wall height', unit: 'm', value: 3 };
const wallArea = (description: string, sides: number): AssemblyLine =>
  ({ description, type: 'Area', unit: 'sq m', times: sides, param: 'height', deduct: { by: 'area', times: sides } });
const skirting = (sides: number): AssemblyLine =>
  ({ description: 'Skirting', type: 'Length', unit: 'm', times: sides, deduct: { by: 'width', times: sides } });
const floorArea = (description: string): AssemblyLine => ({ description, type: 'Area', unit: 'sq m', times: 1 });

export const BUILT_IN_ASSEMBLIES: Assembly[] = [
  {
    id: 'block-internal', name: 'Internal block wall, plastered and painted both sides', from: 'length',
    params: [HEIGHT],
    lines: [wallArea('Blockwork', 1), wallArea('Plaster, both sides', 2), wallArea('Paint, both sides', 2), skirting(2)],
  },
  {
    id: 'block-external', name: 'External block wall, rendered outside, plastered and painted inside', from: 'length',
    params: [HEIGHT],
    lines: [
      wallArea('Blockwork', 1), wallArea('External render', 1), wallArea('External paint', 1),
      wallArea('Internal plaster', 1), wallArea('Internal paint', 1), skirting(1),
    ],
  },
  {
    id: 'drywall', name: 'Drywall partition, boarded and painted both sides', from: 'length',
    params: [HEIGHT],
    lines: [wallArea('Metal stud framing', 1), wallArea('Gypsum board, both sides', 2), wallArea('Paint, both sides', 2), skirting(2)],
  },
  {
    id: 'slab-on-grade', name: 'Ground slab on blinding', from: 'area',
    params: [
      { key: 'slab', label: 'Slab thickness', unit: 'm', value: 0.15 },
      { key: 'blinding', label: 'Blinding thickness', unit: 'm', value: 0.05 },
    ],
    lines: [
      { description: 'Concrete slab', type: 'Volume', unit: 'cu m', times: 1, param: 'slab' },
      { description: 'Blinding concrete', type: 'Volume', unit: 'cu m', times: 1, param: 'blinding' },
      floorArea('Polythene membrane'), floorArea('Mesh reinforcement'), floorArea('Power float finish'),
    ],
  },
  {
    id: 'floor-tiled', name: 'Tiled floor on screed', from: 'area',
    params: [],
    lines: [floorArea('Screed'), floorArea('Floor tiles')],
  },
  {
    id: 'wet-area', name: 'Wet area floor: waterproofing, screed and tiles', from: 'area',
    params: [],
    lines: [floorArea('Waterproofing membrane'), floorArea('Screed'), floorArea('Floor tiles')],
  },
  {
    id: 'ceiling', name: 'Suspended gypsum ceiling, painted', from: 'area',
    params: [],
    lines: [floorArea('Suspended gypsum board ceiling'), floorArea('Ceiling paint')],
  },
];

/** A counted row (doors, windows) taken as openings of one size. */
export interface OpeningDeduction { sourceId: string; opening: Opening }

const AREA_TYPES = new Set(['Area', 'Polygon', 'Rectangle']);
const round4 = (n: number) => parseFloat(n.toFixed(4));
const fmt = (n: number) => String(parseFloat(n.toFixed(3)));

export const assemblyFits = (a: Assembly, row: Pick<TakeoffRow, 'type'>) =>
  a.from === 'length' ? row.type === 'Length' : AREA_TYPES.has(row.type);

/** Quantity a row contributes: a group's total is the sum of its rows. */
export function effectiveQuantity(row: TakeoffRow, byId: Map<string, TakeoffRow>): number {
  if (row.isGroupHeader && row.childIds?.length) {
    return row.childIds.reduce((t, id) => t + (byId.get(id)?.quantity || 0), 0);
  }
  return row.quantity || 0;
}

/** Current quantity of a derived row, or null when its source is gone. */
export function derivedQuantity(row: TakeoffRow, byId: Map<string, TakeoffRow>): number | null {
  const d = row.derived;
  if (!d) return null;
  const src = byId.get(d.sourceId);
  if (!src) return null;
  let q = effectiveQuantity(src, byId) * d.factor;
  for (const l of d.less ?? []) {
    const c = byId.get(l.sourceId);
    if (c) q -= effectiveQuantity(c, byId) * l.each;
  }
  return round4(Math.max(0, q));
}

/**
 * Rows worked out from another row (volume = area × depth, assembly lines, …) follow
 * their source: when the source or a deducted count changes, so do they.
 */
export function followDerived(list: TakeoffRow[]): TakeoffRow[] {
  if (!list.some(m => m.derived)) return list;
  let cur = list;
  // A derived row can itself be a source, so settle in a few passes.
  for (let pass = 0; pass < 4; pass++) {
    const byId = new Map(cur.map(m => [m.id, m]));
    let changed = false;
    const out = cur.map(m => {
      if (!m.derived || m.isOverridden) return m;
      const q = derivedQuantity(m, byId);
      if (q === null || Math.abs(q - m.quantity) < 1e-9) return m;
      changed = true;
      return { ...m, quantity: q };
    });
    if (!changed) break;
    cur = out;
  }
  return cur;
}

export interface BuildAssemblyOptions {
  params?: Record<string, number>;
  deductions?: OpeningDeduction[];
  minVoid?: number;
  newId: () => string;
}

/** The BOQ rows an assembly adds for one measured shape. */
export function buildAssemblyRows(
  source: TakeoffRow,
  assembly: Assembly,
  all: TakeoffRow[],
  { params = {}, deductions = [], minVoid = DEFAULT_MIN_VOID_M2, newId }: BuildAssemblyOptions,
): TakeoffRow[] {
  if (!assemblyFits(assembly, source)) return [];
  const byId = new Map(all.map(m => [m.id, m]));
  const name = source.label || source.description || 'Shape';
  const value = (key: string) => params[key] ?? assembly.params.find(p => p.key === key)?.value ?? 0;

  return assembly.lines.map(line => {
    const p = line.param ? assembly.params.find(x => x.key === line.param) : undefined;
    const factor = line.times * (line.param ? value(line.param) : 1);
    const whatParts = [
      ...(p ? [`${fmt(value(p.key))} ${p.unit}`] : []),
      ...(line.times !== 1 ? [fmt(line.times)] : []),
    ];
    const less: NonNullable<NonNullable<TakeoffRow['derived']>['less']> = [];
    if (line.deduct) for (const d of deductions) {
      const o = d.opening;
      if (!byId.has(d.sourceId)) continue;
      if (line.deduct.by === 'width') {
        if (o.kind !== 'door') continue;
        less.push({ sourceId: d.sourceId, each: round4(o.width * line.deduct.times),
          what: `${o.name}: ${fmt(o.width)} m${line.deduct.times !== 1 ? ` × ${fmt(line.deduct.times)}` : ''}` });
      } else {
        const a = o.width * o.height;
        if (a < minVoid) {
          less.push({ sourceId: d.sourceId, each: 0, what: `${o.name}: not deducted (void under ${fmt(minVoid)} sq m)` });
        } else {
          less.push({ sourceId: d.sourceId, each: round4(a * line.deduct.times),
            what: `${o.name}: ${fmt(o.width)} × ${fmt(o.height)} m${line.deduct.times !== 1 ? ` × ${fmt(line.deduct.times)}` : ''}` });
        }
      }
    }
    const row: TakeoffRow = {
      id: newId(), childIds: [], drawingId: source.drawingId, pageNumber: source.pageNumber,
      label: `${name} – ${line.description}`, description: `${name} – ${line.description}`,
      type: line.type, unit: line.unit, quantity: 0, unitRate: 0, points: [],
      notes: `From “${name}” (${assembly.name}) — follows it when it changes`,
      isOverridden: false, color: source.color, isVisible: true,
      derived: {
        sourceId: source.id, factor: round4(factor),
        what: whatParts.length ? `× ${whatParts.join(' × ')}` : 'same quantity',
        ...(less.length ? { less } : {}),
        assembly: assembly.name,
      },
    };
    row.quantity = derivedQuantity(row, new Map([...byId, [row.id, row]])) ?? 0;
    return row;
  });
}

export interface WorkingLine {
  text: string;
  /** Signed contribution to the total, in the row's unit. */
  value: number;
  /** Row on the drawing this line comes from. */
  sourceId?: string;
}

/** The working behind a derived quantity, for checking: source, timesing, deductions. */
export function explainDerived(row: TakeoffRow, byId: Map<string, TakeoffRow>): WorkingLine[] | null {
  const d = row.derived;
  if (!d) return null;
  const src = byId.get(d.sourceId);
  if (!src) return [{ text: 'The shape this was worked out from has been deleted', value: row.quantity }];
  const sq = effectiveQuantity(src, byId);
  const out: WorkingLine[] = [{
    text: `${src.label || src.description || 'Shape'}: ${fmt(sq)} ${src.unit} ${d.what}`,
    value: round4(sq * d.factor), sourceId: src.id,
  }];
  for (const l of d.less ?? []) {
    const c = byId.get(l.sourceId);
    if (!c) continue;
    const n = effectiveQuantity(c, byId);
    out.push({
      text: `Less ${fmt(n)} nr ${c.label || c.description || 'openings'} — ${l.what}`,
      value: l.each ? -round4(n * l.each) : 0, sourceId: c.id,
    });
  }
  return out;
}

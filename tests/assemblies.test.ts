import { describe, it, expect } from 'vitest';
import type { TakeoffRow } from '@/types';
import {
  BUILT_IN_ASSEMBLIES, STANDARD_OPENINGS, buildAssemblyRows, followDerived, explainDerived, derivedQuantity,
} from '@/lib/takeoff/assemblies';

const row = (o: Partial<TakeoffRow>): TakeoffRow => ({
  id: 'x', childIds: [], drawingId: 'd', description: '', type: 'Length', quantity: 0, unit: 'm', unitRate: 0,
  notes: '', points: [], isOverridden: false, color: '#fff', isVisible: true, ...o,
});
let n = 0;
const newId = () => `new-${++n}`;
const wallAsm = BUILT_IN_ASSEMBLIES.find(a => a.id === 'block-internal')!;
const door = STANDARD_OPENINGS.find(o => o.id === 'door-900x2100')!;
const smallWindow = STANDARD_OPENINGS.find(o => o.id === 'window-600x600')!;
const q = (rows: TakeoffRow[], name: string) => rows.find(r => r.description.endsWith(name))!.quantity;

describe('assemblies', () => {
  const wall = row({ id: 'wall', label: 'Wall A', quantity: 10, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] });
  const doors = row({ id: 'doors', type: 'Count', unit: 'EA', label: 'D1', isGroupHeader: true, childIds: ['p1', 'p2'] });
  const pins = ['p1', 'p2'].map(id => row({ id, type: 'Count', unit: 'EA', quantity: 1, parentId: 'doors' }));
  const windows = row({ id: 'wins', type: 'Count', unit: 'EA', label: 'W1', quantity: 3 });
  const all = [wall, doors, ...pins, windows];

  it('a wall length gives blockwork, plaster, paint and skirting', () => {
    const rows = buildAssemblyRows(wall, wallAsm, all, { params: { height: 3 }, newId });
    expect(rows).toHaveLength(4);
    expect(q(rows, 'Blockwork')).toBeCloseTo(30, 6);
    expect(q(rows, 'Plaster, both sides')).toBeCloseTo(60, 6);
    expect(q(rows, 'Paint, both sides')).toBeCloseTo(60, 6);
    expect(q(rows, 'Skirting')).toBeCloseTo(20, 6);
    expect(rows.every(r => r.derived?.sourceId === 'wall')).toBe(true);
  });

  it('deducts counted doors: once from blockwork, both sides from finishes, width from skirting', () => {
    const rows = buildAssemblyRows(wall, wallAsm, all, {
      params: { height: 3 }, deductions: [{ sourceId: 'doors', opening: door }], newId,
    });
    expect(q(rows, 'Blockwork')).toBeCloseTo(30 - 2 * 1.89, 6);
    expect(q(rows, 'Plaster, both sides')).toBeCloseTo(60 - 2 * 1.89 * 2, 6);
    expect(q(rows, 'Skirting')).toBeCloseTo(20 - 2 * 0.9 * 2, 6);
  });

  it('does not deduct voids under the minimum, and windows never cut skirting', () => {
    const rows = buildAssemblyRows(wall, wallAsm, all, {
      params: { height: 3 }, deductions: [{ sourceId: 'wins', opening: smallWindow }], newId,
    });
    expect(q(rows, 'Blockwork')).toBeCloseTo(30, 6);
    expect(q(rows, 'Skirting')).toBeCloseTo(20, 6);
    const lowLimit = buildAssemblyRows(wall, wallAsm, all, {
      params: { height: 3 }, deductions: [{ sourceId: 'wins', opening: smallWindow }], minVoid: 0.1, newId,
    });
    expect(q(lowLimit, 'Blockwork')).toBeCloseTo(30 - 3 * 0.36, 6);
  });

  it('rows follow the wall and the count when either changes', () => {
    const rows = buildAssemblyRows(wall, wallAsm, all, {
      params: { height: 3 }, deductions: [{ sourceId: 'doors', opening: door }], newId,
    });
    const longer = followDerived([{ ...wall, quantity: 12 }, doors, pins[0], windows, ...rows]);
    // wall is 12 m and one door pin was removed
    expect(q(longer, 'Blockwork')).toBeCloseTo(36 - 1.89, 6);
  });

  it('never goes below zero, and leaves hand-typed quantities alone', () => {
    const tiny = { ...wall, quantity: 0.5 };
    const rows = buildAssemblyRows(tiny, wallAsm, [tiny, doors, ...pins], {
      params: { height: 1 }, deductions: [{ sourceId: 'doors', opening: door }], newId,
    });
    expect(q(rows, 'Blockwork')).toBe(0);
    const typed = { ...rows[0], isOverridden: true, quantity: 99 };
    expect(followDerived([tiny, doors, ...pins, typed])[4].quantity).toBe(99);
  });

  it('only fits the right kind of shape', () => {
    expect(buildAssemblyRows(row({ type: 'Area', quantity: 20 }), wallAsm, [], { newId })).toEqual([]);
    const slab = BUILT_IN_ASSEMBLIES.find(a => a.id === 'slab-on-grade')!;
    const floor = row({ id: 'f', type: 'Polygon', unit: 'sq m', quantity: 100 });
    const rows = buildAssemblyRows(floor, slab, [floor], { newId });
    expect(q(rows, 'Concrete slab')).toBeCloseTo(15, 6);
    expect(q(rows, 'Blinding concrete')).toBeCloseTo(5, 6);
    expect(q(rows, 'Mesh reinforcement')).toBeCloseTo(100, 6);
  });

  it('explains a quantity: the working adds up to the total and points at the shapes', () => {
    const rows = buildAssemblyRows(wall, wallAsm, all, {
      params: { height: 3 }, deductions: [{ sourceId: 'doors', opening: door }, { sourceId: 'wins', opening: smallWindow }], newId,
    });
    const byId = new Map([...all, ...rows].map(m => [m.id, m]));
    const plaster = rows[1];
    const w = explainDerived(plaster, byId)!;
    expect(w.map(l => l.sourceId)).toEqual(['wall', 'doors', 'wins']);
    expect(w[2].value).toBe(0);
    expect(w.reduce((t, l) => t + l.value, 0)).toBeCloseTo(plaster.quantity, 6);
    expect(derivedQuantity(plaster, byId)).toBeCloseTo(plaster.quantity, 9);
  });
});

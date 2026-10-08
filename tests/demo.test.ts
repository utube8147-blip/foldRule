import { describe, it, expect } from 'vitest';
import { templateFromProject, summariseTemplate } from '@/lib/demo/template';
import { findSymbols, rotate90, type Ink } from '@/lib/demo/symbolCount';
import { findRooms, joinLines } from '@/lib/demo/rooms';
import type { StoredProjectState } from '@/lib/storage/projectDb';
import type { TakeoffRow } from '@/types';

const row = (id: string, o: Partial<TakeoffRow> = {}): TakeoffRow =>
  ({ id, drawingId: 'd', description: id, type: 'Area', quantity: 10, unit: 'm²', unitRate: 0, notes: '', points: [{ x: 0, y: 0 }], isOverridden: false, childIds: [], color: '#fff', isVisible: true, ...o } as TakeoffRow);

describe('experiment: project as a template', () => {
  const src = {
    projectName: 'Villa A', measurements: [
      row('g1', { isGroupHeader: true, description: 'Floor tiles', childIds: ['a', 'b'], quantity: 30 }),
      row('a', { parentId: 'g1', materialId: 'tile', unitRate: 45 }), row('b', { parentId: 'g1', materialId: 'tile', unitRate: 45 }),
      row('g2', { isGroupHeader: true, description: 'Walls', childIds: ['c'] }), row('c', { parentId: 'g2' }),
      row('loose', { materialId: 'paint' }),
    ],
    materials: [{ id: 'tile' }, { id: 'paint' }], drawings: [{ id: 'd' }], currency: 'AED', vatPercent: 5,
    markups: { profitPercent: 10, provisional: [{ id: 'p', name: 'Signage', amount: 500 }] }, auditLog: [{}], revisionLog: [{}],
  } as unknown as StoredProjectState;
  const base = { projectName: 'Villa B', measurements: [], materials: [], drawings: [], activeDrawingId: null } as unknown as StoredProjectState;

  it('keeps groups, their material and rate, prices and settings; drops measurements and history', () => {
    const t = templateFromProject(src, base);
    expect(t.projectName).toBe('Villa B');
    expect(t.measurements.map(m => [m.description, m.isGroupHeader, m.quantity, m.materialId, m.unitRate, m.childIds.length]))
      .toEqual([['Floor tiles', true, 0, 'tile', 45, 0], ['Walls', true, 0, undefined, 0, 0]]);
    expect(t.measurements[0].id).not.toBe('g1');
    expect([t.currency, t.vatPercent, t.markups?.profitPercent, t.markups?.provisional]).toEqual(['AED', 5, 10, []]);
    expect([t.drawings.length, t.auditLog, t.revisionLog]).toEqual([0, undefined, undefined]);
    expect(t.materials).toHaveLength(2);
    expect(summariseTemplate(src)).toMatchObject({ groups: 2, materialsUsed: 2, hasMarkups: true });
  });
});

describe('experiment: counting symbols', () => {
  // A small "door": an L with a dot.
  const stamp = (page: Ink, x: number, y: number, t: Ink) => { for (let j = 0; j < t.h; j++) for (let i = 0; i < t.w; i++) if (t.data[j * t.w + i]) page.data[(y + j) * page.w + x + i] = 1; };
  const sym: Ink = { w: 12, h: 10, data: new Uint8Array(120) };
  for (let i = 0; i < 12; i++) sym.data[9 * 12 + i] = 1;
  for (let j = 0; j < 10; j++) sym.data[j * 12] = 1;
  sym.data[3 * 12 + 6] = sym.data[3 * 12 + 7] = sym.data[4 * 12 + 6] = sym.data[4 * 12 + 7] = 1;
  const page: Ink = { w: 200, h: 120, data: new Uint8Array(200 * 120) };
  stamp(page, 20, 20, sym); stamp(page, 90, 60, sym); stamp(page, 150, 30, rotate90(sym));
  for (let i = 0; i < 200; i++) page.data[110 * 200 + i] = 1;       // a wall line: not a door

  it('finds the sample, a copy and a turned copy, and nothing else', () => {
    const m = findSymbols(page, { x: 20, y: 20, w: 12, h: 10 });
    expect(m.map(x => `${x.x},${x.y},${x.turn}`).sort()).toEqual(['150,30,90', '20,20,0', '90,60,0']);
  });
  it('ignores turned copies when asked', () => {
    expect(findSymbols(page, { x: 20, y: 20, w: 12, h: 10 }, { turns: false })).toHaveLength(2);
  });
  it('refuses an empty box', () => {
    expect(findSymbols(page, { x: 60, y: 5, w: 10, h: 10 })).toEqual([]);
  });
});

describe('experiment: rooms from the drawing text', () => {
  const t = (str: string, x: number, y: number, w = str.length * 6) => ({ str, x, y, w, h: 10 });
  it('joins split words and pairs a room with the area under it', () => {
    expect(joinLines([t('BED', 100, 100, 18), t('ROOM 1', 119, 100)])[0].str).toBe('BEDROOM 1');
    const rooms = findRooms([
      t('BED', 100, 100, 18), t('ROOM 1', 119, 100), t('14.20 m²', 105, 114),
      t('KITCHEN', 300, 100), t('3.60 x 2.50', 298, 114),
      t('LIVING 28.5 m2', 100, 300),
      t('SCALE 1:100', 500, 500), t('GROUND FLOOR PLAN', 500, 520), t('W1', 50, 50),
    ]);
    expect(rooms.map(r => [r.name, r.statedArea, r.from])).toEqual([
      ['Bedroom 1', 14.2, 'area label'], ['Kitchen', 9, 'dimensions'], ['Living', 28.5, 'area label'],
    ]);
  });
  it('numbers repeated names and tolerates rooms with no area', () => {
    const rooms = findRooms([t('TOILET', 10, 10), t('TOILET', 300, 10)]);
    expect(rooms.map(r => [r.name, r.statedArea])).toEqual([['Toilet (1)', undefined], ['Toilet (2)', undefined]]);
  });
});

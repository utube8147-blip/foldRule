import { describe, it, expect } from 'vitest';
import type { TakeoffRow } from '@/types';
import { timesIndex, billedQuantities, billedRows } from '@/lib/takeoff/timesing';

const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
const row = (o: Partial<TakeoffRow>): TakeoffRow => ({
  id: 'x', childIds: [], drawingId: 'd', description: '', type: 'Length', quantity: 0, unit: 'm', unitRate: 0,
  notes: '', points: pts, isOverridden: false, color: '#fff', isVisible: true, ...o,
});
const drawings = [{ id: 'd', pageTimes: { 2: 12 } }];

describe('timesing', () => {
  it('a page multiplier applies to everything drawn on that page only', () => {
    const a = row({ id: 'a', pageNumber: 2, quantity: 10 });
    const b = row({ id: 'b', pageNumber: 1, quantity: 10 });
    const typed = row({ id: 'c', pageNumber: 2, quantity: 10, points: [] });
    const q = billedQuantities([a, b, typed], drawings);
    expect([q.get('a'), q.get('b'), q.get('c')]).toEqual([120, 10, 10]);
  });

  it('group, row and page multipliers stack, and the group total is the billed sum', () => {
    const head = row({ id: 'h', isGroupHeader: true, childIds: ['a', 'b'], points: [], times: 3, quantity: 15 });
    const a = row({ id: 'a', parentId: 'h', pageNumber: 2, quantity: 10 });
    const b = row({ id: 'b', parentId: 'h', quantity: 5, times: 2 });
    const all = [head, a, b];
    expect(timesIndex(all, drawings)(a)).toEqual({ page: 12, group: 3, own: 1, total: 36 });
    const q = billedQuantities(all, drawings);
    expect(q.get('a')).toBe(360);
    expect(q.get('b')).toBe(30);
    expect(q.get('h')).toBe(390);
  });

  it('finds the group through groupId as well as parentId', () => {
    const head = row({ id: 'h', isGroupHeader: true, groupId: 'g', points: [], times: 4 });
    const a = row({ id: 'a', groupId: 'g', quantity: 2 });
    expect(billedQuantities([head, a], [])!.get('a')).toBe(8);
  });

  it('rows worked out from a shape are billed as many times as the shape', () => {
    const wall = row({ id: 'w', pageNumber: 2, quantity: 10, times: 2 });
    const plaster = row({ id: 'p', type: 'Area', unit: 'sq m', quantity: 60, points: [],
      derived: { sourceId: 'w', factor: 6, what: '× 3 m × 2' } });
    expect(billedQuantities([wall, plaster], drawings).get('p')).toBe(60 * 24);
  });

  it('ignores bad multipliers and leaves rows untouched when nothing is timesed', () => {
    const a = row({ id: 'a', quantity: 10, times: -3 });
    const list = [a];
    expect(billedRows(list, [{ id: 'd', pageTimes: { 1: 0 } }])).toBe(list);
  });

  it('billed rows carry the multiplied quantity and say how it was reached', () => {
    const a = row({ id: 'a', pageNumber: 2, quantity: 10, notes: 'north wall' });
    const [out] = billedRows([a], drawings);
    expect(out.quantity).toBe(120);
    expect(out.notes).toBe('10 m × 12 — north wall');
  });
});

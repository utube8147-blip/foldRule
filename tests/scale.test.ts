import { describe, it, expect } from 'vitest';
import { getPageScale, effectivePageScale, rescaleMeasurementsForPage } from '@/lib/takeoff/scale';
import type { Drawing, TakeoffRow } from '@/types';

const drawing = (over: Partial<Drawing> = {}): Drawing => ({
  id: 'd1', name: 'A-101.pdf', fileUrl: '', scaleFactor: 1, pageCount: 3, pageScales: {}, ...over,
});

const row = (over: Partial<TakeoffRow>): TakeoffRow => ({
  id: Math.random().toString(36), drawingId: 'd1', pageNumber: 1, description: '', type: 'Length',
  quantity: 10, unit: 'm', unitRate: 0, notes: '', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  isOverridden: false, childIds: [], color: '#000', isVisible: true, ...over,
});

describe('getPageScale', () => {
  it('returns null for an uncalibrated page', () => {
    expect(getPageScale(drawing(), 1)).toBeNull();
    expect(effectivePageScale(drawing(), 1)).toBe(1);
  });
  it('is per page', () => {
    const d = drawing({ pageScales: { 2: 0.05 } });
    expect(getPageScale(d, 1)).toBeNull();
    expect(getPageScale(d, 2)).toBe(0.05);
  });
  it('honours a legacy drawing-wide scale', () => {
    expect(getPageScale(drawing({ pageScales: undefined, scaleFactor: 0.02 }), 3)).toBe(0.02);
  });
});

describe('rescaleMeasurementsForPage', () => {
  const rows = [
    row({ id: 'len',   type: 'Length',  quantity: 10 }),
    row({ id: 'area',  type: 'Polygon', quantity: 10, unit: 'm²' }),
    row({ id: 'count', type: 'Count',   quantity: 7,  unit: 'EA' }),
    row({ id: 'manual', type: 'Length', quantity: 5,  isOverridden: true }),
    row({ id: 'p2',    type: 'Length',  quantity: 10, pageNumber: 2 }),
    row({ id: 'other', type: 'Length',  quantity: 10, drawingId: 'd2' }),
    row({ id: 'legacy', type: 'Area',   quantity: 4,  pageNumber: undefined }),
  ];
  const out = new Map(rescaleMeasurementsForPage(rows, 'd1', 1, 1, 0.5).map(r => [r.id, r.quantity]));

  it('scales lengths linearly and areas by the square', () => {
    expect(out.get('len')).toBeCloseTo(5);
    expect(out.get('area')).toBeCloseTo(2.5);
    expect(out.get('legacy')).toBeCloseTo(1); // no pageNumber → page 1
  });
  it('leaves counts, manual quantities, other pages and other drawings alone', () => {
    expect(out.get('count')).toBe(7);
    expect(out.get('manual')).toBe(5);
    expect(out.get('p2')).toBe(10);
    expect(out.get('other')).toBe(10);
  });
  it('is a no-op for an unchanged scale', () => {
    expect(rescaleMeasurementsForPage(rows, 'd1', 1, 0.5, 0.5)).toBe(rows);
  });
});

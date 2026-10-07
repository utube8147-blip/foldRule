import { describe, it, expect } from 'vitest';
import { guideProgress, STAGES } from '@/lib/guide/stages';

const done = (p: Parameters<typeof guideProgress>[0], exported = false) =>
  Object.fromEntries(guideProgress(p, exported).map(s => [s.stage.id, s.done]));
const drawing = { id: 'd', pageCount: 2, scaleFactor: 1, pageScales: { 1: 0.05 } as Record<number, number> };

describe('getting started progress', () => {
  it('starts with nothing done', () => {
    const d = done({ drawings: [], measurements: [] });
    expect(Object.values(d).every(v => v === false)).toBe(true);
    expect(STAGES.filter(s => !s.later)).toHaveLength(8);
  });

  it('needs every page scaled, not just one', () => {
    expect(done({ drawings: [drawing], measurements: [] }).scale).toBe(false);
    expect(done({ drawings: [{ ...drawing, pageScales: { 1: 0.05, 2: 0.1 } }], measurements: [] }).scale).toBe(true);
    const s = guideProgress({ drawings: [drawing], measurements: [] }).find(x => x.stage.id === 'scale')!;
    expect(s.detail).toBe('1 of 2 pages have a scale');
  });

  it('ticks materials and rates only when every item is covered', () => {
    const rows = [
      { id: 'g', isGroupHeader: true, childIds: ['a', 'b'], unitRate: 0 },
      { id: 'a', childIds: [], materialId: 'm1', unitRate: 10 },
      { id: 'b', childIds: [], unitRate: 0 },
    ];
    let d = done({ drawings: [drawing], measurements: rows });
    expect([d.measure, d.organise, d.materials, d.rates]).toEqual([true, true, false, false]);
    rows[2] = { id: 'b', childIds: [], materialId: 'm2', unitRate: 0 };
    d = done({ drawings: [drawing], measurements: rows });
    expect([d.materials, d.rates]).toEqual([true, false]);
    rows[2].unitRate = 5;
    expect(done({ drawings: [drawing], measurements: rows }).rates).toBe(true);
  });

  it('wants both currency and VAT, and accepts 0% VAT as an answer', () => {
    expect(done({ drawings: [], measurements: [], currency: 'QAR' }).money).toBe(false);
    expect(done({ drawings: [], measurements: [], currency: 'QAR', vatPercent: 0 }).money).toBe(true);
  });

  it('marks export only once it has happened', () => {
    expect(done({ drawings: [], measurements: [] }, true).export).toBe(true);
  });
});

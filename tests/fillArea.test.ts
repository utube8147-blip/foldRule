import { describe, it, expect } from 'vitest';
import { maskOutlineMeasure } from '@/hooks/fill/fillArea';

describe('Magic Fill area in real units', () => {
  it('converts mask pixels → PDF points → metres correctly', () => {
    // Page 500×500 pt rendered as a 1000×1000 mask (2 mask px per point).
    // A 100×100 mask-px square = 50×50 pt. At 1:100 (0.035278 m/pt): 1.7639 m sides.
    const sf = 100 * (25.4 / 72) / 1000;
    const r = maskOutlineMeasure([[0, 0], [100, 0], [100, 100], [0, 100]], { w: 1000, h: 1000 }, { w: 500, h: 500 }, sf);
    expect(r.area).toBeCloseTo((50 * sf) ** 2, 9);
    expect(r.perimeter).toBeCloseTo(200 * sf, 9);
  });

  it('is independent of the mask resolution (the old bug scaled with it)', () => {
    const sf = 0.01;
    const a1 = maskOutlineMeasure([[0, 0], [100, 0], [100, 100], [0, 100]], { w: 1000, h: 1000 }, { w: 1000, h: 1000 }, sf).area;
    const a3 = maskOutlineMeasure([[0, 0], [300, 0], [300, 300], [0, 300]], { w: 3000, h: 3000 }, { w: 1000, h: 1000 }, sf).area;
    expect(a3).toBeCloseTo(a1, 9);
    // What the old code computed for the 3× mask: pixel area × sf² — 9× too big.
    expect((300 * 300 * sf * sf) / a1).toBeCloseTo(9, 6);
  });
});

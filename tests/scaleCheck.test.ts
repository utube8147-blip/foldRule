import { describe, it, expect } from 'vitest';
import { checkScale } from '@/lib/takeoff/scale';

describe('scale check', () => {
  it('passes when the drawn dimension matches the printed one', () => {
    const c = checkScale(100, 5, 0.05)!;
    expect(c.ok).toBe(true);
    expect(c.measured).toBeCloseTo(5, 9);
    expect(c.error).toBeCloseTo(0, 9);
  });

  it('tolerates a small drawing inaccuracy', () => {
    expect(checkScale(101, 5, 0.05)!.ok).toBe(true);
  });

  it('catches a 1:50 sheet measured as 1:100', () => {
    // 5 m printed, but the page scale is twice too big.
    const c = checkScale(100, 5, 0.1)!;
    expect(c.ok).toBe(false);
    expect(c.error).toBeCloseTo(1, 9);       // lengths read double
    expect(c.areaError).toBeCloseTo(3, 9);   // areas read four times
    expect(c.corrected).toBeCloseTo(0.05, 9);
  });

  it('reports a scale that reads short as a negative error', () => {
    const c = checkScale(100, 5, 0.045)!;
    expect(c.ok).toBe(false);
    expect(c.error).toBeCloseTo(-0.1, 9);
  });

  it('returns null for unusable input', () => {
    expect(checkScale(0, 5, 0.05)).toBeNull();
    expect(checkScale(100, 0, 0.05)).toBeNull();
    expect(checkScale(100, NaN, 0.05)).toBeNull();
  });
});

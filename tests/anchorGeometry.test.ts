import { describe, it, expect } from 'vitest';
import { angleInArc, groupByCentre } from '@/components/Viewer/CentreAnchorOverlay';

const deg = (d: number) => (d * Math.PI) / 180;

describe('angleInArc', () => {
  it('works for a simple arc', () => {
    expect(angleInArc(deg(45), 0, deg(90))).toBe(true);
    expect(angleInArc(deg(120), 0, deg(90))).toBe(false);
  });
  it('works for arcs that wrap past 0°', () => {
    // from 300° sweeping 90° → 300…30°
    expect(angleInArc(deg(10), deg(300), deg(90))).toBe(true);
    expect(angleInArc(deg(-20), deg(300), deg(90))).toBe(true);   // atan2 gives negatives
    expect(angleInArc(deg(60), deg(300), deg(90))).toBe(false);
  });
});

describe('groupByCentre', () => {
  it('puts concentric circles and arcs sharing a centre in one group', () => {
    const c = (nx: number, ny: number, r: number) => ({ nx, ny, nrx: r / 1000, nry: r / 1000, r });
    const groups = groupByCentre(
      [c(0.5, 0.5, 80), c(0.5, 0.5, 30), c(0.2, 0.2, 10)],
      [{ ...c(0.5, 0.5, 50), start: 0, sweep: deg(90) }],
      1000, 1000,
    );
    expect(groups).toHaveLength(2);
    const centre = groups.find(g => g.nx === 0.5)!;
    expect(centre.circles.map(x => x.r)).toEqual([80, 30]);     // largest first
    expect(centre.arcs).toHaveLength(1);
  });
});

import { alignSweep } from '@/components/Viewer/CentreAnchorOverlay';

describe('arcs drawn from a centre can go past 180°', () => {
  it('a 270° sweep the mouse went round stays 270°, not the 90° shortcut', () => {
    // start at 0°, mouse went counter-clockwise round to 270°
    expect((alignSweep(deg(265), 0, deg(270)) * 180) / Math.PI).toBeCloseTo(270, 6);
    // same click angle but the mouse went the other way: -90°
    expect((alignSweep(deg(-85), 0, deg(270)) * 180) / Math.PI).toBeCloseTo(-90, 6);
  });
  it('a nearly full turn stays nearly full', () => {
    expect((alignSweep(deg(355), 0, deg(-3)) * 180) / Math.PI).toBeCloseTo(357, 6);
  });
  it('small arcs are unchanged', () => {
    expect((alignSweep(deg(40), deg(10), deg(50)) * 180) / Math.PI).toBeCloseTo(40, 6);
  });
});

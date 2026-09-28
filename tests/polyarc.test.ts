import { describe, it, expect } from 'vitest';
import { polyarcClickPoints, splitPolyarcSegments } from '@/hooks/measurements/useMeasurements/useMeasurementCommit';
import type { InProgressPoint } from '@/context/TakeoffContext';

/** Simulate clicks: each entry is [mode, x, y]. */
function draw(clicks: ['line' | 'arc', number, number][]): InProgressPoint[] {
  let pts: InProgressPoint[] = [];
  for (const [mode, x, y] of clicks) pts = [...pts, ...polyarcClickPoints(pts, mode, { x, y, snapped: false })];
  return pts;
}

describe('polyarc: switching between line and arc', () => {
  it('line → arc → line keeps all three segments, joined end to start', () => {
    const pts = draw([
      ['line', 0, 0], ['line', 10, 0],          // line
      ['arc', 15, 5], ['arc', 10, 10],           // arc (starts at 10,0)
      ['line', 0, 10],                           // line after the arc
    ]);
    const segs = splitPolyarcSegments(pts);
    expect(segs.map(s => s.type)).toEqual(['line', 'arc', 'line']);
    // each segment starts where the previous ended
    expect(segs[1].points[0]).toMatchObject({ x: 10, y: 0 });
    expect(segs[2].points[0]).toMatchObject({ x: 10, y: 10 });
    expect(segs[2].points[1]).toMatchObject({ x: 0, y: 10 });
  });

  it('arc → line → arc → line', () => {
    const segs = splitPolyarcSegments(draw([
      ['arc', 0, 0], ['arc', 5, 5], ['arc', 10, 0],
      ['line', 20, 0],
      ['arc', 25, 5], ['arc', 20, 10],
      ['line', 10, 10], ['line', 0, 10],
    ]));
    expect(segs.map(s => s.type)).toEqual(['arc', 'line', 'arc', 'line']);
    expect(segs[3].points).toHaveLength(3);   // joined start + 2 clicks
  });

  it('two arcs in a row chain from the same point', () => {
    const segs = splitPolyarcSegments(draw([
      ['arc', 0, 0], ['arc', 5, 5], ['arc', 10, 0],
      ['arc', 15, -5], ['arc', 20, 0],
    ]));
    expect(segs.map(s => s.type)).toEqual(['arc', 'arc']);
    expect(segs[1].points[0]).toMatchObject({ x: 10, y: 0 });
  });
});

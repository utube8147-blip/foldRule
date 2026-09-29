import { describe, it, expect } from 'vitest';
import { RASTER_WORKER_SOURCE, ROOMS_WORKER_SOURCE } from '@/hooks/fill/useMagicFillSession';

function run(src: string, data: Record<string, unknown>): any {
  let out: any = null;
  const self: any = { postMessage: (m: unknown) => { out = m; } };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'console', src)(self, { log() {}, warn() {}, error() {} });
  self.onmessage({ data });
  return out;
}

// 300×200 plan: outer walls, a partition at x=150 (rooms A | B),
// a square column inside room A, and a small closet cut out of room B.
function plan() {
  const w = 300, h = 200, m = new Uint8Array(w * h);
  const wall = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * w + x] = 1;
  };
  wall(10, 10, 289, 13); wall(10, 186, 289, 189); wall(10, 10, 13, 189); wall(286, 10, 289, 189);
  wall(150, 10, 153, 189);                 // partition
  wall(60, 80, 79, 99);                    // column in room A
  wall(240, 14, 243, 70); wall(240, 67, 285, 70);  // closet in room B
  return { m, w, h };
}

function clickFill(m: Uint8Array, w: number, h: number, cx: number, cy: number) {
  const r = run(RASTER_WORKER_SOURCE, {
    maskBuffer: m.slice().buffer, fillDataBuffer: new Uint8ClampedArray(w * h * 4).buffer,
    w, h, cx, cy, r: 0, g: 0, b: 0, opacity: 0.5, svgLines: [],
  });
  return r.areaPx as number;
}

function rooms(m: Uint8Array, w: number, h: number) {
  return run(ROOMS_WORKER_SOURCE, { maskBuffer: m.slice().buffer, w, h, minArea: 50 }).regions as any[];
}

const containing = (regs: any[], x: number, y: number) =>
  regs.filter(r => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1).sort((a, b) => a.areaPx - b.areaPx)[0];

describe('pre-computed rooms match what a click fills', () => {
  const { m, w, h } = plan();
  const regs = rooms(m, w, h);

  it('finds room A, room B and the closet', () => {
    expect(regs.length).toBeGreaterThanOrEqual(3);
  });

  it('room A: same area as clicking it (column included, like the flood fill)', () => {
    expect(containing(regs, 40, 50).areaPx).toBe(clickFill(m, w, h, 40, 50));
  });

  it('room B: same area as clicking it', () => {
    expect(containing(regs, 200, 150).areaPx).toBe(clickFill(m, w, h, 200, 150));
  });

  it('the closet: same area as clicking it', () => {
    expect(containing(regs, 265, 40).areaPx).toBe(clickFill(m, w, h, 265, 40));
  });

  it('outlines are real polygons in page-mask coordinates', () => {
    const a = containing(regs, 40, 50);
    expect(a.polygon.length).toBeGreaterThan(3);
    expect(a.x0).toBeGreaterThanOrEqual(13);
    expect(a.x1).toBeLessThanOrEqual(150);
  });
});

describe('room finder skips the space around the building', () => {
  it('does not save a region that closes up into (nearly) the whole page', () => {
    // A building outline occupying most of the page, with open space around it.
    const w = 200, h = 200, m = new Uint8Array(w * h);
    const wall = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * w + x] = 1;
    };
    wall(5, 5, 194, 6); wall(5, 193, 194, 194); wall(5, 5, 6, 194); wall(193, 5, 194, 194);
    const regs = run(ROOMS_WORKER_SOURCE, { maskBuffer: m.slice().buffer, w, h, minArea: 50 }).regions as any[];
    expect(regs.every(r => r.areaPx / (w * h) <= 0.8)).toBe(true);
  });
});

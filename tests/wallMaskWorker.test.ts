import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWallMask, dilateMask, erodeMask, DILATE_R, ERODE_R } from '@/hooks/fill/fillMaskAndSvgPath';

// The worker is plain JS (the build doesn't bundle TS workers); make sure it
// matches the TypeScript implementation exactly.
function runWorker(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const src = readFileSync(join(process.cwd(), 'workers/wallMask.worker.js'), 'utf8');
  let out: Uint8Array | null = null;
  const self: any = { postMessage: (m: any) => { out = m.mask; } };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', src)(self);
  self.onmessage({ data: { id: 1, data, w, h } });
  return out!;
}

describe('wall mask worker', () => {
  it('gives the same mask as the TypeScript version on a plan-like image', () => {
    const w = 400, h = 300;
    const px = new Uint8ClampedArray(w * h * 4).fill(255);
    const ink = (x: number, y: number) => { const i = (y * w + x) * 4; px[i] = px[i + 1] = px[i + 2] = 20; };
    for (let x = 20; x < 380; x++) for (let t = 0; t < 3; t++) { ink(x, 20 + t); ink(x, 277 + t); }   // walls
    for (let y = 20; y < 280; y++) for (let t = 0; t < 3; t++) { ink(20 + t, y); ink(377 + t, y); }
    for (let y = 20; y < 140; y++) ink(200, y);                                                    // partition with a gap
    for (let i = 0; i < 200; i++) ink((i * 37) % w, (i * 91) % h);                                 // specks

    const expected = erodeMask(dilateMask(buildWallMask(px, w, h), w, h, DILATE_R), w, h, ERODE_R);
    const got = runWorker(new Uint8ClampedArray(px), w, h);
    expect(got.length).toBe(expected.length);
    expect(Buffer.from(got).equals(Buffer.from(expected))).toBe(true);
  });
});

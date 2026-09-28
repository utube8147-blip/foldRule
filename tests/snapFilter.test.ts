import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Run the real geometry worker in-process and check that dropping the
// operators it ignores (text, colours, images) doesn't change its output.
function runWorker(operators: { fn: number; args: unknown[] }[]) {
  const src = readFileSync(join(process.cwd(), 'workers/pdfGeometry.worker.js'), 'utf8');
  let out: any = null;
  const self: any = { postMessage: (m: unknown) => { out = m; } };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'console', src)(self, { log() {}, warn() {}, error() {} });
  self.onmessage({ data: { type: 'PARSE', operators, dims: { w: 1000, h: 800 }, viewportTransform: [1, 0, 0, -1, 0, 800] } });
  return out;
}

const GEOMETRY_OPS = new Set([2, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 74, 75, 91]);

describe('snap geometry operator filter', () => {
  it('produces identical lines, curves and snap points', () => {
    const M = 0, L = 1; // DrawOPS.moveTo / lineTo
    const rect = (x: number, y: number, w: number, h: number) =>
      [M, x, y, L, x + w, y, L, x + w, y + h, L, x, y + h, L, x, y];
    const ops: { fn: number; args: unknown[] }[] = [];
    for (let i = 0; i < 40; i++) {
      ops.push({ fn: 10, args: [] });                                   // save
      ops.push({ fn: 59, args: [0, 0, 0] });                            // setStrokeRGBColor (ignored)
      ops.push({ fn: 12, args: [1, 0, 0, 1, i * 3, i * 2] });           // transform
      ops.push({ fn: 2,  args: [0.5 + (i % 3)] });                      // setLineWidth
      ops.push({ fn: 91, args: [20, rect(10 + i * 20, 20 + i * 12, 60, 40), null] }); // stroke path
      ops.push({ fn: 31, args: [] });                                   // beginText (ignored)
      ops.push({ fn: 44, args: [[1, 2, 3]] });                          // showText (ignored)
      ops.push({ fn: 32, args: [] });                                   // endText (ignored)
      ops.push({ fn: 11, args: [] });                                   // restore
    }
    const full     = runWorker(ops);
    const filtered = runWorker(ops.filter(o => GEOMETRY_OPS.has(o.fn)));
    expect(full?.type).toBe('RESULT');
    expect(full.lines.length).toBeGreaterThan(0);
    expect(filtered.lines).toEqual(full.lines);
    expect(filtered.curves).toEqual(full.curves);
    expect(filtered.snapPoints).toEqual(full.snapPoints);
  });

  it('binary path buffers give the same result as plain arrays', () => {
    const M = 0, L = 1;
    const ops = Array.from({ length: 30 }, (_, i) => ({
      fn: 91,
      args: [20, [M, 10 + i * 9, 30, L, 70 + i * 9, 30, L, 70 + i * 9, 90], null],
    }));
    const asArrays = runWorker(ops);
    const asBinary = runWorker(ops.map(o => ({ fn: o.fn, args: [o.args[0], new Float32Array(o.args[1] as number[]), null] })));
    expect(asBinary.lines.length).toBeGreaterThan(0);
    expect(asBinary.lines).toEqual(asArrays.lines);
    expect(asBinary.snapPoints).toEqual(asArrays.snapPoints);
  });
});

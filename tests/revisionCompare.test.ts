import { describe, it, expect } from 'vitest';
import type { TakeoffRow } from '@/types';
import { inkMask, diffMasks, autoAlign, affectedRows, paintDiff, shift } from '@/lib/takeoff/revisionCompare';

const W = 120, H = 80;
const blank = () => new Uint8Array(W * H);
const hline = (m: Uint8Array, y: number, x0: number, x1: number) => { for (let x = x0; x <= x1; x++) m[y * W + x] = 1; return m; };
const vline = (m: Uint8Array, x: number, y0: number, y1: number) => { for (let y = y0; y <= y1; y++) m[y * W + x] = 1; return m; };
const row = (o: Partial<TakeoffRow>): TakeoffRow => ({
  id: 'x', childIds: [], drawingId: 'd', description: '', type: 'Length', quantity: 0, unit: 'm', unitRate: 0,
  notes: '', points: [], isOverridden: false, color: '#fff', isVisible: true, ...o,
});

describe('revision compare', () => {
  it('reads dark and coloured pixels as ink, paper and transparent as blank', () => {
    const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 0, 0, 0]);
    expect([...inkMask(px, 4, 1)]).toEqual([1, 0, 1, 0]);
  });

  it('an unchanged sheet has no differences, even when a line moves by a pixel', () => {
    const a = hline(blank(), 20, 10, 100), b = hline(blank(), 21, 10, 100);
    const d = diffMasks(a, b, W, H);
    expect(d.removedCount + d.addedCount).toBe(0);
  });

  it('finds what was removed and what was added', () => {
    const a = vline(hline(blank(), 20, 10, 100), 40, 20, 60);
    const b = vline(hline(blank(), 20, 10, 100), 70, 20, 60);   // the wall moved from x=40 to x=70
    const d = diffMasks(a, b, W, H);
    expect(d.removedCount).toBeGreaterThan(30);
    expect(d.addedCount).toBeGreaterThan(30);
    expect(d.removed[40 * W + 40]).toBe(1);
    expect(d.added[40 * W + 70]).toBe(1);
    expect(d.removed[20 * W + 55]).toBe(0);
    const img = paintDiff(a, b, d, W, H);
    expect([...img.slice((40 * W + 40) * 4, (40 * W + 40) * 4 + 3)]).toEqual([220, 38, 38]);
    expect([...img.slice((40 * W + 70) * 4, (40 * W + 70) * 4 + 3)]).toEqual([37, 99, 235]);
  });

  it('lines the two revisions up when one was exported slightly offset', () => {
    const a = vline(hline(blank(), 20, 10, 100), 40, 20, 60);
    const b = shift(a, W, H, 4, -3);
    const move = autoAlign(a, b, W, H);
    expect(move).toEqual({ dx: -4, dy: 3 });
    const d = diffMasks(a, b, W, H, move);
    expect(d.removedCount + d.addedCount).toBeLessThan(12);   // only the edges that left the sheet
  });

  it('flags the measurements that sit on a change and leaves the others', () => {
    const a = vline(hline(blank(), 20, 10, 100), 40, 20, 60);
    const b = vline(hline(blank(), 20, 10, 100), 70, 20, 60);
    const d = diffMasks(a, b, W, H);
    const n = (x: number, y: number) => ({ x: x / W, y: y / H });
    const rows = [
      row({ id: 'moved', label: 'Wall that moved', points: [n(40, 20), n(40, 60)] }),
      row({ id: 'kept', label: 'Top wall', points: [n(80, 20), n(100, 20)] }),
      row({ id: 'room', type: 'Polygon', label: 'Room', points: [n(60, 25), n(90, 25), n(90, 55), n(60, 55)] }),
      row({ id: 'far', type: 'Polygon', label: 'Far room', points: [n(5, 65), n(20, 65), n(20, 78), n(5, 78)] }),
      row({ id: 'pin', type: 'Count', points: [n(110, 70)] }),
      row({ id: 'h', isGroupHeader: true }),
    ];
    expect(affectedRows(rows, d, W, H).map(r => r.id).sort()).toEqual(['moved', 'room']);
  });
});

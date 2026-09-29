import { describe, it, expect } from 'vitest';
import { fillPreview } from '@/components/Viewer/RoomHoverOverlay';
import type { StoredRegion } from '@/lib/storage/projectDb';

const rect = (x0: number, y0: number, x1: number, y1: number, areaPx = (x1 - x0) * (y1 - y0)): StoredRegion =>
  ({ x0, y0, x1, y1, areaPx, perimPx: 0, polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });

// Room A (with a table inside), room B next to it, room C far away.
const A = rect(0, 0, 100, 100);
const table = rect(30, 30, 50, 45);
const B = rect(100, 0, 200, 100);
const C = rect(400, 400, 500, 500);
const regions = [A, table, B, C];

describe('Magic Fill preview', () => {
  it('lasso across two rooms → both rooms, plus the table inside A, total counted once', () => {
    const lasso: [number, number][] = [[60, 60], [150, 60], [150, 80], [60, 80]];
    const p = fillPreview(regions, lasso, null);
    expect(p.tops).toEqual(expect.arrayContaining([A, B]));
    expect(p.tops).toHaveLength(2);
    expect(p.inner).toEqual([table]);
    expect(p.areaPx).toBe(A.areaPx + B.areaPx);
  });

  it('a thin lasso strip that only crosses a room still includes it', () => {
    const strip: [number, number][] = [[-20, 48], [220, 48], [220, 52], [-20, 52]];
    const p = fillPreview(regions, strip, null);
    expect(p.tops).toEqual(expect.arrayContaining([A, B]));
  });

  it('hovering a room also shows what is enclosed inside it', () => {
    const p = fillPreview(regions, null, A);
    expect(p.tops).toEqual([A]);
    expect(p.inner).toEqual([table]);
  });

  it('rooms outside the lasso are not included', () => {
    const lasso: [number, number][] = [[10, 10], [90, 10], [90, 90], [10, 90]];
    expect(fillPreview(regions, lasso, null).tops).toEqual([A]);
  });
});

describe('whole-page regions are not rooms', () => {
  it('a region covering more than 80% of the page is never previewed', () => {
    const page = rect(0, 0, 1000, 1000);             // the "outside" that closes up into the page
    const room = rect(100, 100, 200, 200);
    const all = [page, room];
    const pageAreaPx = 1000 * 1000;
    expect(fillPreview(all, null, page, pageAreaPx).tops).toHaveLength(0);
    const lasso: [number, number][] = [[50, 50], [950, 50], [950, 950], [50, 950]];
    expect(fillPreview(all, lasso, null, pageAreaPx).tops).toEqual([room]);
  });
});

// Revision compare: two renderings of the same sheet (revision A and revision B)
// are reduced to "ink" masks and compared, so that what was removed, what was added
// and which measurements sit on a change can be shown.

import type { TakeoffRow } from '@/types';

/** 1 where the pixel is drawn on (dark or strongly coloured), 0 where it is paper. */
export function inkMask(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, threshold = 205): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    // Composite on white, then take the darkest channel so coloured lines count too.
    const min = Math.min(rgba[p], rgba[p + 1], rgba[p + 2]) * a + 255 * (1 - a);
    out[i] = min < threshold ? 1 : 0;
  }
  return out;
}

/** Grow a mask by `r` pixels, so a line that moved by a hair still counts as the same line. */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) tmp[y * w + k] = 1;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!tmp[y * w + x]) continue;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) out[k * w + x] = 1;
  }
  return out;
}

/** Mask moved by (dx, dy) pixels; what leaves the sheet is dropped. */
export function shift(mask: Uint8Array, w: number, h: number, dx: number, dy: number): Uint8Array {
  if (!dx && !dy) return mask;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < w && mask[sy * w + sx]) out[y * w + x] = 1;
    }
  }
  return out;
}

export interface RevisionDiff {
  /** Drawn in A, gone in B. */
  removed: Uint8Array;
  /** New in B. */
  added: Uint8Array;
  removedCount: number;
  addedCount: number;
  /** Share of all ink that changed (0–1). */
  changedShare: number;
}

/**
 * Compare two ink masks of the same size. `tolerance` is how many pixels a line may
 * move and still be the same line; (dx, dy) moves B before comparing (alignment).
 */
export function diffMasks(a: Uint8Array, b: Uint8Array, w: number, h: number, { tolerance = 1, dx = 0, dy = 0 } = {}): RevisionDiff {
  const bs = shift(b, w, h, dx, dy);
  const aWide = dilate(a, w, h, tolerance), bWide = dilate(bs, w, h, tolerance);
  const removed = new Uint8Array(w * h), added = new Uint8Array(w * h);
  let removedCount = 0, addedCount = 0, ink = 0;
  for (let i = 0; i < removed.length; i++) {
    if (a[i] || bs[i]) ink++;
    if (a[i] && !bWide[i]) { removed[i] = 1; removedCount++; }
    if (bs[i] && !aWide[i]) { added[i] = 1; addedCount++; }
  }
  return { removed, added, removedCount, addedCount, changedShare: ink ? (removedCount + addedCount) / ink : 0 };
}

/** Best whole-pixel move of B onto A within ±range, by how much ink lands on ink. */
export function autoAlign(a: Uint8Array, b: Uint8Array, w: number, h: number, range = 6): { dx: number; dy: number } {
  // Compare on a sparse sample of B's ink: plenty for a translation, and fast.
  const pts: number[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250_000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (b[y * w + x]) pts.push(x, y);
  let best = { dx: 0, dy: 0 }, bestScore = -1;
  for (let dy = -range; dy <= range; dy++) for (let dx = -range; dx <= range; dx++) {
    let score = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i] + dx, y = pts[i + 1] + dy;
      if (x >= 0 && x < w && y >= 0 && y < h && a[y * w + x]) score++;
    }
    // Prefer the smaller move when two score the same.
    if (score > bestScore || (score === bestScore && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy))) {
      bestScore = score; best = { dx, dy };
    }
  }
  return best;
}

/** Picture of the comparison: unchanged in grey, removed in red, added in blue. */
export function paintDiff(a: Uint8Array, b: Uint8Array, diff: RevisionDiff, w: number, h: number, { dx = 0, dy = 0 } = {}): Uint8ClampedArray {
  const bs = shift(b, w, h, dx, dy);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    let r = 255, g = 255, bl = 255;
    if (diff.removed[i]) { r = 220; g = 38; bl = 38; }
    else if (diff.added[i]) { r = 37; g = 99; bl = 235; }
    else if (a[i] || bs[i]) { r = g = bl = 150; }
    out[p] = r; out[p + 1] = g; out[p + 2] = bl; out[p + 3] = 255;
  }
  return out;
}

export interface AffectedRow { id: string; name: string; changed: number }

/**
 * Measurements of revision A that sit on a change. An area is affected by changes on or
 * inside its outline; a length or a count by changes within `reach` pixels of it.
 */
export function affectedRows(rows: TakeoffRow[], diff: RevisionDiff, w: number, h: number, { reach = 4, minPixels = 6 } = {}): AffectedRow[] {
  const changed = (x: number, y: number) => (x >= 0 && x < w && y >= 0 && y < h && (diff.removed[y * w + x] || diff.added[y * w + x]) ? 1 : 0);
  const out: AffectedRow[] = [];
  for (const m of rows) {
    if (m.isGroupHeader || !m.points?.length) continue;
    const pts = m.points.filter(p => Number.isFinite(p.x) && p.x >= 0 && p.y >= 0).map(p => ({ x: p.x * w, y: p.y * h }));
    if (!pts.length) continue;
    let n = 0;
    const isArea = m.type === 'Area' || m.type === 'Polygon' || m.type === 'Rectangle';
    if (isArea && pts.length >= 2) {
      const ring = m.type === 'Rectangle' && pts.length === 2
        ? [pts[0], { x: pts[1].x, y: pts[0].y }, pts[1], { x: pts[0].x, y: pts[1].y }] : pts;
      const x0 = Math.floor(Math.min(...ring.map(p => p.x))) - reach, x1 = Math.ceil(Math.max(...ring.map(p => p.x))) + reach;
      const y0 = Math.floor(Math.min(...ring.map(p => p.y))) - reach, y1 = Math.ceil(Math.max(...ring.map(p => p.y))) + reach;
      const inside = (x: number, y: number) => {
        let c = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i], b = ring[j];
          if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
        }
        return c;
      };
      const nearEdge = (x: number, y: number) => ring.some((a, i) => {
        const b = ring[(i + 1) % ring.length];
        const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / l2)) : 0;
        return Math.hypot(x - (a.x + t * (b.x - a.x)), y - (a.y + t * (b.y - a.y))) <= reach;
      });
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (changed(x, y) && (inside(x, y) || nearEdge(x, y))) n++;
      }
    } else {
      const seen = new Set<number>();
      const around = (cx: number, cy: number) => {
        for (let y = Math.round(cy) - reach; y <= Math.round(cy) + reach; y++) for (let x = Math.round(cx) - reach; x <= Math.round(cx) + reach; x++) {
          if (changed(x, y) && !seen.has(y * w + x)) { seen.add(y * w + x); n++; }
        }
      };
      if (pts.length === 1) around(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, reach)));
        for (let s = 0; s <= steps; s++) around(a.x + ((b.x - a.x) * s) / steps, a.y + ((b.y - a.y) * s) / steps);
      }
    }
    if (n >= minPixels) out.push({ id: m.id, name: m.label || m.description || 'Untitled', changed: n });
  }
  return out.sort((p, q) => q.changed - p.changed);
}

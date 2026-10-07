// Revision check by snap: a measurement drawn with snapping has its corners exactly on
// the drawing's own linework. Reading the linework of the new revision tells us, corner
// by corner, whether a measurement still fits (confirmed), has a corner that moved
// (with a suggested new position), or cannot be judged this way (drawn freehand).

import type { TakeoffRow } from '@/types';

export interface Pt { x: number; y: number }
/** Linework of one page, in page points of the OLD sheet's frame. */
export interface PageGeometry {
  /** Corners, line ends and crossings. */
  points: Pt[];
  lines: [Pt, Pt][];
}

export type SnapVerdict = 'confirmed' | 'moved' | 'unknown';
export interface SnapCheck {
  id: string;
  verdict: SnapVerdict;
  /** Corners no longer on linework. */
  movedPoints: number;
  /** Proposed outline (page fractions, old sheet's frame) when every moved corner found a new home. */
  suggestion?: { points: Array<{ x: number; y: number }>; quantity: number };
}

const AREA_TYPES = new Set(['Area', 'Polygon', 'Rectangle']);

class Grid<T> {
  private cells = new Map<string, T[]>();
  constructor(private size: number) {}
  private key(cx: number, cy: number) { return `${cx},${cy}`; }
  add(x0: number, y0: number, x1: number, y1: number, item: T) {
    const s = this.size;
    for (let cx = Math.floor(Math.min(x0, x1) / s); cx <= Math.floor(Math.max(x0, x1) / s); cx++) {
      for (let cy = Math.floor(Math.min(y0, y1) / s); cy <= Math.floor(Math.max(y0, y1) / s); cy++) {
        const k = this.key(cx, cy);
        const c = this.cells.get(k);
        if (c) c.push(item); else this.cells.set(k, [item]);
      }
    }
  }
  near(x: number, y: number, r: number): T[] {
    const s = this.size, out: T[] = [];
    for (let cx = Math.floor((x - r) / s); cx <= Math.floor((x + r) / s); cx++) {
      for (let cy = Math.floor((y - r) / s); cy <= Math.floor((y + r) / s); cy++) {
        const c = this.cells.get(this.key(cx, cy));
        if (c) for (const i of c) out.push(i);
      }
    }
    return out;
  }
}

const distToSegment = (p: Pt, a: Pt, b: Pt) => {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
};

interface Index { pts: Grid<Pt>; lines: Grid<[Pt, Pt]> }
function index(g: PageGeometry): Index {
  const pts = new Grid<Pt>(16), lines = new Grid<[Pt, Pt]>(48);
  for (const p of g.points) pts.add(p.x, p.y, p.x, p.y, p);
  // Line ends are corners too, even where the extractor did not list them.
  for (const l of g.lines) { lines.add(l[0].x, l[0].y, l[1].x, l[1].y, l); pts.add(l[0].x, l[0].y, l[0].x, l[0].y, l[0]); pts.add(l[1].x, l[1].y, l[1].x, l[1].y, l[1]); }
  return { pts, lines };
}
const onCorner = (ix: Index, p: Pt, tol: number) => ix.pts.near(p.x, p.y, tol).some(q => Math.hypot(q.x - p.x, q.y - p.y) <= tol);
const onLine = (ix: Index, p: Pt, tol: number) => ix.lines.near(p.x, p.y, tol).some(l => distToSegment(p, l[0], l[1]) <= tol);
const onLinework = (ix: Index, p: Pt, tol: number) => onCorner(ix, p, tol) || onLine(ix, p, tol);

/**
 * Exact offset of the new sheet against the old one, from matching corners
 * (the picture comparison only knows it to the nearest pixel). Returns what to add to
 * new-sheet coordinates to land on the old sheet, or null when too few corners match.
 */
export function refineOffset(oldG: PageGeometry, newG: PageGeometry, guess: Pt = { x: 0, y: 0 }, reach = 3): Pt | null {
  const ix = index(oldG);
  const dxs: number[] = [], dys: number[] = [];
  const step = Math.max(1, Math.floor(newG.points.length / 4000));
  for (let i = 0; i < newG.points.length; i += step) {
    const p = { x: newG.points[i].x + guess.x, y: newG.points[i].y + guess.y };
    let best: Pt | null = null, bd = reach;
    for (const q of ix.pts.near(p.x, p.y, reach)) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= bd) { bd = d; best = q; } }
    if (best) { dxs.push(best.x - p.x); dys.push(best.y - p.y); }
  }
  if (dxs.length < 12) return null;
  const median = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return { x: guess.x + median(dxs), y: guess.y + median(dys) };
}

export const shiftGeometry = (g: PageGeometry, by: Pt, scale = 1): PageGeometry => {
  const m = (p: Pt) => ({ x: p.x * scale + by.x, y: p.y * scale + by.y });
  return { points: g.points.map(m), lines: g.lines.map(l => [m(l[0]), m(l[1])] as [Pt, Pt]) };
};

const pathLength = (pts: Pt[], closed: boolean) => {
  let t = 0;
  for (let i = 0; i < (closed ? pts.length : pts.length - 1); i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; t += Math.hypot(b.x - a.x, b.y - a.y); }
  return t;
};
const ringArea = (pts: Pt[]) => Math.abs(pts.reduce((t, p, i) => { const q = pts[(i + 1) % pts.length]; return t + p.x * q.y - q.x * p.y; }, 0)) / 2;

export interface SnapCheckOptions {
  /** Page size in points (row points are fractions of it). */
  pageW: number; pageH: number;
  /** How close counts as "on the linework", in points. */
  tolerance?: number;
  /** How far a moved corner is looked for, in points. */
  searchRadius?: number;
}

/** Judge every measurement of the old page against the linework of the new revision. */
export function checkBySnap(rows: TakeoffRow[], oldG: PageGeometry, newG: PageGeometry, opts: SnapCheckOptions): SnapCheck[] {
  const { pageW: W, pageH: H } = opts;
  const tol = opts.tolerance ?? 1.5;
  const reach = opts.searchRadius ?? Math.max(60, Math.min(W, H) * 0.1);
  const oldIx = index(oldG), newIx = index(newG);
  const out: SnapCheck[] = [];

  for (const m of rows) {
    if (m.isGroupHeader || !m.points?.length) continue;
    // Arcs are stored with marker points; they are left to the picture comparison.
    if (m.points.some(p => !Number.isFinite(p.x) || p.x < 0 || p.y < 0) || m.arcRadius != null || m.holes?.length) {
      out.push({ id: m.id, verdict: 'unknown', movedPoints: 0 });
      continue;
    }
    const isArea = AREA_TYPES.has(m.type);
    let ring = m.points.map(p => ({ x: p.x * W, y: p.y * H }));
    const rectangle = m.type === 'Rectangle' && ring.length === 2;
    if (rectangle) ring = [ring[0], { x: ring[1].x, y: ring[0].y }, ring[1], { x: ring[0].x, y: ring[1].y }];
    if (ring.length < 2) { out.push({ id: m.id, verdict: 'unknown', movedPoints: 0 }); continue; }

    const snapped = ring.map(p => onLinework(oldIx, p, tol));
    if (!snapped.every(Boolean)) { out.push({ id: m.id, verdict: 'unknown', movedPoints: 0 }); continue; }

    // A corner must still be a corner; a point that only sat on a line must still sit on one.
    const still = ring.map(p => (onCorner(oldIx, p, tol) ? onCorner(newIx, p, tol) : onLine(newIx, p, tol)));
    // An edge that ran along a line must still run along one (a wall can go while its corners stay).
    let edgeGone = false;
    const edges = isArea ? ring.length : ring.length - 1;
    for (let i = 0; i < edges && !edgeGone; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      for (const f of [0.25, 0.5, 0.75]) {
        const q = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
        if (onLine(oldIx, q, tol) && !onLine(newIx, q, tol)) { edgeGone = true; break; }
      }
    }
    const movedIdx = still.map((ok, i) => (ok ? -1 : i)).filter(i => i >= 0);
    if (!movedIdx.length && !edgeGone) { out.push({ id: m.id, verdict: 'confirmed', movedPoints: 0 }); continue; }

    // Look for where each moved corner went: the nearest new corner, preferring one that
    // lies on the line of an edge meeting at that corner (a wall that got longer or shorter).
    const next = ring.map(p => ({ ...p }));
    let solved = movedIdx.length > 0 && !rectangle;
    for (const i of movedIdx) {
      const p = ring[i];
      const neighbours = [ring[(i - 1 + ring.length) % ring.length], ring[(i + 1) % ring.length]]
        .filter((_, k) => isArea || (k === 0 ? i > 0 : i < ring.length - 1));
      let best: Pt | null = null, bestScore = Infinity;
      // Along its own edge a corner may travel further (a wall cut back or extended).
      const far = Math.max(reach, Math.min(Math.min(W, H) * 0.35, ...neighbours.map(nb => Math.hypot(p.x - nb.x, p.y - nb.y))));
      for (const q of newIx.pts.near(p.x, p.y, far)) {
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d > far || d < 1e-6) continue;
        // Never fold a corner onto another corner of the same shape.
        if (ring.some((o, k) => k !== i && Math.hypot(o.x - q.x, o.y - q.y) <= tol)) continue;
        const along = neighbours.some(n => {
          const len = Math.hypot(p.x - n.x, p.y - n.y);
          if (len < 1e-6) return false;
          // distance of q from the infinite line through n and p
          return Math.abs((p.x - n.x) * (q.y - n.y) - (p.y - n.y) * (q.x - n.x)) / len <= tol;
        });
        if (!along && d > reach) continue;
        const score = along ? d * 0.25 : d;
        if (score < bestScore) { bestScore = score; best = q; }
      }
      if (best) next[i] = { x: best.x, y: best.y }; else solved = false;
    }
    const check: SnapCheck = { id: m.id, verdict: 'moved', movedPoints: movedIdx.length };
    if (solved) {
      const before = isArea ? ringArea(ring) : pathLength(ring, false);
      const after = isArea ? ringArea(next) : pathLength(next, false);
      if (before > 0 && after > 0) {
        check.suggestion = {
          points: m.points.map((p, i) => ({ ...p, x: next[i].x / W, y: next[i].y / H })),
          quantity: parseFloat((m.quantity * (after / before)).toFixed(4)),
        };
      }
    }
    out.push(check);
  }
  return out;
}

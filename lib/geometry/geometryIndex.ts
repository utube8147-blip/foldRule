// ─── lib/geometry/geometryIndex.ts ───────────────────────────────────────────
//
//  Grid index over the geometry extracted from a PDF page (lines + curves, in
//  page units). Used to find the line/arc under the cursor on every pointer
//  move without scanning thousands of segments: only the few grid cells near
//  the cursor are checked.
// ─────────────────────────────────────────────────────────────────────────────

export interface Pt { x: number; y: number }

export type Shape = 'line' | 'arc' | 'circle';

export type GeometryEntity =
  | { kind: 'line'; id: string; shape: Shape; a: Pt; b: Pt }
  | { kind: 'curve'; id: string; shape: Shape; pts: Pt[]; center?: Pt; radius?: number };   // sampled polyline (+ true circle when known)

interface LineLike  { id: string; shape?: Shape; vertices: [Pt, Pt] | Pt[] }
interface CurveLike {
  id: string;
  shape?: Shape;
  bezier?: { p0: Pt; p1: Pt; p2: Pt; p3: Pt };
  center?: Pt; radius?: number; startAngle?: number; endAngle?: number;
  approximate?: boolean;
}

const CELL = 48;          // page units per grid cell
const CURVE_SAMPLES = 12;

function sampleBezier(b: { p0: Pt; p1: Pt; p2: Pt; p3: Pt }): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= CURVE_SAMPLES; i++) {
    const t = i / CURVE_SAMPLES, u = 1 - t;
    out.push({
      x: u * u * u * b.p0.x + 3 * u * u * t * b.p1.x + 3 * u * t * t * b.p2.x + t * t * t * b.p3.x,
      y: u * u * u * b.p0.y + 3 * u * u * t * b.p1.y + 3 * u * t * t * b.p2.y + t * t * t * b.p3.y,
    });
  }
  return out;
}

function closestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface GeometryIndex {
  entities: GeometryEntity[];
  /** Nearest line/curve within `radius` page units of `p` (optionally only these shapes), or null. */
  nearest(p: Pt, radius: number, shapes?: ReadonlySet<Shape> | null): GeometryEntity | null;
  /**
   * The closest point ON the nearest line/curve (snap-to-line). For arcs and
   * circles with a known centre the point lies exactly on the true curve.
   */
  nearestPoint(p: Pt, radius: number, shapes?: ReadonlySet<Shape> | null): { point: Pt; dist: number; entity: GeometryEntity } | null;
}

export function buildGeometryIndex(lines: LineLike[], curves: CurveLike[]): GeometryIndex {
  const entities: GeometryEntity[] = [];
  for (const l of lines) {
    const [a, b] = l.vertices as [Pt, Pt];
    if (a && b) entities.push({ kind: 'line', id: l.id, shape: l.shape ?? 'line', a, b });
  }
  for (const c of curves) {
    if (c.bezier) {
      const exact = !c.approximate && c.center && c.radius && c.radius > 0;
      entities.push({
        kind: 'curve', id: c.id, shape: c.shape ?? 'arc', pts: sampleBezier(c.bezier),
        ...(exact ? { center: c.center, radius: c.radius } : {}),
      });
    }
  }

  const grid = new Map<string, number[]>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  entities.forEach((e, i) => {
    const pts = e.kind === 'line' ? [e.a, e.b] : e.pts;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const cx0 = Math.floor(x0 / CELL), cy0 = Math.floor(y0 / CELL);
    const cx1 = Math.floor(x1 / CELL), cy1 = Math.floor(y1 / CELL);
    // Very long lines span many cells; cap the fan-out and fall back to a
    // shared bucket for them.
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 400) {
      (grid.get('long') ?? grid.set('long', []).get('long')!).push(i);
      return;
    }
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = key(cx, cy);
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
      }
    }
  });

  const distTo = (e: GeometryEntity, p: Pt) => {
    if (e.kind === 'line') return distToSegment(p, e.a, e.b);
    let d = Infinity;
    for (let i = 1; i < e.pts.length; i++) d = Math.min(d, distToSegment(p, e.pts[i - 1], e.pts[i]));
    return d;
  };

  return {
    entities,
    nearest(p, radius, shapes) {
      const seen = new Set<number>();
      let best: GeometryEntity | null = null;
      let bestD = radius;
      const cx0 = Math.floor((p.x - radius) / CELL), cx1 = Math.floor((p.x + radius) / CELL);
      const cy0 = Math.floor((p.y - radius) / CELL), cy1 = Math.floor((p.y + radius) / CELL);
      const check = (idxs: number[] | undefined) => {
        if (!idxs) return;
        for (const i of idxs) {
          if (seen.has(i)) continue;
          seen.add(i);
          if (shapes && !shapes.has(entities[i].shape)) continue;
          const d = distTo(entities[i], p);
          if (d < bestD) { bestD = d; best = entities[i]; }
        }
      };
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) check(grid.get(key(cx, cy)));
      check(grid.get('long'));
      return best;
    },

    nearestPoint(p, radius, shapes) {
      const e = this.nearest(p, radius, shapes);
      if (!e) return null;
      let q: Pt;
      if (e.kind === 'line') {
        q = closestOnSegment(p, e.a, e.b);
      } else {
        // Closest point on the sampled curve…
        let bestD = Infinity; q = e.pts[0];
        for (let i = 1; i < e.pts.length; i++) {
          const c = closestOnSegment(p, e.pts[i - 1], e.pts[i]);
          const d = Math.hypot(p.x - c.x, p.y - c.y);
          if (d < bestD) { bestD = d; q = c; }
        }
        // …moved radially onto the true circle when we know it.
        if (e.center && e.radius) {
          const dx = q.x - e.center.x, dy = q.y - e.center.y, L = Math.hypot(dx, dy);
          if (L > 0) q = { x: e.center.x + (dx / L) * e.radius, y: e.center.y + (dy / L) * e.radius };
        }
      }
      return { point: q, dist: Math.hypot(p.x - q.x, p.y - q.y), entity: e };
    },
  };
}

// ─── lib/geometry/geometryIndex.ts ───────────────────────────────────────────
//
//  Grid index over the geometry extracted from a PDF page (lines + curves, in
//  page units). Used to find the line/arc under the cursor on every pointer
//  move without scanning thousands of segments: only the few grid cells near
//  the cursor are checked.
// ─────────────────────────────────────────────────────────────────────────────

export interface Pt { x: number; y: number }

export type GeometryEntity =
  | { kind: 'line'; id: string; a: Pt; b: Pt }
  | { kind: 'curve'; id: string; pts: Pt[] };   // sampled polyline along the curve

interface LineLike  { id: string; vertices: [Pt, Pt] | Pt[] }
interface CurveLike {
  id: string;
  bezier?: { p0: Pt; p1: Pt; p2: Pt; p3: Pt };
  center?: Pt; radius?: number; startAngle?: number; endAngle?: number;
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

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface GeometryIndex {
  entities: GeometryEntity[];
  /** Nearest line/curve within `radius` page units of `p`, or null. */
  nearest(p: Pt, radius: number): GeometryEntity | null;
}

export function buildGeometryIndex(lines: LineLike[], curves: CurveLike[]): GeometryIndex {
  const entities: GeometryEntity[] = [];
  for (const l of lines) {
    const [a, b] = l.vertices as [Pt, Pt];
    if (a && b) entities.push({ kind: 'line', id: l.id, a, b });
  }
  for (const c of curves) {
    if (c.bezier) entities.push({ kind: 'curve', id: c.id, pts: sampleBezier(c.bezier) });
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
    nearest(p, radius) {
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
          const d = distTo(entities[i], p);
          if (d < bestD) { bestD = d; best = entities[i]; }
        }
      };
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) check(grid.get(key(cx, cy)));
      check(grid.get('long'));
      return best;
    },
  };
}

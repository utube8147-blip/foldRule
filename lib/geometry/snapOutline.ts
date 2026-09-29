// ─── lib/geometry/snapOutline.ts ─────────────────────────────────────────────
//
//  Makes a traced Magic Fill outline hug the drawing's real lines:
//    1. each point near a PDF corner (line end / crossing) moves onto it,
//       otherwise onto the nearest line or arc (exactly on it);
//    2. where the outline passes from one straight wall to another, the exact
//       intersection of the two lines is inserted (sharp corner, no chamfer);
//    3. runs of points on the same straight line collapse to their ends
//       (arcs keep their points so they stay curved);
//    4. safety: if the result is degenerate or its area moves by > 30%, the
//       original outline is returned.
//  All coordinates in page units (PDF points at 100%).
// ─────────────────────────────────────────────────────────────────────────────

export type P = [number, number];

export interface SnapHit {
  point: { x: number; y: number };
  /** Entity the point landed on (lines: segment ends, for corner rebuilding). */
  entity: { id: string; kind: 'line'; a: { x: number; y: number }; b: { x: number; y: number } } | { id: string; kind: 'curve' };
}

export interface SnapOutlineOptions {
  /** Nearest point on a PDF line/arc within `tol`, or null. */
  nearest: (x: number, y: number, tol: number) => SnapHit | null;
  /** Nearest PDF corner (line end / crossing) within `tol`, or null. */
  corner?: (x: number, y: number, tol: number) => { x: number; y: number } | null;
  /** How far a point may move onto a line (page units). */
  edgeTol: number;
  /** How far a point may move onto a corner (page units). */
  cornerTol: number;
}

export function polygonArea(p: P[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  return Math.abs(a / 2);
}

function lineIntersection(a1: { x: number; y: number }, a2: { x: number; y: number }, b1: { x: number; y: number }, b2: { x: number; y: number }): P | null {
  const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (Math.abs(d) < 1e-9) return null;                      // parallel
  const t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
  return [a1.x + t * (a2.x - a1.x), a1.y + t * (a2.y - a1.y)];
}

interface Snapped { p: P; ent: SnapHit['entity'] | null; corner: boolean }

export function snapOutline(poly: P[], o: SnapOutlineOptions): P[] {
  if (poly.length < 3) return poly;

  // 1. Snap each point.
  const pts: Snapped[] = poly.map(([x, y]) => {
    const c = o.corner?.(x, y, o.cornerTol);
    if (c) return { p: [c.x, c.y] as P, ent: null, corner: true };
    const hit = o.nearest(x, y, o.edgeTol);
    if (hit) return { p: [hit.point.x, hit.point.y] as P, ent: hit.entity, corner: false };
    return { p: [x, y] as P, ent: null, corner: false };
  });

  // Nothing landed on the drawing → keep the outline exactly as it was.
  if (pts.every(s => !s.ent && !s.corner)) return poly;

  // 2. Rebuild sharp corners between two different straight walls.
  const withCorners: Snapped[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    withCorners.push(a);
    if (a.ent?.kind === 'line' && b.ent?.kind === 'line' && a.ent.id !== b.ent.id) {
      const X = lineIntersection(a.ent.a, a.ent.b, b.ent.a, b.ent.b);
      const reach = o.cornerTol * 3;
      if (X && Math.hypot(X[0] - a.p[0], X[1] - a.p[1]) < reach && Math.hypot(X[0] - b.p[0], X[1] - b.p[1]) < reach) {
        withCorners.push({ p: X, ent: null, corner: true });
      }
    }
  }

  // 3. Collapse runs on the same straight line to their end points.
  const collapsed: Snapped[] = [];
  for (let i = 0; i < withCorners.length; i++) {
    const cur = withCorners[i];
    const prev = withCorners[(i - 1 + withCorners.length) % withCorners.length];
    const next = withCorners[(i + 1) % withCorners.length];
    const sameAsPrev = cur.ent?.kind === 'line' && prev.ent?.kind === 'line' && prev.ent.id === cur.ent.id;
    const sameAsNext = cur.ent?.kind === 'line' && next.ent?.kind === 'line' && next.ent.id === cur.ent.id;
    if (sameAsPrev && sameAsNext) continue;                   // interior of a straight run
    collapsed.push(cur);
  }

  // 4. Drop duplicates.
  const out: P[] = [];
  for (const s of collapsed) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last[0] - s.p[0], last[1] - s.p[1]) > 1e-6) out.push(s.p);
  }
  if (out.length > 3 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();

  // Remove points lying on the straight segment between their neighbours
  // (e.g. a wall run's end sitting just before the rebuilt corner).
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const abx = c[0] - a[0], aby = c[1] - a[1];
      const len = Math.hypot(abx, aby);
      if (len < 1e-9) continue;
      const dist = Math.abs(abx * (b[1] - a[1]) - aby * (b[0] - a[0])) / len;       // off the line a–c
      const t = ((b[0] - a[0]) * abx + (b[1] - a[1]) * aby) / (len * len);          // between a and c?
      if (dist < 1e-6 * Math.max(1, len) && t > 0 && t < 1) { out.splice(i, 1); changed = true; i--; }
    }
  }

  // 5. Safety.
  if (out.length < 3) return poly;
  const a0 = polygonArea(poly), a1 = polygonArea(out);
  if (!(a1 > 0) || Math.abs(a1 - a0) / a0 > 0.30) return poly;
  return out;
}

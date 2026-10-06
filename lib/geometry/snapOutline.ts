// ─── lib/geometry/snapOutline.ts ─────────────────────────────────────────────
//
//  Makes a traced Magic Fill outline hug the drawing's real lines:
//    1. each point near a PDF corner (line end / crossing) moves onto it,
//       otherwise onto the nearest line or arc (exactly on it);
//    2. where the outline passes from one line or arc to another, the exact
//       intersection of the two is inserted (sharp corner, no chamfer) — for
//       wall/wall, wall/arc and arc/arc joins alike;
//    3. between two points on the same arc the outline follows the arc itself
//       (the true circle when the drawing has one), not the chord between them;
//    4. runs of points on the same straight line collapse to their ends;
//    5. safety: if the result is degenerate or its area moves by > 30%, the
//       original outline is returned.
//  All coordinates in page units (PDF points at 100%).
// ─────────────────────────────────────────────────────────────────────────────

export type P = [number, number];

export interface SnapHit {
  point: { x: number; y: number };
  /** Entity the point landed on (lines: segment ends, for corner rebuilding). */
  entity:
    | { id: string; kind: 'line'; a: { x: number; y: number }; b: { x: number; y: number } }
    /** `pts` = the curve as drawn (sampled); `center`/`radius` when it is a true circular arc. */
    | { id: string; kind: 'curve'; pts?: { x: number; y: number }[]; center?: { x: number; y: number }; radius?: number };
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

type Ent   = SnapHit['entity'];
type Curve = Extract<Ent, { kind: 'curve' }>;
type XY    = { x: number; y: number };

interface Snapped { p: P; ent: Ent | null; corner: boolean }

/** Where `p` sits along a curve's sampled points (segment index + fraction) and how far off it is. */
function curveParam(c: Curve, p: P): { u: number; d: number } | null {
  const pts = c.pts;
  if (!pts || pts.length < 2) return null;
  let best = { u: 0, d: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a.x) * dx + (p[1] - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(p[0] - (a.x + t * dx), p[1] - (a.y + t * dy));
    if (d < best.d) best = { u: i - 1 + t, d };
  }
  return best;
}

/** Points of the curve strictly between `from` and `to` (both on it), in order. */
function curveBetween(c: Curve, from: P, to: P): P[] {
  // A true circular arc: step round the circle itself (the short way).
  if (c.center && c.radius && c.radius > 0) {
    const a0 = Math.atan2(from[1] - c.center.y, from[0] - c.center.x);
    let sweep = Math.atan2(to[1] - c.center.y, to[0] - c.center.x) - a0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    // fine enough that the chords are within ~0.01 units of the circle
    const maxStep = Math.max(0.01, Math.min(0.2, 2 * Math.acos(Math.max(0, 1 - 0.01 / c.radius))));
    const n = Math.min(256, Math.ceil(Math.abs(sweep) / maxStep));
    const out: P[] = [];
    for (let k = 1; k < n; k++) {
      const t = a0 + (sweep * k) / n;
      out.push([c.center.x + c.radius * Math.cos(t), c.center.y + c.radius * Math.sin(t)]);
    }
    return out;
  }
  // Otherwise walk the curve's own sample points.
  const pa = curveParam(c, from), pb = curveParam(c, to);
  if (!pa || !pb || !c.pts) return [];
  const out: P[] = [];
  if (pa.u <= pb.u) { for (let i = Math.floor(pa.u) + 1; i <= Math.ceil(pb.u) - 1 && i < c.pts.length; i++) if (i > pa.u && i < pb.u) out.push([c.pts[i].x, c.pts[i].y]); }
  else              { for (let i = Math.ceil(pa.u) - 1; i >= Math.floor(pb.u) + 1 && i >= 0; i--)          if (i < pa.u && i > pb.u) out.push([c.pts[i].x, c.pts[i].y]); }
  return out;
}

/** The entity as a polyline, run on a little past both ends so near-misses still meet. */
function asPolyline(e: Ent, extend: number): XY[] {
  const pts: XY[] = e.kind === 'line' ? [e.a, e.b] : (e.pts ?? []);
  if (pts.length < 2) return pts;
  const stretch = (p: XY, q: XY): XY => {           // from q through p, `extend` beyond p
    const len = Math.hypot(p.x - q.x, p.y - q.y) || 1;
    return { x: p.x + ((p.x - q.x) / len) * extend, y: p.y + ((p.y - q.y) / len) * extend };
  };
  return [stretch(pts[0], pts[1]), ...pts, stretch(pts[pts.length - 1], pts[pts.length - 2])];
}

/** Distance from `x` to the segment a–b. */
function distToSeg(x: P, a: P, b: P): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x[0] - a[0]) * dx + (x[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(x[0] - (a[0] + t * dx), x[1] - (a[1] + t * dy));
}

/**
 * Where two entities meet, closest to the stretch of outline `from`→`to` that
 * cut the corner (and within `reach` of it), or null.
 */
function meet(e1: Ent, e2: Ent, from: P, to: P, reach: number): P | null {
  const near: P = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  const span = Math.hypot(to[0] - from[0], to[1] - from[1]) / 2;
  if (e1.kind === 'line' && e2.kind === 'line') {
    const X = lineIntersection(e1.a, e1.b, e2.a, e2.b);
    return X && distToSeg(X, from, to) < reach ? X : null;
  }
  const A = asPolyline(e1, reach), B = asPolyline(e2, reach);
  let best: P | null = null, bestD = reach;
  for (let i = 1; i < A.length; i++) {
    // skip segments nowhere near the join
    if (Math.min(Math.hypot(A[i].x - near[0], A[i].y - near[1]), Math.hypot(A[i - 1].x - near[0], A[i - 1].y - near[1])) > span + reach * 2 + Math.hypot(A[i].x - A[i - 1].x, A[i].y - A[i - 1].y)) continue;
    for (let j = 1; j < B.length; j++) {
      const p = A[i - 1], r = { x: A[i].x - p.x, y: A[i].y - p.y };
      const q = B[j - 1], t = { x: B[j].x - q.x, y: B[j].y - q.y };
      const den = r.x * t.y - r.y * t.x;
      if (Math.abs(den) < 1e-12) continue;
      const u = ((q.x - p.x) * t.y - (q.y - p.y) * t.x) / den;
      const v = ((q.x - p.x) * r.y - (q.y - p.y) * r.x) / den;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const X: P = [p.x + u * r.x, p.y + u * r.y];
      const d = distToSeg(X, from, to);
      if (d < bestD) { bestD = d; best = X; }
    }
  }
  // Put the crossing exactly on a true circle when there is one.
  if (best) for (const e of [e1, e2]) {
    if (e.kind === 'curve' && e.center && e.radius && (e1.kind === 'line' || e2.kind === 'line')) {
      const ln = (e1.kind === 'line' ? e1 : e2) as Extract<Ent, { kind: 'line' }>;
      const dx = ln.b.x - ln.a.x, dy = ln.b.y - ln.a.y, L = Math.hypot(dx, dy) || 1;
      const ux = dx / L, uy = dy / L;
      const fx = ln.a.x - e.center.x, fy = ln.a.y - e.center.y;
      const bq = fx * ux + fy * uy, cq = fx * fx + fy * fy - e.radius * e.radius;
      const disc = bq * bq - cq;
      if (disc >= 0) {
        const cand = [-bq - Math.sqrt(disc), -bq + Math.sqrt(disc)].map(tt => [ln.a.x + ux * tt, ln.a.y + uy * tt] as P);
        cand.sort((m, n) => Math.hypot(m[0] - best![0], m[1] - best![1]) - Math.hypot(n[0] - best![0], n[1] - best![1]));
        if (Math.hypot(cand[0][0] - best[0], cand[0][1] - best[1]) < reach) best = cand[0];
      }
      break;
    }
  }
  return best;
}

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

  // 2. Between each pair of neighbours: follow a shared arc, or rebuild the
  //    exact corner where two different lines / arcs meet.
  const reach = o.cornerTol * 3;
  const onCurve = (p: P, c: Curve) => { const q = curveParam(c, p); return !!q && q.d < o.edgeTol * 0.5; };
  const along = (c: Curve, from: P, to: P): Snapped[] => curveBetween(c, from, to).map(p => ({ p, ent: c, corner: false }));
  const withCorners: Snapped[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    withCorners.push(a);

    // Same arc on both sides (a drawing corner that lies on the arc counts).
    const shared: Curve | null =
      a.ent?.kind === 'curve' && (b.ent?.id === a.ent.id || (b.corner && onCurve(b.p, a.ent))) ? a.ent :
      b.ent?.kind === 'curve' && a.corner && onCurve(a.p, b.ent) ? b.ent : null;
    if (shared) { withCorners.push(...along(shared, a.p, b.p)); continue; }

    if (a.ent && b.ent && a.ent.id !== b.ent.id) {
      const X = meet(a.ent, b.ent, a.p, b.p, reach);
      if (X) {
        if (a.ent.kind === 'curve') withCorners.push(...along(a.ent, a.p, X));
        withCorners.push({ p: X, ent: null, corner: true });
        if (b.ent.kind === 'curve') withCorners.push(...along(b.ent, X, b.p));
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

// Shape builders shared by the Area tool's modes. Everything here works in a
// square coordinate space (canvas pixels in the viewer) and returns plain
// rings of points, so every area — however it was drawn — ends up as the same
// kind of polygon and can be edited, offset or combined the same way.

export interface Pt { x: number; y: number }

/**
 * How the Area / Length buttons interpret the underlying drawing tools.
 * Set by the Viewer (it owns the state); read by the measurement hook.
 *   area    — a path of lines and curves closes into an area; a circle is
 *             measured as an area rather than a circumference.
 *   regular — the polygon tool draws a regular polygon (centre, then a corner).
 */
export interface DrawMode { area: boolean; regular: boolean; sides: number }
export const DEFAULT_DRAW_MODE: DrawMode = { area: false, regular: false, sides: 6 };
export const drawModeState: DrawMode = { ...DEFAULT_DRAW_MODE };

export const MIN_SIDES = 3;
export const MAX_SIDES = 24;
export const clampSides = (n: number) =>
  Math.min(MAX_SIDES, Math.max(MIN_SIDES, Math.round(Number.isFinite(n) ? n : DEFAULT_DRAW_MODE.sides)));

/** Points along the arc from `a` to `c` that passes through `b` (inclusive of both ends). */
export function tessellateArc(a: Pt, b: Pt, c: Pt, maxStepPx = 4): Pt[] {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return [a, b, c];                       // collinear: a straight run
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  const r  = Math.hypot(a.x - cx, a.y - cy);

  const TAU = Math.PI * 2;
  const norm = (t: number) => ((t % TAU) + TAU) % TAU;
  const t1 = Math.atan2(a.y - cy, a.x - cx);
  const viaCcw = norm(Math.atan2(b.y - cy, b.x - cx) - t1);
  const endCcw = norm(Math.atan2(c.y - cy, c.x - cx) - t1);
  // Counter-clockwise if the middle point is met before the end going that way.
  const sweep = viaCcw <= endCcw ? endCcw : endCcw - TAU;

  const steps = Math.max(2, Math.min(256, Math.ceil((Math.abs(sweep) * r) / Math.max(0.5, maxStepPx))));
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = t1 + (sweep * i) / steps;
    out.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  out[0] = { ...a };
  out[out.length - 1] = { ...c };
  return out;
}

export type PathSegment =
  | { type: 'line'; points: Pt[] }
  | { type: 'arc';  points: [Pt, Pt, Pt] };

/** Join line and arc segments into one closed ring (no repeated points). */
export function pathToRing(segments: PathSegment[], maxStepPx = 4): Pt[] {
  const ring: Pt[] = [];
  const push = (p: Pt) => {
    const last = ring[ring.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-6) ring.push({ x: p.x, y: p.y });
  };
  for (const seg of segments) {
    const pts = seg.type === 'arc' ? tessellateArc(seg.points[0], seg.points[1], seg.points[2], maxStepPx) : seg.points;
    pts.forEach(push);
  }
  if (ring.length > 1) {
    const f = ring[0], l = ring[ring.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) <= 1e-6) ring.pop();     // explicit closing point
  }
  return ring;
}

/** Regular polygon from its centre and one corner. */
export function regularPolygon(centre: Pt, corner: Pt, sides: number): Pt[] {
  const n  = clampSides(sides);
  const r  = Math.hypot(corner.x - centre.x, corner.y - centre.y);
  const t0 = Math.atan2(corner.y - centre.y, corner.x - centre.x);
  return Array.from({ length: n }, (_, i) => {
    const t = t0 + (i * Math.PI * 2) / n;
    return { x: centre.x + r * Math.cos(t), y: centre.y + r * Math.sin(t) };
  });
}

/** A circle as a ring (drawn smooth; its quantity is computed exactly as πr²). */
export function circleRing(centre: Pt, edge: Pt, segments = 72): Pt[] {
  const r = Math.hypot(edge.x - centre.x, edge.y - centre.y);
  return Array.from({ length: segments }, (_, i) => {
    const t = (i * Math.PI * 2) / segments;
    return { x: centre.x + r * Math.cos(t), y: centre.y + r * Math.sin(t) };
  });
}

export function ringArea(ring: Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}

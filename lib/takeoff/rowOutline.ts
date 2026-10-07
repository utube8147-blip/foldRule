// The outline of a measurement as plain points, with curves followed properly.
// Curves are stored compactly (an arc as start / point on the curve / end, a circle as
// centre / point on the edge, mixed paths with marker points), so anything that draws a
// measurement outside the main viewer should go through here.

import type { TakeoffRow } from '@/types';
import { tessellateArc } from '@/lib/geometry/pathShapes';
import { tessellatePoints, isSentinel } from '@/hooks/perimeterOffset/perimeterOffsetGeometry';

type Pt = { x: number; y: number };
const AREA_TYPES = new Set(['Area', 'Polygon', 'Rectangle']);

/** Outline in pixels of a W × H rendering of the page. */
export function rowOutlinePx(m: TakeoffRow, W: number, H: number): { pts: Pt[]; closed: boolean } {
  const real = m.points.filter(p => !isSentinel(p) && Number.isFinite(p.x) && p.x >= 0 && p.y >= 0).map(p => ({ x: p.x * W, y: p.y * H }));
  const closed = AREA_TYPES.has(m.type);
  const fullCircle = m.arcRadius != null && Math.abs((m.sweepAngle ?? 0) - 2 * Math.PI) < 0.01;
  if (m.arcRadius != null && !fullCircle && real.length === 3) {
    return { pts: tessellateArc(real[0], real[1], real[2], 3), closed };
  }
  if (fullCircle && real.length === 2) {
    const r = Math.hypot(real[1].x - real[0].x, real[1].y - real[0].y);
    return { pts: Array.from({ length: 72 }, (_, i) => ({ x: real[0].x + r * Math.cos((i / 72) * Math.PI * 2), y: real[0].y + r * Math.sin((i / 72) * Math.PI * 2) })), closed: true };
  }
  if (m.points.some(isSentinel)) {
    return { pts: (tessellatePoints(m.points, W, H) as Pt[]).map(p => ({ x: p.x * W, y: p.y * H })), closed };
  }
  if (m.type === 'Rectangle' && real.length === 2) {
    return { pts: [real[0], { x: real[1].x, y: real[0].y }, real[1], { x: real[0].x, y: real[1].y }], closed: true };
  }
  return { pts: real, closed };
}

/** Same outline as fractions of the page (W and H give the page's proportions). */
export function rowOutline(m: TakeoffRow, W: number, H: number): { pts: Pt[]; closed: boolean } {
  const o = rowOutlinePx(m, W, H);
  return { pts: o.pts.map(p => ({ x: p.x / W, y: p.y / H })), closed: o.closed };
}

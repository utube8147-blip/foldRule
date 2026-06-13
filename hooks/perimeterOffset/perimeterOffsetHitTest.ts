// ─── hooks/perimeterOffset/perimeterOffsetHitTest.ts ─────────────────────────
//
//  Hit-testing helpers for the perimeter-offset canvas click / hover handler.
//
//  CHANGES vs previous version
//  ───────────────────────────
//  • buildTestPoints() now delegates to tessellatePoints() from the geometry
//    file, so arc / polyarc rows produce dense chord sequences that follow
//    the actual rendered curve instead of testing chords between raw control
//    points. This makes closed arc/polyarc paths correctly hittable.
//  • hitTestMeasurement accepts an optional `radius` parameter (zoom-adjusted
//    by the caller).
//  • HIT_RADIUS exported so Viewer.tsx can use it as the base value.
//
//  COORDINATE SPACE
//  ────────────────
//  All coordinates are normalised (0..1) matching m.points storage space.
//  HIT_RADIUS 0.008 ≈ 12 px at a 1500 px wide canvas — comfortable for a
//  1.5 px rendered stroke. The caller divides by current zoom scale to keep
//  the hit area visually constant at all zoom levels.
//
// ─────────────────────────────────────────────────────────────────────────────

import { tessellatePoints } from './perimeterOffsetGeometry';

export type NormPt = { x: number; y: number };

/** Base normalised-space hit radius. Divide by zoom scale before passing in. */
export const HIT_RADIUS = 0.008;

// ─── buildTestPoints ──────────────────────────────────────────────────────────
//
// Delegates to tessellatePoints() which correctly handles:
//   • Sentinel markers (stripped)
//   • Arc control-point triples (tessellated into dense chord sequences)
//   • Straight polyline segments (passed through as-is)
//
export function buildTestPoints(rawPoints: any[]): NormPt[] {
  return tessellatePoints(rawPoints);
}

// ─── pointInPolygon ───────────────────────────────────────────────────────────
export function pointInPolygon(px: number, py: number, pts: NormPt[]): boolean {
  if (pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if (
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── pointToSegmentDistSq ─────────────────────────────────────────────────────
function pointToSegmentDistSq(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
}

// ─── pointNearPolyline ────────────────────────────────────────────────────────
export function pointNearPolyline(
  px:     number,
  py:     number,
  pts:    NormPt[],
  closed: boolean,
  radius: number = HIT_RADIUS,
): boolean {
  if (pts.length < 2) return false;
  const rSq   = radius * radius;
  const limit = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < limit; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (pointToSegmentDistSq(px, py, a.x, a.y, b.x, b.y) <= rSq) return true;
  }
  return false;
}

// ─── hitTestMeasurement ───────────────────────────────────────────────────────
//
//  Public API. Pass raw m.points directly — sentinels and arc tessellation
//  are handled internally via buildTestPoints().
//
//  `isClosed` should be true for Polygon / Rectangle / Area and for any
//  Length row where isEffectivelyClosed() returns true (including arc /
//  polyarc rows that form a closed ring).
//
//  `radius` — pass a zoom-adjusted value:
//    const r = HIT_RADIUS / currentZoomScale;
//
export function hitTestMeasurement(
  nx:        number,
  ny:        number,
  rawPoints: any[],
  isClosed:  boolean,
  radius:    number = HIT_RADIUS,
): boolean {
  if (!rawPoints || rawPoints.length < 2) return false;

  const pts = buildTestPoints(rawPoints);
  if (pts.length < 2) return false;

  if (pointNearPolyline(nx, ny, pts, isClosed, radius)) return true;
  if (isClosed && pts.length >= 3 && pointInPolygon(nx, ny, pts)) return true;

  return false;
}
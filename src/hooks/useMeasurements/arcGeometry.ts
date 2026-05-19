// hooks/useMeasurements/arcGeometry.ts  (new file)

export interface ArcResult {
  cx: number; cy: number;   // centre in normalised coords
  r:  number;               // radius in normalised coords
  sweepAngle: number;       // radians (always positive, ≤ 2π)
  arcLength:  number;       // r * sweepAngle  (normalised units)
}

/** Circumscribed circle from three non-collinear points */
export function circumscribedCircle(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
): ArcResult | null {
  const ax = p1.x, ay = p1.y;
  const bx = p2.x, by = p2.y;
  const cx = p3.x, cy = p3.y;

  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(D) < 1e-10) return null; // collinear

  const ux = ((ax*ax + ay*ay) * (by - cy) +
               (bx*bx + by*by) * (cy - ay) +
               (cx*cx + cy*cy) * (ay - by)) / D;
  const uy = ((ax*ax + ay*ay) * (cx - bx) +
               (bx*bx + by*by) * (ax - cx) +
               (cx*cx + cy*cy) * (bx - ax)) / D;

  const r = Math.hypot(ax - ux, ay - uy);

  // Sweep angle: angle at centre from p1 to p3, passing through p2
  const a1 = Math.atan2(ay - uy, ax - ux);
  const a2 = Math.atan2(by - uy, bx - ux); // midpoint angle
  const a3 = Math.atan2(cy - uy, cx - ux);

  // Normalise so sweep goes from a1 → a3 through a2
  let sweep = a3 - a1;
  // Determine correct winding by checking if a2 is "between" a1 and a3
  const mid = a1 + sweep / 2;
  const midNorm = Math.atan2(Math.sin(mid), Math.cos(mid));
  const a2Norm  = Math.atan2(Math.sin(a2),  Math.cos(a2));
  if (Math.abs(midNorm - a2Norm) > 0.1) {
    // Wrong direction — flip
    if (sweep > 0) sweep -= 2 * Math.PI;
    else           sweep += 2 * Math.PI;
  }
  const sweepAngle = Math.abs(sweep);

  return { cx: ux, cy: uy, r, sweepAngle, arcLength: r * sweepAngle };
}
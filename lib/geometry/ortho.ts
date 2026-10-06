// Angle lock ("ortho"): constrain the next point to a ray from the previous
// point at a multiple of `stepDeg` (0°, 45°, 90° … by default), keeping the
// cursor's distance along that ray. Coordinates are in any square unit
// (canvas pixels in the viewer).

export interface Pt { x: number; y: number }

/** Tools whose next point follows the previous one in a straight line. */
export const ORTHO_TOOLS: ReadonlySet<string> = new Set(['linear', 'polygon', 'scale']);

/** Snap types that mean "exactly this point" — these beat the angle lock. */
const EXACT_SNAPS: ReadonlySet<string> = new Set([
  'endpoint', 'midpoint', 'intersection', 'centroid', 'curve-node', 'vertex',
]);
export const isExactSnap = (type: string | undefined, snapped: boolean): boolean =>
  snapped && !!type && EXACT_SNAPS.has(type);

export function constrainToAngle(from: Pt, to: Pt, stepDeg = 45): Pt & { angleDeg: number } {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: to.x, y: to.y, angleDeg: 0 };
  const step  = (stepDeg * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  // Project the cursor onto the locked ray (never behind the start point).
  const along = Math.max(0, dx * Math.cos(angle) + dy * Math.sin(angle));
  const deg   = ((Math.round((angle * 180) / Math.PI) % 360) + 360) % 360;
  return { x: from.x + along * Math.cos(angle), y: from.y + along * Math.sin(angle), angleDeg: deg };
}

/** Live flag read by the pointer-move handler (so the preview follows the lock even with snap off). */
export const orthoState = { on: false };

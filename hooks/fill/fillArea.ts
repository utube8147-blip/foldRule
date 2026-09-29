// Area / perimeter of a Magic Fill outline in real units.
// The outline is in wall-mask pixels; the mask is rendered at `mask` size for
// a page that is `page` PDF points; the page scale is metres per PDF point.

export function maskOutlineMeasure(
  polygon: [number, number][],
  mask: { w: number; h: number },
  page: { w: number; h: number },
  metresPerPoint: number,
): { area: number; perimeter: number } {
  const kx = page.w / mask.w, ky = page.h / mask.h;
  const pts = polygon.map(([x, y]) => [x * kx, y * ky] as [number, number]);
  let a = 0, p = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    p += Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
  }
  return { area: Math.abs(a / 2) * metresPerPoint * metresPerPoint, perimeter: p * metresPerPoint };
}

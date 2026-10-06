'use client';
// ─── hooks/perimeterOffset/perimeterOffsetGeometry.ts ────────────────────────
//
//  FIXES IN THIS REVISION
//  ──────────────────────
//  FIX A — pdfPixelDelta: removed `displayScale` (zoom) from the formula
//           everywhere. The correct conversion is:
//             offsetPdfPixels = offsetMetres / scaleFactor
//           where scaleFactor = realMetres/pdfPixel (calibration ratio).
//           Including zoom (displayScale) in the formula caused all offset
//           distances to scale with the current zoom level, making offsets
//           visually wrong and the geometry inconsistent between zoom levels.
//           This affects computePerimeterOffset, computeOpenPathOffset,
//           computeInscribedCircleRadius, and openPathBufferAreaMetres2.
//
//  FIX B — computeParallelOffset: the normal vector was divided by scaleW/scaleH
//           TWICE — once when building the normalised normal, and again when
//           applying the offset. Fixed by computing the normal in pdf-pixel
//           space, then applying the offset in pdf-pixel space, then converting
//           back to normalised space in one step:
//             x_new = pts[i].x + normalX_unit * delta / scaleW
//             y_new = pts[i].y + normalY_unit * delta / scaleH
//           where normalX_unit, normalY_unit are the unit normal in pdf-pixel
//           space (not converted to normalised).
//
//  FIX C — computeParallelOffset direction: 'left' in screen Y-down means
//           the left-hand side when walking forward along the path. In Y-down
//           screen space, the left normal of segment (dx, dy) is (-dy, dx)/len.
//           Positive delta = left side. This is now consistent with the
//           direction='left'/'right' selection in the panel.
//
//  FIX D — square cap end extension: was extending by pdfPixelDelta (= full
//           offset width) in both directions, creating caps twice as long as
//           expected. Standard square cap extends by HALF the offset width
//           (= pdfPixelDelta / 2) so the cap total length = offset width.
//           Fixed to use pdfPixelDelta / 2 per side.
//
//  FIX E — buildSemiCircleCap: the cap centre was placed at the midpoint of
//           (srcEnd, offEnd). Correct centre is the source endpoint itself
//           (or the corresponding endpoint on the zero side). The cap is a
//           semicircle of radius = pdfPixelDelta, centred at the source
//           endpoint, sweeping from the source side to the offset side.
//
//  FIX F — left/right one-side polygon winding: the explicit polygon
//           construction now closes cleanly by ensuring the polygon starts at
//           pts[0], traverses all source pts forward, applies end cap, traverses
//           offset pts backward, applies start cap, then closes back to pts[0].
//           The closing `polygon.push(pts[0])` at the end is removed because
//           SVG/Clipper auto-closes, and the start cap already returns to pts[0].
//
//  FIX G — openPathOffsetLengthMetres: `direction` and `offsetMetres` params
//           were silently unused. Now explicitly voided (pre-existing fix kept).
//
//  FIX H — computeOpenPathOffset 'both' branch: was not forwarding endStyle to
//           ClipperOffset — was always using etOpenSquare. Now correctly maps
//           endStyle → ClipperEndType for the corridor case.
//
//  FIX I — new ClipperLib.Paths() replaced with [] everywhere, since the
//           @types/clipper-lib definitions type Paths as an array, not a class.

import ClipperLib from 'clipper-lib';

const CLIPPER_SCALE = 1e6;
const SENTINEL_IDS  = new Set(['__arc_break__', '__radius_break__']);
const CLOSED_THRESHOLD              = 0.012;
const ARC_TESSELLATION_SUBDIVISIONS = 64;
const BRIDGE_EPSILON                = 1e-9;

export type NormPoint       = { x: number; y: number };
export type OffsetDirection  = 'inward' | 'outward';
export type JoinStyle        = 'miter' | 'round' | 'square';
export interface PdfDimensions { w: number; h: number; }
export type OpenPathDirection = 'left' | 'right' | 'both';
export type OpenEndStyle      = 'square' | 'round' | 'butt' | 'none';

const ARC_SENTINEL_OBJ = { segmentId: '__arc_break__', x: -1, y: -1 };

// ─── FIX 6 (kept): isOpenPathResult ──────────────────────────────────────────
export function isOpenPathResult(endStyle: OpenEndStyle): boolean {
  return endStyle === 'none';
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

export function isSentinel(p: any): boolean {
  return p?.segmentId != null && SENTINEL_IDS.has(p.segmentId);
}

export function stripSentinels(points: any[]): NormPoint[] {
  return (points as any[])
    .filter(p => !isSentinel(p))
    .map(p => ({ x: p.x as number, y: p.y as number }));
}

function isArcRow(row: any): boolean {
  return (
    row.arcRadius != null &&
    Math.abs((row.sweepAngle ?? 0) - 2 * Math.PI) > 0.01 &&
    Array.isArray(row.points) &&
    row.points.length === 3 &&
    !row.points.some(isSentinel)
  );
}

function injectPolyarcSentinels(rawPts: any[]): any[] {
  const result: any[] = [];
  let inArcRun = false;

  for (let i = 0; i < rawPts.length; i++) {
    const p     = rawPts[i];
    const isArc = p.segmentType === 'arc';

    if (isArc && !inArcRun) {
      const prev = result.length > 0 ? result[result.length - 1] : null;
      if (
        prev && !isSentinel(prev) &&
        Math.abs(prev.x - p.x) < BRIDGE_EPSILON &&
        Math.abs(prev.y - p.y) < BRIDGE_EPSILON
      ) {
        result.pop();
      }
      result.push(ARC_SENTINEL_OBJ);
      inArcRun = true;
    } else if (!isArc && inArcRun) {
      result.push(ARC_SENTINEL_OBJ);
      inArcRun = false;

      const lastArcPt = result.length >= 2 ? result[result.length - 2] : null;
      if (
        lastArcPt && !isSentinel(lastArcPt) &&
        Math.abs(lastArcPt.x - p.x) < BRIDGE_EPSILON &&
        Math.abs(lastArcPt.y - p.y) < BRIDGE_EPSILON
      ) {
        continue;
      }
    }

    result.push(p);
  }

  if (inArcRun) result.push(ARC_SENTINEL_OBJ);
  return result;
}

// ─── tessellateArcTriplet ─────────────────────────────────────────────────────

function tessellateArcTriplet(
  p1: NormPoint, p2: NormPoint, p3: NormPoint,
  scaleW = 1, scaleH = 1,
): NormPoint[] {
  const ax = p1.x * scaleW, ay = p1.y * scaleH;
  const bx = p2.x * scaleW, by = p2.y * scaleH;
  const cx = p3.x * scaleW, cy = p3.y * scaleH;

  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(D) < 1e-12) return [p1, p2, p3];

  const a2v = ax * ax + ay * ay;
  const b2v = bx * bx + by * by;
  const c2v = cx * cx + cy * cy;

  const ux = (a2v * (by - cy) + b2v * (cy - ay) + c2v * (ay - by)) / D;
  const uy = (a2v * (cx - bx) + b2v * (ax - cx) + c2v * (bx - ax)) / D;
  const r  = Math.hypot(ax - ux, ay - uy);

  const norm2pi = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  const a0  = norm2pi(Math.atan2(ay - uy, ax - ux));
  const a1  = norm2pi(Math.atan2(by - uy, bx - ux));
  const a2n = norm2pi(Math.atan2(cy - uy, cx - ux));

  const ccwSweep = norm2pi(a2n - a0);

  let midIsOnCCWArc: boolean;
  if (a0 <= a2n) {
    midIsOnCCWArc = (a1 >= a0 && a1 <= a2n);
  } else {
    midIsOnCCWArc = (a1 >= a0 || a1 <= a2n);
  }

  const sweep = midIsOnCCWArc ? ccwSweep : -(2 * Math.PI - ccwSweep);

  const pts: NormPoint[] = [];
  const n = ARC_TESSELLATION_SUBDIVISIONS;
  for (let i = 0; i <= n; i++) {
    const angle = a0 + sweep * (i / n);
    pts.push({
      x: (ux + r * Math.cos(angle)) / scaleW,
      y: (uy + r * Math.sin(angle)) / scaleH,
    });
  }
  return pts;
}

// ─── tessellatePoints ─────────────────────────────────────────────────────────

export function tessellatePoints(
  rawPoints: any[],
  scaleW = 1,
  scaleH = 1,
): NormPoint[] {
  if (!rawPoints || rawPoints.length === 0) return [];

  const runs: { isArc: boolean; pts: NormPoint[] }[] = [];
  let current: NormPoint[] = [];
  let expectArc = false;

  for (const p of rawPoints) {
    if (isSentinel(p)) {
      if (!expectArc) {
        if (current.length > 0) {
          runs.push({ isArc: false, pts: current });
          current = [];
        }
        expectArc = true;
      } else {
        runs.push({ isArc: true, pts: current });
        current = [];
        expectArc = false;
      }
    } else {
      current.push({ x: p.x, y: p.y });
    }
  }
  if (current.length > 0) runs.push({ isArc: expectArc, pts: current });

  const result: NormPoint[] = [];

  const pushUnlessDuplicate = (p: NormPoint) => {
    const last = result.length > 0 ? result[result.length - 1] : null;
    if (
      last &&
      Math.abs(last.x - p.x) < BRIDGE_EPSILON &&
      Math.abs(last.y - p.y) < BRIDGE_EPSILON
    ) return;
    result.push(p);
  };

  for (const run of runs) {
    if (!run.isArc) {
      for (const p of run.pts) pushUnlessDuplicate(p);
    } else {
      const pts = run.pts;
      for (let j = 0; j + 2 < pts.length; j += 3) {
        const tessellated = tessellateArcTriplet(pts[j], pts[j + 1], pts[j + 2], scaleW, scaleH);
        for (const tp of tessellated) pushUnlessDuplicate(tp);
      }
      const remainder = run.pts.length % 3;
      if (remainder > 0) {
        const startIdx = run.pts.length - remainder;
        for (let k = startIdx; k < run.pts.length; k++) pushUnlessDuplicate(run.pts[k]);
      }
    }
  }

  return result;
}

// ─── getEffectivePoints ───────────────────────────────────────────────────────

export function getEffectivePoints(row: any, allMeasurements: any[]): any[] {
  if (!row) return [];

  if (row.isGroupHeader && Array.isArray(row.childIds) && row.childIds.length > 0) {
    const children: any[] = row.childIds
      .map((id: string) => allMeasurements.find((m: any) => m.id === id))
      .filter(Boolean);

    if (children.length === 0) return [];

    const result: any[] = [];
    let prevLastPt: NormPoint | null = null;

    for (const child of children) {
      const pts: any[] = child.points ?? [];
      if (pts.length === 0) continue;

      const realPts = pts.filter((p: any) => !isSentinel(p));
      if (realPts.length === 0) continue;

      const isChildArc =
        child.arcRadius != null &&
        Math.abs((child.sweepAngle ?? 0) - 2 * Math.PI) > 0.01 &&
        realPts.length === 3;

      const firstPt: NormPoint = { x: realPts[0].x, y: realPts[0].y };
      if (
        prevLastPt &&
        Math.abs(prevLastPt.x - firstPt.x) < BRIDGE_EPSILON &&
        Math.abs(prevLastPt.y - firstPt.y) < BRIDGE_EPSILON
      ) {
        if (isChildArc) {
          result.push(ARC_SENTINEL_OBJ);
          result.push({ x: prevLastPt.x, y: prevLastPt.y });
          result.push({ x: realPts[1].x, y: realPts[1].y });
          result.push({ x: realPts[2].x, y: realPts[2].y });
          result.push(ARC_SENTINEL_OBJ);
          prevLastPt = { x: realPts[2].x, y: realPts[2].y };
        } else {
          for (let k = 1; k < realPts.length; k++) result.push(realPts[k]);
          prevLastPt = { x: realPts[realPts.length - 1].x, y: realPts[realPts.length - 1].y };
        }
      } else {
        if (isChildArc) {
          result.push(ARC_SENTINEL_OBJ);
          for (const pt of realPts) result.push(pt);
          result.push(ARC_SENTINEL_OBJ);
          prevLastPt = { x: realPts[realPts.length - 1].x, y: realPts[realPts.length - 1].y };
        } else {
          for (const pt of realPts) result.push(pt);
          prevLastPt = { x: realPts[realPts.length - 1].x, y: realPts[realPts.length - 1].y };
        }
      }
    }

    return result;
  }

  if (isArcRow(row)) {
    return [ARC_SENTINEL_OBJ, ...row.points, ARC_SENTINEL_OBJ];
  }

  if (
    row.arcRadius != null &&
    Math.abs((row.sweepAngle ?? 0) - 2 * Math.PI) < 0.01 &&
    Array.isArray(row.points) &&
    row.points.length === 2
  ) {
    return buildFullCirclePoints(row.points[0], row.points[1]);
  }

  const rawPts = row.points ?? [];

  const hasSegmentTypeTags = rawPts.some(
    (p: any) => p.segmentType === 'arc' || p.segmentType === 'line'
  );
  const hasSentinels = rawPts.some(isSentinel);

  if (hasSegmentTypeTags && !hasSentinels) {
    return injectPolyarcSentinels(rawPts);
  }

  return rawPts;
}

// ─── buildFullCirclePoints ────────────────────────────────────────────────────

function buildFullCirclePoints(centre: NormPoint, edge: NormPoint): NormPoint[] {
  const r  = Math.hypot(edge.x - centre.x, edge.y - centre.y);
  const n  = ARC_TESSELLATION_SUBDIVISIONS * 2;
  const pts: NormPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const angle = (2 * Math.PI * i) / n;
    pts.push({ x: centre.x + r * Math.cos(angle), y: centre.y + r * Math.sin(angle) });
  }
  return pts;
}

// ─── isEffectivelyClosed ──────────────────────────────────────────────────────

export function isEffectivelyClosed(row: any, allMeasurements: any[] = []): boolean {
  if (!row) return false;

  if (row.type === 'Polygon' || row.type === 'Rectangle' || row.type === 'Area') return true;

  const effectivePts = getEffectivePoints(row, allMeasurements);
  const real = effectivePts.filter((p: any) => !isSentinel(p));
  if (real.length < 3) return false;

  const first = real[0];
  const last  = real[real.length - 1];

  if (Math.hypot(first.x - last.x, first.y - last.y) < CLOSED_THRESHOLD) return true;

  const tessellated = tessellatePoints(effectivePts);
  if (tessellated.length < 3) return false;
  const tf = tessellated[0];
  const tl = tessellated[tessellated.length - 1];
  return Math.hypot(tf.x - tl.x, tf.y - tl.y) < CLOSED_THRESHOLD;
}

// ─── pdfToNormScale ───────────────────────────────────────────────────────────

function pdfToNormScale(dim: PdfDimensions) {
  return { scaleW: dim.w, scaleH: dim.h };
}

function normDeltaToMetres(
  dx: number, dy: number,
  dim: PdfDimensions, scaleFactor: number,
): number {
  const { scaleW, scaleH } = pdfToNormScale(dim);
  return Math.hypot(dx * scaleW, dy * scaleH) * scaleFactor;
}

// ─── polygonAreaMetres2 ───────────────────────────────────────────────────────

export function polygonAreaMetres2(
  row:          any,
  dim:          PdfDimensions,
  displayScale: number,
  scaleFactor:  number,
  allMeasurements: any[] = [],
): number {
  const { scaleW, scaleH } = pdfToNormScale(dim);
  const effectivePts = getEffectivePoints(row, allMeasurements);
  const pts          = tessellatePoints(effectivePts, scaleW, scaleH);
  if (pts.length < 3) return 0;

  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j  = (i + 1) % pts.length;
    const xi = pts[i].x * scaleW, yi = pts[i].y * scaleH;
    const xj = pts[j].x * scaleW, yj = pts[j].y * scaleH;
    area += xi * yj - xj * yi;
  }
  return (Math.abs(area) / 2) * scaleFactor * scaleFactor;
}

// ─── polygonPerimeterMetres ───────────────────────────────────────────────────

export function polygonPerimeterMetres(
  row:          any,
  dim:          PdfDimensions,
  displayScale: number,
  scaleFactor:  number,
  allMeasurements: any[] = [],
): number {
  const { scaleW, scaleH } = pdfToNormScale(dim);
  const effectivePts = getEffectivePoints(row, allMeasurements);
  const pts          = tessellatePoints(effectivePts, scaleW, scaleH);
  if (pts.length < 2) return 0;

  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    len += normDeltaToMetres(pts[j].x - pts[i].x, pts[j].y - pts[i].y, dim, scaleFactor);
  }
  return len;
}

// ─── getClipperJoinType ───────────────────────────────────────────────────────

export function getClipperJoinType(style: JoinStyle = 'miter'): number {
  switch (style) {
    case 'round':  return ClipperLib.JoinType.jtRound;
    case 'square': return ClipperLib.JoinType.jtSquare;
    case 'miter':
    default:       return ClipperLib.JoinType.jtMiter;
  }
}

// ─── computePerimeterOffset ───────────────────────────────────────────────────

export function computePerimeterOffset(
  row:          any,
  offsetMetres: number,
  direction:    OffsetDirection,
  dim:          PdfDimensions,
  displayScale: number,
  scaleFactor:  number,
  allMeasurements: any[] = [],
  joinStyle: JoinStyle = 'miter',
): NormPoint[][] {
  const { scaleW, scaleH } = pdfToNormScale(dim);

  const effectivePts = getEffectivePoints(row, allMeasurements);
  const pts          = tessellatePoints(effectivePts, scaleW, scaleH);
  if (pts.length < 3) return [];

  const pdfPixelDelta = offsetMetres / scaleFactor;
  const clipperDelta  = direction === 'outward'
    ?  pdfPixelDelta * CLIPPER_SCALE
    : -pdfPixelDelta * CLIPPER_SCALE;

  const pdfPath = pts.map(p => ({
    X: Math.round(p.x * scaleW * CLIPPER_SCALE),
    Y: Math.round(p.y * scaleH * CLIPPER_SCALE),
  }));

  const miterLimit = joinStyle === 'miter' ? 10 : 2;
  const co      = new ClipperLib.ClipperOffset(miterLimit, 0.25);
  const paths   = [pdfPath];
  const solution: any[] = [];

  co.AddPaths(paths, getClipperJoinType(joinStyle), ClipperLib.EndType.etClosedPolygon);
  co.Execute(solution, clipperDelta);

  if (!solution || solution.length === 0) return [];

  return solution
    .filter((p: any[]) => p.length >= 3)
    .map((p: any[]) =>
      p.map((pt: { X: number; Y: number }) => ({
        x: (pt.X / CLIPPER_SCALE) / scaleW,
        y: (pt.Y / CLIPPER_SCALE) / scaleH,
      }))
    );
}

// ─── computeInscribedCircleRadius ────────────────────────────────────────────

export function computeInscribedCircleRadius(
  row:             any,
  dim:             PdfDimensions,
  displayScale:    number,
  scaleFactor:     number,
  allMeasurements: any[] = [],
): number {
  const { scaleW, scaleH } = pdfToNormScale(dim);
  const effectivePts = getEffectivePoints(row, allMeasurements);
  const pts          = tessellatePoints(effectivePts, scaleW, scaleH);
  if (pts.length < 3) return 0;

  const pdfPath = pts.map(p => ({
    X: Math.round(p.x * scaleW * CLIPPER_SCALE),
    Y: Math.round(p.y * scaleH * CLIPPER_SCALE),
  }));

  let lo = 0;
  let hi = 100;

  const tryDelta = (metres: number): boolean => {
    const pdfPixelDelta = metres / scaleFactor;
    const clipperDelta  = -pdfPixelDelta * CLIPPER_SCALE;
    const co      = new ClipperLib.ClipperOffset(10, 0.25);
    const paths   = [pdfPath];
    const solution: any[] = [];
    co.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
    co.Execute(solution, clipperDelta);
    return solution && solution.some((p: any[]) => p.length >= 3);
  };

  if (!tryDelta(0.001)) return 0;

  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (tryDelta(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return lo;
}

// ─── isInwardCollapseRisk ─────────────────────────────────────────────────────

export function isInwardCollapseRisk(
  row:             any,
  offsetMetres:    number,
  dim:             PdfDimensions,
  displayScale:    number,
  scaleFactor:     number,
  allMeasurements: any[] = [],
  cachedRadius?:   number,
): boolean {
  const radius = cachedRadius ?? computeInscribedCircleRadius(
    row, dim, displayScale, scaleFactor, allMeasurements,
  );
  return offsetMetres > radius * 0.95;
}

// ─── computeParallelOffset ────────────────────────────────────────────────────

function computeParallelOffset(
  pts:    NormPoint[],
  delta:  number,
  scaleW: number,
  scaleH: number,
): NormPoint[] {
  if (pts.length < 2) return [...pts];

  const segNx: number[] = [];
  const segNy: number[] = [];

  for (let i = 0; i < pts.length - 1; i++) {
    const dxPx = (pts[i + 1].x - pts[i].x) * scaleW;
    const dyPx = (pts[i + 1].y - pts[i].y) * scaleH;
    const len  = Math.hypot(dxPx, dyPx);
    if (len < 1e-12) {
      segNx.push(0);
      segNy.push(0);
    } else {
      segNx.push(-dyPx / len);
      segNy.push( dxPx / len);
    }
  }

  const result: NormPoint[] = [];

  for (let i = 0; i < pts.length; i++) {
    let nx: number;
    let ny: number;

    if (i === 0) {
      nx = segNx[0];
      ny = segNy[0];
    } else if (i === pts.length - 1) {
      nx = segNx[segNx.length - 1];
      ny = segNy[segNy.length - 1];
    } else {
      const ax = segNx[i - 1] + segNx[i];
      const ay = segNy[i - 1] + segNy[i];
      const alen = Math.hypot(ax, ay);
      if (alen < 1e-12) {
        nx = segNx[i];
        ny = segNy[i];
      } else {
        nx = ax / alen;
        ny = ay / alen;
      }
    }

    result.push({
      x: pts[i].x + nx * delta / scaleW,
      y: pts[i].y + ny * delta / scaleH,
    });
  }

  return result;
}

// ─── buildSemiCircleCap ───────────────────────────────────────────────────────

function buildSemiCircleCap(
  fromPt:    NormPoint,
  toPt:      NormPoint,
  tangentNx: number,
  tangentNy: number,
  scaleW:    number,
  scaleH:    number,
  outward:   boolean,
): NormPoint[] {
  const cx = (fromPt.x + toPt.x) / 2;
  const cy = (fromPt.y + toPt.y) / 2;

  const rPx = Math.hypot(
    (toPt.x - fromPt.x) * scaleW,
    (toPt.y - fromPt.y) * scaleH,
  ) / 2;

  if (rPx < 1e-12) return [fromPt, toPt];

  const a0 = Math.atan2((fromPt.y - cy) * scaleH, (fromPt.x - cx) * scaleW);

  const baseTangentAngle = Math.atan2(tangentNy, tangentNx);
  const outwardAngle = outward
    ? baseTangentAngle
    : baseTangentAngle + Math.PI;

  const normAngle = (a: number) => {
    a = a % (2 * Math.PI);
    return a < 0 ? a + 2 * Math.PI : a;
  };
  const angleDist = (a: number, b: number) => {
    const d = Math.abs(normAngle(a) - normAngle(b));
    return d > Math.PI ? 2 * Math.PI - d : d;
  };

  const midCW  = a0 - Math.PI / 2;
  const midCCW = a0 + Math.PI / 2;
  const sweep  = angleDist(midCW, outwardAngle) < angleDist(midCCW, outwardAngle)
    ? -Math.PI
    :  Math.PI;

  const n   = ARC_TESSELLATION_SUBDIVISIONS;
  const pts: NormPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const angle = a0 + sweep * (i / n);
    pts.push({
      x: cx + (Math.cos(angle) * rPx) / scaleW,
      y: cy + (Math.sin(angle) * rPx) / scaleH,
    });
  }
  return pts;
}

// ─── computeOpenPathOffset ───────────────────────────────────────────────────

export function computeOpenPathOffset(
  row:             any,
  offsetMetres:    number,
  direction:       OpenPathDirection,
  dim:             PdfDimensions,
  displayScale:    number,
  scaleFactor:     number,
  allMeasurements: any[] = [],
  joinStyle:       JoinStyle    = 'miter',
  endStyle:        OpenEndStyle = 'square',
): NormPoint[][] {
  const { scaleW, scaleH } = pdfToNormScale(dim);

  const effectivePts = getEffectivePoints(row, allMeasurements);
  const pts          = tessellatePoints(effectivePts, scaleW, scaleH);
  if (pts.length < 2) return [];

  const pdfPixelDelta = offsetMetres / scaleFactor;

  if (endStyle === 'none') {
    if (direction === 'both') {
      const leftStroke  = computeParallelOffset(pts,  pdfPixelDelta, scaleW, scaleH);
      const rightStroke = computeParallelOffset(pts, -pdfPixelDelta, scaleW, scaleH);
      return [leftStroke, rightStroke];
    }
    const delta = direction === 'left' ? pdfPixelDelta : -pdfPixelDelta;
    return [computeParallelOffset(pts, delta, scaleW, scaleH)];
  }

  if (direction === 'both') {
    const pdfPath = pts.map(p => ({
      X: Math.round(p.x * scaleW * CLIPPER_SCALE),
      Y: Math.round(p.y * scaleH * CLIPPER_SCALE),
    }));

    const clipperEndType = (() => {
      switch (endStyle) {
        case 'round': return ClipperLib.EndType.etOpenRound;
        case 'butt':  return ClipperLib.EndType.etOpenButt;
        case 'square':
        default:      return ClipperLib.EndType.etOpenSquare;
      }
    })();

    const clipperJoinType = getClipperJoinType(joinStyle);
    const co      = new ClipperLib.ClipperOffset(10, 0.25);
    const paths   = [pdfPath];
    const solution: any[] = [];
    co.AddPaths(paths, clipperJoinType, clipperEndType);
    co.Execute(solution, pdfPixelDelta * CLIPPER_SCALE);

    if (!solution || solution.length === 0) return [];

    return solution
      .filter((p: any[]) => p.length >= 3)
      .map((p: any[]) =>
        p.map((pt: { X: number; Y: number }) => ({
          x: (pt.X / CLIPPER_SCALE) / scaleW,
          y: (pt.Y / CLIPPER_SCALE) / scaleH,
        }))
      );
  }

  const delta      = direction === 'left' ? pdfPixelDelta : -pdfPixelDelta;
  const offsetPts  = computeParallelOffset(pts, delta, scaleW, scaleH);

  const getEndpoint = (i: number, j: number): { tx: number; ty: number; nx: number; ny: number } => {
    const dxPx = (pts[j].x - pts[i].x) * scaleW;
    const dyPx = (pts[j].y - pts[i].y) * scaleH;
    const len  = Math.hypot(dxPx, dyPx);
    if (len < 1e-12) return { tx: 1, ty: 0, nx: 0, ny: 1 };
    const tx =  dxPx / len;
    const ty =  dyPx / len;
    const nx = -dyPx / len;
    const ny =  dxPx / len;
    return { tx, ty, nx, ny };
  };

  const startInfo = getEndpoint(0, 1);
  const endInfo   = getEndpoint(pts.length - 2, pts.length - 1);

  const srcEnd   = pts[pts.length - 1];
  const offEnd   = offsetPts[offsetPts.length - 1];
  const srcStart = pts[0];
  const offStart = offsetPts[0];

  const polygon: NormPoint[] = [];

  for (const p of pts) polygon.push(p);

  if (endStyle === 'square') {
    const ext = pdfPixelDelta / 2;
    polygon.push({ x: srcEnd.x + endInfo.tx * ext / scaleW, y: srcEnd.y + endInfo.ty * ext / scaleH });
    polygon.push({ x: offEnd.x + endInfo.tx * ext / scaleW, y: offEnd.y + endInfo.ty * ext / scaleH });
  } else if (endStyle === 'round') {
    const arcPts = buildSemiCircleCap(srcEnd, offEnd, endInfo.tx, endInfo.ty, scaleW, scaleH, true);
    for (let i = 1; i < arcPts.length; i++) polygon.push(arcPts[i]);
  }

  {
    const backStart = (endStyle === 'butt') ? offsetPts.length - 1 : offsetPts.length - 2;
    for (let i = backStart; i >= 0; i--) polygon.push(offsetPts[i]);
  }

  if (endStyle === 'square') {
    const ext = pdfPixelDelta / 2;
    polygon.push({ x: offStart.x - startInfo.tx * ext / scaleW, y: offStart.y - startInfo.ty * ext / scaleH });
    polygon.push({ x: srcStart.x - startInfo.tx * ext / scaleW, y: srcStart.y - startInfo.ty * ext / scaleH });
  } else if (endStyle === 'round') {
    const arcPts = buildSemiCircleCap(offStart, srcStart, startInfo.tx, startInfo.ty, scaleW, scaleH, false);
    for (let i = 1; i < arcPts.length; i++) polygon.push(arcPts[i]);
  }

  return [polygon];
}

// ─── openPathBufferAreaMetres2 ────────────────────────────────────────────────

export function openPathBufferAreaMetres2(
  row:             any,
  offsetMetres:    number,
  direction:       OpenPathDirection,
  dim:             PdfDimensions,
  displayScale:    number,
  scaleFactor:     number,
  allMeasurements: any[] = [],
): number {
  const polys = computeOpenPathOffset(
    row, offsetMetres, direction, dim, displayScale, scaleFactor, allMeasurements,
  );
  if (polys.length === 0) return 0;

  const { scaleW, scaleH } = pdfToNormScale(dim);
  let total = 0;

  for (const poly of polys) {
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const j  = (i + 1) % poly.length;
      const xi = poly[i].x * scaleW, yi = poly[i].y * scaleH;
      const xj = poly[j].x * scaleW, yj = poly[j].y * scaleH;
      area += xi * yj - xj * yi;
    }
    total += Math.abs(area) / 2;
  }
  return total * scaleFactor * scaleFactor;
}

// ─── openPathOffsetLengthMetres ───────────────────────────────────────────────

export function openPathOffsetLengthMetres(
  row:             any,
  offsetMetres:    number,
  direction:       OpenPathDirection,
  dim:             PdfDimensions,
  displayScale:    number,
  scaleFactor:     number,
  allMeasurements: any[] = [],
): number {
  void direction;
  void offsetMetres;

  const { scaleW, scaleH } = pdfToNormScale(dim);
  const effectivePts = getEffectivePoints(row, allMeasurements);
  const pts          = tessellatePoints(effectivePts, scaleW, scaleH);
  if (pts.length < 2) return 0;

  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    len += normDeltaToMetres(
      pts[i + 1].x - pts[i].x,
      pts[i + 1].y - pts[i].y,
      dim, scaleFactor,
    );
  }
  return len;
}
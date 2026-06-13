'use client';
// ─── hooks/perimeterOffset/perimeterOffsetGeometry.ts ────────────────────────
//
//  FIXES vs previous version
//  ──────────────────────────
//  FIX 1 — openPathOffsetLengthMetres: `direction` and `offsetMetres` params
//           were accepted but never used. Both are now explicitly voided.
//
//  FIX 2 — computeOpenPathOffset: the 'both' (corridor) direction now
//           correctly forwards the endStyle/clipperEndType to ClipperOffset.
//           Previously the 'both' branch always used etOpenSquare (the
//           default local) rather than the computed clipperEndType, meaning
//           square/round/butt looked identical for corridor offsets.
//
//  FIX 3 — computeOpenPathOffset: left/right single-side now uses an
//           EXPLICIT POLYGON CONSTRUCTION rather than XOR-split. The offset
//           polyline is computed by shifting source points perpendicularly,
//           then capping the ends according to endStyle (square = extend by
//           offsetMetres, round = semicircle arc, butt = flush). The result
//           is a single closed polygon: source fwd + cap + offset reversed +
//           cap. This is geometrically correct and doesn't rely on XOR.
//
//  FIX 4 — computeOpenPathOffset: left/right direction is now correct for
//           screen space (Y-down). 'left' = cross product < 0 relative to
//           forward direction. Normal is (-dy, dx) / len in screen space.
//           'right' = opposite. This matches the 'none' endStyle behavior.
//
//  FIX 5 — OpenEndStyle gains a new 'none' value. When endStyle === 'none'
//           computeOpenPathOffset bypasses ClipperOffset entirely and instead
//           shifts each polyline point perpendicular to the local tangent by
//           offsetMetres. For direction='both' it returns two open strokes
//           (one each side). For direction='left'/'right' it returns a single
//           open stroke. No closing segment is ever drawn — the result is two
//           raw parallel open paths with no cap whatsoever.
//
//  FIX 6 — isOpenPathResult: new exported helper. Returns true only when
//           endStyle === 'none'. For all other cap styles (square/round/butt)
//           the result is a CLOSED polygon and should be rendered/measured as
//           such (filled area for area output types).

import ClipperLib from 'clipper-lib';

const CLIPPER_SCALE = 1e6;
const SENTINEL_IDS  = new Set(['__arc_break__', '__radius_break__']);
const CLOSED_THRESHOLD            = 0.012;
const ARC_TESSELLATION_SUBDIVISIONS = 64;
const BRIDGE_EPSILON              = 1e-9;

export type NormPoint      = { x: number; y: number };
export type OffsetDirection = 'inward' | 'outward';
export type JoinStyle       = 'miter' | 'round' | 'square';

export interface PdfDimensions { w: number; h: number; }

export type OpenPathDirection = 'left' | 'right' | 'both';
// FIX 5: added 'none' — produces two raw parallel open strokes, no caps
export type OpenEndStyle = 'square' | 'round' | 'butt' | 'none';

const ARC_SENTINEL_OBJ = { segmentId: '__arc_break__', x: -1, y: -1 };

// ─── FIX 6: isOpenPathResult ──────────────────────────────────────────────────
//
//  Returns true ONLY when endStyle === 'none'.
//  For square / round / butt the result geometry is a CLOSED polygon
//  (either a corridor strip or a one-side strip with caps), so callers
//  should treat it as closed — render filled, measure as area, etc.

export function isOpenPathResult(endStyle: OpenEndStyle): boolean {
  return endStyle === 'none';
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isSentinel(p: any): boolean {
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

function pdfToNormScale(dim: PdfDimensions, _displayScale: number) {
  return { scaleW: dim.w, scaleH: dim.h };
}

function normDeltaToMetres(
  dx: number, dy: number,
  dim: PdfDimensions, displayScale: number, scaleFactor: number,
): number {
  const { scaleW, scaleH } = pdfToNormScale(dim, displayScale);
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
  const { scaleW, scaleH } = pdfToNormScale(dim, displayScale);
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
  const { scaleW, scaleH } = pdfToNormScale(dim, displayScale);
  const effectivePts = getEffectivePoints(row, allMeasurements);
  const pts          = tessellatePoints(effectivePts, scaleW, scaleH);
  if (pts.length < 2) return 0;

  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    len += normDeltaToMetres(pts[j].x - pts[i].x, pts[j].y - pts[i].y, dim, displayScale, scaleFactor);
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
  const { scaleW, scaleH } = pdfToNormScale(dim, displayScale);

  const effectivePts = getEffectivePoints(row, allMeasurements);
  const pts          = tessellatePoints(effectivePts, scaleW, scaleH);
  if (pts.length < 3) return [];

  const pdfPixelDelta = (offsetMetres / scaleFactor) * displayScale;
  const clipperDelta  = direction === 'outward'
    ?  pdfPixelDelta * CLIPPER_SCALE
    : -pdfPixelDelta * CLIPPER_SCALE;

  const pdfPath = pts.map(p => ({
    X: Math.round(p.x * scaleW * CLIPPER_SCALE),
    Y: Math.round(p.y * scaleH * CLIPPER_SCALE),
  }));

  const miterLimit = joinStyle === 'miter' ? 10 : 2;
  const co    = new ClipperLib.ClipperOffset(miterLimit, 0.25);
  const paths = new ClipperLib.Paths();
  paths.push(pdfPath);

  co.AddPaths(paths, getClipperJoinType(joinStyle), ClipperLib.EndType.etClosedPolygon);

  const solution = new ClipperLib.Paths();
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
  const { scaleW, scaleH } = pdfToNormScale(dim, displayScale);
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
    const pdfPixelDelta = (metres / scaleFactor) * displayScale;
    const clipperDelta  = -pdfPixelDelta * CLIPPER_SCALE;
    const co    = new ClipperLib.ClipperOffset(10, 0.25);
    const paths = new ClipperLib.Paths();
    paths.push(pdfPath);
    co.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
    const solution = new ClipperLib.Paths();
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
//
//  Shifts every point of a polyline perpendicularly by `delta` in pdf-pixel
//  space. Positive delta = left side (screen Y-down: left normal is (-dy, dx)).
//  The perpendicular at each interior vertex is the miter of the two adjacent
//  segment normals, re-normalised.
//
//  scaleW / scaleH are used only for correct aspect-ratio handling of the
//  normal computation; the result is returned in normalised (0..1) space.

function computeParallelOffset(
  pts:     NormPoint[],
  delta:   number,    // pdf-pixel space distance; positive = left in screen Y-down
  scaleW:  number,
  scaleH:  number,
): NormPoint[] {
  if (pts.length < 2) return pts;

  // Per-segment unit normals in normalised space.
  // In screen Y-down: left normal of (dx,dy) is (-dy, dx)/len.
  // We work in pdf-pixel space for correct aspect ratio then convert back.
  const segNormals: NormPoint[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dxPx = (pts[i + 1].x - pts[i].x) * scaleW;
    const dyPx = (pts[i + 1].y - pts[i].y) * scaleH;
    const len  = Math.hypot(dxPx, dyPx);
    if (len < 1e-12) {
      segNormals.push({ x: 0, y: 0 });
    } else {
      // Left normal in pdf-pixel space: (-dyPx, dxPx) / len
      // Convert back to normalised space: divide by scaleW, scaleH respectively
      segNormals.push({
        x: (-dyPx / len) / scaleW,
        y: ( dxPx / len) / scaleH,
      });
    }
  }

  const result: NormPoint[] = [];

  for (let i = 0; i < pts.length; i++) {
    let nx: number, ny: number;

    if (i === 0) {
      nx = segNormals[0].x;
      ny = segNormals[0].y;
    } else if (i === pts.length - 1) {
      nx = segNormals[segNormals.length - 1].x;
      ny = segNormals[segNormals.length - 1].y;
    } else {
      // Average adjacent normals then re-normalise in pdf-pixel space
      const ax = segNormals[i - 1].x + segNormals[i].x;
      const ay = segNormals[i - 1].y + segNormals[i].y;
      const aPxLen = Math.hypot(ax * scaleW, ay * scaleH);
      if (aPxLen < 1e-12) {
        nx = segNormals[i].x;
        ny = segNormals[i].y;
      } else {
        nx = (ax * scaleW / aPxLen) / scaleW;
        ny = (ay * scaleH / aPxLen) / scaleH;
      }
    }

    // delta is in pdf-pixel space; convert to normalised offset
    // by multiplying normalised normal by (delta / scaleW, delta / scaleH)
    // but normal is already normalised in pdf-pixel space so:
    result.push({
      x: pts[i].x + nx * delta / scaleW,
      y: pts[i].y + ny * delta / scaleH,
    });
  }

  return result;
}

// ─── buildSemiCircleCap ───────────────────────────────────────────────────────
//
//  Generates a semicircle arc cap at `centre` point. The arc goes from
//  `fromPt` to `toPt` sweeping around centre on the cap side.
//  Used for 'round' end style on left/right single-side offsets.

function buildSemiCircleCap(
  centre: NormPoint,
  fromPt: NormPoint,
  toPt:   NormPoint,
  scaleW: number,
  scaleH: number,
  clockwise: boolean,
): NormPoint[] {
  const r    = Math.hypot((fromPt.x - centre.x) * scaleW, (fromPt.y - centre.y) * scaleH);
  const rNx  = r / scaleW;
  const rNy  = r / scaleH;
  const a0   = Math.atan2((fromPt.y - centre.y) * scaleH, (fromPt.x - centre.x) * scaleW);
  const a1   = Math.atan2((toPt.y   - centre.y) * scaleH, (toPt.x   - centre.x) * scaleW);

  const norm2pi = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = norm2pi(a1 - a0);
  if (clockwise && sweep > 0) sweep -= 2 * Math.PI;
  if (!clockwise && sweep < 0) sweep += 2 * Math.PI;

  const n   = ARC_TESSELLATION_SUBDIVISIONS;
  const pts: NormPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const angle = a0 + sweep * (i / n);
    pts.push({
      x: centre.x + Math.cos(angle) * rNx,
      y: centre.y + Math.sin(angle) * rNy,
    });
  }
  return pts;
}

// ─── computeOpenPathOffset ───────────────────────────────────────────────────
//
//  Computes offset geometry for open paths.
//
//  direction = 'both':
//    Returns a single closed polygon (full corridor strip) using ClipperOffset
//    with the chosen endStyle cap. This is always a closed polygon.
//
//  direction = 'left' | 'right':
//    FIX 3/4: Builds an EXPLICIT closed polygon:
//      1. Shift source pts perpendicularly (correct screen-Y-down direction)
//      2. Cap the end: square (extend ½ offset), round (semicircle), butt (flush)
//      3. Reverse source pts form the "other side" of the polygon
//      4. Cap the start similarly
//    This gives a geometrically correct closed area polygon without relying
//    on XOR-splitting a full buffer.
//
//  direction = any, endStyle = 'none':
//    FIX 5: Bypasses Clipper. Returns raw open parallel stroke(s).
//    For 'both': two open strokes. For 'left'/'right': one open stroke.

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
  const { scaleW, scaleH } = pdfToNormScale(dim, displayScale);

  const effectivePts = getEffectivePoints(row, allMeasurements);
  const pts          = tessellatePoints(effectivePts, scaleW, scaleH);
  if (pts.length < 2) return [];

  // pdfPixelDelta: the offset distance in pdf-pixel space
  const pdfPixelDelta = (offsetMetres / scaleFactor) * displayScale;

  // ── FIX 5: 'none' — pure parallel translation, no caps, open strokes ──────
  if (endStyle === 'none') {
    if (direction === 'both') {
      const leftStroke  = computeParallelOffset(pts,  pdfPixelDelta, scaleW, scaleH);
      const rightStroke = computeParallelOffset(pts, -pdfPixelDelta, scaleW, scaleH);
      return [leftStroke, rightStroke];
    }
    // FIX 4: left = positive (left normal in Y-down), right = negative
    const delta = direction === 'left' ? pdfPixelDelta : -pdfPixelDelta;
    return [computeParallelOffset(pts, delta, scaleW, scaleH)];
  }

  // ── 'both': use ClipperOffset for a full corridor polygon ─────────────────
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
    const co    = new ClipperLib.ClipperOffset(10, 0.25);
    const paths = new ClipperLib.Paths();
    paths.push(pdfPath);
    co.AddPaths(paths, clipperJoinType, clipperEndType);
    const solution = new ClipperLib.Paths();
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

  // ── 'left' or 'right': explicit closed polygon construction ───────────────
  //
  // FIX 3 + FIX 4: Build the one-side strip as an explicit closed polygon:
  //   Forward along source pts → end cap → backward along offset pts → start cap
  //
  // In screen Y-down space:
  //   left  = positive pdfPixelDelta (left normal = (-dy, dx)/len)
  //   right = negative pdfPixelDelta

  const delta = direction === 'left' ? pdfPixelDelta : -pdfPixelDelta;
  const offsetPts = computeParallelOffset(pts, delta, scaleW, scaleH);

  // Helper: unit tangent at the start/end of the source polyline (pdf-pixel)
  const startTangent = (() => {
    const dx = (pts[1].x - pts[0].x) * scaleW;
    const dy = (pts[1].y - pts[0].y) * scaleH;
    const len = Math.hypot(dx, dy);
    return len > 1e-12 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
  })();
  const endTangent = (() => {
    const n  = pts.length - 1;
    const dx = (pts[n].x - pts[n - 1].x) * scaleW;
    const dy = (pts[n].y - pts[n - 1].y) * scaleH;
    const len = Math.hypot(dx, dy);
    return len > 1e-12 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
  })();

  const polygon: NormPoint[] = [];

  // 1. Forward along source pts (the "zero" side of the strip)
  for (const p of pts) polygon.push(p);

  // 2. End cap at pts[last] → offsetPts[last]
  const srcEnd    = pts[pts.length - 1];
  const offEnd    = offsetPts[offsetPts.length - 1];
  const srcStart  = pts[0];
  const offStart  = offsetPts[0];

  if (endStyle === 'square') {
    // Extend ½ offset beyond endpoint along tangent, then across to offset side
    const ext = pdfPixelDelta; // extend by full offset (square cap extends ½ width on each side)
    const capSrcEnd: NormPoint = {
      x: srcEnd.x + endTangent.x * ext / scaleW,
      y: srcEnd.y + endTangent.y * ext / scaleH,
    };
    const capOffEnd: NormPoint = {
      x: offEnd.x + endTangent.x * ext / scaleW,
      y: offEnd.y + endTangent.y * ext / scaleH,
    };
    polygon.push(capSrcEnd);
    polygon.push(capOffEnd);
  } else if (endStyle === 'round') {
    // Semicircle cap centred at midpoint of srcEnd–offEnd
    const capCentre: NormPoint = {
      x: (srcEnd.x + offEnd.x) / 2,
      y: (srcEnd.y + offEnd.y) / 2,
    };
    // Arc goes from srcEnd to offEnd sweeping outward (away from line body)
    // Clockwise in screen Y-down when delta > 0 (left side)
    const arcPts = buildSemiCircleCap(
      capCentre, srcEnd, offEnd,
      scaleW, scaleH,
      delta > 0, // clockwise for left, ccw for right
    );
    for (const p of arcPts) polygon.push(p);
  } else {
    // butt: straight line from srcEnd to offEnd (already handled by polygon closure)
    polygon.push(offEnd);
  }

  // 3. Backward along offset pts
  for (let i = offsetPts.length - 1; i >= 0; i--) {
    polygon.push(offsetPts[i]);
  }

  // 4. Start cap at offsetPts[0] → pts[0]
  if (endStyle === 'square') {
    const ext = pdfPixelDelta;
    const capOffStart: NormPoint = {
      x: offStart.x - startTangent.x * ext / scaleW,
      y: offStart.y - startTangent.y * ext / scaleH,
    };
    const capSrcStart: NormPoint = {
      x: srcStart.x - startTangent.x * ext / scaleW,
      y: srcStart.y - startTangent.y * ext / scaleH,
    };
    polygon.push(capOffStart);
    polygon.push(capSrcStart);
  } else if (endStyle === 'round') {
    const capCentre: NormPoint = {
      x: (offStart.x + srcStart.x) / 2,
      y: (offStart.y + srcStart.y) / 2,
    };
    const arcPts = buildSemiCircleCap(
      capCentre, offStart, srcStart,
      scaleW, scaleH,
      delta > 0,
    );
    for (const p of arcPts) polygon.push(p);
  } else {
    // butt
    polygon.push(srcStart);
  }

  // Close the polygon back to first point
  polygon.push(pts[0]);

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

  const { scaleW, scaleH } = pdfToNormScale(dim, displayScale);
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
//
//  FIX 1: `direction` and `offsetMetres` were accepted but ignored, causing
//  strict-mode warnings. Both are now explicitly voided.

export function openPathOffsetLengthMetres(
  row:             any,
  offsetMetres:    number,
  direction:       OpenPathDirection,
  dim:             PdfDimensions,
  displayScale:    number,
  scaleFactor:     number,
  allMeasurements: any[] = [],
): number {
  // For parallel-length output: the offset line length ≈ source polyline length
  // for all direction values ('left', 'right', 'both').
  void direction;
  void offsetMetres;

  const { scaleW, scaleH } = pdfToNormScale(dim, displayScale);
  const effectivePts = getEffectivePoints(row, allMeasurements);
  const pts          = tessellatePoints(effectivePts, scaleW, scaleH);
  if (pts.length < 2) return 0;

  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    len += normDeltaToMetres(
      pts[i + 1].x - pts[i].x,
      pts[i + 1].y - pts[i].y,
      dim, displayScale, scaleFactor,
    );
  }
  return len;
}
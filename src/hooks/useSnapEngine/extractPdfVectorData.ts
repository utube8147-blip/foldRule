// hooks/useSnapEngine/extractPdfVectorData.ts
//
// TRUE VECTOR EXTRACTION — full rewrite
//
// Goal: extract every drawn line, arc, and curve from a digital PDF
// (ArchiCAD, Revit, AutoCAD) as exact segments with real coordinates,
// so the caller can run their own room-detection / snap logic on top.
//
// What this file produces:
//   RawSegment[]  — every individual line/curve segment with endpoints,
//                   stroke width, angle, length, isCurve flag
//   Wall[]        — paired parallel lines merged into wall centerlines
//                   with thickness + door/window openings detected
//   VectorTextItem[] — text positions (room labels, dimensions)
//   VectorRoom[]  — rooms built from text labels + wall geometry
//
// Key design decisions vs old code:
//   OLD: collect all path points → emit one AABB per stroke command
//   NEW: emit one RawSegment per consecutive point pair
//
//   OLD: ignore lineWidth (graphics state not tracked)
//   NEW: full graphics state stack tracks lineWidth, so wall thickness
//        is available on every segment
//
//   OLD: bezier curves ignored / collapsed to AABB
//   NEW: cubic beziers flattened to polyline at configurable resolution
//
//   OLD: no wall pairing, no opening detection
//   NEW: parallel-line pairing → Wall centerlines; gap/arc detection → openings
//
// Coordinate systems:
//   PDF user space: origin bottom-left, Y up.
//   We store raw coords in PDF points AND normalised [0,1] top-left origin.
//   nx = x / W,  ny = 1 - y / H
// ─────────────────────────────────────────────────────────────────────────────

import type { PDFPageProxy } from 'pdfjs-dist';

// ─── Public types ──────────────────────────────────────────────────────────────

/**
 * A single drawn line or flattened curve segment.
 * This is the atomic unit — everything else is built from these.
 */
export interface RawSegment {
  // PDF point coordinates (for measurement / scale)
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  // Normalised [0,1] top-left origin (for rendering)
  nx0: number;
  ny0: number;
  nx1: number;
  ny1: number;
  // Graphics state at time of stroke
  strokeWidth: number;   // PDF points — use this to identify wall lines vs annotation lines
  // Derived geometry (computed once, cached)
  angle: number;         // radians [0, π) — normalised so angle is always in first two quadrants
  length: number;        // PDF points
  isCurve: boolean;      // true if this segment was flattened from a bezier
}

/**
 * An opening (door or window) detected in a wall.
 * t is the parametric position along the wall centerline [0,1].
 */
export interface Opening {
  t: number;             // position along wall centerline
  width: number;         // PDF points
  type: 'door' | 'window' | 'unknown';
}

/**
 * A wall: two parallel RawSegments merged into a single centerline.
 */
export interface Wall {
  // Centerline in PDF points
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
  // Centerline normalised
  ncx0: number;
  ncy0: number;
  ncx1: number;
  ncy1: number;
  thickness: number;     // PDF points (distance between the two source lines)
  angle: number;         // radians [0, π)
  length: number;        // PDF points
  openings: Opening[];
  sourceA: RawSegment;   // the two lines that were merged
  sourceB: RawSegment;
}

export interface VectorTextItem {
  text: string;
  x:    number;          // PDF points
  y:    number;
  nx:   number;          // normalised
  ny:   number;
}

export interface VectorRoom {
  polygon:  Array<{ nx: number; ny: number }>;
  areaNorm: number;
  areaSqM:  number | null;
  label:    string;
  centroid: { nx: number; ny: number };
  source:   'vector';
}

export interface VectorExtractionResult {
  segments:  RawSegment[];   // every individual line/curve segment
  walls:     Wall[];         // paired wall centerlines with thickness
  rooms:     VectorRoom[];
  textItems: VectorTextItem[];
  isVector:  boolean;
  pageWidth:  number;        // PDF points — use for scale calculations
  pageHeight: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const PT_TO_M                  = (1 / 72) * 0.0254;
const MIN_TEXT_ITEMS_FOR_VECTOR = 3;
const BEZIER_FLATTEN_STEPS     = 12;   // segments per cubic bezier curve
const MIN_SEGMENT_LENGTH_PT    = 0.5;  // ignore sub-pixel noise (PDF points)

// Wall pairing thresholds
const WALL_ANGLE_TOLERANCE_RAD = 0.035;  // ~2 degrees
const WALL_MAX_THICKNESS_PT    = 60;     // ignore pairs farther apart than this
const WALL_MIN_THICKNESS_PT    = 0.5;    // ignore degenerate pairs
const WALL_OVERLAP_RATIO       = 0.4;    // parallel lines must overlap ≥40% of shorter length

// Opening detection
const DOOR_MAX_WIDTH_PT        = 120;
const DOOR_MIN_WIDTH_PT        = 15;
const WINDOW_MAX_WIDTH_PT      = 200;

// Room reconstruction
const SEGMENT_SEARCH_RADIUS    = 0.18;
const MAX_ROOM_AREA_NORM       = 0.80;
const MIN_ROOM_AREA_NORM       = 0.002;
const MAX_ASPECT_RATIO         = 8;

// ─── PDF.js OPS codes ──────────────────────────────────────────────────────────
// Hardcoded to avoid bundler issues with pdfjs-dist internal imports.
// Source: https://github.com/mozilla/pdf.js/blob/master/src/core/evaluator.js

const OPS = {
  // Path construction
  moveTo:          14,
  lineTo:          15,
  curveTo:         16,   // c: x1 y1 x2 y2 x3 y3
  curveTo2:        17,   // v: (current) x2 y2 x3 y3
  curveTo3:        18,   // y: x1 y1 x3 y3 (last CP = endpoint)
  closePath:       19,
  rectangle:       20,   // re: x y w h
  // Path painting
  stroke:          21,
  closeStroke:     22,
  fill:            23,
  eoFill:          24,
  fillStroke:      25,
  eoFillStroke:    26,
  closeFillStroke: 27,
  endPath:         29,
  // Graphics state
  save:            30,
  restore:         31,
  transform:       32,   // cm: a b c d e f
  setLineWidth:    38,   // w: lineWidth
  // Clipping
  clip:            33,
  eoClip:          34,
} as const;

// ─── Matrix math ───────────────────────────────────────────────────────────────

type Matrix = [number, number, number, number, number, number];
// [a, b, c, d, e, f] →  x' = a*x + c*y + e
//                        y' = b*x + d*y + f

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ];
}

function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

// ─── Graphics state stack ──────────────────────────────────────────────────────

interface GState {
  ctm:       Matrix;
  lineWidth: number;
}

function cloneGState(s: GState): GState {
  return { ctm: [...s.ctm] as Matrix, lineWidth: s.lineWidth };
}

// ─── Geometry helpers ──────────────────────────────────────────────────────────

function segmentAngle(x0: number, y0: number, x1: number, y1: number): number {
  let a = Math.atan2(y1 - y0, x1 - x0);
  if (a < 0) a += Math.PI;
  if (a >= Math.PI) a -= Math.PI;
  return a;
}

function segmentLength(x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  return Math.sqrt(dx * dx + dy * dy);
}

function perpDistance(
  ax0: number, ay0: number, ax1: number, ay1: number,
  bx0: number, by0: number,
): number {
  // Perpendicular distance from point (bx0,by0) to line through (ax0,ay0)→(ax1,ay1)
  const dx = ax1 - ax0, dy = ay1 - ay0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-9) return segmentLength(ax0, ay0, bx0, by0);
  return Math.abs((by0 - ay0) * dx - (bx0 - ax0) * dy) / len;
}

function projectOntoSegment(
  ax0: number, ay0: number, ax1: number, ay1: number,
  px: number, py: number,
): number {
  // Returns t ∈ [0,1] of the projection of P onto segment A
  const dx = ax1 - ax0, dy = ay1 - ay0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return 0;
  return Math.max(0, Math.min(1, ((px - ax0) * dx + (py - ay0) * dy) / lenSq));
}

// ─── Bezier flattening ─────────────────────────────────────────────────────────

interface Pt { x: number; y: number }

function flattenCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, steps = BEZIER_FLATTEN_STEPS): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t  = i / steps;
    const mt = 1 - t;
    pts.push({
      x: mt ** 3 * p0.x + 3 * mt ** 2 * t * p1.x + 3 * mt * t ** 2 * p2.x + t ** 3 * p3.x,
      y: mt ** 3 * p0.y + 3 * mt ** 2 * t * p1.y + 3 * mt * t ** 2 * p2.y + t ** 3 * p3.y,
    });
  }
  return pts;
}

// ─── Core: operator list → RawSegment[] ───────────────────────────────────────

function extractRawSegments(
  fnArray:   number[],
  argsArray: any[][],
  pageW:     number,
  pageH:     number,
): RawSegment[] {

  const segments: RawSegment[] = [];

  // Graphics state stack
  const stateStack: GState[] = [];
  let state: GState = { ctm: IDENTITY, lineWidth: 1 };

  // Current path
  interface PathPoint { x: number; y: number; isCurve: boolean }
  let path:         PathPoint[] = [];
  let subpathStart: Pt | null   = null;
  let cursor:       Pt          = { x: 0, y: 0 };

  // Transform a raw PDF point through CTM and normalise
  function transformPt(x: number, y: number): Pt {
    const [tx, ty] = applyMatrix(state.ctm, x, y);
    return { x: tx, y: ty };
  }

  function normalise(x: number, y: number): { nx: number; ny: number } {
    return {
      nx: Math.max(0, Math.min(1, x / pageW)),
      ny: Math.max(0, Math.min(1, 1 - y / pageH)),
    };
  }

  function addPoint(x: number, y: number, isCurve = false) {
    cursor = { x, y };
    path.push({ x, y, isCurve });
  }

  function addCurvePoints(pts: Pt[]) {
    for (const p of pts) path.push({ x: p.x, y: p.y, isCurve: true });
    if (pts.length > 0) cursor = pts[pts.length - 1];
  }

  function emitPath(isPainted: boolean) {
    if (!isPainted || path.length < 2) { path = []; return; }

    const sw = state.lineWidth;

    for (let i = 0; i < path.length - 1; i++) {
      const a = transformPt(path[i].x, path[i].y);
      const b = transformPt(path[i + 1].x, path[i + 1].y);

      const len = segmentLength(a.x, a.y, b.x, b.y);
      if (len < MIN_SEGMENT_LENGTH_PT) continue;

      const { nx: nx0, ny: ny0 } = normalise(a.x, a.y);
      const { nx: nx1, ny: ny1 } = normalise(b.x, b.y);

      segments.push({
        x0: a.x,  y0: a.y,
        x1: b.x,  y1: b.y,
        nx0, ny0, nx1, ny1,
        strokeWidth: sw,
        angle:  segmentAngle(a.x, a.y, b.x, b.y),
        length: len,
        isCurve: path[i].isCurve || path[i + 1].isCurve,
      });
    }

    path = [];
  }

  function discardPath() { path = []; }

  for (let i = 0; i < fnArray.length; i++) {
    const fn   = fnArray[i];
    const args = argsArray[i] ?? [];

    switch (fn) {

      // ── Graphics state ──────────────────────────────────────────────────
      case OPS.save:
        stateStack.push(cloneGState(state));
        break;

      case OPS.restore:
        state = stateStack.pop() ?? { ctm: IDENTITY, lineWidth: 1 };
        break;

      case OPS.transform: {
        const m: Matrix = [args[0], args[1], args[2], args[3], args[4], args[5]];
        state.ctm = multiplyMatrix(state.ctm, m);
        break;
      }

      case OPS.setLineWidth:
        state.lineWidth = args[0] ?? 1;
        break;

      // ── Path construction ────────────────────────────────────────────────
      case OPS.moveTo:
        // Start fresh subpath — do NOT connect to previous cursor
        path = [];
        subpathStart = { x: args[0], y: args[1] };
        cursor       = subpathStart;
        addPoint(args[0], args[1]);
        break;

      case OPS.lineTo:
        addPoint(args[0], args[1]);
        break;

      case OPS.curveTo: {
        // c: x1 y1 x2 y2 x3 y3
        const pts = flattenCubic(
          { x: cursor.x, y: cursor.y },
          { x: args[0],  y: args[1]  },
          { x: args[2],  y: args[3]  },
          { x: args[4],  y: args[5]  },
        );
        addCurvePoints(pts.slice(1)); // skip first (already in path as cursor)
        break;
      }

      case OPS.curveTo2: {
        // v: first CP = current point
        const pts = flattenCubic(
          { x: cursor.x, y: cursor.y },
          { x: cursor.x, y: cursor.y },
          { x: args[0],  y: args[1]  },
          { x: args[2],  y: args[3]  },
        );
        addCurvePoints(pts.slice(1));
        break;
      }

      case OPS.curveTo3: {
        // y: last CP = endpoint
        const pts = flattenCubic(
          { x: cursor.x, y: cursor.y },
          { x: args[0],  y: args[1]  },
          { x: args[2],  y: args[3]  },
          { x: args[2],  y: args[3]  },
        );
        addCurvePoints(pts.slice(1));
        break;
      }

      case OPS.closePath:
        if (subpathStart) addPoint(subpathStart.x, subpathStart.y);
        break;

      case OPS.rectangle: {
        // re: x y w h — a closed rectangular subpath
        // Emit as 4 individual line segments so wall pairing can work on each side
        const [rx, ry, rw, rh] = args;
        const corners: Pt[] = [
          { x: rx,      y: ry      },
          { x: rx + rw, y: ry      },
          { x: rx + rw, y: ry + rh },
          { x: rx,      y: ry + rh },
          { x: rx,      y: ry      }, // close
        ];
        const sw = state.lineWidth;
        for (let ci = 0; ci < corners.length - 1; ci++) {
          const a = transformPt(corners[ci].x,     corners[ci].y);
          const b = transformPt(corners[ci + 1].x, corners[ci + 1].y);
          const len = segmentLength(a.x, a.y, b.x, b.y);
          if (len < MIN_SEGMENT_LENGTH_PT) continue;
          const { nx: nx0, ny: ny0 } = normalise(a.x, a.y);
          const { nx: nx1, ny: ny1 } = normalise(b.x, b.y);
          segments.push({
            x0: a.x, y0: a.y, x1: b.x, y1: b.y,
            nx0, ny0, nx1, ny1,
            strokeWidth: sw,
            angle:  segmentAngle(a.x, a.y, b.x, b.y),
            length: len,
            isCurve: false,
          });
        }
        path = [];
        break;
      }

      // ── Path painting ────────────────────────────────────────────────────
      case OPS.stroke:
      case OPS.closeStroke:
        if (fn === OPS.closeStroke && subpathStart) addPoint(subpathStart.x, subpathStart.y);
        emitPath(true);
        break;

      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
        emitPath(true);   // filled + stroked — still has geometry
        break;

      case OPS.fill:
      case OPS.eoFill:
        // Filled paths define room boundaries / wall faces — still useful
        emitPath(true);
        break;

      case OPS.endPath:
        discardPath();    // clipping path or unpainted — discard
        break;

      default:
        break;
    }
  }

  console.log(`[extractPdfVectorData] operator list → ${segments.length} raw segments`);
  return segments;
}

// ─── Wall pairing: parallel lines → Wall centerlines ──────────────────────────
//
// ArchiCAD / Revit draw walls as TWO parallel lines with a gap equal to
// the wall thickness. This function detects those pairs and merges them
// into a single Wall with a centerline, thickness, and angle.
//
// Algorithm:
//   1. Consider only straight (non-curve) segments above a minimum length.
//   2. For each segment A, find all segments B that are:
//        a) Nearly parallel (angle difference < WALL_ANGLE_TOLERANCE_RAD)
//        b) Close enough (perpendicular distance < WALL_MAX_THICKNESS_PT)
//        c) Sufficiently overlapping in projection (≥ WALL_OVERLAP_RATIO)
//   3. Among candidates pick the one with the smallest perpendicular distance.
//   4. Compute the centerline as the midpoint of the two parallel lines.
//   5. Mark both segments as consumed to avoid double-pairing.

function pairWallSegments(segments: RawSegment[]): Wall[] {
  // Only consider straight segments long enough to be wall lines
  // (skip very short segments which are likely hatching or detail lines)
  const candidates = segments.filter(s => !s.isCurve && s.length >= 10);

  const consumed = new Set<number>();
  const walls:    Wall[] = [];

  for (let i = 0; i < candidates.length; i++) {
    if (consumed.has(i)) continue;
    const a = candidates[i];

    let bestJ   = -1;
    let bestDist = Infinity;

    for (let j = i + 1; j < candidates.length; j++) {
      if (consumed.has(j)) continue;
      const b = candidates[j];

      // ── Angle check ────────────────────────────────────────────────────
      let angleDiff = Math.abs(a.angle - b.angle);
      if (angleDiff > Math.PI / 2) angleDiff = Math.PI - angleDiff;
      if (angleDiff > WALL_ANGLE_TOLERANCE_RAD) continue;

      // ── Distance check (perp from midpoint of B to line of A) ──────────
      const bmx = (b.x0 + b.x1) / 2;
      const bmy = (b.y0 + b.y1) / 2;
      const dist = perpDistance(a.x0, a.y0, a.x1, a.y1, bmx, bmy);
      if (dist < WALL_MIN_THICKNESS_PT || dist > WALL_MAX_THICKNESS_PT) continue;

      // ── Overlap check ──────────────────────────────────────────────────
      // Project both endpoints of B onto A, check they overlap with A's span
      const t0 = projectOntoSegment(a.x0, a.y0, a.x1, a.y1, b.x0, b.y0);
      const t1 = projectOntoSegment(a.x0, a.y0, a.x1, a.y1, b.x1, b.y1);
      const overlapMin = Math.max(0, Math.min(t0, t1));
      const overlapMax = Math.min(1, Math.max(t0, t1));
      const overlap    = Math.max(0, overlapMax - overlapMin);
      const minLen     = Math.min(a.length, b.length);
      if (overlap * a.length < WALL_OVERLAP_RATIO * minLen) continue;

      if (dist < bestDist) {
        bestDist = dist;
        bestJ    = j;
      }
    }

    if (bestJ < 0) continue;

    // ── Found a pair ───────────────────────────────────────────────────────
    const b = candidates[bestJ];
    consumed.add(i);
    consumed.add(bestJ);

    // Centerline: midpoint between the two lines
    const cx0 = (a.x0 + b.x0) / 2;
    const cy0 = (a.y0 + b.y0) / 2;
    const cx1 = (a.x1 + b.x1) / 2;
    const cy1 = (a.y1 + b.y1) / 2;

    // Use page dimensions stored on segments for normalisation
    // We don't have pageW/H here directly — store them via closure below
    walls.push({
      cx0, cy0, cx1, cy1,
      ncx0: 0, ncy0: 0, ncx1: 0, ncy1: 0, // filled in normaliseWalls()
      thickness: bestDist,
      angle:     a.angle,
      length:    segmentLength(cx0, cy0, cx1, cy1),
      openings:  [],
      sourceA:   a,
      sourceB:   b,
    });
  }

  console.log(`[extractPdfVectorData] wall pairing → ${walls.length} walls from ${candidates.length} candidate segments`);
  return walls;
}

function normaliseWalls(walls: Wall[], pageW: number, pageH: number): void {
  for (const w of walls) {
    w.ncx0 = Math.max(0, Math.min(1, w.cx0 / pageW));
    w.ncy0 = Math.max(0, Math.min(1, 1 - w.cy0 / pageH));
    w.ncx1 = Math.max(0, Math.min(1, w.cx1 / pageW));
    w.ncy1 = Math.max(0, Math.min(1, 1 - w.cy1 / pageH));
  }
}

// ─── Opening detection: gaps in walls + arc segments → doors/windows ──────────
//
// Two strategies:
//
// Strategy A — Gap detection:
//   For each wall centerline, check for collinear wall segments on the same
//   line with a gap between them. If the gap width is in the door/window
//   range, classify it as an opening.
//
// Strategy B — Arc detection:
//   Door swings in ArchiCAD are drawn as quarter-circle arcs. We detect
//   curve segments whose bounding box centroid is near a wall endpoint.
//   If found, the wall has a door at that end.

function detectOpenings(walls: Wall[], allSegments: RawSegment[]): void {
  const arcSegments = allSegments.filter(s => s.isCurve);

  for (const wall of walls) {
    const openings: Opening[] = [];

    // ── Strategy B: arc near wall endpoints ───────────────────────────
    for (const arc of arcSegments) {
      const arcCx = (arc.x0 + arc.x1) / 2;
      const arcCy = (arc.y0 + arc.y1) / 2;

      // Check proximity to wall start or end
      const distToStart = segmentLength(arcCx, arcCy, wall.cx0, wall.cy0);
      const distToEnd   = segmentLength(arcCx, arcCy, wall.cx1, wall.cy1);
      const thresh      = wall.thickness * 3 + 10;

      if (distToStart < thresh || distToEnd < thresh) {
        const t    = distToStart < distToEnd ? 0 : 1;
        const w    = arc.length;
        if (w >= DOOR_MIN_WIDTH_PT && w <= DOOR_MAX_WIDTH_PT) {
          openings.push({ t, width: w, type: 'door' });
        }
      }
    }

    // ── Strategy A: collinear gap detection ───────────────────────────
    // Find all straight segments roughly collinear with this wall
    const collinear = allSegments.filter(s => {
      if (s.isCurve) return false;
      let angleDiff = Math.abs(s.angle - wall.angle);
      if (angleDiff > Math.PI / 2) angleDiff = Math.PI - angleDiff;
      if (angleDiff > WALL_ANGLE_TOLERANCE_RAD * 2) return false;
      // Must be close to wall line
      const dist = perpDistance(wall.cx0, wall.cy0, wall.cx1, wall.cy1,
                                (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2);
      return dist < wall.thickness * 2 + 5;
    });

    // Project onto wall axis and look for gaps
    if (collinear.length >= 2) {
      const intervals: Array<[number, number]> = collinear.map(s => {
        const t0 = projectOntoSegment(wall.cx0, wall.cy0, wall.cx1, wall.cy1, s.x0, s.y0);
        const t1 = projectOntoSegment(wall.cx0, wall.cy0, wall.cx1, wall.cy1, s.x1, s.y1);
        return [Math.min(t0, t1), Math.max(t0, t1)];
      }).sort((a, b) => a[0] - b[0]);

      // Merge overlapping intervals, then find gaps
      const merged: Array<[number, number]> = [intervals[0]];
      for (let i = 1; i < intervals.length; i++) {
        const last = merged[merged.length - 1];
        if (intervals[i][0] <= last[1] + 0.01) {
          last[1] = Math.max(last[1], intervals[i][1]);
        } else {
          merged.push(intervals[i]);
        }
      }

      for (let i = 0; i < merged.length - 1; i++) {
        const gapStart = merged[i][1];
        const gapEnd   = merged[i + 1][0];
        const gapT     = (gapStart + gapEnd) / 2;
        const gapWidth = (gapEnd - gapStart) * wall.length;

        if (gapWidth >= DOOR_MIN_WIDTH_PT && gapWidth <= DOOR_MAX_WIDTH_PT) {
          // Avoid duplicating arc-detected openings at same position
          const alreadyDetected = openings.some(o => Math.abs(o.t - gapT) < 0.05);
          if (!alreadyDetected) {
            openings.push({ t: gapT, width: gapWidth, type: 'door' });
          }
        } else if (gapWidth > DOOR_MAX_WIDTH_PT && gapWidth <= WINDOW_MAX_WIDTH_PT) {
          openings.push({ t: gapT, width: gapWidth, type: 'window' });
        }
      }
    }

    wall.openings = openings;
  }
}

// ─── Room reconstruction ───────────────────────────────────────────────────────
// Same iterative AABB expansion as before, but now operating on RawSegment[]
// converted to normalised AABB entries. This gives much better room shapes
// since the segments are now individual lines rather than whole-path AABBs.

interface SegAABB { nx0: number; ny0: number; nx1: number; ny1: number }

function segToAABB(s: RawSegment): SegAABB {
  return {
    nx0: Math.min(s.nx0, s.nx1),
    ny0: Math.min(s.ny0, s.ny1),
    nx1: Math.max(s.nx0, s.nx1),
    ny1: Math.max(s.ny0, s.ny1),
  };
}

function reconstructRooms(
  textItems:   VectorTextItem[],
  segments:    RawSegment[],
  pageW:       number,
  pageH:       number,
  drawingScale: number,
): VectorRoom[] {

  const segAABBs = segments.map(segToAABB);
  const roomTextItems = textItems.filter(t => looksLikeRoomName(t.text));

  console.log(
    `[extractPdfVectorData] ${roomTextItems.length} room-name candidates:`,
    roomTextItems.map(t => t.text),
  );

  const rooms: VectorRoom[] = [];

  for (const ti of roomTextItems) {

    let aabb: SegAABB = {
      nx0: ti.nx - 0.002, ny0: ti.ny - 0.002,
      nx1: ti.nx + 0.002, ny1: ti.ny + 0.002,
    };

    let prevArea = -1;
    for (let pass = 0; pass < 8; pass++) {
      const radius = pass === 0 ? SEGMENT_SEARCH_RADIUS : 0.008;
      const sx0 = aabb.nx0 - radius, sy0 = aabb.ny0 - radius;
      const sx1 = aabb.nx1 + radius, sy1 = aabb.ny1 + radius;

      let changed = false;
      for (const seg of segAABBs) {
        if (seg.nx1 < sx0 || seg.nx0 > sx1 || seg.ny1 < sy0 || seg.ny0 > sy1) continue;
        const nx0 = Math.min(aabb.nx0, seg.nx0);
        const ny0 = Math.min(aabb.ny0, seg.ny0);
        const nx1 = Math.max(aabb.nx1, seg.nx1);
        const ny1 = Math.max(aabb.ny1, seg.ny1);
        if (nx0 !== aabb.nx0 || ny0 !== aabb.ny0 || nx1 !== aabb.nx1 || ny1 !== aabb.ny1) {
          aabb = { nx0, ny0, nx1, ny1 };
          changed = true;
        }
      }

      const area = (aabb.nx1 - aabb.nx0) * (aabb.ny1 - aabb.ny0);
      if (!changed || Math.abs(area - prevArea) < 0.000001) break;
      prevArea = area;
    }

    const w = aabb.nx1 - aabb.nx0;
    const h = aabb.ny1 - aabb.ny0;
    const areaNorm = w * h;
    const aspect   = w > 0 && h > 0 ? Math.max(w / h, h / w) : 999;
    let usedSynthetic = false;

    if (areaNorm < MIN_ROOM_AREA_NORM || areaNorm > MAX_ROOM_AREA_NORM || aspect > MAX_ASPECT_RATIO) {
      const PAD = 0.045;
      aabb = {
        nx0: Math.max(0, ti.nx - PAD), ny0: Math.max(0, ti.ny - PAD),
        nx1: Math.min(1, ti.nx + PAD), ny1: Math.min(1, ti.ny + PAD),
      };
      usedSynthetic = true;
    }

    const fw = aabb.nx1 - aabb.nx0;
    const fh = aabb.ny1 - aabb.ny0;
    const finalArea = fw * fh;

    const AREA_SEARCH = 0.06;
    let areaSqM: number | null = null;
    for (const t of textItems) {
      if (Math.abs(t.nx - ti.nx) > AREA_SEARCH || Math.abs(t.ny - ti.ny) > AREA_SEARCH) continue;
      const parsed = parseAreaAnnotation(t.text);
      if (parsed !== null) { areaSqM = parsed; break; }
    }
    if (areaSqM === null && !usedSynthetic) {
      const mpp = PT_TO_M * drawingScale;
      areaSqM = (fw * pageW) * (fh * pageH) * mpp * mpp;
    }

    const polygon = [
      { nx: aabb.nx0, ny: aabb.ny0 },
      { nx: aabb.nx1, ny: aabb.ny0 },
      { nx: aabb.nx1, ny: aabb.ny1 },
      { nx: aabb.nx0, ny: aabb.ny1 },
    ];

    const label    = normaliseLabel(ti.text);
    const centroid = { nx: (aabb.nx0 + aabb.nx1) / 2, ny: (aabb.ny0 + aabb.ny1) / 2 };

    console.log(
      `[extractPdfVectorData] "${ti.text}" → "${label}" | ` +
      `${usedSynthetic ? 'SYNTHETIC' : 'wall-reconstructed'} | ` +
      `area=${finalArea.toFixed(4)} aspect=${aspect.toFixed(1)} | ${areaSqM?.toFixed(1) ?? '?'} m²`,
    );

    rooms.push({ polygon, areaNorm: finalArea, areaSqM, label, centroid, source: 'vector' });
  }

  return deduplicateRooms(rooms);
}

// ─── Label / text helpers ──────────────────────────────────────────────────────

const AREA_PATTERN = /(\d+\.?\d*)\s*(?:m[²2]|sq\.?\s*m|sqm)/i;

function parseAreaAnnotation(text: string): number | null {
  const m = text.match(AREA_PATTERN);
  return m ? parseFloat(m[1]) : null;
}

const ROOM_KEYWORDS = [
  'office', 'meeting', 'conference', 'board', 'boardroom', 'open plan',
  'lobby', 'corridor', 'hallway', 'kitchen', 'bathroom', 'toilet', 'wc',
  'bedroom', 'living', 'dining', 'lounge', 'storage', 'closet', 'garage',
  'laundry', 'utility', 'balcony', 'study', 'library', 'nursery', 'gym',
  'pantry', 'reception', 'breakout', 'server', 'director', 'stairs',
  'stair', 'foyer', 'entry', 'entrance', 'passage', 'hall',
];

function looksLikeRoomName(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (!lower || lower.length < 2) return false;
  if (/^\d+(\.\d+)?$/.test(lower)) return false;
  if (/^\d[\d\s]*\d$/.test(lower)) return false;
  if (/^\d+(\.\d+)?\s*(mm|cm|m|ft|'|")/.test(lower)) return false;
  if (AREA_PATTERN.test(lower)) return false;
  return (
    ROOM_KEYWORDS.some(k => lower.includes(k)) ||
    (/[a-z]{4,}/.test(lower) && !/^\d/.test(lower))
  );
}

const LABEL_MAP: Record<string, string> = {
  OFFICE: 'OFFICE', CONFERENCE: 'CONFERENCE ROOM', MEETING: 'MEETING ROOM',
  KITCHEN: 'KITCHEN', BATHROOM: 'BATHROOM', TOILET: 'BATHROOM', WC: 'BATHROOM',
  BEDROOM: 'BEDROOM', BED: 'BEDROOM', LIVING: 'LIVING ROOM', LIVING_ROOM: 'LIVING ROOM',
  LOUNGE: 'LIVING ROOM', DINING: 'DINING ROOM', DINING_AREA: 'DINING ROOM',
  DINING_ROOM: 'DINING ROOM', CORRIDOR: 'CORRIDOR', HALLWAY: 'CORRIDOR',
  HALL: 'CORRIDOR', PASSAGE: 'CORRIDOR', STORAGE: 'STORAGE', CLOSET: 'STORAGE',
  LOBBY: 'LOBBY', FOYER: 'LOBBY', ENTRY: 'LOBBY', ENTRANCE: 'LOBBY',
  OPEN: 'OPEN PLAN', GARAGE: 'GARAGE', LAUNDRY: 'LAUNDRY',
  UTILITY: 'UTILITY', BALCONY: 'BALCONY', TERRACE: 'BALCONY', STUDY: 'STUDY',
  LIBRARY: 'LIBRARY', NURSERY: 'NURSERY', GYM: 'GYM', PANTRY: 'PANTRY',
  RECEPTION: 'RECEPTION', GUEST: 'GUEST ROOM', ZONE: 'ROOM',
  'BED RM': 'BEDROOM', 'BD RM': 'BEDROOM', 'BR': 'BEDROOM',
  'LR': 'LIVING ROOM', 'DR': 'DINING ROOM', 'KIT': 'KITCHEN',
  'BATH': 'BATHROOM', 'LAV': 'BATHROOM', 'PWD': 'BATHROOM',
  'COR': 'CORRIDOR', 'CORR': 'CORRIDOR', 'STOR': 'STORAGE',
  'GAR': 'GARAGE', 'UTIL': 'UTILITY', 'MECH': 'MECHANICAL',
  SINK: 'SINK', TUB: 'BATHTUB', BATHTUB: 'BATHTUB', SHOWER: 'SHOWER',
  STAIRS: 'STAIRS', STAIR: 'STAIRS', STAIRCASE: 'STAIRS',
  BOARDROOM: 'BOARDROOM', 'BOARD ROOM': 'BOARDROOM',
  SERVER: 'SERVER ROOM', 'SERVER RM': 'SERVER ROOM',
  BREAKOUT: 'BREAKOUT', DIRECTOR: 'DIRECTOR',
  'OPEN PLAN': 'OPEN PLAN', 'MEETING RM': 'MEETING ROOM',
};

function normaliseLabel(raw: string): string {
  const up = raw.toUpperCase().trim().replace(/\s+/g, ' ');
  if (LABEL_MAP[up]) return LABEL_MAP[up];
  for (const [key, value] of Object.entries(LABEL_MAP))
    if (up.includes(key)) return value;
  return up;
}

function deduplicateRooms(rooms: VectorRoom[]): VectorRoom[] {
  const kept: VectorRoom[] = [];
  for (const r of rooms) {
    const dup = kept.some(k => {
      const dx = Math.abs(k.centroid.nx - r.centroid.nx);
      const dy = Math.abs(k.centroid.ny - r.centroid.ny);
      return dx < 0.03 && dy < 0.03;
    });
    if (!dup) kept.push(r);
  }
  return kept;
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function extractPdfVectorData(
  page:         PDFPageProxy,
  drawingScale = 100,
): Promise<VectorExtractionResult> {

  const viewport = page.getViewport({ scale: 1 });
  const W = viewport.width;
  const H = viewport.height;

  // ── Step 1: Text items ─────────────────────────────────────────────────────
  const textContent = await page.getTextContent();

  const textItems: VectorTextItem[] = (textContent.items as any[])
    .filter(item => typeof item.str === 'string' && item.str.trim().length > 0)
    .map(item => ({
      text: item.str.trim().toUpperCase(),
      x:    item.transform[4],
      y:    item.transform[5],
      nx:   Math.max(0, Math.min(1, item.transform[4] / W)),
      ny:   Math.max(0, Math.min(1, 1 - item.transform[5] / H)),
    }));

  console.log(`[extractPdfVectorData] ${textItems.length} text items`);

  if (textItems.length < MIN_TEXT_ITEMS_FOR_VECTOR) {
    console.warn('[extractPdfVectorData] Too few text items — likely a scanned PDF.');
    return { rooms: [], textItems: [], segments: [], walls: [], isVector: false, pageWidth: W, pageHeight: H };
  }

  // ── Step 2: Raw segment extraction from operator list ─────────────────────
  let segments: RawSegment[] = [];
  try {
    const opList = await page.getOperatorList();
    segments = extractRawSegments(opList.fnArray as number[], opList.argsArray, W, H);
  } catch (err) {
    console.warn('[extractPdfVectorData] getOperatorList() failed:', err);
  }

  console.log(`[extractPdfVectorData] ${segments.length} raw segments (lines + flattened curves)`);

  // ── Step 3: Wall pairing ───────────────────────────────────────────────────
  const walls = pairWallSegments(segments);
  normaliseWalls(walls, W, H);

  // ── Step 4: Opening detection ──────────────────────────────────────────────
  detectOpenings(walls, segments);
  const totalOpenings = walls.reduce((n, w) => n + w.openings.length, 0);
  console.log(`[extractPdfVectorData] ${totalOpenings} openings detected across ${walls.length} walls`);

  // ── Step 5: Room reconstruction ────────────────────────────────────────────
  const rooms = reconstructRooms(textItems, segments, W, H, drawingScale);

  console.log(
    `[extractPdfVectorData] ✅ ${rooms.length} rooms | ${walls.length} walls | ${segments.length} segments`,
    rooms.map(r => `${r.label} (${r.areaSqM?.toFixed(1) ?? '?'} m²)`),
  );

  return {
    segments,
    walls,
    rooms,
    textItems,
    isVector: true,
    pageWidth:  W,
    pageHeight: H,
  };
}
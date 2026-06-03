// lib/svg/parseSvgPath.ts
// ── Vector SVG path parser ────────────────────────────────────────────────────
//
// Replaces the raster-based measureSvgPath with true vector polygon extraction.
// For floor plans (mostly M/L/H/V/Z) corners are exact. Curves (C/Q/A) are
// sampled at configurable resolution.
//
// DROP-IN replacement — same signature as measureSvgPath in fillCore.ts:
//   measureSvgPathVector(pathD, canvasW, canvasH) → { areaPx, perimPx, polygon, cornerIndices }
//
// areaPx        — computed via shoelace formula (no canvas needed)
// perimPx       — sum of segment lengths on the true polygon
// polygon       — the actual vector corners (not marching-squares approximation)
// cornerIndices — Set of indices into polygon that are true M/L/H/V/Z endpoints
//                 Curve sample intermediates are NOT included, so dot rendering
//                 only marks real corners rather than flooding curve segments.
//
// FIX (v2): Compound paths (multiple M subpaths in one <path> element) are now
// split and measured independently. The subpath with the largest shoelace area
// is returned as the fill polygon. This prevents a small room click from
// matching a compound path whose full concatenated polygon covers the whole floor.

// ── Number tokeniser ──────────────────────────────────────────────────────────

function parseNumbers(s: string): number[] {
  const nums: number[] = [];
  const re = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) nums.push(parseFloat(m[0]));
  return nums;
}

// ── Path command tokeniser ────────────────────────────────────────────────────

interface Cmd { type: string; args: number[] }

function tokenise(d: string): Cmd[] {
  const cmds: Cmd[] = [];
  const re = /([MmZzLlHhVvCcSsQqTtAa])([^MmZzLlHhVvCcSsQqTtAa]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    cmds.push({ type: m[1], args: parseNumbers(m[2]) });
  }
  return cmds;
}

// ── Curve samplers ────────────────────────────────────────────────────────────

/** Sample N points along a cubic bezier (not including the start point) */
function sampleCubic(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  samples = 8,
): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 1; i <= samples; i++) {
    const t  = i / samples;
    const mt = 1 - t;
    const x  = mt**3*x0 + 3*mt**2*t*x1 + 3*mt*t**2*x2 + t**3*x3;
    const y  = mt**3*y0 + 3*mt**2*t*y1 + 3*mt*t**2*y2 + t**3*y3;
    pts.push([x, y]);
  }
  return pts;
}

/** Sample N points along a quadratic bezier (not including start) */
function sampleQuadratic(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  samples = 6,
): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 1; i <= samples; i++) {
    const t  = i / samples;
    const mt = 1 - t;
    const x  = mt**2*x0 + 2*mt*t*x1 + t**2*x2;
    const y  = mt**2*y0 + 2*mt*t*y1 + t**2*y2;
    pts.push([x, y]);
  }
  return pts;
}

/** Sample N points along an SVG arc (not including start) */
function sampleArc(
  x0: number, y0: number,
  rx: number, ry: number,
  xRot: number,
  largeArc: number,
  sweep: number,
  x1: number, y1: number,
  samples = 8,
): [number, number][] {
  // Convert endpoint to centre parameterisation (SVG spec §B.2.4)
  const phi    = (xRot * Math.PI) / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const dx2 = (x0 - x1) / 2, dy2 = (y0 - y1) / 2;
  const x1p =  cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  let rxs = rx * rx, rys = ry * ry;
  const x1ps = x1p * x1p, y1ps = y1p * y1p;
  // Ensure radii are large enough
  const lambda = x1ps / rxs + y1ps / rys;
  if (lambda > 1) { const sq = Math.sqrt(lambda); rx *= sq; ry *= sq; rxs = rx*rx; rys = ry*ry; }
  const num  = Math.max(0, rxs*rys - rxs*y1ps - rys*x1ps);
  const den  = rxs*y1ps + rys*x1ps;
  const sq   = den === 0 ? 0 : Math.sqrt(num / den);
  const sign = largeArc === sweep ? -1 : 1;
  const cxp  =  sign * sq * rx * y1p / ry;
  const cyp  = -sign * sq * ry * x1p / rx;
  const ccx  = cosPhi*cxp - sinPhi*cyp + (x0+x1)/2;
  const ccy  = sinPhi*cxp + cosPhi*cyp + (y0+y1)/2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const s = Math.sign(ux*vy - uy*vx);
    return s * Math.acos(Math.max(-1, Math.min(1, (ux*vx+uy*vy) / (Math.hypot(ux,uy)*Math.hypot(vx,vy)))));
  };
  const theta1 = angle(1, 0, (x1p-cxp)/rx, (y1p-cyp)/ry);
  let dTheta   = angle((x1p-cxp)/rx, (y1p-cyp)/ry, (-x1p-cxp)/rx, (-y1p-cyp)/ry);
  if (!sweep && dTheta >  0) dTheta -= 2*Math.PI;
  if ( sweep && dTheta <  0) dTheta += 2*Math.PI;

  const pts: [number, number][] = [];
  for (let i = 1; i <= samples; i++) {
    const t   = theta1 + dTheta * (i / samples);
    const xpt = cosPhi * rx * Math.cos(t) - sinPhi * ry * Math.sin(t) + ccx;
    const ypt = sinPhi * rx * Math.cos(t) + cosPhi * ry * Math.sin(t) + ccy;
    pts.push([xpt, ypt]);
  }
  return pts;
}

// ── Return type ───────────────────────────────────────────────────────────────

export interface ParsedSvgPath {
  /**
   * Full polygon including curve sample intermediates.
   * Used for area (shoelace) and perimeter calculation.
   */
  points: [number, number][];
  /**
   * Indices into `points` that are true path command endpoints:
   *   M  — move-to anchor
   *   L  — line-to endpoint
   *   H  — horizontal line endpoint
   *   V  — vertical line endpoint
   *   Z  — close-path back to subpath start
   *   C/S/Q/T/A destination — the final x,y of the command (NOT the intermediate samples)
   *
   * Use this set to render corner dots without flooding every curve sample.
   * For a rectangle (M H V H Z) → 4 indices.
   * For a rounded-rect with arcs → only the arc endpoints, not the 8 sampled arc points.
   */
  cornerIndices: Set<number>;
}

// ── Main parser (single subpath) ──────────────────────────────────────────────

/**
 * Parse an SVG path `d` string into a polygon plus a set of "true corner" indices.
 *
 * Straight-line commands (M/L/H/V/Z) → exact corners, all marked in cornerIndices.
 * Curve commands (C/S/Q/T/A)         → sampled at `curveSamples` points each,
 *                                       but ONLY the final destination endpoint
 *                                       is added to cornerIndices.
 *
 * NOTE: This function processes the full `d` string as-is (all subpaths
 * concatenated). For compound paths use splitSubpaths() first.
 */
export function parseSvgPathToPolygon(
  d: string,
  curveSamples = 8,
): ParsedSvgPath {
  const cmds         = tokenise(d);
  const pts: [number, number][] = [];
  const cornerIndices            = new Set<number>();

  let cx = 0, cy = 0;   // current point
  let sx = 0, sy = 0;   // subpath start (for Z)
  let prevCpx = 0, prevCpy = 0; // previous control point (for S/T reflection)
  let prevCmd = '';

  /**
   * Push a point and optionally mark it as a true corner.
   * isCorner=true  → M/L/H/V/Z or curve destination endpoint
   * isCorner=false → curve sample intermediate (never gets a dot)
   */
  const push = (x: number, y: number, isCorner: boolean) => {
    if (isCorner) cornerIndices.add(pts.length);
    cx = x; cy = y;
    pts.push([x, y]);
  };

  /**
   * Push all sampled curve points then mark the final destination as a corner.
   * The intermediates are pushed directly (bypassing push()) so they don't
   * update cx/cy until the real endpoint is reached.
   */
  const pushSampled = (sampled: [number, number][]) => {
    for (let i = 0; i < sampled.length - 1; i++) {
      pts.push(sampled[i]); // intermediate sample — NOT a corner, cx/cy not updated
    }
    if (sampled.length > 0) {
      const [lx, ly] = sampled[sampled.length - 1];
      push(lx, ly, true); // destination endpoint IS a true corner
    }
  };

  for (const { type, args } of cmds) {
    const rel = type === type.toLowerCase() && type !== 'z' && type !== 'Z';

    switch (type.toUpperCase()) {

      case 'M': {
        // M x y  [implicit L x y ...]
        for (let i = 0; i < args.length; i += 2) {
          const x = rel && i === 0 ? cx + args[i]   : rel ? cx + args[i]   : args[i];
          const y = rel && i === 0 ? cy + args[i+1] : rel ? cy + args[i+1] : args[i+1];
          if (i === 0) { sx = x; sy = y; }
          push(x, y, true); // M is always a true corner
        }
        break;
      }

      case 'L': {
        for (let i = 0; i < args.length; i += 2) {
          push(rel ? cx + args[i] : args[i], rel ? cy + args[i+1] : args[i+1], true);
        }
        break;
      }

      case 'H': {
        for (let i = 0; i < args.length; i++) {
          push(rel ? cx + args[i] : args[i], cy, true);
        }
        break;
      }

      case 'V': {
        for (let i = 0; i < args.length; i++) {
          push(cx, rel ? cy + args[i] : args[i], true);
        }
        break;
      }

      case 'Z': {
        // Close back to subpath start — only add if not already there
        if (pts.length > 0 && (pts[pts.length-1][0] !== sx || pts[pts.length-1][1] !== sy)) {
          push(sx, sy, true); // Z close is a true corner
        }
        cx = sx; cy = sy;
        break;
      }

      case 'C': {
        // C x1 y1 x2 y2 x y  [repeat...]
        for (let i = 0; i < args.length; i += 6) {
          const x1 = rel ? cx + args[i]   : args[i];
          const y1 = rel ? cy + args[i+1] : args[i+1];
          const x2 = rel ? cx + args[i+2] : args[i+2];
          const y2 = rel ? cy + args[i+3] : args[i+3];
          const x  = rel ? cx + args[i+4] : args[i+4];
          const y  = rel ? cy + args[i+5] : args[i+5];
          pushSampled(sampleCubic(cx, cy, x1, y1, x2, y2, x, y, curveSamples));
          prevCpx = x2; prevCpy = y2;
        }
        break;
      }

      case 'S': {
        // S x2 y2 x y — smooth cubic (reflect previous C/S control point)
        for (let i = 0; i < args.length; i += 4) {
          const x1 = prevCmd.toUpperCase() === 'C' || prevCmd.toUpperCase() === 'S'
            ? 2*cx - prevCpx : cx;
          const y1 = prevCmd.toUpperCase() === 'C' || prevCmd.toUpperCase() === 'S'
            ? 2*cy - prevCpy : cy;
          const x2 = rel ? cx + args[i]   : args[i];
          const y2 = rel ? cy + args[i+1] : args[i+1];
          const x  = rel ? cx + args[i+2] : args[i+2];
          const y  = rel ? cy + args[i+3] : args[i+3];
          pushSampled(sampleCubic(cx, cy, x1, y1, x2, y2, x, y, curveSamples));
          prevCpx = x2; prevCpy = y2;
        }
        break;
      }

      case 'Q': {
        for (let i = 0; i < args.length; i += 4) {
          const x1 = rel ? cx + args[i]   : args[i];
          const y1 = rel ? cy + args[i+1] : args[i+1];
          const x  = rel ? cx + args[i+2] : args[i+2];
          const y  = rel ? cy + args[i+3] : args[i+3];
          pushSampled(sampleQuadratic(cx, cy, x1, y1, x, y, curveSamples));
          prevCpx = x1; prevCpy = y1;
        }
        break;
      }

      case 'T': {
        // T x y — smooth quadratic (reflect previous Q/T control point)
        for (let i = 0; i < args.length; i += 2) {
          const x1 = prevCmd.toUpperCase() === 'Q' || prevCmd.toUpperCase() === 'T'
            ? 2*cx - prevCpx : cx;
          const y1 = prevCmd.toUpperCase() === 'Q' || prevCmd.toUpperCase() === 'T'
            ? 2*cy - prevCpy : cy;
          const x  = rel ? cx + args[i]   : args[i];
          const y  = rel ? cy + args[i+1] : args[i+1];
          pushSampled(sampleQuadratic(cx, cy, x1, y1, x, y, curveSamples));
          prevCpx = x1; prevCpy = y1;
        }
        break;
      }

      case 'A': {
        for (let i = 0; i < args.length; i += 7) {
          const rx    = Math.abs(args[i]);
          const ry    = Math.abs(args[i+1]);
          const xRot  = args[i+2];
          const large = args[i+3];
          const sweep = args[i+4];
          const x     = rel ? cx + args[i+5] : args[i+5];
          const y     = rel ? cy + args[i+6] : args[i+6];
          if (rx === 0 || ry === 0) {
            push(x, y, true); // degenerate arc → straight line endpoint
          } else {
            pushSampled(sampleArc(cx, cy, rx, ry, xRot, large, sweep, x, y, curveSamples));
          }
        }
        break;
      }
    }

    prevCmd = type;
  }

  return { points: pts, cornerIndices };
}

// ── Geometric helpers ─────────────────────────────────────────────────────────

/** Shoelace formula — returns unsigned area */
export function shoelaceArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1];
    a -= pts[j][0] * pts[i][1];
  }
  return Math.abs(a) / 2;
}

/** True arc-length perimeter of a polygon */
export function vectorPolygonPerim(pts: [number, number][]): number {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    p += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  return Math.round(p);
}

// ── Subpath splitter ──────────────────────────────────────────────────────────

/**
 * Split a compound SVG path `d` string into individual subpath strings.
 *
 * A new subpath begins at each M/m command. Each returned string starts
 * with the M command that opens it and ends just before the next M (or
 * at end-of-string).
 *
 * Example:
 *   "M 0 0 H 10 V 10 Z M 20 20 L 30 30 Z"
 *   → ["M 0 0 H 10 V 10 Z", "M 20 20 L 30 30 Z"]
 */
export function splitSubpaths(d: string): string[] {
  // Split on any M or m that starts a new move (lookahead keeps the M)
  return d
    .split(/(?=[Mm])/)
    .map(s => s.trim())
    .filter(s => s.length > 1); // skip empty or lone whitespace entries
}

// ── Drop-in replacement for measureSvgPath ────────────────────────────────────
//
// Key differences from the raster version:
//   • polygon       — true vector corners (exact for M/L/H/V, sampled for curves)
//   • cornerIndices — only true command endpoints; use for dot rendering
//   • areaPx        — shoelace area in canvas-pixel units (not pixel-count)
//   • perimPx       — true arc-length, not marching-squares boundary length
//   • No offscreen canvas needed → faster, no GC pressure
//
// v2 fix — compound paths:
//   Floor-plan SVGs often embed multiple subpaths in one <path> element
//   (e.g. a room outline + a door cutout). The old code concatenated all
//   subpaths into one polygon, producing a massive shoelace area that made
//   every click appear to flood the entire drawing.
//
//   Now each subpath is parsed independently and the one with the LARGEST
//   shoelace area is returned as the fill region. This means:
//     • A room outline + tiny door notch → room outline wins (largest area).
//     • A background rect + room detail  → background rect is filtered out
//       upstream by the canvasArea * 0.5 guard in doSvgFill.
//
// canvasW / canvasH are kept in the signature for API compatibility but are
// no longer used (the path coordinates are already in canvas-pixel space
// because svgElToAbsPath scales them by SVG_SCALE).

export function measureSvgPathVector(
  pathD: string,
  _canvasW: number,
  _canvasH: number,
  curveSamples = 8,
): {
  areaPx: number;
  perimPx: number;
  polygon: [number, number][];
  cornerIndices: Set<number>;
} {
  const subpaths = splitSubpaths(pathD);

  // ── Single subpath (most common case) ──────────────────────────────────────
  if (subpaths.length <= 1) {
    const { points, cornerIndices } = parseSvgPathToPolygon(pathD, curveSamples);
    if (points.length < 3) {
      return {
        areaPx: 0,
        perimPx: 0,
        polygon: points,
        cornerIndices: cornerIndices ?? new Set<number>(),
      };
    }
    return {
      areaPx:        shoelaceArea(points),
      perimPx:       vectorPolygonPerim(points),
      polygon:       points,
      cornerIndices: cornerIndices ?? new Set<number>(),
    };
  }

  // ── Compound path — pick the subpath with the largest shoelace area ─────────
  //
  // Why largest? In a typical floor-plan compound path the room boundary is the
  // outermost (largest) closed loop. Any inner cutouts (doors, windows) will have
  // smaller areas and are intentionally ignored for the fill polygon.
  //
  // If the caller also applies the canvasArea * 0.5 filter in doSvgFill the
  // truly enormous background rectangles are excluded before we even get here.

  let bestPoints:       [number, number][] = [];
  let bestCornerIndices: Set<number>       = new Set();
  let bestArea          = -1;

  for (const sub of subpaths) {
    const { points, cornerIndices } = parseSvgPathToPolygon(sub, curveSamples);
    if (points.length < 3) continue;
    const area = shoelaceArea(points);
    if (area > bestArea) {
      bestArea          = area;
      bestPoints        = points;
      bestCornerIndices = cornerIndices ?? new Set<number>();
    }
  }

  // Fallback — if every subpath had < 3 points, return empty
  if (bestPoints.length < 3) {
    return { areaPx: 0, perimPx: 0, polygon: bestPoints, cornerIndices: bestCornerIndices };
  }

  return {
    areaPx:        bestArea,
    perimPx:       vectorPolygonPerim(bestPoints),
    polygon:       bestPoints,
    cornerIndices: bestCornerIndices,
  };
}
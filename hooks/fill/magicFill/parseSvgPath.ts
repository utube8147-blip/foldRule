// ── Vector SVG path parser ────────────────────────────────────────────────────
//
// Replaces the raster-based measureSvgPath with true vector polygon extraction.
// For floor plans (mostly M/L/H/V/Z) corners are exact. Curves (C/Q/A) are
// sampled at configurable resolution.
//
// DROP-IN replacement — same signature as measureSvgPath in fillCore.ts:
//   measureSvgPath(pathD, canvasW, canvasH) → { areaPx, perimPx, polygon }
//
// areaPx  — computed via shoelace formula (no canvas needed)
// perimPx — sum of segment lengths on the true polygon
// polygon — the actual vector corners (not marching-squares approximation)

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
  const phi  = (xRot * Math.PI) / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const dx2 = (x0 - x1) / 2, dy2 = (y0 - y1) / 2;
  const x1p =  cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  let rxs = rx * rx, rys = ry * ry;
  const x1ps = x1p * x1p, y1ps = y1p * y1p;
  // Ensure radii are large enough
  const lambda = x1ps / rxs + y1ps / rys;
  if (lambda > 1) { const sq = Math.sqrt(lambda); rx *= sq; ry *= sq; rxs = rx*rx; rys = ry*ry; }
  const num = Math.max(0, rxs*rys - rxs*y1ps - rys*x1ps);
  const den = rxs*y1ps + rys*x1ps;
  const sq  = den === 0 ? 0 : Math.sqrt(num / den);
  const sign = largeArc === sweep ? -1 : 1;
  const cxp =  sign * sq * rx * y1p / ry;
  const cyp = -sign * sq * ry * x1p / rx;
  const cx  = cosPhi*cxp - sinPhi*cyp + (x0+x1)/2;
  const cy  = sinPhi*cxp + cosPhi*cyp + (y0+y1)/2;

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
    const xpt = cosPhi * rx * Math.cos(t) - sinPhi * ry * Math.sin(t) + cx;
    const ypt = sinPhi * rx * Math.cos(t) + cosPhi * ry * Math.sin(t) + cy;
    pts.push([xpt, ypt]);
  }
  return pts;
}

// ── Main parser ───────────────────────────────────────────────────────────────

/**
 * Parse an SVG path `d` string into an array of polygon points.
 * Straight-line commands (M/L/H/V/Z) produce exact corners.
 * Curve commands (C/S/Q/T/A) are sampled at `curveSamples` points each.
 *
 * Returns a closed polygon (last point ≠ first point; caller closes if needed).
 */
export function parseSvgPathToPolygon(
  d: string,
  curveSamples = 8,
): [number, number][] {
  const cmds = tokenise(d);
  const pts: [number, number][] = [];

  let cx = 0, cy = 0;   // current point
  let sx = 0, sy = 0;   // subpath start (for Z)
  let prevCpx = 0, prevCpy = 0; // previous control point (for S/T reflection)
  let prevCmd = '';

  const push = (x: number, y: number) => { cx = x; cy = y; pts.push([x, y]); };

  for (const { type, args } of cmds) {
    const rel = type === type.toLowerCase() && type !== 'z' && type !== 'Z';

    switch (type.toUpperCase()) {

      case 'M': {
        // M x y  [L x y ...]  — subsequent pairs are implicit L
        for (let i = 0; i < args.length; i += 2) {
          const x = rel && i === 0 ? cx + args[i] : rel ? cx + args[i] : args[i];
          const y = rel && i === 0 ? cy + args[i+1] : rel ? cy + args[i+1] : args[i+1];
          if (i === 0) { sx = x; sy = y; }
          push(x, y);
        }
        break;
      }

      case 'L': {
        for (let i = 0; i < args.length; i += 2) {
          push(rel ? cx + args[i] : args[i], rel ? cy + args[i+1] : args[i+1]);
        }
        break;
      }

      case 'H': {
        for (let i = 0; i < args.length; i++) {
          push(rel ? cx + args[i] : args[i], cy);
        }
        break;
      }

      case 'V': {
        for (let i = 0; i < args.length; i++) {
          push(cx, rel ? cy + args[i] : args[i]);
        }
        break;
      }

      case 'Z': {
        // Close path back to subpath start — only add if not already there
        if (pts.length > 0 && (pts[pts.length-1][0] !== sx || pts[pts.length-1][1] !== sy)) {
          push(sx, sy);
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
          const sampled = sampleCubic(cx, cy, x1, y1, x2, y2, x, y, curveSamples);
          sampled.forEach(p => push(p[0], p[1]));
          prevCpx = x2; prevCpy = y2;
        }
        break;
      }

      case 'S': {
        // S x2 y2 x y — smooth cubic (reflect previous C control point)
        for (let i = 0; i < args.length; i += 4) {
          const x1 = prevCmd.toUpperCase() === 'C' || prevCmd.toUpperCase() === 'S'
            ? 2*cx - prevCpx : cx;
          const y1 = prevCmd.toUpperCase() === 'C' || prevCmd.toUpperCase() === 'S'
            ? 2*cy - prevCpy : cy;
          const x2 = rel ? cx + args[i]   : args[i];
          const y2 = rel ? cy + args[i+1] : args[i+1];
          const x  = rel ? cx + args[i+2] : args[i+2];
          const y  = rel ? cy + args[i+3] : args[i+3];
          const sampled = sampleCubic(cx, cy, x1, y1, x2, y2, x, y, curveSamples);
          sampled.forEach(p => push(p[0], p[1]));
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
          const sampled = sampleQuadratic(cx, cy, x1, y1, x, y, curveSamples);
          sampled.forEach(p => push(p[0], p[1]));
          prevCpx = x1; prevCpy = y1;
        }
        break;
      }

      case 'T': {
        // T x y — smooth quadratic
        for (let i = 0; i < args.length; i += 2) {
          const x1 = prevCmd.toUpperCase() === 'Q' || prevCmd.toUpperCase() === 'T'
            ? 2*cx - prevCpx : cx;
          const y1 = prevCmd.toUpperCase() === 'Q' || prevCmd.toUpperCase() === 'T'
            ? 2*cy - prevCpy : cy;
          const x  = rel ? cx + args[i]   : args[i];
          const y  = rel ? cy + args[i+1] : args[i+1];
          const sampled = sampleQuadratic(cx, cy, x1, y1, x, y, curveSamples);
          sampled.forEach(p => push(p[0], p[1]));
          prevCpx = x1; prevCpy = y1;
        }
        break;
      }

      case 'A': {
        for (let i = 0; i < args.length; i += 7) {
          const rx      = Math.abs(args[i]);
          const ry      = Math.abs(args[i+1]);
          const xRot    = args[i+2];
          const large   = args[i+3];
          const sweep   = args[i+4];
          const x       = rel ? cx + args[i+5] : args[i+5];
          const y       = rel ? cy + args[i+6] : args[i+6];
          if (rx === 0 || ry === 0) {
            push(x, y);
          } else {
            const sampled = sampleArc(cx, cy, rx, ry, xRot, large, sweep, x, y, curveSamples);
            sampled.forEach(p => push(p[0], p[1]));
          }
        }
        break;
      }
    }

    prevCmd = type;
  }

  return pts;
}

// ── Geometric helpers ─────────────────────────────────────────────────────────

/** Shoelace formula — signed area (positive = CCW) */
export function shoelaceArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1];
    a -= pts[j][0] * pts[i][1];
  }
  return Math.abs(a) / 2;
}

/** Perimeter of a polygon */
export function vectorPolygonPerim(pts: [number, number][]): number {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    p += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  return Math.round(p);
}

// ── Drop-in replacement for measureSvgPath ────────────────────────────────────
//
// Key differences from the raster version:
//   • polygon  — true vector corners (exact for M/L/H/V, sampled for curves)
//   • areaPx   — shoelace area in canvas-pixel units (not pixel-count)
//   • perimPx  — true arc-length, not marching-squares boundary length
//   • No offscreen canvas needed → faster, no GC pressure
//
// canvasW / canvasH are kept in the signature for API compatibility but are
// no longer used (the path coordinates are already in canvas-pixel space
// because svgElToAbsPath scales them by SVG_SCALE).

export function measureSvgPathVector(
  pathD: string,
  _canvasW: number,
  _canvasH: number,
  curveSamples = 8,
): { areaPx: number; perimPx: number; polygon: [number, number][] } {
  const polygon = parseSvgPathToPolygon(pathD, curveSamples);
  if (polygon.length < 3) {
    return { areaPx: 0, perimPx: 0, polygon };
  }
  const areaPx  = shoelaceArea(polygon);
  const perimPx = vectorPolygonPerim(polygon);
  return { areaPx, perimPx, polygon };
}
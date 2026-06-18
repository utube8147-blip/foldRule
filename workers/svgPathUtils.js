// ─── workers/svgPathUtils.js ──────────────────────────────────────────────────
//
//  Self-contained SVG path utilities.
//
//  DUAL USE:
//    1. Imported directly in main-thread TypeScript via the re-export in
//       fillMaskAndSvgPath.ts (marchingSquaresContour, traceMaskBoundary,
//       rdpSimplify, buildAdaptivePath, maskToSvgPath).
//    2. Embedded verbatim into Blob-based web workers via SVG_PATH_UTILS_SOURCE
//       (exported as a string so workers can inline it without ES-module imports).
//
//  IMPROVEMENTS (this revision):
//
//  1. OUTLINE SHRINK BEFORE TRACING
//     The flood-fill stops at wall pixels, so the traced boundary runs along
//     the *inner* wall face — offset inward from the actual wall centre line
//     by roughly half the wall thickness.  The workers' mfOuterShape() used to
//     run erode(2)→dilate(2) (a morphological opening whose net displacement is
//     zero).  It now runs erode(WALL_HALF_PX) only — a true inward shrink of
//     the filled region — so that traceMaskBoundary sees the shrunken edge,
//     which sits closer to the wall centre line.  WALL_HALF_PX defaults to 3
//     and is tunable at the top of the worker source.
//     NOTE: this only affects the polygon[] measurement array; maskToSvgPath
//     receives the *original* closed mask and does the shrink internally via
//     the new shrinkMaskForTrace() helper, controlled by OUTLINE_SHRINK_PX.
//
//  2. SNAP OUTLINE SEGMENTS TO SVG WALL LINES
//     maskToSvgPath now accepts an optional svgLines parameter — the same
//     normalised line segments that useSvgSnapPoints already produces and
//     passes to the snap engine.  After RDP simplification each simplified
//     vertex is projected onto the nearest SVG wall line within SNAP_RADIUS_PX.
//     When the projection distance is below the threshold the vertex is moved
//     onto the line, pulling the outline onto the actual architectural lines.
//     This is the largest quality win when vector data is available.  The
//     function degrades gracefully when svgLines is empty or absent.
//
//  3. ANGLE-CONSTRAINED RDP FOR STRAIGHT WALLS
//     After snapping (or when no svgLines are available), segments whose
//     angle is within ANGLE_LOCK_TOL_DEG of a principal direction (0 / 45 /
//     90 / 135°) are rotated to that exact angle.  Both endpoints of a segment
//     are adjusted so the midpoint stays fixed — this preserves the overall
//     outline position while straightening slightly-off-axis wall segments into
//     crisp rectilinear or diagonal lines.
//
//  4. TIGHTER PARAMETERS + PER-SEGMENT RDP EPSILON
//     Straight-wall runs now use RDP_EPSILON_STRAIGHT (4.0 px) instead of the
//     shared 2.0 px, giving more aggressive simplification for long straight
//     walls while arc runs retain fine detail.  The Gaussian smoother σ is
//     kept at 1.5 but its role is now *purely* for arc detection — all path
//     commands still use the original (unsmoothed) coordinates.
//
// ─────────────────────────────────────────────────────────────────────────────

const BEZIER_TENSION        = 0.3;
const RDP_EPSILON           = 2.0;    // default / arc-adjacent segments
const RDP_EPSILON_STRAIGHT  = 4.0;    // straight-wall runs (more aggressive)
const CORNER_ANGLE_DEG      = 32;

// Arc-fitting tuning (all distances in mask-pixel units).
const ARC_FIT_TOL_PX    = 1.2;
const MIN_ARC_RUN_LEN   = 22;
const MAX_ARC_GROW      = 800;
const MIN_ARC_SPAN_DEG  = 18;
const MAX_TRACE_POINTS  = 4000;
const MIN_ARC_RADIUS_PX = 40;
const MIN_ARC_RADIUS_REL= 0.04;

// Improvement 1: how many pixels to erode the mask before tracing the boundary.
// Moving the trace point inward by ~half the wall thickness moves it toward the
// wall centre line rather than the inner face.
const OUTLINE_SHRINK_PX = 3;

// Improvement 2: SVG wall-line snap radius in mask-pixel units.
// Vertices within this distance of a nearby wall line are snapped onto it.
const SNAP_RADIUS_PX = 8;

// Improvement 3: how many degrees off-axis a segment may be before its angle
// is locked to the nearest principal direction (0/45/90/135°).
const ANGLE_LOCK_TOL_DEG = 8;

// ── Improvement 1 helper: erode a Uint8Array mask by r pixels ────────────────
//
//  Separable horizontal + vertical pass (box structuring element, radius r).
//  A pixel survives only when every pixel in its r-radius neighbourhood is set.
//  Used to shrink the filled region so the boundary tracer runs closer to the
//  wall centre line rather than the inner wall face.
//
function erodeMask(src, w, h, r) {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let zeros = 0;
    for (let x = 0; x < r && x < w; x++) if (!src[y * w + x]) zeros++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && !src[y * w + add]) zeros++;
      if (zeros === 0) horiz[y * w + x] = 1;
      const rem = x - r; if (rem >= 0 && !src[y * w + rem]) zeros--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let zeros = 0;
    for (let y = 0; y < r && y < h; y++) if (!horiz[y * w + x]) zeros++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && !horiz[add * w + x]) zeros++;
      if (zeros === 0) out[y * w + x] = 1;
      const rem = y - r; if (rem >= 0 && !horiz[rem * w + x]) zeros--;
    }
  }
  return out;
}

// Shrink the mask by OUTLINE_SHRINK_PX before tracing so the outline sits
// closer to the wall centre line than to the inner wall face.
function shrinkMaskForTrace(mask, w, h) {
  if (OUTLINE_SHRINK_PX <= 0) return mask;
  return erodeMask(mask, w, h, OUTLINE_SHRINK_PX);
}

// ── Gaussian boundary smoother ────────────────────────────────────────────────
//
//  Applies a 1-D Gaussian (σ=1.5, half-width 4) to a closed loop of boundary
//  points.  Used ONLY for arc detection — path commands always use the original
//  unsmoothed coordinates.
//
function smoothBoundary(pts) {
  const n = pts.length;
  if (n < 9) return pts;
  const sigma = 1.5, hw = 4;
  const kernel = [];
  let ksum = 0;
  for (let i = -hw; i <= hw; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0;
    for (let k = -hw; k <= hw; k++) {
      const j = ((i + k) % n + n) % n;
      const w = kernel[k + hw];
      sx += pts[j][0] * w;
      sy += pts[j][1] * w;
    }
    out[i] = [sx, sy];
  }
  return out;
}

// ── Exact pixel-grid boundary tracer ──────────────────────────────────────────
//
//  Returns an array of closed loops (each loop = array of [x, y] corner
//  coordinates in mask-pixel space).  The interior of each filled pixel occupies
//  [x, x+1] × [y, y+1]; boundary vertices therefore run from (0,0) to (w,h).
//
export function traceMaskBoundary(mask, w, h) {
  const isFilled = (x, y) =>
    x >= 0 && x < w && y >= 0 && y < h && mask[y * w + x] === 1;

  const VW = w + 1;
  const vid = (x, y) => y * VW + x;
  const nextOf = new Map();
  const addEdge = (x1, y1, x2, y2) => nextOf.set(vid(x1, y1), vid(x2, y2));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isFilled(x, y)) continue;
      if (!isFilled(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!isFilled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!isFilled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!isFilled(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  const loops = [];
  const used  = new Set();
  const maxGuard = nextOf.size + 1;

  for (const startV of nextOf.keys()) {
    if (used.has(startV)) continue;
    const loop = [];
    let v = startV;
    let guard = 0;
    do {
      used.add(v);
      loop.push([v % VW, (v / VW) | 0]);
      v = nextOf.get(v);
      if (v === undefined) { loop.length = 0; break; }
      guard++;
    } while (v !== startV && guard < maxGuard);
    if (loop.length >= 3) loops.push(loop);
  }

  return loops;
}

// ── Marching-squares contour tracer — single-loop convenience wrapper ─────────
export function marchingSquaresContour(mask, w, h) {
  const loops = traceMaskBoundary(mask, w, h);
  if (loops.length === 0) return [];
  let best = loops[0];
  for (const loop of loops) if (loop.length > best.length) best = loop;
  return best;
}

// ── Ramer–Douglas–Peucker simplification ─────────────────────────────────────
export function rdpSimplify(pts, eps) {
  if (pts.length <= 3) return pts;
  const distToLine = (p, a, b) => {
    const [ax, ay] = a, [bx, by] = b, [px, py] = p;
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px-ax)*(bx-ax) + (py-ay)*(by-ay)) / len2));
    return Math.hypot(px - (ax + t*(bx-ax)), py - (ay + t*(by-ay)));
  };
  const keep = new Set([0, pts.length - 1]);
  const rec = (lo, hi) => {
    if (hi - lo < 2) return;
    let maxD = 0, idx = lo;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToLine(pts[i], pts[lo], pts[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) { keep.add(idx); rec(lo, idx); rec(idx, hi); }
  };
  rec(0, pts.length - 1);
  return [...keep].sort((a, b) => a - b).map(i => pts[i]);
}

// ── Turn-angle helper ─────────────────────────────────────────────────────────
function turnAngleDeg(prev, curr, next) {
  const v1x = curr[0] - prev[0], v1y = curr[1] - prev[1];
  const v2x = next[0] - curr[0], v2y = next[1] - curr[1];
  const len1 = Math.hypot(v1x, v1y), len2 = Math.hypot(v2x, v2y);
  if (len1 < 1e-6 || len2 < 1e-6) return 0;
  const dot = Math.max(-1, Math.min(1, (v1x*v2x + v1y*v2y) / (len1*len2)));
  return Math.acos(dot) * 180 / Math.PI;
}

// ── Improvement 2: SVG wall-line snap ────────────────────────────────────────
//
//  svgLines: array of { x1, y1, x2, y2 } in mask-pixel space (callers that
//  receive them in normalised [0-1] coords must pre-scale by (maskW, maskH)
//  before passing here).
//
//  Projects each point in pts[] onto every nearby SVG line.  If the closest
//  projection distance is within SNAP_RADIUS_PX the point is moved onto the
//  line.  This pulls simplified outline vertices onto the actual architectural
//  lines, removing the systematic inward offset that remains after the mask
//  shrink.
//
function snapToWallLines(pts, svgLines) {
  if (!svgLines || svgLines.length === 0) return pts;
  const r2 = SNAP_RADIUS_PX * SNAP_RADIUS_PX;

  return pts.map(([px, py]) => {
    let bestDist2 = r2 + 1;
    let bestX = px, bestY = py;

    for (const seg of svgLines) {
      const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1,
        ((px - seg.x1) * dx + (py - seg.y1) * dy) / len2));
      const nx = seg.x1 + t * dx;
      const ny = seg.y1 + t * dy;
      const d2 = (px - nx) ** 2 + (py - ny) ** 2;
      if (d2 < bestDist2) { bestDist2 = d2; bestX = nx; bestY = ny; }
    }

    return bestDist2 <= r2 ? [bestX, bestY] : [px, py];
  });
}

// ── Improvement 3: angle-lock straight segments ───────────────────────────────
//
//  For each consecutive pair of vertices, if the segment angle is within
//  ANGLE_LOCK_TOL_DEG of a principal direction (0/45/90/135°), rotate the
//  segment to that exact angle while keeping its midpoint fixed.
//
//  The adjustment is propagated only to the two endpoints of the segment, not
//  beyond — this ensures adjacent segments stay connected (they share the same
//  vertex object reference after the snap step).
//
//  Returns a *new* array; the input is not mutated.
//
function angleLockSegments(pts, closed) {
  const n = pts.length;
  if (n < 2) return pts;

  // Work on a mutable copy
  const out = pts.map(p => [p[0], p[1]]);

  const PRINCIPALS_DEG = [0, 45, 90, 135, 180, 225, 270, 315];
  const TOL = ANGLE_LOCK_TOL_DEG;

  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % n;
    const dx = out[j][0] - out[i][0];
    const dy = out[j][1] - out[i][1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;

    const angDeg = Math.atan2(dy, dx) * 180 / Math.PI;
    // Normalise to [0, 360)
    const angNorm = ((angDeg % 360) + 360) % 360;

    let bestDelta = Infinity, bestPrincipal = angNorm;
    for (const p of PRINCIPALS_DEG) {
      let delta = Math.abs(angNorm - p);
      if (delta > 180) delta = 360 - delta;
      if (delta < bestDelta) { bestDelta = delta; bestPrincipal = p; }
    }

    if (bestDelta > TOL) continue; // segment is not near a principal axis

    const targetRad = bestPrincipal * Math.PI / 180;
    const halfLen   = len / 2;
    const mx = (out[i][0] + out[j][0]) / 2;
    const my = (out[i][1] + out[j][1]) / 2;
    out[i][0] = mx - Math.cos(targetRad) * halfLen;
    out[i][1] = my - Math.sin(targetRad) * halfLen;
    out[j][0] = mx + Math.cos(targetRad) * halfLen;
    out[j][1] = my + Math.sin(targetRad) * halfLen;
  }

  return out;
}

// ── Catmull-Rom → cubic bezier path builder (closed loop) ────────────────────
export function buildAdaptivePath(pts, tension = BEZIER_TENSION) {
  const n = pts.length;
  if (n < 2) return '';
  if (n === 2)
    return `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]} Z`;

  const sharp = pts.map((_, i) => {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    return turnAngleDeg(prev, pts[i], next) > CORNER_ANGLE_DEG;
  });

  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    if (sharp[i] || sharp[(i + 1) % n]) {
      d += ` L ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    } else {
      const p0 = pts[(i - 1 + n) % n];
      const p3 = pts[(i + 2) % n];
      const cp1x = p1[0] + (p2[0] - p0[0]) * tension;
      const cp1y = p1[1] + (p2[1] - p0[1]) * tension;
      const cp2x = p2[0] - (p3[0] - p1[0]) * tension;
      const cp2y = p2[1] - (p3[1] - p1[1]) * tension;
      d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)},${cp2x.toFixed(2)} ${cp2y.toFixed(2)},${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    }
  }
  return d + ' Z';
}

// ── Catmull-Rom → cubic bezier path builder (open chain) ─────────────────────
function buildOpenChainPath(pts, tension = BEZIER_TENSION) {
  const n = pts.length;
  if (n < 2) return '';
  if (n === 2) return ` L ${pts[1][0].toFixed(2)} ${pts[1][1].toFixed(2)}`;

  const sharp = new Array(n);
  sharp[0] = true;
  sharp[n - 1] = true;
  for (let i = 1; i < n - 1; i++) {
    sharp[i] = turnAngleDeg(pts[i - 1], pts[i], pts[i + 1]) > CORNER_ANGLE_DEG;
  }

  let d = '';
  for (let i = 0; i < n - 1; i++) {
    const p1 = pts[i], p2 = pts[i + 1];
    if (sharp[i] || sharp[i + 1]) {
      d += ` L ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    } else {
      const p0 = pts[i - 1];
      const p3 = pts[i + 2];
      const cp1x = p1[0] + (p2[0] - p0[0]) * tension;
      const cp1y = p1[1] + (p2[1] - p0[1]) * tension;
      const cp2x = p2[0] - (p3[0] - p1[0]) * tension;
      const cp2y = p2[1] - (p3[1] - p1[1]) * tension;
      d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)},${cp2x.toFixed(2)} ${cp2y.toFixed(2)},${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    }
  }
  return d;
}

// ── Circle fitting (Kasa / algebraic) ────────────────────────────────────────
function solveLinear3(M, b) {
  const A = [M[0].slice(), M[1].slice(), M[2].slice()];
  const B = b.slice();
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
    if (Math.abs(A[piv][i]) < 1e-9) return null;
    if (piv !== i) {
      [A[i], A[piv]] = [A[piv], A[i]];
      [B[i], B[piv]] = [B[piv], B[i]];
    }
    for (let k = i + 1; k < 3; k++) {
      const f = A[k][i] / A[i][i];
      for (let j = i; j < 3; j++) A[k][j] -= f * A[i][j];
      B[k] -= f * B[i];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = B[i];
    for (let j = i + 1; j < 3; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}

function fitCircle(pts) {
  let sx=0, sy=0, sxx=0, syy=0, sxy=0, sxxx=0, syyy=0, sxyy=0, sxxy=0;
  for (const [x, y] of pts) {
    sx += x; sy += y; sxx += x*x; syy += y*y; sxy += x*y;
    sxxx += x*x*x; syyy += y*y*y; sxyy += x*y*y; sxxy += x*x*y;
  }
  const n = pts.length;
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const R = [-(sxxx + sxyy), -(sxxy + syyy), -(sxx + syy)];
  const sol = solveLinear3(M, R);
  if (!sol) return null;
  const [a, b, c] = sol;
  const cx = -a / 2, cy = -b / 2;
  const r2 = cx*cx + cy*cy - c;
  if (!(r2 > 0)) return null;
  return { cx, cy, r: Math.sqrt(r2) };
}

function maxResidual(pts, fit) {
  let m = 0;
  for (const [x, y] of pts) {
    const d = Math.abs(Math.hypot(x - fit.cx, y - fit.cy) - fit.r);
    if (d > m) m = d;
  }
  return m;
}

function angleAt(pt, fit) { return Math.atan2(pt[1] - fit.cy, pt[0] - fit.cx); }

function normDelta(a, b) {
  let d = b - a;
  while (d <= -Math.PI) d += 2 * Math.PI;
  while (d >   Math.PI) d -= 2 * Math.PI;
  return d;
}

function arcSpanDeg(pStart, pMid, pEnd, fit) {
  const a0 = angleAt(pStart, fit), aMid = angleAt(pMid, fit), a1 = angleAt(pEnd, fit);
  const total = normDelta(a0, aMid) + normDelta(aMid, a1);
  return total * 180 / Math.PI;
}

// ── Arc-run detection ─────────────────────────────────────────────────────────
function findArcRuns(pts) {
  const n = pts.length;
  const runs = [];
  if (n < MIN_ARC_RUN_LEN) return runs;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const bboxDiag      = Math.hypot(maxX - minX, maxY - minY);
  const maxSaneRadius = bboxDiag * 3;
  const minRadiusAbs  = MIN_ARC_RADIUS_PX;
  const minRadiusRel  = bboxDiag * MIN_ARC_RADIUS_REL;
  const minRadius     = Math.max(minRadiusAbs, minRadiusRel);

  const smooth = smoothBoundary(pts);

  let i = 0;
  while (i <= n - MIN_ARC_RUN_LEN) {
    let bestLen = 0, bestFit = null;
    const cap = Math.min(MAX_ARC_GROW, n - i);
    for (let len = MIN_ARC_RUN_LEN; len <= cap; len++) {
      const window = smooth.slice(i, i + len);
      const fit = fitCircle(window);
      if (!fit || fit.r > maxSaneRadius || fit.r < minRadius) break;
      if (maxResidual(window, fit) > ARC_FIT_TOL_PX) break;
      bestLen = len; bestFit = fit;
    }
    if (bestLen >= MIN_ARC_RUN_LEN) {
      const endIdx = i + bestLen - 1;
      const midIdx = i + ((bestLen - 1) >> 1);
      // Refit on raw (unsmoothed) points so the emitted radius matches the
      // true mask boundary rather than the smoothed detection window.
      const rawWindow = pts.slice(i, endIdx + 1);
      const rawFit    = fitCircle(rawWindow);
      const finalFit  = (rawFit && rawFit.r <= maxSaneRadius && rawFit.r >= minRadius * 0.5)
        ? rawFit
        : bestFit;
      const span = arcSpanDeg(pts[i], pts[midIdx], pts[endIdx], finalFit);
      if (Math.abs(span) >= MIN_ARC_SPAN_DEG) {
        runs.push({ startIdx: i, endIdx, fit: finalFit, span });
        i = endIdx;
        continue;
      }
    }
    i++;
  }
  return runs;
}

function chainLen(pts) {
  let p = 0;
  for (let i = 0; i < pts.length - 1; i++)
    p += Math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1]);
  return p;
}

function loopLen(pts) {
  return chainLen(pts) +
    Math.hypot(pts[0][0]-pts[pts.length-1][0], pts[0][1]-pts[pts.length-1][1]);
}

// ── Improvement 2+3 applied to a straight segment array ───────────────────────
//
//  Helper used inside buildSmartPath to post-process a non-arc segment before
//  turning it into path commands.  Receives the raw segment points and the
//  optional svgLines array (already in mask-pixel space).
//
//  Pipeline:
//    1. RDP with RDP_EPSILON_STRAIGHT (more aggressive for straight walls)
//    2. Snap vertices to nearby SVG wall lines
//    3. Angle-lock remaining segments to principal axes
//
function processStraightSegment(seg, svgLines) {
  const eps = Math.max(1.0, Math.min(RDP_EPSILON_STRAIGHT, chainLen(seg) / 400));
  let simp = seg.length > 2 ? rdpSimplify(seg, eps) : seg.slice();
  if (svgLines && svgLines.length > 0) simp = snapToWallLines(simp, svgLines);
  simp = angleLockSegments(simp, false);
  return simp;
}

// ── Arc-aware path builder for one closed loop ────────────────────────────────
//
//  Improvements applied here:
//   • Non-arc segments go through processStraightSegment (improvement 2+3+4)
//   • Arc segments are unchanged — they already use raw-refit geometry
//
function buildSmartPath(pts, svgLines) {
  const n = pts.length;
  if (n < 3) return '';

  const runs = findArcRuns(pts);
  if (runs.length === 0) {
    // Whole loop is straight — apply straight-wall pipeline to the full loop.
    const eps = Math.max(1.0, Math.min(RDP_EPSILON_STRAIGHT, loopLen(pts) / 400));
    let simplified = rdpSimplify(pts, eps);
    if (svgLines && svgLines.length > 0) simplified = snapToWallLines(simplified, svgLines);
    simplified = angleLockSegments(simplified, true);
    return simplified.length >= 3 ? buildAdaptivePath(simplified, BEZIER_TENSION) : '';
  }

  const runByStart = new Map(runs.map(r => [r.startIdx, r]));

  const flushStraight = (from, to) => {
    if (to <= from) return '';
    const seg = pts.slice(from, to + 1);
    const simp = processStraightSegment(seg, svgLines);
    return buildOpenChainPath(simp, BEZIER_TENSION);
  };

  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  let bufStart = 0;
  let i = 0;
  while (i < n) {
    const run = runByStart.get(i);
    if (run) {
      d += flushStraight(bufStart, i);
      const ep = pts[run.endIdx];
      const largeArc = Math.abs(run.span) > 180 ? 1 : 0;
      const sweep    = run.span >= 0 ? 1 : 0;
      d += ` A ${run.fit.r.toFixed(2)} ${run.fit.r.toFixed(2)} 0 ${largeArc} ${sweep} ${ep[0].toFixed(2)} ${ep[1].toFixed(2)}`;
      bufStart = run.endIdx;
      i = run.endIdx;
    } else {
      i++;
    }
  }
  // Tail: the remaining segment back to the start point
  const tail = pts.slice(bufStart).concat([pts[0]]);
  const simpTail = processStraightSegment(tail, svgLines);
  d += buildOpenChainPath(simpTail, BEZIER_TENSION);

  return d + ' Z';
}

// ── Main entry: pixel mask → SVG path string ──────────────────────────────────
//
//  New signature: maskToSvgPath(mask, w, h, svgLines?)
//
//  svgLines (optional): array of { x1, y1, x2, y2 } line segments in
//  mask-pixel space.  When provided, simplified outline vertices that fall
//  within SNAP_RADIUS_PX of a segment are snapped onto it (improvement 2).
//
//  Internally applies shrinkMaskForTrace() (improvement 1) before boundary
//  tracing so the outline sits closer to the wall centre line.
//
export function maskToSvgPath(mask, w, h, svgLines) {
  const fallbackRect = () => {
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return `M ${minX} ${minY} L ${maxX} ${minY} L ${maxX} ${maxY} L ${minX} ${maxY} Z`;
  };

  // Improvement 1: shrink the mask before tracing so the outline boundary
  // runs along (approximately) the wall centre line rather than the inner face.
  const traceMask = shrinkMaskForTrace(mask, w, h);

  const loops = traceMaskBoundary(traceMask, w, h);
  if (loops.length === 0) return fallbackRect();

  const subpaths = [];
  for (let pts of loops) {
    if (pts.length > MAX_TRACE_POINTS) {
      const step = Math.ceil(pts.length / MAX_TRACE_POINTS);
      pts = pts.filter((_, i) => i % step === 0);
    }
    if (pts.length < 3 || loopLen(pts) < 6) continue;

    const d = buildSmartPath(pts, svgLines || null);
    if (d) subpaths.push(d);
  }

  return subpaths.length > 0 ? subpaths.join(' ') : fallbackRect();
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker embed string
//
//  Mirrors the module above, inlined as a template-literal string so that both
//  the raster worker and the polygon lasso worker in useMagicFillSession.ts can
//  splice it into their Blob sources without ES-module imports.
//
//  SYNC NOTE: Any change to the logic above MUST be mirrored here.
//  The two copies are identical except:
//    • `export function` / `export const` → plain `function` / `const`
//    • No top-level `export` statements
//    • Destructuring assignments replaced with compatible equivalents for
//      older V8 worker environments (kept the same — modern workers are fine)
//
// ─────────────────────────────────────────────────────────────────────────────

export const SVG_PATH_UTILS_SOURCE = /* js */`
const BEZIER_TENSION        = 0.3;
const RDP_EPSILON           = 2.0;
const RDP_EPSILON_STRAIGHT  = 4.0;
const CORNER_ANGLE_DEG      = 32;

const ARC_FIT_TOL_PX    = 1.2;
const MIN_ARC_RUN_LEN   = 22;
const MAX_ARC_GROW      = 800;
const MIN_ARC_SPAN_DEG  = 18;
const MAX_TRACE_POINTS  = 4000;
const MIN_ARC_RADIUS_PX = 40;
const MIN_ARC_RADIUS_REL= 0.04;

const OUTLINE_SHRINK_PX  = 3;
const SNAP_RADIUS_PX     = 8;
const ANGLE_LOCK_TOL_DEG = 8;

function erodeMask(src, w, h, r) {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let zeros = 0;
    for (let x = 0; x < r && x < w; x++) if (!src[y * w + x]) zeros++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && !src[y * w + add]) zeros++;
      if (zeros === 0) horiz[y * w + x] = 1;
      const rem = x - r; if (rem >= 0 && !src[y * w + rem]) zeros--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let zeros = 0;
    for (let y = 0; y < r && y < h; y++) if (!horiz[y * w + x]) zeros++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && !horiz[add * w + x]) zeros++;
      if (zeros === 0) out[y * w + x] = 1;
      const rem = y - r; if (rem >= 0 && !horiz[rem * w + x]) zeros--;
    }
  }
  return out;
}

function shrinkMaskForTrace(mask, w, h) {
  if (OUTLINE_SHRINK_PX <= 0) return mask;
  return erodeMask(mask, w, h, OUTLINE_SHRINK_PX);
}

function smoothBoundary(pts) {
  const n = pts.length;
  if (n < 9) return pts;
  const sigma = 1.5, hw = 4;
  const kernel = [];
  let ksum = 0;
  for (let i = -hw; i <= hw; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0;
    for (let k = -hw; k <= hw; k++) {
      const j = ((i + k) % n + n) % n;
      const w = kernel[k + hw];
      sx += pts[j][0] * w;
      sy += pts[j][1] * w;
    }
    out[i] = [sx, sy];
  }
  return out;
}

function traceMaskBoundary(mask, w, h) {
  function isFilled(x, y) {
    return x >= 0 && x < w && y >= 0 && y < h && mask[y * w + x] === 1;
  }
  const VW = w + 1;
  function vid(x, y) { return y * VW + x; }
  const nextOf = new Map();
  function addEdge(x1, y1, x2, y2) { nextOf.set(vid(x1, y1), vid(x2, y2)); }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isFilled(x, y)) continue;
      if (!isFilled(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!isFilled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!isFilled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!isFilled(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  const loops = [];
  const used  = new Set();
  const maxGuard = nextOf.size + 1;

  for (const startV of nextOf.keys()) {
    if (used.has(startV)) continue;
    const loop = [];
    let v = startV;
    let guard = 0;
    do {
      used.add(v);
      loop.push([v % VW, (v / VW) | 0]);
      v = nextOf.get(v);
      if (v === undefined) { loop.length = 0; break; }
      guard++;
    } while (v !== startV && guard < maxGuard);
    if (loop.length >= 3) loops.push(loop);
  }

  return loops;
}

function marchingSquaresContour(mask, w, h) {
  const loops = traceMaskBoundary(mask, w, h);
  if (loops.length === 0) return [];
  let best = loops[0];
  for (const loop of loops) if (loop.length > best.length) best = loop;
  return best;
}

function rdpSimplify(pts, eps) {
  if (pts.length <= 3) return pts;
  const distToLine = (p, a, b) => {
    const ax = a[0], ay = a[1], bx = b[0], by = b[1], px = p[0], py = p[1];
    const len2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px-ax)*(bx-ax) + (py-ay)*(by-ay)) / len2));
    return Math.hypot(px - (ax + t*(bx-ax)), py - (ay + t*(by-ay)));
  };
  const keep = new Set([0, pts.length - 1]);
  const rec = (lo, hi) => {
    if (hi - lo < 2) return;
    let maxD = 0, idx = lo;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToLine(pts[i], pts[lo], pts[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) { keep.add(idx); rec(lo, idx); rec(idx, hi); }
  };
  rec(0, pts.length - 1);
  return Array.from(keep).sort((a, b) => a - b).map(i => pts[i]);
}

function turnAngleDeg(prev, curr, next) {
  const v1x = curr[0] - prev[0], v1y = curr[1] - prev[1];
  const v2x = next[0] - curr[0], v2y = next[1] - curr[1];
  const len1 = Math.hypot(v1x, v1y), len2 = Math.hypot(v2x, v2y);
  if (len1 < 1e-6 || len2 < 1e-6) return 0;
  const dot = Math.max(-1, Math.min(1, (v1x*v2x + v1y*v2y) / (len1*len2)));
  return Math.acos(dot) * 180 / Math.PI;
}

function snapToWallLines(pts, svgLines) {
  if (!svgLines || svgLines.length === 0) return pts;
  const r2 = SNAP_RADIUS_PX * SNAP_RADIUS_PX;
  return pts.map(function(pt) {
    const px = pt[0], py = pt[1];
    let bestDist2 = r2 + 1, bestX = px, bestY = py;
    for (let si = 0; si < svgLines.length; si++) {
      const seg = svgLines[si];
      const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((px - seg.x1) * dx + (py - seg.y1) * dy) / len2));
      const nx = seg.x1 + t * dx, ny = seg.y1 + t * dy;
      const d2 = (px - nx) * (px - nx) + (py - ny) * (py - ny);
      if (d2 < bestDist2) { bestDist2 = d2; bestX = nx; bestY = ny; }
    }
    return bestDist2 <= r2 ? [bestX, bestY] : [px, py];
  });
}

function angleLockSegments(pts, closed) {
  const n = pts.length;
  if (n < 2) return pts;
  const out = pts.map(function(p) { return [p[0], p[1]]; });
  const PRINCIPALS = [0, 45, 90, 135, 180, 225, 270, 315];
  const TOL = ANGLE_LOCK_TOL_DEG;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % n;
    const dx = out[j][0] - out[i][0], dy = out[j][1] - out[i][1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const angDeg = Math.atan2(dy, dx) * 180 / Math.PI;
    const angNorm = ((angDeg % 360) + 360) % 360;
    let bestDelta = Infinity, bestPrincipal = angNorm;
    for (let pi = 0; pi < PRINCIPALS.length; pi++) {
      let delta = Math.abs(angNorm - PRINCIPALS[pi]);
      if (delta > 180) delta = 360 - delta;
      if (delta < bestDelta) { bestDelta = delta; bestPrincipal = PRINCIPALS[pi]; }
    }
    if (bestDelta > TOL) continue;
    const targetRad = bestPrincipal * Math.PI / 180;
    const halfLen = len / 2;
    const mx = (out[i][0] + out[j][0]) / 2, my = (out[i][1] + out[j][1]) / 2;
    out[i][0] = mx - Math.cos(targetRad) * halfLen;
    out[i][1] = my - Math.sin(targetRad) * halfLen;
    out[j][0] = mx + Math.cos(targetRad) * halfLen;
    out[j][1] = my + Math.sin(targetRad) * halfLen;
  }
  return out;
}

function buildAdaptivePath(pts, tension) {
  const n = pts.length;
  if (n < 2) return '';
  if (n === 2) return 'M ' + pts[0][0] + ' ' + pts[0][1] + ' L ' + pts[1][0] + ' ' + pts[1][1] + ' Z';
  const sharp = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    sharp[i] = turnAngleDeg(prev, pts[i], next) > CORNER_ANGLE_DEG;
  }
  let d = 'M ' + pts[0][0].toFixed(2) + ' ' + pts[0][1].toFixed(2);
  for (let i = 0; i < n; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % n];
    if (sharp[i] || sharp[(i + 1) % n]) {
      d += ' L ' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2);
    } else {
      const p0 = pts[(i - 1 + n) % n], p3 = pts[(i + 2) % n];
      const cp1x = p1[0] + (p2[0] - p0[0]) * tension;
      const cp1y = p1[1] + (p2[1] - p0[1]) * tension;
      const cp2x = p2[0] - (p3[0] - p1[0]) * tension;
      const cp2y = p2[1] - (p3[1] - p1[1]) * tension;
      d += ' C ' + cp1x.toFixed(2) + ' ' + cp1y.toFixed(2) + ',' + cp2x.toFixed(2) + ' ' + cp2y.toFixed(2) + ',' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2);
    }
  }
  return d + ' Z';
}

function buildOpenChainPath(pts, tension) {
  const n = pts.length;
  if (n < 2) return '';
  if (n === 2) return ' L ' + pts[1][0].toFixed(2) + ' ' + pts[1][1].toFixed(2);
  const sharp = new Array(n);
  sharp[0] = true; sharp[n - 1] = true;
  for (let i = 1; i < n - 1; i++) {
    sharp[i] = turnAngleDeg(pts[i - 1], pts[i], pts[i + 1]) > CORNER_ANGLE_DEG;
  }
  let d = '';
  for (let i = 0; i < n - 1; i++) {
    const p1 = pts[i], p2 = pts[i + 1];
    if (sharp[i] || sharp[i + 1]) {
      d += ' L ' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2);
    } else {
      const p0 = pts[i - 1], p3 = pts[i + 2];
      const cp1x = p1[0] + (p2[0] - p0[0]) * tension;
      const cp1y = p1[1] + (p2[1] - p0[1]) * tension;
      const cp2x = p2[0] - (p3[0] - p1[0]) * tension;
      const cp2y = p2[1] - (p3[1] - p1[1]) * tension;
      d += ' C ' + cp1x.toFixed(2) + ' ' + cp1y.toFixed(2) + ',' + cp2x.toFixed(2) + ' ' + cp2y.toFixed(2) + ',' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2);
    }
  }
  return d;
}

function solveLinear3(M, b) {
  const A = [M[0].slice(), M[1].slice(), M[2].slice()];
  const B = b.slice();
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
    if (Math.abs(A[piv][i]) < 1e-9) return null;
    if (piv !== i) {
      const tmpA = A[i]; A[i] = A[piv]; A[piv] = tmpA;
      const tmpB = B[i]; B[i] = B[piv]; B[piv] = tmpB;
    }
    for (let k = i + 1; k < 3; k++) {
      const f = A[k][i] / A[i][i];
      for (let j = i; j < 3; j++) A[k][j] -= f * A[i][j];
      B[k] -= f * B[i];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = B[i];
    for (let j = i + 1; j < 3; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}

function fitCircle(pts) {
  let sx=0, sy=0, sxx=0, syy=0, sxy=0, sxxx=0, syyy=0, sxyy=0, sxxy=0;
  for (let pi = 0; pi < pts.length; pi++) {
    const x = pts[pi][0], y = pts[pi][1];
    sx += x; sy += y; sxx += x*x; syy += y*y; sxy += x*y;
    sxxx += x*x*x; syyy += y*y*y; sxyy += x*y*y; sxxy += x*x*y;
  }
  const n = pts.length;
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const R = [-(sxxx + sxyy), -(sxxy + syyy), -(sxx + syy)];
  const sol = solveLinear3(M, R);
  if (!sol) return null;
  const a = sol[0], b = sol[1], c = sol[2];
  const cx = -a / 2, cy = -b / 2;
  const r2 = cx*cx + cy*cy - c;
  if (!(r2 > 0)) return null;
  return { cx: cx, cy: cy, r: Math.sqrt(r2) };
}

function maxResidual(pts, fit) {
  let m = 0;
  for (let pi = 0; pi < pts.length; pi++) {
    const d = Math.abs(Math.hypot(pts[pi][0] - fit.cx, pts[pi][1] - fit.cy) - fit.r);
    if (d > m) m = d;
  }
  return m;
}

function angleAt(pt, fit) { return Math.atan2(pt[1] - fit.cy, pt[0] - fit.cx); }

function normDelta(a, b) {
  let d = b - a;
  while (d <= -Math.PI) d += 2 * Math.PI;
  while (d >   Math.PI) d -= 2 * Math.PI;
  return d;
}

function arcSpanDeg(pStart, pMid, pEnd, fit) {
  const a0 = angleAt(pStart, fit), aMid = angleAt(pMid, fit), a1 = angleAt(pEnd, fit);
  const total = normDelta(a0, aMid) + normDelta(aMid, a1);
  return total * 180 / Math.PI;
}

function findArcRuns(pts) {
  const n = pts.length;
  const runs = [];
  if (n < MIN_ARC_RUN_LEN) return runs;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let pi = 0; pi < pts.length; pi++) {
    if (pts[pi][0] < minX) minX = pts[pi][0]; if (pts[pi][0] > maxX) maxX = pts[pi][0];
    if (pts[pi][1] < minY) minY = pts[pi][1]; if (pts[pi][1] > maxY) maxY = pts[pi][1];
  }
  const bboxDiag      = Math.hypot(maxX - minX, maxY - minY);
  const maxSaneRadius = bboxDiag * 3;
  const minRadius     = Math.max(MIN_ARC_RADIUS_PX, bboxDiag * MIN_ARC_RADIUS_REL);
  const smooth = smoothBoundary(pts);
  let i = 0;
  while (i <= n - MIN_ARC_RUN_LEN) {
    let bestLen = 0, bestFit = null;
    const cap = Math.min(MAX_ARC_GROW, n - i);
    for (let len = MIN_ARC_RUN_LEN; len <= cap; len++) {
      const window = smooth.slice(i, i + len);
      const fit = fitCircle(window);
      if (!fit || fit.r > maxSaneRadius || fit.r < minRadius) break;
      if (maxResidual(window, fit) > ARC_FIT_TOL_PX) break;
      bestLen = len; bestFit = fit;
    }
    if (bestLen >= MIN_ARC_RUN_LEN) {
      const endIdx = i + bestLen - 1;
      const midIdx = i + ((bestLen - 1) >> 1);
      const rawWindow = pts.slice(i, endIdx + 1);
      const rawFit    = fitCircle(rawWindow);
      const finalFit  = (rawFit && rawFit.r <= maxSaneRadius && rawFit.r >= minRadius * 0.5)
        ? rawFit : bestFit;
      const span = arcSpanDeg(pts[i], pts[midIdx], pts[endIdx], finalFit);
      if (Math.abs(span) >= MIN_ARC_SPAN_DEG) {
        runs.push({ startIdx: i, endIdx: endIdx, fit: finalFit, span: span });
        i = endIdx; continue;
      }
    }
    i++;
  }
  return runs;
}

function chainLen(pts) {
  let p = 0;
  for (let i = 0; i < pts.length - 1; i++) p += Math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1]);
  return p;
}

function loopLen(pts) {
  return chainLen(pts) + Math.hypot(pts[0][0]-pts[pts.length-1][0], pts[0][1]-pts[pts.length-1][1]);
}

function processStraightSegment(seg, svgLines) {
  const eps = Math.max(1.0, Math.min(RDP_EPSILON_STRAIGHT, chainLen(seg) / 400));
  let simp = seg.length > 2 ? rdpSimplify(seg, eps) : seg.slice();
  if (svgLines && svgLines.length > 0) simp = snapToWallLines(simp, svgLines);
  simp = angleLockSegments(simp, false);
  return simp;
}

function buildSmartPath(pts, svgLines) {
  const n = pts.length;
  if (n < 3) return '';

  const runs = findArcRuns(pts);
  if (runs.length === 0) {
    const eps = Math.max(1.0, Math.min(RDP_EPSILON_STRAIGHT, loopLen(pts) / 400));
    let simplified = rdpSimplify(pts, eps);
    if (svgLines && svgLines.length > 0) simplified = snapToWallLines(simplified, svgLines);
    simplified = angleLockSegments(simplified, true);
    return simplified.length >= 3 ? buildAdaptivePath(simplified, BEZIER_TENSION) : '';
  }

  const runByStart = new Map();
  for (let ri = 0; ri < runs.length; ri++) runByStart.set(runs[ri].startIdx, runs[ri]);

  function flushStraight(from, to) {
    if (to <= from) return '';
    const seg = pts.slice(from, to + 1);
    const simp = processStraightSegment(seg, svgLines);
    return buildOpenChainPath(simp, BEZIER_TENSION);
  }

  let d = 'M ' + pts[0][0].toFixed(2) + ' ' + pts[0][1].toFixed(2);
  let bufStart = 0;
  let i = 0;
  while (i < n) {
    const run = runByStart.get(i);
    if (run) {
      d += flushStraight(bufStart, i);
      const ep = pts[run.endIdx];
      const largeArc = Math.abs(run.span) > 180 ? 1 : 0;
      const sweep    = run.span >= 0 ? 1 : 0;
      d += ' A ' + run.fit.r.toFixed(2) + ' ' + run.fit.r.toFixed(2) + ' 0 ' + largeArc + ' ' + sweep + ' ' + ep[0].toFixed(2) + ' ' + ep[1].toFixed(2);
      bufStart = run.endIdx;
      i = run.endIdx;
    } else {
      i++;
    }
  }
  const tail = pts.slice(bufStart).concat([pts[0]]);
  const simpTail = processStraightSegment(tail, svgLines);
  d += buildOpenChainPath(simpTail, BEZIER_TENSION);
  return d + ' Z';
}

function maskToSvgPath(mask, w, h, svgLines) {
  const fallbackRect = function() {
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return 'M ' + minX + ' ' + minY + ' L ' + maxX + ' ' + minY + ' L ' + maxX + ' ' + maxY + ' L ' + minX + ' ' + maxY + ' Z';
  };

  const traceMask = shrinkMaskForTrace(mask, w, h);
  const loops = traceMaskBoundary(traceMask, w, h);
  if (loops.length === 0) return fallbackRect();

  const subpaths = [];
  for (let li = 0; li < loops.length; li++) {
    let pts = loops[li];
    if (pts.length > MAX_TRACE_POINTS) {
      const step = Math.ceil(pts.length / MAX_TRACE_POINTS);
      pts = pts.filter(function(_, idx) { return idx % step === 0; });
    }
    if (pts.length < 3 || loopLen(pts) < 6) continue;
    const d = buildSmartPath(pts, svgLines || null);
    if (d) subpaths.push(d);
  }

  return subpaths.length > 0 ? subpaths.join(' ') : fallbackRect();
}
`;
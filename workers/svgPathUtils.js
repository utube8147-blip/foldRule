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
//  FIX (previous revision): replaced the boundary tracer with an exact
//  pixel-grid edge tracer (traceMaskBoundary) so notches/doorways no longer
//  cause early termination / fallback-to-bbox-rectangle.
//
//  FIX (previous revision): arc-aware path building — detects circular arc
//  runs and emits exact SVG "A" arc commands for them.
//
//  FIX (this revision): arc noise suppression.
//
//  The previous arc detector was too permissive: on scanned/painted floor
//  plans the boundary trace is slightly rough/noisy, which meant tiny circles
//  (radius 5-30 px) were fitted to short runs of jagged boundary pixels and
//  emitted as real arcs. This produced hundreds of microscopic arc commands
//  that distorted the outline instead of smoothing it.
//
//  Key changes in this revision:
//
//  1. MIN_ARC_RADIUS_PX (40 px) — any fitted circle whose radius is below
//     this absolute threshold is rejected immediately. Real architectural
//     arcs (stairwells, curved walls, rounded corners) are always much larger
//     than the pixel-level noise circles that were slipping through.
//
//  2. MIN_ARC_RADIUS_REL (0.04) — the fitted radius must also be at least
//     4 % of the loop's bounding-box diagonal. This catches the same noise
//     on high-resolution scans where a 40 px absolute floor might still be
//     too small. The two thresholds are ANDed: both must pass.
//
//  3. MIN_ARC_RUN_LEN raised 14 → 22 — a longer minimum window means the
//     Kasa fit has more points to work with, making it much harder for a
//     short noisy spike to accumulate enough consecutive points to qualify.
//
//  4. ARC_FIT_TOL_PX tightened 1.5 → 1.2 px — stricter per-point residual
//     tolerance so that a run is only accepted when the points genuinely lie
//     on a circle, not merely "close enough" due to the grow/merge that
//     turns a jagged painted boundary into a fuzzy blob.
//
//  5. MIN_ARC_SPAN_DEG raised 10 → 18° — rejects very shallow "arcs" that
//     are really just mildly bowed straight wall segments.
//
//  6. Gaussian pre-smoothing of the boundary trace (smoothBoundary, σ=1.5,
//     kernel half-width 4) before arc detection. This reduces the ±1–2 px
//     pixel-grid noise inherent in the exact edge tracer without blurring
//     the large-scale geometry. Arc detection runs on the smoothed coords;
//     the actual path commands still use the original (unsmoothed) endpoint
//     positions so the final outline stays precisely on the mask boundary.
//
//  Together these changes mean that only genuine architectural curves —
//  stairwells, rounded vestibules, curved exterior walls — are emitted as
//  SVG arc commands, while pixel-level roughness is handled by the existing
//  RDP + Catmull-Rom bezier pipeline.
//
// ─────────────────────────────────────────────────────────────────────────────

const BEZIER_TENSION    = 0.3;
const RDP_EPSILON       = 2.0;
const CORNER_ANGLE_DEG  = 32;

// Arc-fitting tuning. All distances are in mask-pixel units.
const ARC_FIT_TOL_PX    = 1.2;   // max allowed distance from a fitted circle (tightened from 1.5)
const MIN_ARC_RUN_LEN   = 22;    // min dense boundary points to call something an arc (raised from 14)
const MAX_ARC_GROW      = 800;   // cap on how far a single run is grown (perf safety)
const MIN_ARC_SPAN_DEG  = 18;    // min angular sweep (raised from 10) — rejects gently-bowed straights
const MAX_TRACE_POINTS  = 4000;  // pre-decimation cap so pathological masks can't hang the worker
const MIN_ARC_RADIUS_PX = 40;    // NEW: absolute min radius in pixels — kills noise-circle arcs
const MIN_ARC_RADIUS_REL= 0.04;  // NEW: min radius as fraction of loop bbox diagonal

// ── Gaussian boundary smoother ────────────────────────────────────────────────
//
//  Applies a 1-D Gaussian (σ=1.5, half-width 4) separately to the x and y
//  coordinates of a closed loop of boundary points. This damps the ±1-2 px
//  pixel-grid jitter that the exact edge tracer produces without shifting the
//  large-scale geometry. Used only for arc detection; the original unsmoothed
//  points are still used for building the final path commands.
//
function smoothBoundary(pts) {
  const n = pts.length;
  if (n < 9) return pts;

  // Pre-compute Gaussian kernel (σ = 1.5, half-width = 4)
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
//  Pixel (x, y) is treated as occupying the unit square [x, x+1] × [y, y+1],
//  so grid-corner coordinates run from (0,0) to (w,h) — the SAME coordinate
//  space the mask itself lives in (no padding/offset bookkeeping needed by
//  callers).
//
//  Returns an array of closed loops (each loop = array of [x, y] points).
//  A normal single-blob fill produces exactly one loop; multiple disjoint
//  filled regions (e.g. several rooms that never got bridged together by
//  dilation) each produce their own loop.
//
//  Orientation: edges are emitted clockwise around each filled pixel
//  (top→right, right→down, down→left, left→up in image/canvas coordinates,
//  where y increases downward), so the outer boundary of a solid blob comes
//  out as a clockwise loop. Callers here only stroke the path, so winding
//  doesn't affect rendering — it's noted for completeness.
//
//  Known limitation: a mask with single-pixel diagonal ("checkerboard")
//  touches has an inherently ambiguous boundary at that corner. This
//  tracer resolves it arbitrarily (last edge registered at that vertex
//  wins) rather than implementing the full marching-squares saddle-case
//  table — an acceptable simplification for real architectural wall masks.
//
export function traceMaskBoundary(mask, w, h) {
  const isFilled = (x, y) =>
    x >= 0 && x < w && y >= 0 && y < h && mask[y * w + x] === 1;

  const VW = w + 1; // vertex-grid stride
  const vid = (x, y) => y * VW + x;
  const nextOf = new Map();
  const addEdge = (x1, y1, x2, y2) => nextOf.set(vid(x1, y1), vid(x2, y2));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isFilled(x, y)) continue;
      if (!isFilled(x, y - 1)) addEdge(x, y, x + 1, y);         // top edge
      if (!isFilled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1); // right edge
      if (!isFilled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1); // bottom edge
      if (!isFilled(x - 1, y)) addEdge(x, y + 1, x, y);         // left edge
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
      if (v === undefined) { loop.length = 0; break; } // malformed/open chain — discard
      guard++;
    } while (v !== startV && guard < maxGuard);
    if (loop.length >= 3) loops.push(loop);
  }

  return loops;
}

// ── Marching-squares contour tracer — single-loop convenience wrapper ────────
//
//  Preserved for backward compatibility with existing callers expecting a
//  single contour array (e.g. fillMaskAndSvgPath.ts's re-export). Now backed
//  by the robust edge tracer above: returns the largest loop by point count,
//  which is the real outer boundary for the common single-blob-fill case.
//
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

// ── Catmull-Rom → cubic bezier path builder (closed loop) ────────────────────
//
//  Used as the whole-path fallback when a loop has no detectable arcs at all
//  (e.g. a purely rectangular room) — same behaviour as before this revision.
//
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

// ── Catmull-Rom → cubic bezier path builder (OPEN chain) ──────────────────────
//
//  Same corner logic as buildAdaptivePath, but for a non-closed run of
//  points sitting between two arcs (or between an arc and the seam). The
//  two endpoints of the chain are forced "sharp" so smoothing never reaches
//  across the seam into an adjacent arc/line run.
//
//  Returns just the trailing " L"/" C" commands (no leading "M").
//
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
      const p0 = pts[i - 1]; // safe: sharp[0]=true forces i>=1 here
      const p3 = pts[i + 2]; // safe: sharp[n-1]=true forces i<=n-3 here
      const cp1x = p1[0] + (p2[0] - p0[0]) * tension;
      const cp1y = p1[1] + (p2[1] - p0[1]) * tension;
      const cp2x = p2[0] - (p3[0] - p1[0]) * tension;
      const cp2y = p2[1] - (p3[1] - p1[1]) * tension;
      d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)},${cp2x.toFixed(2)} ${cp2y.toFixed(2)},${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    }
  }
  return d;
}

// ── Least-squares circle fit (algebraic / Kasa-style normal equations) ───────
//
//  Fits x²+y²+ax+by+c=0 to a set of points via the 3×3 normal-equations
//  system, then converts to center/radius. Returns null if the points are
//  (numerically) collinear or otherwise don't determine a circle.
//
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
  while (d > Math.PI) d -= 2 * Math.PI;
  return d;
}

// Signed angular sweep (degrees) going start → mid → end around `fit`'s
// center, using three ACTUAL points from the traced boundary (not just the
// endpoints) so the direction and quadrant are unambiguous even for sweeps
// approaching or exceeding 180°.
function arcSpanDeg(pStart, pMid, pEnd, fit) {
  const a0 = angleAt(pStart, fit), aMid = angleAt(pMid, fit), a1 = angleAt(pEnd, fit);
  const total = normDelta(a0, aMid) + normDelta(aMid, a1);
  return total * 180 / Math.PI;
}

// ── Arc-run detection over a DENSE boundary trace ─────────────────────────────
//
//  Greedily grows, from every still-unclaimed start index, the longest run
//  of consecutive points (on the SMOOTHED boundary) whose max distance from
//  a fitted circle stays under ARC_FIT_TOL_PX.
//
//  A run is accepted only when ALL of the following hold:
//    • length ≥ MIN_ARC_RUN_LEN (22 pts) — enough samples for a confident fit
//    • span   ≥ MIN_ARC_SPAN_DEG (18°)  — not a barely-bowed straight wall
//    • radius ≥ MIN_ARC_RADIUS_PX (40 px) — not a noise micro-circle
//    • radius ≥ MIN_ARC_RADIUS_REL × bbox_diagonal — not tiny relative to shape
//    • radius ≤ maxSaneRadius (3× bbox diagonal) — not an absurdly huge circle
//
//  Detection runs on the smoothed coords (Gaussian pre-smoothed, σ=1.5) to
//  suppress the ±1-2 px pixel-grid jitter from the exact edge tracer.
//  The arc endpoint written into the SVG "A" command still uses the ORIGINAL
//  unsmoothed position so the outline stays true to the mask boundary.
//
function findArcRuns(pts) {
  const n = pts.length;
  const runs = [];
  if (n < MIN_ARC_RUN_LEN) return runs;

  // Compute bounding-box diagonal for relative radius check
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

  // Smooth the boundary for arc detection only
  const smooth = smoothBoundary(pts);

  let i = 0;
  while (i <= n - MIN_ARC_RUN_LEN) {
    let bestLen = 0, bestFit = null;
    const cap = Math.min(MAX_ARC_GROW, n - i);
    for (let len = MIN_ARC_RUN_LEN; len <= cap; len++) {
      const window = smooth.slice(i, i + len);
      const fit = fitCircle(window);
      // Reject immediately if radius is out of sane range
      if (!fit || fit.r > maxSaneRadius || fit.r < minRadius) break;
      if (maxResidual(window, fit) > ARC_FIT_TOL_PX) break;
      bestLen = len; bestFit = fit;
    }
    if (bestLen >= MIN_ARC_RUN_LEN) {
      const endIdx = i + bestLen - 1;
      const midIdx = i + ((bestLen - 1) >> 1);
      // Use ORIGINAL (unsmoothed) points for span calculation so the SVG
      // arc endpoints are on the true mask boundary
      const span = arcSpanDeg(pts[i], pts[midIdx], pts[endIdx], bestFit);
      if (Math.abs(span) >= MIN_ARC_SPAN_DEG) {
        runs.push({ startIdx: i, endIdx, fit: bestFit, span });
        i = endIdx; // re-check from the shared boundary point — allows back-to-back arcs
        continue;
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

// ── Arc-aware path builder for one closed loop ────────────────────────────────
//
//  Detects arc runs on the dense loop, then walks it once: non-arc stretches
//  get RDP-simplified and passed through buildOpenChainPath (line/bezier),
//  arc stretches become a single "A" command. Falls back to the original
//  whole-loop buildAdaptivePath when no arcs are found at all.
//
function buildSmartPath(pts) {
  const n = pts.length;
  if (n < 3) return '';

  const runs = findArcRuns(pts);
  if (runs.length === 0) {
    const eps = Math.max(1.0, Math.min(RDP_EPSILON, loopLen(pts) / 400));
    const simplified = rdpSimplify(pts, eps);
    return simplified.length >= 3 ? buildAdaptivePath(simplified, BEZIER_TENSION) : '';
  }

  const runByStart = new Map(runs.map(r => [r.startIdx, r]));

  const flushLine = (from, to) => {
    if (to <= from) return '';
    const seg = pts.slice(from, to + 1);
    const eps = Math.max(1.0, Math.min(RDP_EPSILON, chainLen(seg) / 400));
    const simp = seg.length > 2 ? rdpSimplify(seg, eps) : seg;
    return buildOpenChainPath(simp, BEZIER_TENSION);
  };

  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  let bufStart = 0;
  let i = 0;
  while (i < n) {
    const run = runByStart.get(i);
    if (run) {
      d += flushLine(bufStart, i);
      const ep = pts[run.endIdx];
      const largeArc = Math.abs(run.span) > 180 ? 1 : 0;
      const sweep = run.span >= 0 ? 1 : 0;
      d += ` A ${run.fit.r.toFixed(2)} ${run.fit.r.toFixed(2)} 0 ${largeArc} ${sweep} ${ep[0].toFixed(2)} ${ep[1].toFixed(2)}`;
      bufStart = run.endIdx;
      i = run.endIdx;
    } else {
      i++;
    }
  }
  // close the loop: flush whatever's left, then connect back to the start point
  const tail = pts.slice(bufStart).concat([pts[0]]);
  const eps2 = Math.max(1.0, Math.min(RDP_EPSILON, chainLen(tail) / 400));
  const simpTail = tail.length > 2 ? rdpSimplify(tail, eps2) : tail;
  d += buildOpenChainPath(simpTail, BEZIER_TENSION);

  return d + ' Z';
}

// ── Main entry: pixel mask → SVG path string ──────────────────────────────────
//
//  Traces ALL boundary loops of the mask (traceMaskBoundary). Each loop
//  becomes its own subpath via buildSmartPath — mixing exact circular arcs
//  with straight lines and gentle beziers as appropriate — joined with " "
//  into one `d` string (SVG / Path2D both support multiple subpaths in one
//  path natively), so disjoint fill regions each get their own outline.
//
export function maskToSvgPath(mask, w, h) {
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

  const loops = traceMaskBoundary(mask, w, h);
  if (loops.length === 0) return fallbackRect();

  const subpaths = [];
  for (let pts of loops) {
    if (pts.length > MAX_TRACE_POINTS) {
      const step = Math.ceil(pts.length / MAX_TRACE_POINTS);
      pts = pts.filter((_, i) => i % step === 0);
    }
    if (pts.length < 3 || loopLen(pts) < 6) continue; // discard noise slivers

    const d = buildSmartPath(pts);
    if (d) subpaths.push(d);
  }

  return subpaths.length > 0 ? subpaths.join(' ') : fallbackRect();
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker embed string
//
//  Import this in useMagicFillSession.ts and splice into RASTER_WORKER_SOURCE
//  and POLYGON_WORKER_SOURCE instead of the hand-maintained SVG_PATH_UTILS
//  template literal.
//
//  NOTE: this block intentionally avoids template literals / backticks in
//  its OWN source (string concatenation only), because it is itself nested
//  inside the outer `/* js */ \`...\`` template literal below — a raw
//  backtick in here would terminate that outer string early.
// ─────────────────────────────────────────────────────────────────────────────

export const SVG_PATH_UTILS_SOURCE = /* js */`
const BEZIER_TENSION    = 0.3;
const RDP_EPSILON       = 2.0;
const CORNER_ANGLE_DEG  = 32;

const ARC_FIT_TOL_PX    = 1.2;
const MIN_ARC_RUN_LEN   = 22;
const MAX_ARC_GROW      = 800;
const MIN_ARC_SPAN_DEG  = 18;
const MAX_TRACE_POINTS  = 4000;
const MIN_ARC_RADIUS_PX = 40;
const MIN_ARC_RADIUS_REL= 0.04;

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

function turnAngleDeg(prev, curr, next) {
  const v1x = curr[0] - prev[0], v1y = curr[1] - prev[1];
  const v2x = next[0] - curr[0], v2y = next[1] - curr[1];
  const len1 = Math.hypot(v1x, v1y), len2 = Math.hypot(v2x, v2y);
  if (len1 < 1e-6 || len2 < 1e-6) return 0;
  const dot = Math.max(-1, Math.min(1, (v1x*v2x + v1y*v2y) / (len1*len2)));
  return Math.acos(dot) * 180 / Math.PI;
}

function buildAdaptivePath(pts, tension) {
  const n = pts.length;
  if (n < 2) return '';
  if (n === 2) return 'M ' + pts[0][0] + ' ' + pts[0][1] + ' L ' + pts[1][0] + ' ' + pts[1][1] + ' Z';
  const sharp = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
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
  sharp[0] = true;
  sharp[n - 1] = true;
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
  for (const p of pts) {
    const x = p[0], y = p[1];
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
  for (const p of pts) {
    const d = Math.abs(Math.hypot(p[0] - fit.cx, p[1] - fit.cy) - fit.r);
    if (d > m) m = d;
  }
  return m;
}

function angleAt(pt, fit) { return Math.atan2(pt[1] - fit.cy, pt[0] - fit.cx); }

function normDelta(a, b) {
  let d = b - a;
  while (d <= -Math.PI) d += 2 * Math.PI;
  while (d > Math.PI) d -= 2 * Math.PI;
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
  for (const p of pts) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
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
      const span = arcSpanDeg(pts[i], pts[midIdx], pts[endIdx], bestFit);
      if (Math.abs(span) >= MIN_ARC_SPAN_DEG) {
        runs.push({ startIdx: i, endIdx: endIdx, fit: bestFit, span: span });
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
  for (let i = 0; i < pts.length - 1; i++) p += Math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1]);
  return p;
}

function loopLen(pts) {
  return chainLen(pts) + Math.hypot(pts[0][0]-pts[pts.length-1][0], pts[0][1]-pts[pts.length-1][1]);
}

function buildSmartPath(pts) {
  const n = pts.length;
  if (n < 3) return '';

  const runs = findArcRuns(pts);
  if (runs.length === 0) {
    const eps = Math.max(1.0, Math.min(RDP_EPSILON, loopLen(pts) / 400));
    const simplified = rdpSimplify(pts, eps);
    return simplified.length >= 3 ? buildAdaptivePath(simplified, BEZIER_TENSION) : '';
  }

  const runByStart = new Map();
  for (const r of runs) runByStart.set(r.startIdx, r);

  function flushLine(from, to) {
    if (to <= from) return '';
    const seg = pts.slice(from, to + 1);
    const eps = Math.max(1.0, Math.min(RDP_EPSILON, chainLen(seg) / 400));
    const simp = seg.length > 2 ? rdpSimplify(seg, eps) : seg;
    return buildOpenChainPath(simp, BEZIER_TENSION);
  }

  let d = 'M ' + pts[0][0].toFixed(2) + ' ' + pts[0][1].toFixed(2);
  let bufStart = 0;
  let i = 0;
  while (i < n) {
    const run = runByStart.get(i);
    if (run) {
      d += flushLine(bufStart, i);
      const ep = pts[run.endIdx];
      const largeArc = Math.abs(run.span) > 180 ? 1 : 0;
      const sweep = run.span >= 0 ? 1 : 0;
      d += ' A ' + run.fit.r.toFixed(2) + ' ' + run.fit.r.toFixed(2) + ' 0 ' + largeArc + ' ' + sweep + ' ' + ep[0].toFixed(2) + ' ' + ep[1].toFixed(2);
      bufStart = run.endIdx;
      i = run.endIdx;
    } else {
      i++;
    }
  }
  const tail = pts.slice(bufStart).concat([pts[0]]);
  const eps2 = Math.max(1.0, Math.min(RDP_EPSILON, chainLen(tail) / 400));
  const simpTail = tail.length > 2 ? rdpSimplify(tail, eps2) : tail;
  d += buildOpenChainPath(simpTail, BEZIER_TENSION);

  return d + ' Z';
}

function maskToSvgPath(mask, w, h) {
  const fallbackRect = () => {
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return 'M ' + minX + ' ' + minY + ' L ' + maxX + ' ' + minY + ' L ' + maxX + ' ' + maxY + ' L ' + minX + ' ' + maxY + ' Z';
  };

  const loops = traceMaskBoundary(mask, w, h);
  if (loops.length === 0) return fallbackRect();

  const subpaths = [];
  for (let pts of loops) {
    if (pts.length > MAX_TRACE_POINTS) {
      const step = Math.ceil(pts.length / MAX_TRACE_POINTS);
      pts = pts.filter((_, i) => i % step === 0);
    }
    if (pts.length < 3 || loopLen(pts) < 6) continue;

    const d = buildSmartPath(pts);
    if (d) subpaths.push(d);
  }

  return subpaths.length > 0 ? subpaths.join(' ') : fallbackRect();
}
`;
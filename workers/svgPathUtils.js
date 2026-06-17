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
//  FIX (this revision): replaced the boundary tracer.
//
//  The previous `marchingSquaresContour` walked along foreground PIXEL
//  CENTERS using an 8-connectivity "Moore-neighbor"-style search, and
//  terminated as soon as it revisited its starting pixel POSITION — without
//  also checking it was arriving from the same direction. Any filled region
//  with a notch, doorway, or concave corner that brings the walk back near
//  its start mid-trace causes early/incorrect termination, producing an
//  empty or degenerate contour. maskToSvgPath() then silently fell back to
//  fallbackRect() — the bounding-box rectangle outline reported as a bug.
//
//  Fix: trace along pixel-GRID EDGES instead — the actual boundary between
//  a filled cell and an empty/out-of-bounds neighbor. Every filled pixel
//  contributes 0–4 such edges; stitching them together by shared endpoints
//  always yields exact, closed loop(s), with no positional-revisit
//  ambiguity, because every boundary vertex has exactly one well-defined
//  outgoing edge (barring single-pixel diagonal "checkerboard" touches,
//  which essentially never occur in real wall/room masks — see
//  traceMaskBoundary's doc comment). This is the standard, robust way to
//  extract a binary mask's exact pixel perimeter.
//
// ─────────────────────────────────────────────────────────────────────────────

const BEZIER_TENSION   = 0.3;
const RDP_EPSILON      = 2.0;
const CORNER_ANGLE_DEG = 32;

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

// ── Catmull-Rom → cubic bezier path builder ───────────────────────────────────

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

// ── Main entry: pixel mask → SVG path string ──────────────────────────────────
//
//  FIX: now traces ALL boundary loops of the mask (traceMaskBoundary) rather
//  than relying on the old single-contour walker. Each loop becomes its own
//  "M ... Z" subpath in the returned `d` string (SVG / Path2D both support
//  multiple subpaths in one path natively), so disjoint fill regions each
//  get their own exact outline instead of only the first/whole bounding box.
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
    if (pts.length > 2000) {
      const step = Math.ceil(pts.length / 2000);
      pts = pts.filter((_, i) => i % step === 0);
    }

    let perim = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      perim += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
    }
    if (perim < 6) continue; // discard noise slivers

    const eps = Math.max(1.0, Math.min(RDP_EPSILON, perim / 400));
    const simplified = rdpSimplify(pts, eps);
    if (simplified.length < 3) continue;

    subpaths.push(buildAdaptivePath(simplified, BEZIER_TENSION));
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
const BEZIER_TENSION   = 0.3;
const RDP_EPSILON      = 2.0;
const CORNER_ANGLE_DEG = 32;

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
    if (pts.length > 2000) {
      const step = Math.ceil(pts.length / 2000);
      pts = pts.filter((_, i) => i % step === 0);
    }

    let perim = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      perim += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
    }
    if (perim < 6) continue;

    const eps = Math.max(1.0, Math.min(RDP_EPSILON, perim / 400));
    const simplified = rdpSimplify(pts, eps);
    if (simplified.length < 3) continue;

    subpaths.push(buildAdaptivePath(simplified, BEZIER_TENSION));
  }

  return subpaths.length > 0 ? subpaths.join(' ') : fallbackRect();
}
`;
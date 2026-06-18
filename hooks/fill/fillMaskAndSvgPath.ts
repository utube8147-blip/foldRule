// ─────────────────────────────────────────────────────────────────────────────
// PIXEL BITMAP (wall mask) — runs on main thread
// ─────────────────────────────────────────────────────────────────────────────

const WALL_LUMA           = 120;
const STROKE_NEIGHBOR_MIN = 0.4;
const DILATE_R            = 2;
const ERODE_R             = 2;

/**
 * Step 1 — dark-pixel detection + stroke-neighbor filter.
 * Returns a binary mask: 1 = wall pixel, 0 = open space.
 */
export function buildWallMask(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): Uint8Array {
  // Pass 1: mark every pixel whose luminance is below the wall threshold
  // and whose alpha is non-trivial.
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 20) continue;
    const luma =
      0.299 * data[i * 4] +
      0.587 * data[i * 4 + 1] +
      0.114 * data[i * 4 + 2];
    if (luma < WALL_LUMA) dark[i] = 1;
  }

  // Pass 2: keep only dark pixels that have at least one dark neighbour
  // (eliminates isolated noise specks that aren't part of a wall stroke).
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!dark[y * w + x]) continue;
      let n = 0;
      if (x > 0   && dark[y * w + x - 1])           n++;
      if (x < w-1 && dark[y * w + x + 1])           n++;
      if (y > 0   && dark[(y-1) * w + x])           n++;
      if (y < h-1 && dark[(y+1) * w + x])           n++;
      if (x > 0   && y > 0   && dark[(y-1)*w+x-1]) n++;
      if (x < w-1 && y > 0   && dark[(y-1)*w+x+1]) n++;
      if (x > 0   && y < h-1 && dark[(y+1)*w+x-1]) n++;
      if (x < w-1 && y < h-1 && dark[(y+1)*w+x+1]) n++;
      if (n >= STROKE_NEIGHBOR_MIN) mask[y * w + x] = 1;
    }
  }
  return mask;
}

/** Separable box dilation — O(w*h) regardless of radius. */
export function dilateMask(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < r && x < w; x++) if (src[y * w + x]) count++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && src[y * w + add]) count++;
      if (count > 0) horiz[y * w + x] = 1;
      const rem = x - r; if (rem >= 0 && src[y * w + rem]) count--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < r && y < h; y++) if (horiz[y * w + x]) count++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && horiz[add * w + x]) count++;
      if (count > 0) out[y * w + x] = 1;
      const rem = y - r; if (rem >= 0 && horiz[rem * w + x]) count--;
    }
  }
  return out;
}

/** Separable box erosion — O(w*h) regardless of radius. */
export function erodeMask(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
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

/**
 * Full pipeline: raw RGBA frame → closed binary wall mask.
 * Handles resolution normalisation internally — if the frame's long edge is
 * below REFERENCE_LONG_EDGE the image is upsampled before the closing runs,
 * then the result is mapped back to native size (nearest-neighbour, binary).
 */
const REFERENCE_LONG_EDGE   = 1800;
const MAX_NORMALIZE_UPSCALE = 4;

export function buildNormalisedWallMask(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): Uint8Array {
  const longEdge = Math.max(w, h);
  const upscale  = longEdge < REFERENCE_LONG_EDGE
    ? Math.min(MAX_NORMALIZE_UPSCALE, REFERENCE_LONG_EDGE / longEdge)
    : 1;

  if (upscale === 1) {
    const raw = buildWallMask(data, w, h);
    const dil = dilateMask(raw, w, h, DILATE_R);
    return erodeMask(dil, w, h, ERODE_R);
  }

  // Upsample so closing radii stay proportionally correct at low res.
  const uw = Math.max(1, Math.round(w * upscale));
  const uh = Math.max(1, Math.round(h * upscale));

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = w; srcCanvas.height = h;
  srcCanvas.getContext('2d')!.putImageData(
    new ImageData(new Uint8ClampedArray(data), w, h), 0, 0,
  );
  const upCanvas = document.createElement('canvas');
  upCanvas.width = uw; upCanvas.height = uh;
  const upCtx = upCanvas.getContext('2d')!;
  upCtx.imageSmoothingEnabled = true;
  upCtx.imageSmoothingQuality = 'high';
  upCtx.drawImage(srcCanvas, 0, 0, uw, uh);
  const upData = upCtx.getImageData(0, 0, uw, uh).data;

  const raw    = buildWallMask(upData, uw, uh);
  const dil    = dilateMask(raw, uw, uh, DILATE_R);
  const maskUp = erodeMask(dil, uw, uh, ERODE_R);

  // Nearest-neighbour downsample back to native size (must stay binary).
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(uh - 1, Math.round(y * upscale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(uw - 1, Math.round(x * upscale));
      mask[y * w + x] = maskUp[sy * uw + sx];
    }
  }
  return mask;
}


// ─────────────────────────────────────────────────────────────────────────────
// SVG PERIMETER PATH — Moore-neighbour boundary trace → RDP → adaptive bezier
// ─────────────────────────────────────────────────────────────────────────────

const BEZIER_TENSION   = 0.3;
const RDP_EPSILON      = 2.0;
const CORNER_ANGLE_DEG = 32; // turns sharper than this → straight L line

/**
 * Step A — Moore-neighbour boundary tracing.
 *
 * Walks the connected perimeter pixel-by-pixel in order. Works correctly for
 * any shape, including non-convex / re-entrant geometry (e.g. staircase
 * treads). The old angle-sort approach only worked for star-shaped blobs.
 */
export function traceBoundary(mask: Uint8Array, w: number, h: number): [number, number][] {
  // Work in a 1-pixel padded field so boundary pixels are never cut off.
  const W = w + 2, H = h + 2;
  const field = new Uint8Array(W * H);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) field[(y + 1) * W + (x + 1)] = 1;

  // Find first set pixel (top-left scan).
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (field[y * W + x]) { startX = x; startY = y; break outer; }
  if (startX === -1) return [];

  const dx8 = [ 1, 1, 0,-1,-1,-1, 0, 1];
  const dy8 = [ 0, 1, 1, 1, 0,-1,-1,-1];
  const contour: [number, number][] = [];
  let cx = startX, cy = startY;
  let prevX = startX - 1, prevY = startY; // virtual predecessor
  let steps = 0;
  const maxSteps = W * H * 2;

  do {
    contour.push([cx - 1, cy - 1]); // undo the 1-pixel padding offset

    // Find the direction we came from, then probe neighbours in order.
    const fromDx = cx - prevX, fromDy = cy - prevY;
    let startDir = 0;
    for (let d = 0; d < 8; d++)
      if (dx8[d] === -fromDx && dy8[d] === -fromDy) { startDir = d; break; }

    let moved = false;
    for (let t = 0; t < 8; t++) {
      const d = (startDir + t) % 8;
      const nx = cx + dx8[d], ny = cy + dy8[d];
      if (nx >= 0 && nx < W && ny >= 0 && ny < H && field[ny * W + nx]) {
        prevX = cx; prevY = cy; cx = nx; cy = ny; moved = true; break;
      }
    }
    if (!moved) break;
    if (++steps > maxSteps) break;
  } while (!(cx === startX && cy === startY));

  return contour;
}

/**
 * Step B — Ramer-Douglas-Peucker simplification.
 * Removes redundant collinear / near-collinear points.
 */
export function rdpSimplify(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length <= 3) return pts;

  const distToLine = (
    p: [number, number], a: [number, number], b: [number, number],
  ) => {
    const [ax, ay] = a, [bx, by] = b, [px, py] = p;
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px-ax)*(bx-ax) + (py-ay)*(by-ay)) / len2));
    return Math.hypot(px - (ax + t*(bx-ax)), py - (ay + t*(by-ay)));
  };

  const keep = new Set<number>([0, pts.length - 1]);
  const rec = (lo: number, hi: number) => {
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

/**
 * Turn angle (degrees) at a vertex, used to classify corners vs. curves.
 * ~0° = dead straight, ~90° = right-angle wall corner.
 */
function turnAngleDeg(
  prev: [number, number],
  curr: [number, number],
  next: [number, number],
): number {
  const v1x = curr[0] - prev[0], v1y = curr[1] - prev[1];
  const v2x = next[0] - curr[0], v2y = next[1] - curr[1];
  const len1 = Math.hypot(v1x, v1y), len2 = Math.hypot(v2x, v2y);
  if (len1 < 1e-6 || len2 < 1e-6) return 0;
  const dot = Math.max(-1, Math.min(1, (v1x*v2x + v1y*v2y) / (len1*len2)));
  return Math.acos(dot) * 180 / Math.PI;
}

/**
 * Step C — adaptive path builder.
 *
 * Uses straight L commands through sharp corners (real wall joints) and
 * Catmull-Rom cubic bezier curves across runs of shallow-turning vertices
 * (genuine arcs / rounded features). A segment is only curved if NEITHER
 * endpoint is a sharp corner.
 */
export function buildAdaptivePath(pts: [number, number][], tension: number): string {
  const n = pts.length;
  if (n < 2) return '';
  if (n === 2)
    return `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]} Z`;

  // Classify each vertex.
  const sharp = pts.map((_, i) =>
    turnAngleDeg(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n]) > CORNER_ANGLE_DEG,
  );

  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;

  for (let i = 0; i < n; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];

    if (sharp[i] || sharp[(i + 1) % n]) {
      // At least one endpoint is a real corner → straight line.
      d += ` L ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    } else {
      // Both endpoints are shallow-turning → smooth Catmull-Rom edge.
      const p0 = pts[(i - 1 + n) % n];
      const p3 = pts[(i + 2) % n];
      const cp1x = p1[0] + (p2[0] - p0[0]) * tension;
      const cp1y = p1[1] + (p2[1] - p0[1]) * tension;
      const cp2x = p2[0] - (p3[0] - p1[0]) * tension;
      const cp2y = p2[1] - (p3[1] - p1[1]) * tension;
      d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)},`
         +    `${cp2x.toFixed(2)} ${cp2y.toFixed(2)},`
         +    `${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    }
  }
  return d + ' Z';
}

/**
 * Full pipeline: binary pixel mask → smooth closed SVG path string.
 *
 *  1. traceBoundary   — Moore-neighbour walk, O(perimeter)
 *  2. rdpSimplify     — removes staircase noise, adaptive epsilon
 *  3. buildAdaptivePath — straight lines at corners, bezier curves elsewhere
 *
 * The returned path is in the same coordinate space as the mask (w × h),
 * so the SVG viewBox must be set to "0 0 w h" using the mask dimensions,
 * NOT the CSS display dimensions.
 */
export function maskToSvgPath(mask: Uint8Array, w: number, h: number): string {
  const contour = traceBoundary(mask, w, h);

  if (contour.length === 0) {
    // Fallback: axis-aligned bounding box of all set pixels.
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return `M ${minX} ${minY} L ${maxX} ${minY} L ${maxX} ${maxY} L ${minX} ${maxY} Z`;
  }

  // Subsample if the raw contour is huge (keeps RDP fast).
  let pts = contour;
  if (pts.length > 2000) {
    const step = Math.ceil(pts.length / 2000);
    pts = pts.filter((_, i) => i % step === 0);
  }

  // Adaptive RDP epsilon proportional to perimeter length.
  let perim = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    perim += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  const eps = Math.max(1.0, Math.min(RDP_EPSILON, perim / 400));
  const simplified = rdpSimplify(pts, eps);

  // Need at least 3 points for a closed path.
  if (simplified.length < 3) {
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (const [x, y] of contour) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return `M ${minX} ${minY} L ${maxX} ${minY} L ${maxX} ${maxY} L ${minX} ${maxY} Z`;
  }

  return buildAdaptivePath(simplified, BEZIER_TENSION);
}
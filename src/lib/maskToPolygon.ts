// ─── maskToPolygon.ts ──────────────────────────────────────────────────────────
//
// Converts a SAM binary mask (Uint8Array, 1 byte per pixel, 1 = inside) into
// a simplified polygon (Point[]) suitable for your existing FilledArea system.
//
// Pipeline:
//   1. Trace the outer contour of the largest connected region in the mask
//   2. Simplify the contour with Ramer-Douglas-Peucker to reduce point count
//   3. Return Point[] in canvas-pixel space
//
// The mask comes from SAM in the model's coordinate space (e.g. 1024×1024).
// Pass maskW/maskH so we can normalise to [0,1] before scaling to canvas dims.
// ─────────────────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface MaskToPolygonOptions {
  /** Width of the SAM mask in pixels (usually 256 or 1024) */
  maskW: number;
  /** Height of the SAM mask in pixels */
  maskH: number;
  /** Canvas width to scale output into */
  canvasW: number;
  /** Canvas height to scale output into */
  canvasH: number;
  /**
   * Ramer-Douglas-Peucker epsilon in canvas pixels.
   * Higher = fewer points, less accurate.
   * Default: 2.5
   */
  epsilon?: number;
  /**
   * Minimum area (in canvas px²) for a region to be kept.
   * Filters out tiny noise blobs.
   * Default: 500
   */
  minArea?: number;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Convert a flat binary mask array into a simplified polygon.
 * Returns null if no valid region is found.
 */
export function maskToPolygon(
  mask: Uint8Array | Uint8ClampedArray,
  opts: MaskToPolygonOptions,
): Point[] | null {
  const { maskW, maskH, canvasW, canvasH, epsilon = 2.5, minArea = 500 } = opts;

  // ── 1. Find the largest connected component ─────────────────────────────
  const labeled = labelConnectedComponents(mask, maskW, maskH);
  if (!labeled) return null;

  const { labels, numLabels } = labeled;

  // Count pixels per label (label 0 = background)
  const counts = new Int32Array(numLabels + 1);
  for (let i = 0; i < labels.length; i++) counts[labels[i]]++;

  // Find the largest non-background label
  let bestLabel = -1;
  let bestCount = 0;
  for (let l = 1; l <= numLabels; l++) {
    if (counts[l] > bestCount) { bestCount = counts[l]; bestLabel = l; }
  }

  if (bestLabel === -1 || bestCount < 10) return null;

  // Build a boolean mask for just this component
  const region = new Uint8Array(maskW * maskH);
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === bestLabel) region[i] = 1;
  }

  // ── 2. Trace the outer contour (Moore neighborhood tracing) ────────────
  const contour = traceContour(region, maskW, maskH);
  if (contour.length < 3) return null;

  // ── 3. Scale from mask space → canvas space ─────────────────────────────
  const scaleX = canvasW / maskW;
  const scaleY = canvasH / maskH;
  const scaled: Point[] = contour.map(p => ({
    x: p.x * scaleX,
    y: p.y * scaleY,
  }));

  // ── 4. Check area in canvas space ───────────────────────────────────────
  const area = polygonArea(scaled);
  if (area < minArea) return null;

  // ── 5. Simplify with Ramer-Douglas-Peucker ──────────────────────────────
  const simplified = rdp(scaled, epsilon);
  if (simplified.length < 3) return null;

  return simplified;
}

// ─── Connected component labeling (union-find) ────────────────────────────────

interface LabelResult {
  labels: Int32Array;
  numLabels: number;
}

function labelConnectedComponents(
  mask: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
): LabelResult | null {
  const labels = new Int32Array(w * h); // 0 = unlabeled/background
  const parent = new Int32Array(w * h + 1);
  for (let i = 0; i < parent.length; i++) parent[i] = i;

  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a: number, b: number) {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  }

  let nextLabel = 1;

  // First pass — assign provisional labels
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx]) continue;

      const above = y > 0 && mask[(y - 1) * w + x] ? labels[(y - 1) * w + x] : 0;
      const left  = x > 0 && mask[y * w + (x - 1)] ? labels[y * w + (x - 1)] : 0;

      if (!above && !left) {
        labels[idx] = nextLabel++;
      } else if (above && !left) {
        labels[idx] = above;
      } else if (!above && left) {
        labels[idx] = left;
      } else {
        labels[idx] = Math.min(above, left);
        union(above, left);
      }
    }
  }

  if (nextLabel === 1) return null; // empty mask

  // Second pass — resolve labels to roots
  for (let i = 0; i < labels.length; i++) {
    if (labels[i]) labels[i] = find(labels[i]);
  }

  // Compact label ids
  const remap = new Int32Array(nextLabel);
  let compact = 0;
  for (let l = 1; l < nextLabel; l++) {
    if (find(l) === l) remap[l] = ++compact;
  }
  for (let i = 0; i < labels.length; i++) {
    if (labels[i]) labels[i] = remap[find(labels[i])];
  }

  return { labels, numLabels: compact };
}

// ─── Moore-neighborhood contour tracing ──────────────────────────────────────
// Implements the Square Tracing Algorithm for outer contours.
// Returns contour in image pixel coordinates.

function traceContour(region: Uint8Array, w: number, h: number): Point[] {
  // Find the topmost-leftmost pixel in the region (start point)
  let startX = -1, startY = -1;
  outer:
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (region[y * w + x]) { startX = x; startY = y; break outer; }
    }
  }
  if (startX === -1) return [];

  // 8-connected neighbor directions: E, SE, S, SW, W, NW, N, NE
  const dx = [1, 1, 0, -1, -1, -1,  0,  1];
  const dy = [0, 1, 1,  1,  0, -1, -1, -1];

  const contour: Point[] = [];
  const visited = new Set<number>();

  let cx = startX, cy = startY;
  let dir = 0; // start facing East

  const maxSteps = w * h * 2; // safety limit
  let steps = 0;

  do {
    const key = cy * w + cx;
    if (!visited.has(key)) {
      visited.add(key);
      contour.push({ x: cx, y: cy });
    }

    // Try to turn right first (clockwise boundary following)
    let found = false;
    for (let i = 0; i < 8; i++) {
      const nd = (dir + 6 + i) % 8; // start from left-of-current
      const nx = cx + dx[nd];
      const ny = cy + dy[nd];
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && region[ny * w + nx]) {
        cx = nx; cy = ny; dir = nd;
        found = true;
        break;
      }
    }
    if (!found) break;

    steps++;
    if (steps > maxSteps) break;

  } while (cx !== startX || cy !== startY);

  // Subsample if very long (keep at most 800 contour points before RDP)
  if (contour.length > 800) {
    const step = Math.ceil(contour.length / 800);
    return contour.filter((_, i) => i % step === 0);
  }

  return contour;
}

// ─── Ramer-Douglas-Peucker polyline simplification ───────────────────────────

function rdp(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx  = 0;
  const last  = points.length - 1;

  for (let i = 1; i < last; i++) {
    const d = perpendicularDist(points[i], points[0], points[last]);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist > epsilon) {
    const left  = rdp(points.slice(0, maxIdx + 1), epsilon);
    const right = rdp(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [points[0], points[last]];
}

function perpendicularDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  const nearX = a.x + t * dx, nearY = a.y + t * dy;
  return Math.hypot(p.x - nearX, p.y - nearY);
}

// ─── Polygon area (shoelace) ─────────────────────────────────────────────────

function polygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}
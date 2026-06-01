// cornerWorker.ts
// Web Worker for corner detection via Harris + edge analysis

export interface DetectedCorner {
  x: number;
  y: number;
  confidence: number;
  // Normalized 0-1 coords for zoom-invariance
  nx: number;
  ny: number;
}

export interface DetectedLine {
  x1: number; y1: number;
  x2: number; y2: number;
  angle: number;
  length: number;
}

export interface ExtractionResult {
  pageIndex: number;
  corners: DetectedCorner[];
  lines: DetectedLine[];
  intersections: DetectedCorner[];
  width: number;
  height: number;
}

// Gaussian blur kernel (5x5)
function gaussianBlur(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const kernel = [2, 4, 5, 4, 2, 4, 9, 12, 9, 4, 5, 12, 15, 12, 5, 4, 9, 12, 9, 4, 2, 4, 5, 4, 2];
  const kSum = 159;
  const out = new Float32Array(w * h);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      let v = 0;
      let ki = 0;
      for (let ky = -2; ky <= 2; ky++) {
        for (let kx = -2; kx <= 2; kx++) {
          const idx = ((y + ky) * w + (x + kx)) * 4;
          const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          v += lum * kernel[ki++];
        }
      }
      out[y * w + x] = v / kSum;
    }
  }
  return out;
}

// Sobel gradients
function sobelGradients(gray: Float32Array, w: number, h: number): { gx: Float32Array; gy: Float32Array } {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const tl = gray[(y - 1) * w + (x - 1)], tc = gray[(y - 1) * w + x], tr = gray[(y - 1) * w + (x + 1)];
      const ml = gray[y * w + (x - 1)],                                       mr = gray[y * w + (x + 1)];
      const bl = gray[(y + 1) * w + (x - 1)], bc = gray[(y + 1) * w + x], br = gray[(y + 1) * w + (x + 1)];
      gx[y * w + x] = -tl - 2 * ml - bl + tr + 2 * mr + br;
      gy[y * w + x] = -tl - 2 * tc - tr + bl + 2 * bc + br;
    }
  }
  return { gx, gy };
}

// Harris corner response
function harrisResponse(gx: Float32Array, gy: Float32Array, w: number, h: number, k = 0.05): Float32Array {
  const R = new Float32Array(w * h);
  const winSize = 3;
  for (let y = winSize; y < h - winSize; y++) {
    for (let x = winSize; x < w - winSize; x++) {
      let Ixx = 0, Iyy = 0, Ixy = 0;
      for (let wy = -winSize; wy <= winSize; wy++) {
        for (let wx = -winSize; wx <= winSize; wx++) {
          const i = (y + wy) * w + (x + wx);
          Ixx += gx[i] * gx[i];
          Iyy += gy[i] * gy[i];
          Ixy += gx[i] * gy[i];
        }
      }
      const det = Ixx * Iyy - Ixy * Ixy;
      const trace = Ixx + Iyy;
      R[y * w + x] = det - k * trace * trace;
    }
  }
  return R;
}

// Non-maximum suppression
// FIX Bug #5: replaced Math.max(...R) spread (stack overflow on large arrays)
// with a manual loop.
function nonMaxSuppression(R: Float32Array, w: number, h: number, winSize = 10): DetectedCorner[] {
  const corners: DetectedCorner[] = [];

  let maxR = 0;
  for (let i = 0; i < R.length; i++) {
    if (R[i] > maxR) maxR = R[i];
  }

  const threshold = maxR * 0.01;

  for (let y = winSize; y < h - winSize; y++) {
    for (let x = winSize; x < w - winSize; x++) {
      const r = R[y * w + x];
      if (r < threshold) continue;

      let isMax = true;
      for (let wy = -winSize; wy <= winSize && isMax; wy++) {
        for (let wx = -winSize; wx <= winSize && isMax; wx++) {
          if (wy === 0 && wx === 0) continue;
          if (R[(y + wy) * w + (x + wx)] >= r) isMax = false;
        }
      }

      if (isMax) {
        const confidence = Math.min(1, r / (maxR * 0.1));
        corners.push({ x, y, confidence, nx: x / w, ny: y / h });
      }
    }
  }
  return corners;
}

// Simplified line segment detection
function detectLines(gx: Float32Array, gy: Float32Array, w: number, h: number): DetectedLine[] {
  const magnitude = new Float32Array(w * h);
  let maxMag = 0;

  for (let i = 0; i < w * h; i++) {
    magnitude[i] = Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]);
    if (magnitude[i] > maxMag) maxMag = magnitude[i];
  }

  const threshold = maxMag * 0.15;
  const lines: DetectedLine[] = [];

  // Horizontal
  for (let y = 0; y < h; y += 4) {
    let lineStart = -1;
    for (let x = 0; x < w; x++) {
      if (magnitude[y * w + x] > threshold) {
        if (lineStart === -1) lineStart = x;
      } else {
        if (lineStart !== -1 && x - lineStart > 30) {
          lines.push({ x1: lineStart, y1: y, x2: x - 1, y2: y, angle: 0, length: x - 1 - lineStart });
        }
        lineStart = -1;
      }
    }
  }

  // Vertical
  for (let x = 0; x < w; x += 4) {
    let lineStart = -1;
    for (let y = 0; y < h; y++) {
      if (magnitude[y * w + x] > threshold) {
        if (lineStart === -1) lineStart = y;
      } else {
        if (lineStart !== -1 && y - lineStart > 30) {
          lines.push({ x1: x, y1: lineStart, x2: x, y2: y - 1, angle: 90, length: y - 1 - lineStart });
        }
        lineStart = -1;
      }
    }
  }

  return lines;
}

// Find intersections of detected lines — high-priority corner candidates.
// FIX Bug #1: renamed loop variable `h` → `hl` to prevent shadowing the
// `h` (image height) parameter. Previously `iy / h` divided by the hLines
// entry object instead of the image height, producing NaN for every `ny`.
function findIntersections(lines: DetectedLine[], imgW: number, imgH: number): DetectedCorner[] {
  const intersections: DetectedCorner[] = [];
  const hLines = lines.filter(l => l.angle === 0);
  const vLines = lines.filter(l => l.angle === 90);

  for (const hl of hLines) {           // <-- was: for (const h of hLines)
    for (const vl of vLines) {         // <-- was: for (const v of vLines)
      const ix = vl.x1;
      const iy = hl.y1;
      if (
        ix >= Math.min(hl.x1, hl.x2) && ix <= Math.max(hl.x1, hl.x2) &&
        iy >= Math.min(vl.y1, vl.y2) && iy <= Math.max(vl.y1, vl.y2)
      ) {
        intersections.push({ x: ix, y: iy, confidence: 1.0, nx: ix / imgW, ny: iy / imgH });
      }
    }
  }

  // Deduplicate close intersections
  const result: DetectedCorner[] = [];
  for (const pt of intersections) {
    const tooClose = result.some(r => Math.hypot(r.x - pt.x, r.y - pt.y) < 20);
    if (!tooClose) result.push(pt);
  }
  return result;
}

self.onmessage = (e: MessageEvent) => {
  const { imageData, pageIndex, width, height } = e.data as {
    imageData: ImageData;
    pageIndex: number;
    width: number;
    height: number;
  };

  try {
    const data = imageData.data as Uint8ClampedArray;

    self.postMessage({ type: 'progress', pageIndex, step: 'blurring' });
    const blurred = gaussianBlur(data, width, height);

    self.postMessage({ type: 'progress', pageIndex, step: 'gradients' });
    const { gx, gy } = sobelGradients(blurred, width, height);

    self.postMessage({ type: 'progress', pageIndex, step: 'harris' });
    const R = harrisResponse(gx, gy, width, height);

    self.postMessage({ type: 'progress', pageIndex, step: 'suppression' });
    const corners = nonMaxSuppression(R, width, height);

    self.postMessage({ type: 'progress', pageIndex, step: 'lines' });
    const lines = detectLines(gx, gy, width, height);
    const intersections = findIntersections(lines, width, height);

    const mergedCorners = [...intersections];
    for (const c of corners) {
      const nearIntersection = intersections.some(i => Math.hypot(i.x - c.x, i.y - c.y) < 15);
      if (!nearIntersection) mergedCorners.push(c);
    }

    const result: ExtractionResult = {
      pageIndex,
      corners: mergedCorners.sort((a, b) => b.confidence - a.confidence).slice(0, 2000),
      lines,
      intersections,
      width,
      height,
    };

    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({ type: 'error', pageIndex, error: String(err) });
  }
};
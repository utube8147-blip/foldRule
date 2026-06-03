import { useState, useCallback, useRef, useEffect, RefObject } from 'react';
import type { DetectedCorner, DetectedLine, ExtractionResult } from '@/workers/cornerWorker';

export type { DetectedCorner, DetectedLine, ExtractionResult };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PageExtractionState {
  status: 'idle' | 'processing' | 'done' | 'error';
  step?: string;
  corners: DetectedCorner[];
  lines: DetectedLine[];
  intersections: DetectedCorner[];
  width: number;
  height: number;
}

export interface SnapResult {
  point: { x: number; y: number };
  snapped: boolean;
}

export interface SnapFlash {
  x: number; y: number; id: number;
}

export interface SnapCandidate {
  pointIndex: number;
  snapTarget: { x: number; y: number };
}

export interface UseCornerDetectionReturn {
  // Status
  analysisStatus: 'idle' | 'analyzing' | 'done';
  analysisPage: { current: number; total: number } | null;
  currentPageCornerCount: number;

  // Settings
  snapEnabled: boolean;
  setSnapEnabled: (v: boolean) => void;
  showPins: boolean;
  setShowPins: (v: boolean) => void;
  snapThreshold: number;
  setSnapThreshold: (v: number) => void;
  confidenceFilter: number;
  setConfidenceFilter: (v: number) => void;

  // Flash animations
  snapFlashes: SnapFlash[];
  triggerSnapFlash: (x: number, y: number) => void;

  // Core actions
  startExtraction: (pdf: any, file?: File) => void;
  snapToCorner: (rawX: number, rawY: number) => SnapResult;
  findPostDrawCandidates: (points: Array<{ x: number; y: number; snapped: boolean }>) => SnapCandidate[];
  handlePinHover: (canvasX: number, canvasY: number) => void;
  clearHover: () => void;

  // Pin canvas: hook owns all drawing. Consumer mounts the ref and calls the
  // two notify callbacks whenever Viewer's dimensions or page number change.
  pinCanvasRef: RefObject<HTMLCanvasElement | null>;
  onPdfDimensionsChanged: (w: number, h: number) => void;
  onPageChanged: (pageNumber: number) => void;
}

// ─── Session cache (module-level — survives component re-mounts) ──────────────

const sessionCache = new Map<string, Map<number, ExtractionResult>>();

function fileHash(file: File): string {
  return `${file.name}_${file.size}_${file.lastModified}`;
}

// ─── Worker source ────────────────────────────────────────────────────────────
// Inlined as a string so it works in every bundler without plugin config.
// FIX Bug #1: renamed `h` → `hl` / `v` → `vl` in findIntersections to
//   prevent the loop variable from shadowing the `imgH` / height parameter.
//   Previously `iy / h` divided by the DetectedLine object, giving NaN for ny.
// FIX Bug #5: replaced Math.max(...R) spread with a manual loop to avoid
//   a RangeError stack overflow on large Float32Arrays.

function getWorkerSource(): string {
  return `
function gaussianBlur(data, w, h) {
  const kernel = [2,4,5,4,2, 4,9,12,9,4, 5,12,15,12,5, 4,9,12,9,4, 2,4,5,4,2];
  const kSum = 159;
  const out = new Float32Array(w * h);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      let v = 0, ki = 0;
      for (let ky = -2; ky <= 2; ky++) {
        for (let kx = -2; kx <= 2; kx++) {
          const idx = ((y + ky) * w + (x + kx)) * 4;
          v += (0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2]) * kernel[ki++];
        }
      }
      out[y * w + x] = v / kSum;
    }
  }
  return out;
}

function sobelGradients(gray, w, h) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const tl=gray[(y-1)*w+(x-1)], tc=gray[(y-1)*w+x], tr=gray[(y-1)*w+(x+1)];
      const ml=gray[y*w+(x-1)],                           mr=gray[y*w+(x+1)];
      const bl=gray[(y+1)*w+(x-1)], bc=gray[(y+1)*w+x], br=gray[(y+1)*w+(x+1)];
      gx[y*w+x] = -tl - 2*ml - bl + tr + 2*mr + br;
      gy[y*w+x] = -tl - 2*tc - tr + bl + 2*bc + br;
    }
  }
  return { gx, gy };
}

function harrisResponse(gx, gy, w, h, k) {
  k = k === undefined ? 0.05 : k;
  const R = new Float32Array(w * h);
  const win = 3;
  for (let y = win; y < h - win; y++) {
    for (let x = win; x < w - win; x++) {
      let Ixx = 0, Iyy = 0, Ixy = 0;
      for (let wy = -win; wy <= win; wy++) {
        for (let wx = -win; wx <= win; wx++) {
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

function nonMaxSuppression(R, w, h, win) {
  win = win === undefined ? 10 : win;
  // FIX Bug #5: manual loop instead of Math.max(...R) to avoid stack overflow
  let maxR = 0;
  for (let i = 0; i < R.length; i++) if (R[i] > maxR) maxR = R[i];
  const threshold = maxR * 0.01;
  const corners = [];
  for (let y = win; y < h - win; y++) {
    for (let x = win; x < w - win; x++) {
      const r = R[y * w + x];
      if (r < threshold) continue;
      let isMax = true;
      outer: for (let wy = -win; wy <= win; wy++) {
        for (let wx = -win; wx <= win; wx++) {
          if (wy === 0 && wx === 0) continue;
          if (R[(y + wy) * w + (x + wx)] >= r) { isMax = false; break outer; }
        }
      }
      if (isMax) {
        corners.push({ x, y, confidence: Math.min(1, r / (maxR * 0.1)), nx: x / w, ny: y / h });
      }
    }
  }
  return corners;
}

function detectLines(gx, gy, w, h) {
  const mag = new Float32Array(w * h);
  let maxMag = 0;
  for (let i = 0; i < w * h; i++) {
    mag[i] = Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]);
    if (mag[i] > maxMag) maxMag = mag[i];
  }
  const threshold = maxMag * 0.15;
  const lines = [];

  for (let y = 0; y < h; y += 4) {
    let start = -1;
    for (let x = 0; x < w; x++) {
      if (mag[y * w + x] > threshold) {
        if (start === -1) start = x;
      } else {
        if (start !== -1 && x - start > 30)
          lines.push({ x1: start, y1: y, x2: x - 1, y2: y, angle: 0, length: x - 1 - start });
        start = -1;
      }
    }
  }

  for (let x = 0; x < w; x += 4) {
    let start = -1;
    for (let y = 0; y < h; y++) {
      if (mag[y * w + x] > threshold) {
        if (start === -1) start = y;
      } else {
        if (start !== -1 && y - start > 30)
          lines.push({ x1: x, y1: start, x2: x, y2: y - 1, angle: 90, length: y - 1 - start });
        start = -1;
      }
    }
  }

  return lines;
}

// FIX Bug #1: renamed loop vars h → hl, v → vl so they no longer shadow
// the imgH parameter. Previously iy / h was dividing by a DetectedLine
// object, producing NaN for every intersection's ny coordinate.
function findIntersections(lines, imgW, imgH) {
  const hLines = lines.filter(function(l) { return l.angle === 0; });
  const vLines = lines.filter(function(l) { return l.angle === 90; });
  const result = [];
  for (var hi = 0; hi < hLines.length; hi++) {
    var hl = hLines[hi];
    for (var vi = 0; vi < vLines.length; vi++) {
      var vl = vLines[vi];
      var ix = vl.x1, iy = hl.y1;
      if (
        ix >= Math.min(hl.x1, hl.x2) && ix <= Math.max(hl.x1, hl.x2) &&
        iy >= Math.min(vl.y1, vl.y2) && iy <= Math.max(vl.y1, vl.y2)
      ) {
        var tooClose = result.some(function(r) { return Math.hypot(r.x - ix, r.y - iy) < 20; });
        if (!tooClose)
          result.push({ x: ix, y: iy, confidence: 1.0, nx: ix / imgW, ny: iy / imgH });
      }
    }
  }
  return result;
}

self.onmessage = function(e) {
  var imageData = e.data.imageData;
  var pageIndex = e.data.pageIndex;
  var width     = e.data.width;
  var height    = e.data.height;
  try {
    self.postMessage({ type: 'progress', pageIndex: pageIndex, step: 'blurring' });
    var blurred = gaussianBlur(imageData.data, width, height);

    self.postMessage({ type: 'progress', pageIndex: pageIndex, step: 'gradients' });
    var grads = sobelGradients(blurred, width, height);

    self.postMessage({ type: 'progress', pageIndex: pageIndex, step: 'harris' });
    var R = harrisResponse(grads.gx, grads.gy, width, height);

    self.postMessage({ type: 'progress', pageIndex: pageIndex, step: 'suppression' });
    var harrisCandidates = nonMaxSuppression(R, width, height);

    self.postMessage({ type: 'progress', pageIndex: pageIndex, step: 'lines' });
    var lines = detectLines(grads.gx, grads.gy, width, height);
    var intersections = findIntersections(lines, width, height);

    var merged = intersections.slice();
    for (var i = 0; i < harrisCandidates.length; i++) {
      var c = harrisCandidates[i];
      var near = intersections.some(function(pt) { return Math.hypot(pt.x - c.x, pt.y - c.y) < 15; });
      if (!near) merged.push(c);
    }

    self.postMessage({
      type: 'result',
      result: {
        pageIndex: pageIndex,
        corners: merged.sort(function(a, b) { return b.confidence - a.confidence; }).slice(0, 2000),
        lines: lines,
        intersections: intersections,
        width: width,
        height: height,
      },
    });
  } catch(err) {
    self.postMessage({ type: 'error', pageIndex: pageIndex, error: String(err) });
  }
};
`;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCornerDetection(): UseCornerDetectionReturn {

  // ── Reactive state ────────────────────────────────────────────────────────
  const [pageData,         setPageData]         = useState<Map<number, PageExtractionState>>(new Map());
  const [analysisStatus,   setAnalysisStatus]   = useState<'idle' | 'analyzing' | 'done'>('idle');
  const [analysisPage,     setAnalysisPage]     = useState<{ current: number; total: number } | null>(null);
  const [snapEnabled,      setSnapEnabled]      = useState(true);
  const [showPins,         setShowPins]         = useState(true);
  const [snapThreshold,    setSnapThreshold]    = useState(14);
  const [confidenceFilter, setConfidenceFilter] = useState(0.1);
  const [snapFlashes,      setSnapFlashes]      = useState<SnapFlash[]>([]);

  // ── Stable refs (never cause re-renders) ─────────────────────────────────
  const workerRef       = useRef<Worker | null>(null);
  const blobUrlRef      = useRef('');
  const queueRef        = useRef<Array<{ pageIndex: number; pdf: any; cacheKey: string }>>([]);
  const extractingRef   = useRef(false);
  const cacheKeyRef     = useRef('');
  const flashIdRef      = useRef(0);
  const pinCanvasRef    = useRef<HTMLCanvasElement>(null);

  // Mutable render-context — Viewer notifies us via callbacks
  const pdfDimsRef   = useRef<{ w: number; h: number } | null>(null);
  const pageNumberRef = useRef(1);
  const hoveredRef   = useRef<{ x: number; y: number } | null>(null);
  const cursorRef    = useRef<{ x: number; y: number } | null>(null);

  // Shadow refs so snap/pin callbacks always read current settings without
  // needing to be recreated on every settings change (stable callbacks).
  const snapEnabledRef      = useRef(snapEnabled);
  const showPinsRef         = useRef(showPins);
  const snapThresholdRef    = useRef(snapThreshold);
  const confidenceFilterRef = useRef(confidenceFilter);
  const pageDataRef         = useRef(pageData);

  useEffect(() => { snapEnabledRef.current      = snapEnabled;      }, [snapEnabled]);
  useEffect(() => { showPinsRef.current         = showPins;         }, [showPins]);
  useEffect(() => { snapThresholdRef.current    = snapThreshold;    }, [snapThreshold]);
  useEffect(() => { confidenceFilterRef.current = confidenceFilter; }, [confidenceFilter]);
  useEffect(() => { pageDataRef.current         = pageData;         }, [pageData]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const makeEmptyPage = (): PageExtractionState => ({
    status: 'idle', corners: [], lines: [], intersections: [], width: 0, height: 0,
  });

  // Returns corners for the current page scaled to canvas-pixel space using
  // normalised (nx, ny) coords — correct at any zoom level.
  const getScaledCorners = useCallback(() => {
    const dims = pdfDimsRef.current;
    if (!dims) return [];
    const pg = pageDataRef.current.get(pageNumberRef.current - 1);
    if (!pg || pg.status !== 'done') return [];
    return pg.corners
      .filter(c => c.confidence >= confidenceFilterRef.current)
      .map(c => ({ x: c.nx * dims.w, y: c.ny * dims.h, confidence: c.confidence }));
  }, []); // stable — reads only through refs

  // ── Pin canvas drawing ────────────────────────────────────────────────────

  const redrawPins = useCallback(() => {
    const canvas = pinCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showPinsRef.current) return;

    const corners = getScaledCorners();
    const hovered = hoveredRef.current;
    const cursor  = cursorRef.current;
    const thresh  = snapThresholdRef.current;

    for (const c of corners) {
      const isHovered  = hovered !== null && Math.hypot(hovered.x - c.x, hovered.y - c.y) < 2;
      const isInRange  = cursor  !== null && Math.hypot(cursor.x  - c.x, cursor.y  - c.y) < thresh;

      ctx.beginPath();
      if (isHovered || isInRange) {
        ctx.arc(c.x, c.y, 7, 0, Math.PI * 2);
        ctx.fillStyle   = isInRange ? '#F59E0B' : '#60A5FA';
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      } else {
        ctx.arc(c.x, c.y, 3 + c.confidence * 2, 0, Math.PI * 2);
        ctx.fillStyle   = `rgba(96,165,250,${0.3 + c.confidence * 0.5})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(96,165,250,${0.5 + c.confidence * 0.4})`;
        ctx.lineWidth   = 1;
        ctx.stroke();
      }
    }
  }, [getScaledCorners]);

  // Repaint whenever anything that affects pin appearance changes.
  useEffect(() => {
    redrawPins();
  }, [redrawPins, pageData, showPins, snapThreshold, confidenceFilter]);

  // ── Extraction queue processor ────────────────────────────────────────────

  // FIX Bug #2: processQueue is stored in a ref so the worker's onmessage
  // closure always calls the latest version, eliminating the stale-closure
  // problem that occurred when the callback was captured at worker setup time.
  const processQueueRef = useRef<() => void>(() => {});

  const processQueue = useCallback(async () => {
    if (extractingRef.current || queueRef.current.length === 0) {
      if (queueRef.current.length === 0) {
        setAnalysisStatus('done');
        setAnalysisPage(null);
      }
      return;
    }

    const item = queueRef.current.shift()!;
    extractingRef.current = true;

    // Cache hit — skip the worker entirely
    const cached = sessionCache.get(item.cacheKey)?.get(item.pageIndex);
    if (cached) {
      setPageData(prev => {
        const next = new Map(prev);
        next.set(item.pageIndex, {
          status: 'done',
          corners: cached.corners,
          lines: cached.lines,
          intersections: cached.intersections,
          width: cached.width,
          height: cached.height,
        });
        return next;
      });
      extractingRef.current = false;
      processQueueRef.current();
      return;
    }

    // Rasterise the PDF page at 1.5× then transfer pixels to the worker
    try {
      const page      = await item.pdf.getPage(item.pageIndex + 1);
      const viewport  = page.getViewport({ scale: 1.5 });
      const offscreen = new OffscreenCanvas(viewport.width, viewport.height);
      const ctx       = offscreen.getContext('2d') as any;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const imageData = ctx.getImageData(0, 0, viewport.width, viewport.height);

      workerRef.current!.postMessage(
        { imageData, pageIndex: item.pageIndex, width: viewport.width, height: viewport.height },
        [imageData.data.buffer],
      );
    } catch (err) {
      console.error('[useCornerDetection] render error:', err);
      extractingRef.current = false;
      processQueueRef.current();
    }
  }, []);

  // Keep the ref up-to-date after every render
  useEffect(() => {
    processQueueRef.current = processQueue;
  }, [processQueue]);

  // ── Worker setup ──────────────────────────────────────────────────────────

  useEffect(() => {
    const src  = getWorkerSource();
    const blob = new Blob([src], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    blobUrlRef.current = url;

    const worker = new Worker(url);
    workerRef.current = worker;

    worker.onmessage = (e) => {
      const msg = e.data;

      if (msg.type === 'progress') {
        setPageData(prev => {
          const next = new Map(prev);
          const ex   = next.get(msg.pageIndex) ?? makeEmptyPage();
          next.set(msg.pageIndex, { ...ex, status: 'processing', step: msg.step });
          return next;
        });
        setAnalysisPage(prev => prev ? { ...prev, current: msg.pageIndex + 1 } : null);
        return;
      }

      if (msg.type === 'result') {
        const result: ExtractionResult = msg.result;

        const key = cacheKeyRef.current;
        if (key) {
          if (!sessionCache.has(key)) sessionCache.set(key, new Map());
          sessionCache.get(key)!.set(result.pageIndex, result);
        }

        setPageData(prev => {
          const next = new Map(prev);
          next.set(result.pageIndex, {
            status: 'done',
            corners: result.corners,
            lines: result.lines,
            intersections: result.intersections,
            width: result.width,
            height: result.height,
          });
          return next;
        });
        extractingRef.current = false;
        // FIX Bug #2: call via ref so we always use the latest closure
        processQueueRef.current();
        return;
      }

      if (msg.type === 'error') {
        console.error('[useCornerDetection] worker error page', msg.pageIndex, msg.error);
        setPageData(prev => {
          const next = new Map(prev);
          const ex   = next.get(msg.pageIndex) ?? makeEmptyPage();
          next.set(msg.pageIndex, { ...ex, status: 'error' });
          return next;
        });
        extractingRef.current = false;
        processQueueRef.current();
      }
    };

    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  }, []); // intentionally runs once — worker lifecycle matches component mount

  // ── Public API ────────────────────────────────────────────────────────────

  const startExtraction = useCallback((pdfDoc: any, file?: File) => {
    const numPages = pdfDoc.numPages;
    const cacheKey = file ? fileHash(file) : `pdf_${numPages}_${Date.now()}`;
    cacheKeyRef.current    = cacheKey;
    queueRef.current       = [];
    extractingRef.current  = false;

    setAnalysisStatus('analyzing');
    setAnalysisPage({ current: 1, total: numPages });

    const initial = new Map<number, PageExtractionState>();
    for (let i = 0; i < numPages; i++) {
      const cached = sessionCache.get(cacheKey)?.get(i);
      if (cached) {
        initial.set(i, {
          status: 'done',
          corners: cached.corners,
          lines: cached.lines,
          intersections: cached.intersections,
          width: cached.width,
          height: cached.height,
        });
      } else {
        initial.set(i, makeEmptyPage());
        queueRef.current.push({ pageIndex: i, pdf: pdfDoc, cacheKey });
      }
    }
    setPageData(initial);

    if (queueRef.current.length === 0) {
      setAnalysisStatus('done');
      setAnalysisPage(null);
    } else {
      processQueueRef.current();
    }
  }, []);

  const snapToCorner = useCallback((rawX: number, rawY: number): SnapResult => {
    if (!snapEnabledRef.current || !pdfDimsRef.current) {
      return { point: { x: rawX, y: rawY }, snapped: false };
    }
    const corners = getScaledCorners();
    let best: { x: number; y: number } | null = null;
    let bestDist = snapThresholdRef.current;
    for (const c of corners) {
      const d = Math.hypot(rawX - c.x, rawY - c.y);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best
      ? { point: { x: best.x, y: best.y }, snapped: true }
      : { point: { x: rawX, y: rawY }, snapped: false };
  }, [getScaledCorners]);

  const findPostDrawCandidates = useCallback(
    (points: Array<{ x: number; y: number; snapped: boolean }>): SnapCandidate[] => {
      if (!snapEnabledRef.current || !pdfDimsRef.current) return [];
      const corners = getScaledCorners();
      const doubled = snapThresholdRef.current * 2;
      const out: SnapCandidate[] = [];
      points.forEach((p, i) => {
        if (p.snapped) return;
        let bestDist = doubled;
        let bestTarget: { x: number; y: number } | null = null;
        for (const c of corners) {
          const d = Math.hypot(p.x - c.x, p.y - c.y);
          if (d < bestDist) { bestDist = d; bestTarget = { x: c.x, y: c.y }; }
        }
        if (bestTarget) out.push({ pointIndex: i, snapTarget: bestTarget });
      });
      return out;
    },
    [getScaledCorners],
  );

  const triggerSnapFlash = useCallback((x: number, y: number) => {
    const id = ++flashIdRef.current;
    setSnapFlashes(prev => [...prev, { x, y, id }]);
    setTimeout(() => setSnapFlashes(prev => prev.filter(f => f.id !== id)), 700);
  }, []);

  const handlePinHover = useCallback((canvasX: number, canvasY: number) => {
    cursorRef.current = { x: canvasX, y: canvasY };
    if (!showPinsRef.current || !pdfDimsRef.current) {
      hoveredRef.current = null;
      redrawPins();
      return;
    }
    const corners = getScaledCorners();
    let closest: { x: number; y: number } | null = null;
    let closestDist = 16;
    for (const c of corners) {
      const d = Math.hypot(canvasX - c.x, canvasY - c.y);
      if (d < closestDist) { closestDist = d; closest = c; }
    }
    hoveredRef.current = closest;
    redrawPins();
  }, [getScaledCorners, redrawPins]);

  const clearHover = useCallback(() => {
    hoveredRef.current = null;
    cursorRef.current  = null;
    redrawPins();
  }, [redrawPins]);

  const onPdfDimensionsChanged = useCallback((w: number, h: number) => {
    pdfDimsRef.current = { w, h };
    redrawPins();
  }, [redrawPins]);

  const onPageChanged = useCallback((pageNumber: number) => {
    pageNumberRef.current = pageNumber;
    redrawPins();
  }, [redrawPins]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const currentPageCornerCount =
    (pageData.get(pageNumberRef.current - 1)?.corners ?? [])
      .filter(c => c.confidence >= confidenceFilter).length;

  return {
    analysisStatus,
    analysisPage,
    currentPageCornerCount,

    snapEnabled,      setSnapEnabled,
    showPins,         setShowPins,
    snapThreshold,    setSnapThreshold,
    confidenceFilter, setConfidenceFilter,

    snapFlashes,
    triggerSnapFlash,

    startExtraction,
    snapToCorner,
    findPostDrawCandidates,
    handlePinHover,
    clearHover,

    pinCanvasRef,
    onPdfDimensionsChanged,
    onPageChanged,
  };
}

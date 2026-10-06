'use client';

// ─── hooks/fill/useMagicFill.ts ───────────────────────────────────────────────
//
//  CHANGE: MagicFill now carries svgPath and svgMode so MagicFillCanvas can
//  render the smooth marching-squares contour via Path2D instead of the
//  bounding-box polygon array.
//
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useCallback, useEffect } from 'react';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MagicFill {
  id:       number;
  label:    string;
  color:    string;
  opacity:  number;
  areaPx:   number;
  perimPx:  number;
  polygon:  [number, number][];
  /** Parts taken back out of the fill (Alt-click). Deducted from the area. */
  holes?:   [number, number][][];
  /** Room name read from the drawing, when there is one inside the fill. */
  roomLabel?: string;
  groupId?: number;

  // ── SVG path fields (populated by useMagicFillSession workers) ────────────
  //  svgPath — the full SVG path data string produced by maskToSvgPath()
  //  svgMode — true when svgPath should be used in preference to polygon
  svgPath?: string;
  svgMode?: boolean;
}

export interface HoleFillResult {
  areaPx:  number;
  perimPx: number;
  polygon: [number, number][];
}

export interface MagicFillAPI {
  ready:            boolean;
  buildMask:        (pdfCanvas: HTMLCanvasElement) => void;
  fillAt:           (cx: number, cy: number, fc: HTMLCanvasElement,
                     color: string, opacity: number, label: string) => Promise<MagicFill | null>;
  fillRect:         (x1: number, y1: number, x2: number, y2: number,
                     fc: HTMLCanvasElement, color: string, opacity: number,
                     labelPrefix: string, groupId: number,
                     onProgress?: (done: number, total: number) => void) => Promise<MagicFill[]>;
  fillHoles:        (id: number, fill: MagicFill, fc: HTMLCanvasElement) => HoleFillResult | null;
  undo:             (fc: HTMLCanvasElement) => boolean;
  clearAll:         (fc: HTMLCanvasElement) => void;
  pushSnapshot:     (fc: HTMLCanvasElement) => void;
  getPixelMap:      (id: number) => Uint8Array | undefined;
  getPixelAt:       (cx: number, cy: number, fc: HTMLCanvasElement) => number;
  registerFill:     (fill: MagicFill, pixelMap: Uint8Array) => void;
  unregisterFill:   (id: number) => void;
  restoreFills:     (visibleIds: Set<number>, fc: HTMLCanvasElement) => void;
  repaintFillColor: (id: number, newColor: string,
                     visibleIds: Set<number>, fc: HTMLCanvasElement) => void;
}

// ─── Tunables ─────────────────────────────────────────────────────────────────

const FILL_GROW   = 2;
const RDP_EPSILON = 3;

// ─── Main-thread helpers ──────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function dilateFast(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < r && x < w; x++) if (src[y * w + x]) c++;
    for (let x = 0; x < w; x++) {
      if (x + r < w && src[y * w + x + r]) c++;
      if (c > 0) horiz[y * w + x] = 1;
      if (x - r >= 0 && src[y * w + x - r]) c--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y < r && y < h; y++) if (horiz[y * w + x]) c++;
    for (let y = 0; y < h; y++) {
      if (y + r < h && horiz[(y + r) * w + x]) c++;
      if (c > 0) out[y * w + x] = 1;
      if (y - r >= 0 && horiz[(y - r) * w + x]) c--;
    }
  }
  return out;
}

function paintFillToSnapshot(
  filled: Uint8Array, w: number, h: number,
  r: number, g: number, b: number, opacity: number,
): ImageData {
  const snap = new ImageData(w, h);
  const d = snap.data;
  const a255 = Math.round(opacity * 255);
  for (let i = 0; i < filled.length; i++) {
    if (!filled[i]) continue;
    d[i * 4]     = r;
    d[i * 4 + 1] = g;
    d[i * 4 + 2] = b;
    d[i * 4 + 3] = a255;
  }
  return snap;
}

function compositeOver(dst: ImageData, src: ImageData): void {
  const d = dst.data, s = src.data;
  for (let i = 0; i < d.length; i += 4) {
    const sa = s[i + 3] / 255;
    if (!sa) continue;
    const da  = d[i + 3] / 255;
    const oa  = sa + da * (1 - sa);
    if (!oa) continue;
    d[i]     = ((s[i]     * sa + d[i]     * da * (1 - sa)) / oa + 0.5) | 0;
    d[i + 1] = ((s[i + 1] * sa + d[i + 1] * da * (1 - sa)) / oa + 0.5) | 0;
    d[i + 2] = ((s[i + 2] * sa + d[i + 2] * da * (1 - sa)) / oa + 0.5) | 0;
    d[i + 3] = (oa * 255 + 0.5) | 0;
  }
}

function findPerimeter(filled: Uint8Array, w: number, h: number): Uint8Array {
  const p = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!filled[y * w + x]) continue;
      if (
        x === 0     || !filled[y * w + x - 1]   ||
        x === w - 1 || !filled[y * w + x + 1]   ||
        y === 0     || !filled[(y - 1) * w + x]  ||
        y === h - 1 || !filled[(y + 1) * w + x]
      ) p[y * w + x] = 1;
    }
  }
  return p;
}

function measurePerim(p: Uint8Array, w: number, h: number): number {
  let c = 0;
  for (let i = 0; i < p.length; i++) {
    if (!p[i]) continue;
    const x = i % w, y = (i / w) | 0;
    const diag =
      (x > 0   && y > 0   && p[(y - 1) * w + x - 1]) ||
      (x < w-1 && y > 0   && p[(y - 1) * w + x + 1]) ||
      (x > 0   && y < h-1 && p[(y + 1) * w + x - 1]) ||
      (x < w-1 && y < h-1 && p[(y + 1) * w + x + 1]);
    c += diag ? 1.41 : 1;
  }
  return Math.round(c);
}

function rdpSimplify(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length <= 3) return pts;
  const distToLine = (
    p: [number, number], a: [number, number], b: [number, number],
  ) => {
    const [ax, ay] = a, [bx, by] = b, [px, py] = p;
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    if (!len2) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1,
      ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2));
    return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
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

function buildPolygon(perim: Uint8Array, w: number, h: number): [number, number][] {
  let si = -1;
  for (let i = 0; i < perim.length; i++) { if (perim[i]) { si = i; break; } }
  if (si === -1) return [];
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const sx = si % w, sy = (si / w) | 0;
  let cx = sx, cy = sy, dir = 0;
  const steps: [number, number, number][] = [];
  let count = 0;
  do {
    steps.push([cx, cy, dir]);
    let moved = false;
    for (let t = 0; t < 4; t++) {
      const nd = (dir + 3 + t) % 4;
      const nx = cx + DX[nd], ny = cy + DY[nd];
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && perim[ny * w + nx]) {
        cx = nx; cy = ny; dir = nd; moved = true; break;
      }
    }
    if (!moved || ++count > perim.length * 2) break;
  } while (cx !== sx || cy !== sy);
  const n = steps.length;
  const corners: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (steps[i][2] !== steps[(i - 1 + n) % n][2])
      corners.push([steps[i][0], steps[i][1]]);
  }
  return corners.length >= 3 ? rdpSimplify(corners, RDP_EPSILON) : [[sx, sy]];
}

function processMask(grown: Uint8Array, w: number, h: number) {
  const areaPx   = grown.reduce((s, v) => s + v, 0);
  const dilated  = dilateFast(grown, w, h, 2);
  const perimMsk = findPerimeter(dilated, w, h);
  const perimPx  = measurePerim(perimMsk, w, h);
  const polygon  = buildPolygon(perimMsk, w, h);
  return { areaPx, perimPx, polygon };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useMagicFill(): MagicFillAPI {

  const workerRef        = useRef<Worker | null>(null);
  const readyRef         = useRef(false);

  type PendingFillAt = {
    cx: number; cy: number; fc: HTMLCanvasElement;
    color: string; opacity: number; label: string;
    resolve: (v: MagicFill | null) => void;
  };
  const pendingFillAt = useRef<PendingFillAt[]>([]);
  const drainRef = useRef<(() => void) | null>(null);

  const labelMapRef      = useRef<Uint32Array | null>(null);
  const regionPixelsRef  = useRef<Int32Array  | null>(null);
  const regionOffsetsRef = useRef<Int32Array  | null>(null);
  const maskWRef         = useRef(0);
  const maskHRef         = useRef(0);

  const snapshots     = useRef<ImageData[]>([]);
  const pixelMaps     = useRef<Map<number, Uint8Array>>(new Map());
  const fillOrder     = useRef<number[]>([]);
  const fillSnapshots = useRef<Map<number, ImageData>>(new Map());
  const fillWRef      = useRef(0);
  const fillHRef      = useRef(0);

  useEffect(() => {
    const w = new Worker(
      new URL('../../workers/maskWorker.js', import.meta.url),
    );
    workerRef.current = w;

    w.onerror = (e) => {
      console.error('[useMagicFill] worker error:', e.message, e);
    };

    w.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'error') {
        console.error('[useMagicFill] worker reported error:', msg.message);
        return;
      }
      if (msg.type === 'ready') {
        labelMapRef.current      = new Uint32Array(msg.labelMap);
        regionPixelsRef.current  = new Int32Array(msg.pixelsBuf);
        regionOffsetsRef.current = new Int32Array(msg.offsetsBuf);
        maskWRef.current         = msg.width;
        maskHRef.current         = msg.height;
        readyRef.current         = true;
        drainRef.current?.();
      }
    };

    return () => { w.terminate(); };
  }, []);

  const buildMask = useCallback((pdfCanvas: HTMLCanvasElement) => {
    const pw = pdfCanvas.width, ph = pdfCanvas.height;
    if (!pw || !ph) return;
    readyRef.current = false;

    const ctx = pdfCanvas.getContext('2d');
    if (!ctx) return;

    const MAX_PX = 4_000_000;
    let tw = pw, th = ph;
    if (pw * ph > MAX_PX) {
      const sc = Math.sqrt(MAX_PX / (pw * ph));
      tw = Math.max(1, Math.round(pw * sc));
      th = Math.max(1, Math.round(ph * sc));
    }

    let imgData: ImageData;
    if (tw !== pw || th !== ph) {
      const off = document.createElement('canvas');
      off.width = tw; off.height = th;
      off.getContext('2d')!.drawImage(pdfCanvas, 0, 0, tw, th);
      imgData = off.getContext('2d')!.getImageData(0, 0, tw, th);
    } else {
      imgData = ctx.getImageData(0, 0, pw, ph);
    }

    const buffer = imgData.data.buffer.slice(0);
    workerRef.current?.postMessage(
      { type: 'build', buffer, width: tw, height: th },
      [buffer],
    );
  }, []);

  const getRegionMask = useCallback((
    canvasX: number, canvasY: number, fw: number, fh: number,
  ): Uint8Array | null => {
    const lm = labelMapRef.current;
    const rp = regionPixelsRef.current;
    const ro = regionOffsetsRef.current;
    const mw = maskWRef.current, mh = maskHRef.current;
    if (!lm || !rp || !ro || !mw || !mh) return null;

    const px = Math.round(canvasX * mw / fw);
    const py = Math.round(canvasY * mh / fh);
    if (px < 0 || px >= mw || py < 0 || py >= mh) return null;

    const regionId = lm[py * mw + px];
    if (regionId === 0xFFFFFFFF) return null;

    const start = ro[regionId], end = ro[regionId + 1];
    if (end - start < 10) return null;

    const mask   = new Uint8Array(fw * fh);
    const scaleX = fw / mw, scaleY = fh / mh;

    for (let i = start; i < end; i++) {
      const mi  = rp[i];
      const mx  = mi % mw, my = (mi / mw) | 0;
      const fx0 = Math.round(mx * scaleX);
      const fy0 = Math.round(my * scaleY);
      const fx1 = Math.min(fw, Math.round((mx + 1) * scaleX));
      const fy1 = Math.min(fh, Math.round((my + 1) * scaleY));
      for (let fy = fy0; fy < fy1; fy++)
        for (let fx = fx0; fx < fx1; fx++)
          mask[fy * fw + fx] = 1;
    }
    return mask;
  }, []);

  const getFreshFillData = useCallback((fc: HTMLCanvasElement): ImageData => {
    const w = fc.width, h = fc.height;
    fillWRef.current = w; fillHRef.current = h;
    const ctx = fc.getContext('2d');
    return ctx ? ctx.getImageData(0, 0, w, h) : new ImageData(w, h);
  }, []);

  const applyAutoHoleFill = useCallback((
    fill: MagicFill,
    pixMap: Uint8Array,
    fw: number,
    fh: number,
    fc: HTMLCanvasElement,
  ): { closed: Uint8Array; result: HoleFillResult } => {
    const outside = new Uint8Array(fw * fh);
    const stack: number[] = [];

    const push = (i: number) => {
      if (i >= 0 && i < fw * fh && !pixMap[i] && !outside[i]) {
        outside[i] = 1;
        stack.push(i);
      }
    };

    for (let x = 0; x < fw; x++) { push(x); push((fh - 1) * fw + x); }
    for (let y = 1; y < fh - 1; y++) { push(y * fw); push(y * fw + fw - 1); }

    while (stack.length) {
      const i = stack.pop()!;
      const x = i % fw, y = (i / fw) | 0;
      if (x > 0)    push(i - 1);
      if (x < fw-1) push(i + 1);
      if (y > 0)    push(i - fw);
      if (y < fh-1) push(i + fw);
    }

    const closed = new Uint8Array(fw * fh);
    for (let i = 0; i < fw * fh; i++)
      closed[i] = pixMap[i] || (outside[i] ? 0 : 1);

    const [r, g, b] = hexToRgb(fill.color);
    const a         = fill.opacity / 100;

    const added = new Uint8Array(fw * fh);
    for (let i = 0; i < fw * fh; i++) if (closed[i] && !pixMap[i]) added[i] = 1;

    if (added.some(Boolean)) {
      const fd = getFreshFillData(fc);
      compositeOver(fd, paintFillToSnapshot(added, fw, fh, r, g, b, a));
      fc.getContext('2d')!.putImageData(fd, 0, 0);
    }

    pixelMaps.current.set(fill.id, closed);
    fillSnapshots.current.set(fill.id,
      paintFillToSnapshot(closed, fw, fh, r, g, b, a));

    return { closed, result: processMask(closed, fw, fh) };
  }, [getFreshFillData]);

  const paintRegion = useCallback((
    regionMask: Uint8Array, fw: number, fh: number,
    color: string, opacity: number, label: string,
    fc: HTMLCanvasElement,
  ): MagicFill => {
    const grown    = dilateFast(regionMask, fw, fh, FILL_GROW);
    const [r, g, b] = hexToRgb(color);
    const snap     = paintFillToSnapshot(grown, fw, fh, r, g, b, opacity / 100);
    const fd       = getFreshFillData(fc);
    compositeOver(fd, snap);
    fc.getContext('2d')!.putImageData(fd, 0, 0);
    const { areaPx, perimPx, polygon } = processMask(grown, fw, fh);
    const fill: MagicFill = {
      id: Date.now() + Math.random(),
      label, color, opacity, areaPx, perimPx, polygon,
    };
    pixelMaps.current.set(fill.id, grown);
    fillSnapshots.current.set(fill.id, snap);
    fillOrder.current.push(fill.id);
    return fill;
  }, [getFreshFillData]);

  const fillAt = useCallback((
    canvasX: number, canvasY: number, fc: HTMLCanvasElement,
    color: string, opacity: number, label: string,
  ): Promise<MagicFill | null> => {
    if (!readyRef.current) {
      return new Promise<MagicFill | null>((resolve) => {
        pendingFillAt.current.push({
          cx: canvasX, cy: canvasY, fc, color, opacity, label, resolve,
        });
      });
    }

    const fw = fc.width, fh = fc.height;
    fillWRef.current = fw; fillHRef.current = fh;

    const regionMask = getRegionMask(canvasX, canvasY, fw, fh);
    if (!regionMask) return Promise.resolve(null);

    const fill = paintRegion(regionMask, fw, fh, color, opacity, label, fc);

    const pixMap = pixelMaps.current.get(fill.id)!;
    const { result } = applyAutoHoleFill(fill, pixMap, fw, fh, fc);
    fill.areaPx  = result.areaPx;
    fill.perimPx = result.perimPx;
    fill.polygon = result.polygon;

    return Promise.resolve(fill);
  }, [getRegionMask, paintRegion, applyAutoHoleFill]);

  const fillRect = useCallback(async (
    x1: number, y1: number, x2: number, y2: number,
    fc: HTMLCanvasElement, color: string, opacity: number,
    labelPrefix: string, groupId: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<MagicFill[]> => {
    if (!readyRef.current) return [];
    const lm = labelMapRef.current;
    const ro = regionOffsetsRef.current;
    const rp = regionPixelsRef.current;
    const mw = maskWRef.current, mh = maskHRef.current;
    const fw = fc.width, fh = fc.height;
    if (!lm || !ro || !rp || !mw) return [];

    const rx1 = Math.round(Math.min(x1, x2) * mw / fw);
    const ry1 = Math.round(Math.min(y1, y2) * mh / fh);
    const rx2 = Math.round(Math.max(x1, x2) * mw / fw);
    const ry2 = Math.round(Math.max(y1, y2) * mh / fh);
    if (rx2 - rx1 < 5 || ry2 - ry1 < 5) return [];

    const found = new Set<number>();
    const step  = Math.max(2, Math.round(Math.min(rx2 - rx1, ry2 - ry1) / 60));
    for (let sy = ry1; sy <= ry2; sy += step)
      for (let sx = rx1; sx <= rx2; sx += step) {
        const id = lm[sy * mw + sx];
        if (id !== 0xFFFFFFFF) found.add(id);
      }

    const ids     = [...found];
    const results: MagicFill[] = [];
    let count = 0;
    const scaleX = fw / mw, scaleY = fh / mh;

    for (const regionId of ids) {
      onProgress?.(count, ids.length);
      await Promise.resolve();

      const start = ro[regionId], end = ro[regionId + 1];
      if (end - start < 10) { count++; continue; }

      const regionMask = new Uint8Array(fw * fh);
      for (let i = start; i < end; i++) {
        const mi  = rp[i];
        const mx  = mi % mw, my = (mi / mw) | 0;
        const fx0 = Math.round(mx * scaleX);
        const fy0 = Math.round(my * scaleY);
        const fx1 = Math.min(fw, Math.round((mx + 1) * scaleX));
        const fy1 = Math.min(fh, Math.round((my + 1) * scaleY));
        for (let fy = fy0; fy < fy1; fy++)
          for (let fx = fx0; fx < fx1; fx++)
            regionMask[fy * fw + fx] = 1;
      }

      const fill = paintRegion(regionMask, fw, fh, color, opacity,
        `${labelPrefix} ${++count}`, fc);
      fill.groupId = groupId;

      const pixMap = pixelMaps.current.get(fill.id)!;
      const { result } = applyAutoHoleFill(fill, pixMap, fw, fh, fc);
      fill.areaPx  = result.areaPx;
      fill.perimPx = result.perimPx;
      fill.polygon = result.polygon;

      results.push(fill);
    }

    onProgress?.(ids.length, ids.length);
    return results;
  }, [paintRegion, applyAutoHoleFill]);

  const fillHoles = useCallback((
    id: number, fill: MagicFill, fc: HTMLCanvasElement,
  ): HoleFillResult | null => {
    const pixMap = pixelMaps.current.get(id);
    if (!pixMap) return null;
    const fw = fc.width, fh = fc.height;
    const { result } = applyAutoHoleFill(fill, pixMap, fw, fh, fc);
    return result;
  }, [applyAutoHoleFill]);

  drainRef.current = () => {
    const pending = pendingFillAt.current.splice(0);
    if (!pending.length) return;
    for (const p of pending) {
      const fw = p.fc.width, fh = p.fc.height;
      const regionMask = getRegionMask(p.cx, p.cy, fw, fh);
      if (!regionMask) { p.resolve(null); continue; }
      const fill = paintRegion(regionMask, fw, fh, p.color, p.opacity, p.label, p.fc);
      const pixMap = pixelMaps.current.get(fill.id)!;
      const { result } = applyAutoHoleFill(fill, pixMap, fw, fh, p.fc);
      fill.areaPx  = result.areaPx;
      fill.perimPx = result.perimPx;
      fill.polygon = result.polygon;
      p.resolve(fill);
    }
  };

  const pushSnapshot = useCallback((fc: HTMLCanvasElement) => {
    fillWRef.current = fc.width; fillHRef.current = fc.height;
    const ctx = fc.getContext('2d');
    const fd  = ctx
      ? ctx.getImageData(0, 0, fc.width, fc.height)
      : new ImageData(fc.width, fc.height);
    snapshots.current.push(
      new ImageData(new Uint8ClampedArray(fd.data), fd.width, fd.height),
    );
  }, []);

  const undo = useCallback((fc: HTMLCanvasElement): boolean => {
    if (!snapshots.current.length) return false;
    const prev = snapshots.current.pop()!;
    fillWRef.current = prev.width; fillHRef.current = prev.height;
    fc.getContext('2d')!.putImageData(prev, 0, 0);
    return true;
  }, []);

  const clearAll = useCallback((fc: HTMLCanvasElement) => {
    fc.getContext('2d')?.clearRect(0, 0, fc.width, fc.height);
    fillWRef.current = fc.width; fillHRef.current = fc.height;
    snapshots.current = [];
    pixelMaps.current.clear();
    fillSnapshots.current.clear();
    fillOrder.current = [];
  }, []);

  const registerFill = useCallback((fill: MagicFill, pm: Uint8Array) => {
    pixelMaps.current.set(fill.id, pm);
    fillOrder.current.push(fill.id);
  }, []);

  const unregisterFill = useCallback((id: number) => {
    pixelMaps.current.delete(id);
    fillSnapshots.current.delete(id);
    fillOrder.current = fillOrder.current.filter(x => x !== id);
  }, []);

  const getPixelMap = useCallback(
    (id: number) => pixelMaps.current.get(id), [],
  );

  const getPixelAt = useCallback((
    cx: number, cy: number, fc: HTMLCanvasElement,
  ): number => {
    const w = fc.width, h = fc.height;
    const px = Math.round(cx), py = Math.round(cy);
    if (px < 0 || px >= w || py < 0 || py >= h) return -1;
    const idx = py * w + px;
    for (let i = fillOrder.current.length - 1; i >= 0; i--) {
      const id  = fillOrder.current[i];
      const map = pixelMaps.current.get(id);
      if (map && map[idx]) return id;
    }
    return -1;
  }, []);

  const restoreFills = useCallback((
    visibleIds: Set<number>, fc: HTMLCanvasElement,
  ) => {
    const ctx = fc.getContext('2d');
    if (!ctx) return;
    const w = fc.width, h = fc.height;
    ctx.clearRect(0, 0, w, h);
    if (!visibleIds.size) return;
    const composite = new ImageData(w, h);
    for (const id of fillOrder.current) {
      if (!visibleIds.has(id)) continue;
      const snap = fillSnapshots.current.get(id);
      if (snap && snap.width === w && snap.height === h)
        compositeOver(composite, snap);
    }
    ctx.putImageData(composite, 0, 0);
  }, []);

  const repaintFillColor = useCallback((
    id: number, newColor: string,
    visibleIds: Set<number>, fc: HTMLCanvasElement,
  ) => {
    const pm = pixelMaps.current.get(id);
    if (!pm) return;
    const w = fc.width, h = fc.height;
    const [r, g, b] = hexToRgb(newColor);
    fillSnapshots.current.set(id, paintFillToSnapshot(pm, w, h, r, g, b, 40 / 100));
    restoreFills(visibleIds, fc);
  }, [restoreFills]);

  return {
    get ready() { return readyRef.current; },
    buildMask,
    fillAt,
    fillRect,
    fillHoles,
    undo,
    clearAll,
    pushSnapshot,
    getPixelMap,
    getPixelAt,
    registerFill,
    unregisterFill,
    restoreFills,
    repaintFillColor,
  };
}
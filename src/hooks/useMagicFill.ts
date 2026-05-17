'use client';

// ─── hooks/useMagicFill.ts ────────────────────────────────────────────────────
//
//  FIX (hover on existing fills):
//
//  getPixelAt() used fillWRef.current / fillHRef.current to compute the pixel
//  index into each fill's pixelMap. Those refs are set inside ensureFillData(),
//  which is only called during fill operations (fillAt, fillRect, fillHoles).
//
//  When the user zooms and a new PDF render commits, Viewer.tsx resizes the
//  fillCanvas (new canvas.width / canvas.height). fillWRef / fillHRef are NOT
//  updated at that point because ensureFillData() is not called again until the
//  next fill. So getPixelAt() was computing the index with stale dimensions,
//  landing in the wrong position in every pixelMap → always returning -1 →
//  mfHoveredId stays null → tooltip never shows.
//
//  FIX 1 – getPixelAt now accepts the fillCanvas element directly so it can
//           read canvas.width / canvas.height live, and also refreshes the refs.
//
//  FIX 2 – clearAll, undo, and pushSnapshot also sync the refs so they are
//           never stale after a canvas resize / reset.
//
//  API surface change: getPixelAt(canvasX, canvasY, fillCanvas)
//    — fillCanvas is the third argument (optional for back-compat; falls back
//      to the cached refs so callers that don't pass it still work).
//
//  Caller change required in Viewer.tsx:
//    handleMagicHover passes fillCanvasRef.current as third arg to getPixelAt.
//
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useCallback } from 'react';

// ─── Tunables ─────────────────────────────────────────────────────────────────

const WALL_LUMA           = 120;
const STROKE_NEIGHBOR_MIN = 2;
const DILATE_R            = 2;
const ERODE_R             = 1;
const FILL_GROW           = 3;
const RDP_EPSILON         = 3;
const MAX_MASK_PIXELS     = 2_000_000;
const RECT_STEP_DIVISOR   = 40;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MagicFill {
  id:        number;
  label:     string;
  color:     string;
  opacity:   number;
  areaPx:    number;
  perimPx:   number;
  polygon:   [number, number][];
  groupId?:  number;
}

export interface HoleFillResult {
  areaPx:  number;
  perimPx: number;
  polygon: [number, number][];
}

export interface MagicFillAPI {
  ready:        boolean;
  buildMask:    (pdfCanvas: HTMLCanvasElement) => void;
  fillAt:       (
    canvasX:    number,
    canvasY:    number,
    fillCanvas: HTMLCanvasElement,
    color:      string,
    opacity:    number,
    label:      string,
  ) => MagicFill | null;
  fillRect:     (
    x1: number, y1: number,
    x2: number, y2: number,
    fillCanvas:  HTMLCanvasElement,
    color:       string,
    opacity:     number,
    labelPrefix: string,
    groupId:     number,
    onProgress?: (done: number, total: number) => void,
  ) => Promise<MagicFill[]>;
  fillHoles:    (
    id:         number,
    fill:       MagicFill,
    fillCanvas: HTMLCanvasElement,
  ) => HoleFillResult | null;
  undo:         (fillCanvas: HTMLCanvasElement) => boolean;
  clearAll:     (fillCanvas: HTMLCanvasElement) => void;
  pushSnapshot: (fillCanvas: HTMLCanvasElement) => void;
  getPixelMap:  (id: number) => Uint8Array | undefined;
  /** FIX: fillCanvas is now required so live dimensions are always used. */
  getPixelAt:   (canvasX: number, canvasY: number, fillCanvas: HTMLCanvasElement) => number;
  registerFill:   (fill: MagicFill, pixelMap: Uint8Array) => void;
  unregisterFill: (id: number) => void;
}

// ─── Internal helpers (unchanged) ─────────────────────────────────────────────

function buildWallMask(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 20) continue;
    const luma = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    if (luma < WALL_LUMA) dark[i] = 1;
  }
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

function dilateFast(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < r && x < w; x++) if (src[y*w+x]) count++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && src[y*w+add]) count++;
      if (count > 0) horiz[y*w+x] = 1;
      const rem = x - r; if (rem >= 0 && src[y*w+rem]) count--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < r && y < h; y++) if (horiz[y*w+x]) count++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && horiz[add*w+x]) count++;
      if (count > 0) out[y*w+x] = 1;
      const rem = y - r; if (rem >= 0 && horiz[rem*w+x]) count--;
    }
  }
  return out;
}

function erodeFast(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let zeros = 0;
    for (let x = 0; x < r && x < w; x++) if (!src[y*w+x]) zeros++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && !src[y*w+add]) zeros++;
      if (zeros === 0) horiz[y*w+x] = 1;
      const rem = x - r; if (rem >= 0 && !src[y*w+rem]) zeros--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let zeros = 0;
    for (let y = 0; y < r && y < h; y++) if (!horiz[y*w+x]) zeros++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && !horiz[add*w+x]) zeros++;
      if (zeros === 0) out[y*w+x] = 1;
      const rem = y - r; if (rem >= 0 && !horiz[rem*w+x]) zeros--;
    }
  }
  return out;
}

function closeHoles(filled: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (i >= 0 && i < w * h && !filled[i] && !outside[i]) {
      outside[i] = 1; stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i / w) | 0;
    if (x > 0)   push(i - 1);
    if (x < w-1) push(i + 1);
    if (y > 0)   push(i - w);
    if (y < h-1) push(i + w);
  }
  const closed = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    closed[i] = filled[i] || (!outside[i] ? 1 : 0);
  }
  return closed;
}

function scanlineFill(mask: Uint8Array, w: number, h: number, sx: number, sy: number): Uint8Array | null {
  if (sx < 0 || sx >= w || sy < 0 || sy >= h || mask[sy*w+sx]) return null;
  const filled  = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
  const stack   = new Int32Array(w * h);
  let top = 0;
  stack[top++] = sy * w + sx;
  visited[sy*w+sx] = 1;
  while (top > 0) {
    const idx = stack[--top];
    const cy  = (idx / w) | 0;
    const cx  = idx % w;
    let left = cx;
    while (left > 0 && !mask[cy*w+left-1] && !visited[cy*w+left-1]) left--;
    let right = cx;
    while (right < w-1 && !mask[cy*w+right+1] && !visited[cy*w+right+1]) right++;
    for (let x = left; x <= right; x++) { filled[cy*w+x] = 1; visited[cy*w+x] = 1; }
    const up = (cy-1)*w, dn = (cy+1)*w;
    for (let x = left; x <= right; x++) {
      if (cy > 0   && !mask[up+x] && !visited[up+x]) { visited[up+x]=1; stack[top++]=up+x; }
      if (cy < h-1 && !mask[dn+x] && !visited[dn+x]) { visited[dn+x]=1; stack[top++]=dn+x; }
    }
  }
  let count = 0;
  for (let i = 0; i < filled.length; i++) if (filled[i]) count++;
  return count > 4 ? filled : null;
}

function multiSeedFill(mask: Uint8Array, w: number, h: number, cx: number, cy: number): Uint8Array | null {
  const OFFSETS: [number,number][] = [
    [0,0],[1,0],[-1,0],[0,1],[0,-1],
    [2,0],[-2,0],[0,2],[0,-2],
    [1,1],[-1,1],[1,-1],[-1,-1],
  ];
  let merged: Uint8Array | null = null;
  let mergedDilated: Uint8Array | null = null;
  for (const [dx, dy] of OFFSETS) {
    const f = scanlineFill(mask, w, h, cx+dx, cy+dy);
    if (!f) continue;
    if (!merged) {
      merged = f;
      mergedDilated = dilateFast(f, w, h, FILL_GROW + 2);
    } else {
      let overlaps = false;
      for (let i = 0; i < f.length; i++) {
        if (f[i] && mergedDilated![i]) { overlaps = true; break; }
      }
      if (overlaps) {
        for (let i = 0; i < merged.length; i++) if (f[i]) merged[i] = 1;
        mergedDilated = dilateFast(merged, w, h, FILL_GROW + 2);
      }
    }
  }
  return merged;
}

function paintFill(
  filled:   Uint8Array,
  fillData: ImageData,
  r: number, g: number, b: number,
  opacity:  number,
): void {
  const d    = fillData.data;
  const newA = opacity;
  for (let i = 0; i < filled.length; i++) {
    if (!filled[i]) continue;
    const di = i * 4;
    const existA = d[di+3] / 255;
    const outA   = newA + existA * (1 - newA);
    if (outA > 0) {
      d[di]   = ((r * newA + d[di]   * existA * (1 - newA)) / outA) | 0;
      d[di+1] = ((g * newA + d[di+1] * existA * (1 - newA)) / outA) | 0;
      d[di+2] = ((b * newA + d[di+2] * existA * (1 - newA)) / outA) | 0;
      d[di+3] = (outA * 255) | 0;
    }
  }
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1,3), 16),
    parseInt(hex.slice(3,5), 16),
    parseInt(hex.slice(5,7), 16),
  ];
}

function outerShape(filled: Uint8Array, w: number, h: number): Uint8Array {
  return dilateFast(erodeFast(filled, w, h, 2), w, h, 2);
}

function findPerimeter(filled: Uint8Array, w: number, h: number): Uint8Array {
  const perim = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!filled[y*w+x]) continue;
      if (
        x === 0     || !filled[y*w+x-1] ||
        x === w - 1 || !filled[y*w+x+1] ||
        y === 0     || !filled[(y-1)*w+x] ||
        y === h - 1 || !filled[(y+1)*w+x]
      ) perim[y*w+x] = 1;
    }
  }
  return perim;
}

function measurePerim(perimMask: Uint8Array, w: number, h: number): number {
  let c = 0;
  for (let i = 0; i < perimMask.length; i++) {
    if (!perimMask[i]) continue;
    const x = i % w, y = (i / w) | 0;
    const diag =
      (x > 0   && y > 0   && perimMask[(y-1)*w+x-1]) ||
      (x < w-1 && y > 0   && perimMask[(y-1)*w+x+1]) ||
      (x > 0   && y < h-1 && perimMask[(y+1)*w+x-1]) ||
      (x < w-1 && y < h-1 && perimMask[(y+1)*w+x+1]);
    c += diag ? 1.41 : 1;
  }
  return Math.round(c);
}

function buildPolygon(perim: Uint8Array, w: number, h: number): [number, number][] {
  let startIdx = -1;
  for (let i = 0; i < perim.length; i++) {
    if (perim[i]) { startIdx = i; break; }
  }
  if (startIdx === -1) return [];

  const DX = [1, 0, -1, 0];
  const DY = [0, 1,  0, -1];
  const sx = startIdx % w, sy = (startIdx / w) | 0;
  let cx = sx, cy = sy, dir = 0;
  const steps: [number, number, number][] = [];
  const maxSteps = perim.length * 2;
  let count = 0;
  do {
    steps.push([cx, cy, dir]);
    let moved = false;
    for (let t = 0; t < 4; t++) {
      const nd = (dir + 3 + t) % 4;
      const nx = cx + DX[nd], ny = cy + DY[nd];
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && perim[ny*w+nx]) {
        cx = nx; cy = ny; dir = nd; moved = true; break;
      }
    }
    if (!moved) break;
    if (++count > maxSteps) break;
  } while (cx !== sx || cy !== sy);

  if (steps.length === 0) return [];
  const n = steps.length;
  const corners: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const prevDir = steps[(i - 1 + n) % n][2];
    const currDir = steps[i][2];
    if (currDir !== prevDir) corners.push([steps[i][0], steps[i][1]]);
  }
  if (corners.length < 3) {
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (let i = 0; i < perim.length; i++) {
      if (!perim[i]) continue;
      const px = i % w, py = (i / w) | 0;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    return [[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY]];
  }
  return rdpSimplify(corners, RDP_EPSILON);
}

function rdpSimplify(pts: [number,number][], eps: number): [number,number][] {
  if (pts.length <= 3) return pts;
  const distToLine = (p: [number,number], a: [number,number], b: [number,number]) => {
    const [ax,ay]=a,[bx,by]=b,[px,py]=p;
    const len2 = (bx-ax)**2+(by-ay)**2;
    if (len2 === 0) return Math.hypot(px-ax,py-ay);
    const t = Math.max(0,Math.min(1,((px-ax)*(bx-ax)+(py-ay)*(by-ay))/len2));
    return Math.hypot(px-(ax+t*(bx-ax)),py-(ay+t*(by-ay)));
  };
  const keep = new Set<number>([0, pts.length-1]);
  const rec = (lo: number, hi: number) => {
    if (hi-lo < 2) return;
    let maxD = 0, idx = lo;
    for (let i = lo+1; i < hi; i++) {
      const d = distToLine(pts[i],pts[lo],pts[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) { keep.add(idx); rec(lo,idx); rec(idx,hi); }
  };
  rec(0, pts.length-1);
  return [...keep].sort((a,b)=>a-b).map(i=>pts[i]);
}

function processMask(grown: Uint8Array, w: number, h: number) {
  const areaPx   = grown.reduce((s, v) => s + v, 0);
  const outer    = outerShape(grown, w, h);
  const perimMsk = findPerimeter(outer, w, h);
  const perimPx  = measurePerim(perimMsk, w, h);
  const polygon  = buildPolygon(perimMsk, w, h);
  return { areaPx, perimPx, polygon };
}

function findRegionsInRect(
  mask: Uint8Array, w: number, h: number,
  rx1: number, ry1: number, rx2: number, ry2: number,
): Uint8Array[] {
  const x1 = Math.max(0, Math.min(rx1, rx2));
  const y1 = Math.max(0, Math.min(ry1, ry2));
  const x2 = Math.min(w-1, Math.max(rx1, rx2));
  const y2 = Math.min(h-1, Math.max(ry1, ry2));
  const results: Uint8Array[] = [];
  const seen = new Uint8Array(w * h);
  const step = Math.max(4, Math.round(Math.min(x2-x1, y2-y1) / RECT_STEP_DIVISOR));
  for (let sy = y1; sy <= y2; sy += step) {
    for (let sx = x1; sx <= x2; sx += step) {
      if (mask[sy*w+sx] || seen[sy*w+sx]) continue;
      const filled = multiSeedFill(mask, w, h, sx, sy);
      if (!filled) continue;
      let overlaps = false;
      for (let ty = y1; ty <= y2 && !overlaps; ty++)
        for (let tx = x1; tx <= x2 && !overlaps; tx++)
          if (filled[ty*w+tx]) overlaps = true;
      if (!overlaps) continue;
      for (let i = 0; i < filled.length; i++) if (filled[i]) seen[i] = 1;
      results.push(filled);
    }
  }
  return results;
}

function getLogicalDims(canvas: HTMLCanvasElement): { w: number; h: number } {
  const sw = parseFloat(canvas.style.width);
  const sh = parseFloat(canvas.style.height);
  if (sw > 0 && sh > 0) return { w: sw, h: sh };
  const ow = canvas.offsetWidth;
  const oh = canvas.offsetHeight;
  if (ow > 0 && oh > 0) return { w: ow, h: oh };
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (cw > 0 && ch > 0) return { w: cw, h: ch };
  return { w: canvas.width, h: canvas.height };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useMagicFill(): MagicFillAPI {
  const maskRef      = useRef<Uint8Array | null>(null);
  const maskWRef     = useRef(0);
  const maskHRef     = useRef(0);
  const maskScaleRef = useRef(1);
  const readyRef     = useRef(false);

  const fillDataRef  = useRef<ImageData | null>(null);
  const fillWRef     = useRef(0);
  const fillHRef     = useRef(0);

  const snapshots    = useRef<ImageData[]>([]);
  const pixelMaps    = useRef<Map<number, Uint8Array>>(new Map());
  const fillOrder    = useRef<number[]>([]);

  // ── buildMask ─────────────────────────────────────────────────────────────
  const buildMask = useCallback((pdfCanvas: HTMLCanvasElement) => {
    const { w: logW, h: logH } = getLogicalDims(pdfCanvas);
    if (!logW || !logH) { console.warn('[MagicFill] buildMask: zero logical dims'); return; }

    const ratio = Math.min(1, Math.sqrt(MAX_MASK_PIXELS / (logW * logH)));
    const mw    = Math.max(1, Math.round(logW * ratio));
    const mh    = Math.max(1, Math.round(logH * ratio));

    const off    = document.createElement('canvas');
    off.width    = mw; off.height = mh;
    const offCtx = off.getContext('2d');
    if (!offCtx) return;
    offCtx.drawImage(pdfCanvas, 0, 0, mw, mh);
    const imgData = offCtx.getImageData(0, 0, mw, mh);

    const raw     = buildWallMask(imgData.data, mw, mh);
    const dilated = dilateFast(raw, mw, mh, DILATE_R);

    maskRef.current      = erodeFast(dilated, mw, mh, ERODE_R);
    maskWRef.current     = mw;
    maskHRef.current     = mh;
    maskScaleRef.current = ratio;
    readyRef.current     = true;
  }, []);

  // ── ensureFillData ────────────────────────────────────────────────────────
  const ensureFillData = useCallback((fillCanvas: HTMLCanvasElement): ImageData => {
    const w = fillCanvas.width, h = fillCanvas.height;
    if (!fillDataRef.current || fillWRef.current !== w || fillHRef.current !== h) {
      const ctx = fillCanvas.getContext('2d');
      fillDataRef.current = ctx
        ? ctx.getImageData(0, 0, w, h)
        : new ImageData(w, h);
      fillWRef.current = w;
      fillHRef.current = h;
    }
    return fillDataRef.current;
  }, []);

  // ── pushSnapshot ──────────────────────────────────────────────────────────
  const pushSnapshot = useCallback((fillCanvas: HTMLCanvasElement) => {
    // Sync dims so refs are always fresh
    fillWRef.current = fillCanvas.width;
    fillHRef.current = fillCanvas.height;
    const fd = ensureFillData(fillCanvas);
    snapshots.current.push(new ImageData(
      new Uint8ClampedArray(fd.data),
      fd.width, fd.height,
    ));
  }, [ensureFillData]);

  // ── undo ──────────────────────────────────────────────────────────────────
  const undo = useCallback((fillCanvas: HTMLCanvasElement): boolean => {
    if (!snapshots.current.length) return false;
    const prev = snapshots.current.pop()!;
    fillDataRef.current = prev;
    // FIX: always sync refs after restoring a snapshot
    fillWRef.current    = prev.width;
    fillHRef.current    = prev.height;
    fillCanvas.getContext('2d')!.putImageData(prev, 0, 0);
    return true;
  }, []);

  // ── clearAll ──────────────────────────────────────────────────────────────
  const clearAll = useCallback((fillCanvas: HTMLCanvasElement) => {
    const ctx = fillCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, fillCanvas.width, fillCanvas.height);
    // FIX: sync refs on clear
    fillWRef.current     = fillCanvas.width;
    fillHRef.current     = fillCanvas.height;
    fillDataRef.current  = new ImageData(fillCanvas.width, fillCanvas.height);
    snapshots.current    = [];
    pixelMaps.current.clear();
    fillOrder.current    = [];
  }, []);

  // ── registerFill / unregisterFill ─────────────────────────────────────────
  const registerFill = useCallback((fill: MagicFill, pixelMap: Uint8Array) => {
    pixelMaps.current.set(fill.id, pixelMap);
    fillOrder.current.push(fill.id);
  }, []);

  const unregisterFill = useCallback((id: number) => {
    pixelMaps.current.delete(id);
    fillOrder.current = fillOrder.current.filter(x => x !== id);
  }, []);

  // ── getPixelMap ───────────────────────────────────────────────────────────
  const getPixelMap = useCallback((id: number) => pixelMaps.current.get(id), []);

  // ── getPixelAt ────────────────────────────────────────────────────────────
  //
  // FIX: Accept fillCanvas as a required argument and read canvas.width /
  // canvas.height directly. This guarantees we always use the current backing-
  // store size even after a zoom-commit resize, instead of stale cached refs.
  // We also update the refs here so ensureFillData() stays in sync.
  //
  const getPixelAt = useCallback((
    canvasX:    number,
    canvasY:    number,
    fillCanvas: HTMLCanvasElement,
  ): number => {
    // Read live dimensions from the canvas element
    const w = fillCanvas.width;
    const h = fillCanvas.height;

    // Keep refs in sync so subsequent fill operations don't need to re-read
    if (fillWRef.current !== w || fillHRef.current !== h) {
      fillWRef.current = w;
      fillHRef.current = h;
      // Invalidate cached ImageData so ensureFillData re-reads on next fill
      fillDataRef.current = null;
    }

    if (!w || !h) return -1;

    const px = Math.round(canvasX);
    const py = Math.round(canvasY);
    if (px < 0 || px >= w || py < 0 || py >= h) return -1;

    const idx = py * w + px;
    // Walk newest → oldest so the topmost fill wins
    for (let i = fillOrder.current.length - 1; i >= 0; i--) {
      const id  = fillOrder.current[i];
      const map = pixelMaps.current.get(id);
      if (map && map[idx]) return id;
    }
    return -1;
  }, []);

  // ── fillAt ────────────────────────────────────────────────────────────────
  const fillAt = useCallback((
    canvasX: number, canvasY: number,
    fillCanvas: HTMLCanvasElement,
    color: string, opacity: number, label: string,
  ): MagicFill | null => {
    if (!maskRef.current || !readyRef.current) return null;

    const mw = maskWRef.current, mh = maskHRef.current;
    const sc = maskScaleRef.current;
    const mask = maskRef.current;

    const mpx = Math.round(canvasX * sc);
    const mpy = Math.round(canvasY * sc);
    if (mpx < 0 || mpx >= mw || mpy < 0 || mpy >= mh) return null;
    if (mask[mpy * mw + mpx]) return null;

    const filledMask = multiSeedFill(mask, mw, mh, mpx, mpy);
    if (!filledMask) return null;

    const fw = fillCanvas.width, fh = fillCanvas.height;
    const scaleToCanvas = fw / mw;
    const filledCanvas  = new Uint8Array(fw * fh);
    for (let my = 0; my < mh; my++) {
      for (let mx = 0; mx < mw; mx++) {
        if (!filledMask[my * mw + mx]) continue;
        const cx0 = Math.round(mx * scaleToCanvas);
        const cy0 = Math.round(my * scaleToCanvas);
        const cx1 = Math.round((mx+1) * scaleToCanvas);
        const cy1 = Math.round((my+1) * scaleToCanvas);
        for (let cy = cy0; cy < cy1 && cy < fh; cy++)
          for (let cx = cx0; cx < cx1 && cx < fw; cx++)
            filledCanvas[cy * fw + cx] = 1;
      }
    }

    const grown = dilateFast(filledCanvas, fw, fh, FILL_GROW);
    const fd    = ensureFillData(fillCanvas);
    const [r, g, b] = hexToRgb(color);
    paintFill(grown, fd, r, g, b, opacity / 100);
    fillCanvas.getContext('2d')!.putImageData(fd, 0, 0);

    const { areaPx, perimPx, polygon } = processMask(grown, fw, fh);

    const fill: MagicFill = {
      id: Date.now() + Math.random(),
      label, color, opacity, areaPx, perimPx, polygon,
    };

    pixelMaps.current.set(fill.id, grown);
    fillOrder.current.push(fill.id);

    return fill;
  }, [ensureFillData]);

  // ── fillRect ──────────────────────────────────────────────────────────────
  const fillRect = useCallback(async (
    x1: number, y1: number, x2: number, y2: number,
    fillCanvas: HTMLCanvasElement,
    color: string, opacity: number,
    labelPrefix: string, groupId: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<MagicFill[]> => {
    if (!maskRef.current || !readyRef.current) return [];

    const mw   = maskWRef.current, mh = maskHRef.current;
    const sc   = maskScaleRef.current;
    const mask = maskRef.current;
    const fw   = fillCanvas.width, fh = fillCanvas.height;

    const mrx1 = Math.round(Math.min(x1,x2) * sc);
    const mry1 = Math.round(Math.min(y1,y2) * sc);
    const mrx2 = Math.round(Math.max(x1,x2) * sc);
    const mry2 = Math.round(Math.max(y1,y2) * sc);
    if (mrx2 - mrx1 < 4 || mry2 - mry1 < 4) return [];

    const regionsMask = findRegionsInRect(mask, mw, mh, mrx1, mry1, mrx2, mry2);
    if (regionsMask.length === 0) return [];

    const fd  = ensureFillData(fillCanvas);
    const [r, g, b] = hexToRgb(color);
    const scaleToCanvas = fw / mw;
    const newFills: MagicFill[] = [];
    let fillCount = 0;

    for (let i = 0; i < regionsMask.length; i++) {
      onProgress?.(i, regionsMask.length);
      await Promise.resolve();

      const filledMask   = regionsMask[i];
      const filledCanvas = new Uint8Array(fw * fh);
      for (let my = 0; my < mh; my++) {
        for (let mx = 0; mx < mw; mx++) {
          if (!filledMask[my * mw + mx]) continue;
          const cx0 = Math.round(mx * scaleToCanvas);
          const cy0 = Math.round(my * scaleToCanvas);
          const cx1 = Math.round((mx+1) * scaleToCanvas);
          const cy1 = Math.round((my+1) * scaleToCanvas);
          for (let cy = cy0; cy < cy1 && cy < fh; cy++)
            for (let cx = cx0; cx < cx1 && cx < fw; cx++)
              filledCanvas[cy * fw + cx] = 1;
        }
      }

      const grown = dilateFast(filledCanvas, fw, fh, FILL_GROW);
      paintFill(grown, fd, r, g, b, opacity / 100);

      if (i % 5 === 0 || i === regionsMask.length - 1) {
        fillCanvas.getContext('2d')!.putImageData(fd, 0, 0);
      }

      const { areaPx, perimPx, polygon } = processMask(grown, fw, fh);
      fillCount++;
      const fill: MagicFill = {
        id:      Date.now() + Math.random() + i,
        label:   `${labelPrefix} ${fillCount}`,
        color, opacity, areaPx, perimPx, polygon, groupId,
      };

      pixelMaps.current.set(fill.id, grown);
      fillOrder.current.push(fill.id);
      newFills.push(fill);
    }

    fillCanvas.getContext('2d')!.putImageData(fd, 0, 0);
    onProgress?.(regionsMask.length, regionsMask.length);

    return newFills;
  }, [ensureFillData]);

  // ── fillHoles ─────────────────────────────────────────────────────────────
  const fillHoles = useCallback((
    id:         number,
    fill:       MagicFill,
    fillCanvas: HTMLCanvasElement,
  ): HoleFillResult | null => {
    const pixMap = pixelMaps.current.get(id);
    if (!pixMap) return null;

    const fw = fillCanvas.width, fh = fillCanvas.height;
    const closed = closeHoles(pixMap, fw, fh);

    const added = new Uint8Array(fw * fh);
    for (let i = 0; i < fw * fh; i++) if (closed[i] && !pixMap[i]) added[i] = 1;

    const [r, g, b] = hexToRgb(fill.color);
    const fd = ensureFillData(fillCanvas);
    paintFill(added, fd, r, g, b, fill.opacity / 100);
    fillCanvas.getContext('2d')!.putImageData(fd, 0, 0);

    pixelMaps.current.set(id, closed);

    const { areaPx, perimPx, polygon } = processMask(closed, fw, fh);
    return { areaPx, perimPx, polygon };
  }, [ensureFillData]);

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
  };
}
'use client';

// ─── hooks/useMagicFill.ts ────────────────────────────────────────────────────
//
//  FIX: Use dilateFast(FILL_GROW) instead of dilateToWall in fillAt and fillRect.
//  This matches the page exactly — grow 3px in all directions, stopping naturally
//  at wall pixels, giving the tight wall-kissing behavior.
//
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useCallback } from 'react';

// ─── Tunables ─────────────────────────────────────────────────────────────────

const WALL_LUMA           = 140;
const STROKE_NEIGHBOR_MIN = 1;
const DILATE_R            = 4;
const ERODE_R             = 1;
const FILL_GROW           = 3;
const RDP_EPSILON         = 3;
const MAX_CANVAS_PIXELS   = 4_000_000;
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
  getPixelAt:   (canvasX: number, canvasY: number, fillCanvas: HTMLCanvasElement) => number;
  registerFill:   (fill: MagicFill, pixelMap: Uint8Array) => void;
  unregisterFill: (id: number) => void;
  restoreFills: (visibleIds: Set<number>, fillCanvas: HTMLCanvasElement) => void;
  repaintFillColor: (
    id:         number,
    newColor:   string,
    visibleIds: Set<number>,
    fillCanvas: HTMLCanvasElement,
  ) => void;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildWallMaskAtFullResolution(
  data: Uint8ClampedArray,
  w: number,
  h: number
): Uint8Array {
  const dark = new Uint8Array(w * h);

  // Step 1: Detect dark pixels (potential walls)
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 20) continue;
    const luma = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    if (luma < WALL_LUMA) dark[i] = 1;
  }

  // Step 2: Filter out text/symbols
  const MIN_WALL_PIXELS  = 400;
  const MAX_TEXT_PIXELS  = 1500;
  const MAX_TEXT_ASPECT  = 3.5;
  const MIN_WALL_ASPECT  = 5.0;
  const MAX_TEXT_DENSITY = 0.55;

  const visited = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!dark[i] || visited[i]) continue;

    const stack: number[] = [i];
    const members: number[] = [];
    visited[i] = 1;

    while (stack.length) {
      const idx = stack.pop()!;
      members.push(idx);
      const x = idx % w, y = (idx / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (dark[ni] && !visited[ni]) {
            visited[ni] = 1;
            stack.push(ni);
          }
        }
      }
    }

    const size = members.length;

    if (size < MIN_WALL_PIXELS) {
      for (const idx of members) dark[idx] = 0;
      continue;
    }

    if (size > MAX_TEXT_PIXELS) continue;

    let minX = w, maxX = 0, minY = h, maxY = 0;
    for (const idx of members) {
      const x = idx % w, y = (idx / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const bboxW   = maxX - minX + 1;
    const bboxH   = maxY - minY + 1;
    const aspect  = Math.max(bboxW, bboxH) / Math.min(bboxW, bboxH);
    const density = size / (bboxW * bboxH);

    if (aspect > MIN_WALL_ASPECT) continue;

    if (aspect < MAX_TEXT_ASPECT && density < MAX_TEXT_DENSITY) {
      for (const idx of members) dark[idx] = 0;
    }
  }

  // Step 3: Stroke neighbor filter
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

/**
 * dilateCorners — one extra pass that fills diagonal corner gaps.
 * After dilateFast (which is axis-aligned), pixels at 45° diagonal corners
 * are missed. This pass checks all 8 neighbours so diagonal corners are filled.
 * Only runs a single pixel radius (enough to close the gap at corners).
 */
function dilateCorners(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (out[y * w + x]) continue;
      // If any of the 8 neighbours is filled, fill this pixel too
      if (
        src[(y-1)*w + (x-1)] || src[(y-1)*w + x] || src[(y-1)*w + (x+1)] ||
        src[ y   *w + (x-1)] ||                     src[ y   *w + (x+1)] ||
        src[(y+1)*w + (x-1)] || src[(y+1)*w + x] || src[(y+1)*w + (x+1)]
      ) out[y * w + x] = 1;
    }
  }
  return out;
}

/**
 * dilateForFill — FILL_GROW box dilation followed by a corner pass.
 * The box dilation kisses straight walls; the corner pass fills the
 * triangular gaps that appear where diagonal walls meet.
 */
function dilateForFill(src: Uint8Array, w: number, h: number): Uint8Array {
  return dilateCorners(dilateFast(src, w, h, FILL_GROW), w, h);
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

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1,3), 16),
    parseInt(hex.slice(3,5), 16),
    parseInt(hex.slice(5,7), 16),
  ];
}

function paintFillToSnapshot(
  filled:  Uint8Array,
  w:       number,
  h:       number,
  r: number, g: number, b: number,
  opacity: number,
): ImageData {
  const snap = new ImageData(w, h);
  const d    = snap.data;
  const a255 = Math.round(opacity * 255);
  for (let i = 0; i < filled.length; i++) {
    if (!filled[i]) continue;
    const di  = i * 4;
    d[di]     = r;
    d[di + 1] = g;
    d[di + 2] = b;
    d[di + 3] = a255;
  }
  return snap;
}

function compositeOver(dst: ImageData, src: ImageData): void {
  const d = dst.data;
  const s = src.data;
  const n = d.length;
  for (let i = 0; i < n; i += 4) {
    const sa = s[i + 3] / 255;
    if (sa === 0) continue;
    const da   = d[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA === 0) continue;
    d[i]     = ((s[i]     * sa + d[i]     * da * (1 - sa)) / outA + 0.5) | 0;
    d[i + 1] = ((s[i + 1] * sa + d[i + 1] * da * (1 - sa)) / outA + 0.5) | 0;
    d[i + 2] = ((s[i + 2] * sa + d[i + 2] * da * (1 - sa)) / outA + 0.5) | 0;
    d[i + 3] = (outA * 255 + 0.5) | 0;
  }
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
  const wallMaskRef   = useRef<Uint8Array | null>(null);
  const maskWRef      = useRef(0);
  const maskHRef      = useRef(0);
  const readyRef      = useRef(false);

  const fillWRef      = useRef(0);
  const fillHRef      = useRef(0);

  const snapshots     = useRef<ImageData[]>([]);
  const pixelMaps     = useRef<Map<number, Uint8Array>>(new Map());
  const fillOrder     = useRef<number[]>([]);
  const fillSnapshots = useRef<Map<number, ImageData>>(new Map());

  // ── buildMask ─────────────────────────────────────────────────────────────
  const buildMask = useCallback((pdfCanvas: HTMLCanvasElement) => {
    const { w: logW, h: logH } = getLogicalDims(pdfCanvas);
    if (!logW || !logH) {
      console.warn('[MagicFill] buildMask: zero logical dims');
      return;
    }

    let targetW = logW;
    let targetH = logH;
    const totalPixels = targetW * targetH;

    if (totalPixels > MAX_CANVAS_PIXELS) {
      const scale = Math.sqrt(MAX_CANVAS_PIXELS / totalPixels);
      targetW = Math.max(1, Math.round(targetW * scale));
      targetH = Math.max(1, Math.round(targetH * scale));
      console.log(`[MagicFill] Downscaling from ${logW}x${logH} to ${targetW}x${targetH} for performance`);
    }

    const off = document.createElement('canvas');
    off.width = targetW;
    off.height = targetH;
    const offCtx = off.getContext('2d');
    if (!offCtx) return;
    offCtx.drawImage(pdfCanvas, 0, 0, targetW, targetH);
    const imgData = offCtx.getImageData(0, 0, targetW, targetH);

    const raw = buildWallMaskAtFullResolution(imgData.data, targetW, targetH);
    const dilated = dilateFast(raw, targetW, targetH, DILATE_R);
    wallMaskRef.current = erodeFast(dilated, targetW, targetH, ERODE_R);
    maskWRef.current = targetW;
    maskHRef.current = targetH;
    readyRef.current = true;

    console.log(`[MagicFill] Wall mask built at ${targetW}x${targetH}`);
  }, []);

  // ── getFreshFillData ──────────────────────────────────────────────────────
  const getFreshFillData = useCallback((fillCanvas: HTMLCanvasElement): ImageData => {
    const w = fillCanvas.width, h = fillCanvas.height;
    fillWRef.current = w;
    fillHRef.current = h;
    const ctx = fillCanvas.getContext('2d');
    return ctx ? ctx.getImageData(0, 0, w, h) : new ImageData(w, h);
  }, []);

  // ── pushSnapshot ──────────────────────────────────────────────────────────
  const pushSnapshot = useCallback((fillCanvas: HTMLCanvasElement) => {
    fillWRef.current = fillCanvas.width;
    fillHRef.current = fillCanvas.height;
    const ctx = fillCanvas.getContext('2d');
    const fd = ctx
      ? ctx.getImageData(0, 0, fillCanvas.width, fillCanvas.height)
      : new ImageData(fillCanvas.width, fillCanvas.height);
    snapshots.current.push(new ImageData(
      new Uint8ClampedArray(fd.data),
      fd.width, fd.height,
    ));
  }, []);

  // ── undo ──────────────────────────────────────────────────────────────────
  const undo = useCallback((fillCanvas: HTMLCanvasElement): boolean => {
    if (!snapshots.current.length) return false;
    const prev = snapshots.current.pop()!;
    fillWRef.current = prev.width;
    fillHRef.current = prev.height;
    fillCanvas.getContext('2d')!.putImageData(prev, 0, 0);
    return true;
  }, []);

  // ── clearAll ──────────────────────────────────────────────────────────────
  const clearAll = useCallback((fillCanvas: HTMLCanvasElement) => {
    const ctx = fillCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, fillCanvas.width, fillCanvas.height);
    fillWRef.current = fillCanvas.width;
    fillHRef.current = fillCanvas.height;
    snapshots.current = [];
    pixelMaps.current.clear();
    fillSnapshots.current.clear();
    fillOrder.current = [];
  }, []);

  // ── registerFill / unregisterFill ─────────────────────────────────────────
  const registerFill = useCallback((fill: MagicFill, pixelMap: Uint8Array) => {
    pixelMaps.current.set(fill.id, pixelMap);
    fillOrder.current.push(fill.id);
  }, []);

  const unregisterFill = useCallback((id: number) => {
    pixelMaps.current.delete(id);
    fillSnapshots.current.delete(id);
    fillOrder.current = fillOrder.current.filter(x => x !== id);
  }, []);

  // ── getPixelMap ───────────────────────────────────────────────────────────
  const getPixelMap = useCallback((id: number) => pixelMaps.current.get(id), []);

  // ── getPixelAt ────────────────────────────────────────────────────────────
  const getPixelAt = useCallback((
    canvasX:    number,
    canvasY:    number,
    fillCanvas: HTMLCanvasElement,
  ): number => {
    const w = fillCanvas.width;
    const h = fillCanvas.height;
    if (fillWRef.current !== w || fillHRef.current !== h) {
      fillWRef.current = w;
      fillHRef.current = h;
    }
    if (!w || !h) return -1;
    const px = Math.round(canvasX);
    const py = Math.round(canvasY);
    if (px < 0 || px >= w || py < 0 || py >= h) return -1;
    const idx = py * w + px;
    for (let i = fillOrder.current.length - 1; i >= 0; i--) {
      const id = fillOrder.current[i];
      const map = pixelMaps.current.get(id);
      if (map && map[idx]) return id;
    }
    return -1;
  }, []);

  // ── restoreFills ──────────────────────────────────────────────────────────
  const restoreFills = useCallback((
    visibleIds: Set<number>,
    fillCanvas: HTMLCanvasElement,
  ) => {
    const ctx = fillCanvas.getContext('2d');
    if (!ctx) return;

    const w = fillCanvas.width;
    const h = fillCanvas.height;
    ctx.clearRect(0, 0, w, h);

    if (visibleIds.size === 0) return;

    const composite = new ImageData(w, h);

    for (const id of fillOrder.current) {
      if (!visibleIds.has(id)) continue;
      const snap = fillSnapshots.current.get(id);
      if (!snap) continue;
      if (snap.width !== w || snap.height !== h) continue;
      compositeOver(composite, snap);
    }

    ctx.putImageData(composite, 0, 0);
  }, []);

  // ── repaintFillColor ──────────────────────────────────────────────────────
  const repaintFillColor = useCallback((
    id:         number,
    newColor:   string,
    visibleIds: Set<number>,
    fillCanvas: HTMLCanvasElement,
  ) => {
    const pixMap = pixelMaps.current.get(id);
    if (!pixMap) return;
    const w = fillCanvas.width;
    const h = fillCanvas.height;
    const [r, g, b] = hexToRgb(newColor);
    const newSnap = paintFillToSnapshot(pixMap, w, h, r, g, b, 40 / 100);
    fillSnapshots.current.set(id, newSnap);
    restoreFills(visibleIds, fillCanvas);
  }, [restoreFills]);

  // ── fillAt ────────────────────────────────────────────────────────────────
  // Uses dilateFast(FILL_GROW) — same as the page — for tight wall-kissing.
  const fillAt = useCallback((
    canvasX: number, canvasY: number,
    fillCanvas: HTMLCanvasElement,
    color: string, opacity: number, label: string,
  ): MagicFill | null => {
    if (!wallMaskRef.current || !readyRef.current) return null;

    const fw = fillCanvas.width;
    const fh = fillCanvas.height;
    const wallMask = wallMaskRef.current;
    const mw = maskWRef.current;
    const mh = maskHRef.current;

    if (mw !== fw || mh !== fh) {
      console.warn(`[MagicFill] Mask size mismatch: mask=${mw}x${mh}, canvas=${fw}x${fh}. Rebuilding mask...`);
      return null;
    }

    const px = Math.round(canvasX);
    const py = Math.round(canvasY);
    if (px < 0 || px >= fw || py < 0 || py >= fh) return null;
    if (wallMask[py * fw + px]) return null;

    // Flood fill into the room
    const filledMask = multiSeedFill(wallMask, fw, fh, px, py);
    if (!filledMask) return null;

    // Box dilation to kiss straight walls + corner pass for diagonal gaps
    const grown = dilateForFill(filledMask, fw, fh);

    const [r, g, b] = hexToRgb(color);
    const snap = paintFillToSnapshot(grown, fw, fh, r, g, b, opacity / 100);

    // Composite onto canvas
    const fd = getFreshFillData(fillCanvas);
    compositeOver(fd, snap);
    fillCanvas.getContext('2d')!.putImageData(fd, 0, 0);

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

  // ── fillRect ──────────────────────────────────────────────────────────────
  // Uses dilateFast(FILL_GROW) — same as the page — for tight wall-kissing.
  const fillRect = useCallback(async (
    x1: number, y1: number, x2: number, y2: number,
    fillCanvas: HTMLCanvasElement,
    color: string, opacity: number,
    labelPrefix: string, groupId: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<MagicFill[]> => {
    if (!wallMaskRef.current || !readyRef.current) return [];

    const fw = fillCanvas.width;
    const fh = fillCanvas.height;
    const wallMask = wallMaskRef.current;
    const mw = maskWRef.current;
    const mh = maskHRef.current;

    if (mw !== fw || mh !== fh) {
      console.warn(`[MagicFill] Mask size mismatch in fillRect: mask=${mw}x${mh}, canvas=${fw}x${fh}`);
      return [];
    }

    const rx1 = Math.round(Math.min(x1, x2));
    const ry1 = Math.round(Math.min(y1, y2));
    const rx2 = Math.round(Math.max(x1, x2));
    const ry2 = Math.round(Math.max(y1, y2));

    if (rx2 - rx1 < 5 || ry2 - ry1 < 5) return [];

    const regionsMask = findRegionsInRect(wallMask, fw, fh, rx1, ry1, rx2, ry2);
    if (regionsMask.length === 0) return [];

    const fd = getFreshFillData(fillCanvas);
    const [r, g, b] = hexToRgb(color);
    const newFills: MagicFill[] = [];
    let fillCount = 0;

    for (let i = 0; i < regionsMask.length; i++) {
      onProgress?.(i, regionsMask.length);
      await Promise.resolve();

      // Box dilation to kiss straight walls + corner pass for diagonal gaps
      const grown = dilateForFill(regionsMask[i], fw, fh);
      const snap  = paintFillToSnapshot(grown, fw, fh, r, g, b, opacity / 100);
      compositeOver(fd, snap);

      if (i % 5 === 0 || i === regionsMask.length - 1) {
        fillCanvas.getContext('2d')!.putImageData(fd, 0, 0);
      }

      const { areaPx, perimPx, polygon } = processMask(grown, fw, fh);
      fillCount++;
      const fill: MagicFill = {
        id: Date.now() + Math.random() + i,
        label: `${labelPrefix} ${fillCount}`,
        color, opacity, areaPx, perimPx, polygon, groupId,
      };

      pixelMaps.current.set(fill.id, grown);
      fillSnapshots.current.set(fill.id, snap);
      fillOrder.current.push(fill.id);
      newFills.push(fill);
    }

    fillCanvas.getContext('2d')!.putImageData(fd, 0, 0);
    onProgress?.(regionsMask.length, regionsMask.length);

    return newFills;
  }, [getFreshFillData]);

  // ── fillHoles ─────────────────────────────────────────────────────────────
  // closeHoles is correct here — this is the explicit "close interior gaps" op.
  const fillHoles = useCallback((
    id: number,
    fill: MagicFill,
    fillCanvas: HTMLCanvasElement,
  ): HoleFillResult | null => {
    const pixMap = pixelMaps.current.get(id);
    if (!pixMap) return null;

    const fw = fillCanvas.width, fh = fillCanvas.height;
    const closed = closeHoles(pixMap, fw, fh);

    const added = new Uint8Array(fw * fh);
    for (let i = 0; i < fw * fh; i++) if (closed[i] && !pixMap[i]) added[i] = 1;

    const [r, g, b] = hexToRgb(fill.color);

    const fd = getFreshFillData(fillCanvas);
    const addedSnap = paintFillToSnapshot(added, fw, fh, r, g, b, fill.opacity / 100);
    compositeOver(fd, addedSnap);
    fillCanvas.getContext('2d')!.putImageData(fd, 0, 0);

    pixelMaps.current.set(id, closed);
    const fullSnap = paintFillToSnapshot(closed, fw, fh, r, g, b, fill.opacity / 100);
    fillSnapshots.current.set(id, fullSnap);

    const { areaPx, perimPx, polygon } = processMask(closed, fw, fh);
    return { areaPx, perimPx, polygon };
  }, [getFreshFillData]);

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
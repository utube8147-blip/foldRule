'use client';

/**
 * useSnapEngine
 *
 * Drop-in replacement that accepts raw PDF geometry types (PdfLine, PdfCurve,
 * SnapPoint) directly from usePdfDocument — no SvgLine/SvgSnapPoint conversion.
 *
 * RENDERING: Matches the SVG snap engine visual style exactly:
 *   - Secondary candidates: hollow ring + centre dot + type badge (e/m/i/c/n)
 *   - Primary candidate approaching: growing crosshair arms + faint ring
 *   - Primary candidate locked (snapped): filled dot + white ring + crosshair arms
 *   - Proximity circle guide: dashed ring around cursor when near any candidate
 *   - Per-type colors: endpoint=amber, midpoint=green, centroid=purple,
 *                      intersection=red, curve-node=cyan
 *
 * COLORS (matching SVG engine exactly):
 *   endpoint     → amber  #f59e0b
 *   midpoint     → green  #10b981
 *   centroid     → purple #8b5cf6
 *   intersection → red    #f43f5e
 *   curve-node   → cyan   #22d3ee
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import type { PdfLine, PdfCurve, SnapPoint } from '@/types/snapTypes';

// ─── Re-exported convenience types ───────────────────────────────────────────

export type SnapFlash  = { x: number; y: number; id: number };
export type SnapResult = { point: { x: number; y: number }; snapped: boolean; type: string | null };

export interface LinearChainPoint {
  x: number; y: number; type: string; label?: string;
}

// ─── Inline worker source ─────────────────────────────────────────────────────

const PROD_WORKER_SOURCE = /* js */`
let canvas = null, ctx = null;
let vpW = 800, vpH = 600, dpr = 1;
let zoom = 1, panX = 0, panY = 0;
let cursorX = null, cursorY = null;
let lines = [], curves = [], candidates = [];
let spatialGrid = null;
let snapThreshold = 14, proximityRadius = 80;
let showPins = true, activeTool = 'linear';
let rafHandle = null;

// ── Colors matching SVG snap engine exactly ───────────────────────────────────
const SNAP_COLOURS = {
  endpoint:     { dot: 'rgba(245,158,11,0.85)',  ring: 'rgba(245,158,11,0.5)',  fill: '#f59e0b' },
  midpoint:     { dot: 'rgba(16,185,129,0.85)',  ring: 'rgba(16,185,129,0.5)',  fill: '#10b981' },
  centroid:     { dot: 'rgba(139,92,246,0.85)',  ring: 'rgba(139,92,246,0.5)',  fill: '#8b5cf6' },
  intersection: { dot: 'rgba(244,63,94,0.85)',   ring: 'rgba(244,63,94,0.5)',   fill: '#f43f5e' },
  'curve-node': { dot: 'rgba(34,211,238,0.90)',  ring: 'rgba(34,211,238,0.45)', fill: '#22d3ee' },
};

const SNAP_PRIORITY = { endpoint: 0, intersection: 1, midpoint: 2, centroid: 3, 'curve-node': 4 };
const SNAP_SIZE     = { intersection: 1.0, endpoint: 1.0, midpoint: 0.85, centroid: 0.85, 'curve-node': 0.85 };

// Type badge labels (single char, matching SVG engine)
const TYPE_LABEL = { endpoint: 'e', midpoint: 'm', intersection: 'i', centroid: 'c', 'curve-node': 'n' };

const LINE_COLOUR  = { base: 'rgba(56,189,248,{a})',  fill: '#38bdf8' };
const CURVE_COLOUR = { base: 'rgba(167,139,250,{a})', fill: '#a78bfa' };

function withAlpha(t, a) { return t.replace('{a}', a.toFixed(2)); }

// ── Coordinate transforms ─────────────────────────────────────────────────────
// PDF-pixel → screen-pixel (before DPR scale)
function toSx(x) { return x * zoom + panX; }
function toSy(y) { return y * zoom + panY; }
// PDF-pixel → canvas-pixel (after DPR scale)
function toSxPx(x) { return (x * zoom + panX) * dpr; }
function toSyPx(y) { return (y * zoom + panY) * dpr; }

// ── Spatial grid ──────────────────────────────────────────────────────────────
function buildGrid(cands, cellSize) {
  const cells = new Map();
  for (const c of cands) {
    const key = Math.floor(c.x / cellSize) + ',' + Math.floor(c.y / cellSize);
    let b = cells.get(key);
    if (!b) { b = []; cells.set(key, b); }
    b.push(c);
  }
  return { cells, cellSize };
}

function queryGrid(grid, x, y, radius) {
  const { cells, cellSize } = grid;
  const r  = Math.ceil(radius / cellSize);
  const cx = Math.floor(x / cellSize);
  const cy = Math.floor(y / cellSize);
  const out = [];
  for (let dx = -r; dx <= r; dx++)
    for (let dy = -r; dy <= r; dy++) {
      const b = cells.get((cx + dx) + ',' + (cy + dy));
      if (b) out.push(...b);
    }
  return out;
}

// ── Canvas resize ─────────────────────────────────────────────────────────────
function resizeCanvas() {
  if (!canvas) return;
  const tw = Math.round(vpW * dpr);
  const th = Math.round(vpH * dpr);
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width  = tw;
    canvas.height = th;
  }
}

// ── Line hit test ─────────────────────────────────────────────────────────────
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ── Main draw ─────────────────────────────────────────────────────────────────
function draw() {
  rafHandle = null;
  if (!canvas || !ctx) return;
  resizeCanvas();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Gate: suppress overlay for select tool or when pins disabled
  const shouldDraw = showPins && activeTool !== 'select' && cursorX !== null && cursorY !== null;
  if (!shouldDraw) return;

  const prox   = proximityRadius;
  const thresh = snapThreshold;
  const z      = zoom;

  const cx = cursorX, cy = cursorY;
  // Cursor in screen-px (before DPR) for viewport-space distance comparisons
  const cxVP = toSx(cx), cyVP = toSy(cy);
  // Cursor in canvas-px (after DPR) for actual drawing
  const cxPx = cxVP * dpr, cyPx = cyVP * dpr;

  // Viewport culling bounds in PDF-pixel space
  const vpMinX = -panX / z, vpMinY = -panY / z;
  const vpMaxX = (vpW - panX) / z, vpMaxY = (vpH - panY) / z;
  const proxC  = prox / z; // proximity radius in PDF-pixel space
  const cullMinX = vpMinX - proxC, cullMinY = vpMinY - proxC;
  const cullMaxX = vpMaxX + proxC, cullMaxY = vpMaxY + proxC;

  // ── 1. PDF lines ─────────────────────────────────────────────────────────
  let nearestLineIdx  = -1;
  let nearestLineDist = prox;
  let nearestLineSnapX = 0, nearestLineSnapY = 0;
  const lineDrawCache = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const [a, b] = line.vertices;
    // Viewport cull
    if (Math.max(a.x, b.x) < cullMinX || Math.min(a.x, b.x) > cullMaxX) continue;
    if (Math.max(a.y, b.y) < cullMinY || Math.min(a.y, b.y) > cullMaxY) continue;

    const ax = toSxPx(a.x), ay = toSyPx(a.y);
    const bx = toSxPx(b.x), by = toSyPx(b.y);

    // Distance from cursor to segment in canvas-px, then convert to screen-px
    const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy;
    let cpx, cpy;
    if (lenSq === 0) { cpx = ax; cpy = ay; }
    else {
      const t = Math.max(0, Math.min(1, ((cxPx - ax) * dx + (cyPx - ay) * dy) / lenSq));
      cpx = ax + t * dx; cpy = ay + t * dy;
    }
    const distCSS = Math.hypot(cxPx - cpx, cyPx - cpy) / dpr;
    if (distCSS > prox) continue;

    lineDrawCache.push({ ax, ay, bx, by, cpx, cpy, dist: distCSS, idx: li });
    if (distCSS < nearestLineDist) {
      nearestLineDist  = distCSS;
      nearestLineIdx   = li;
      nearestLineSnapX = cpx;
      nearestLineSnapY = cpy;
    }
  }

  for (const { ax, ay, bx, by, dist, idx } of lineDrawCache) {
    const isNearest  = idx === nearestLineIdx;
    const isSnapping = isNearest && dist < thresh;
    const rawAlpha   = 1 - dist / prox;
    const lineAlpha  = isNearest ? rawAlpha : rawAlpha * 0.25;
    const lineWidth  = isSnapping ? 2.0 : isNearest ? 1.2 : 0.6;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.strokeStyle = withAlpha(LINE_COLOUR.base, lineAlpha);
    ctx.lineWidth   = lineWidth * dpr;
    if (!isSnapping && isNearest) ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (isSnapping) {
      ctx.beginPath();
      ctx.arc(nearestLineSnapX, nearestLineSnapY, 5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle   = LINE_COLOUR.fill;
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth   = 1.5 * dpr;
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── 2. PDF curves (bezier) ────────────────────────────────────────────────
  for (let ci = 0; ci < curves.length; ci++) {
    const curve = curves[ci];
    if (!curve.bezier) continue;
    const { p0, p1, p2, p3 } = curve.bezier;
    if (Math.max(p0.x, p3.x) < cullMinX || Math.min(p0.x, p3.x) > cullMaxX) continue;
    if (Math.max(p0.y, p3.y) < cullMinY || Math.min(p0.y, p3.y) > cullMaxY) continue;

    // Sample curve to find distance to cursor
    let minD = Infinity;
    for (let i = 0; i <= 24; i++) {
      const t = i / 24, u = 1 - t;
      const ptxS = (u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x) * z + panX;
      const ptyS = (u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y) * z + panY;
      const d = Math.hypot(cxVP - ptxS, cyVP - ptyS);
      if (d < minD) minD = d;
    }
    if (minD > prox) continue;

    const fade  = Math.max(0, 1 - minD / prox);
    const alpha = 0.10 + fade * 0.60;

    // Draw bezier in canvas-px
    const s0x = toSxPx(p0.x), s0y = toSyPx(p0.y);
    const s1x = toSxPx(p1.x), s1y = toSyPx(p1.y);
    const s2x = toSxPx(p2.x), s2y = toSyPx(p2.y);
    const s3x = toSxPx(p3.x), s3y = toSyPx(p3.y);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(s0x, s0y);
    ctx.bezierCurveTo(s1x, s1y, s2x, s2y, s3x, s3y);
    ctx.strokeStyle = withAlpha(CURVE_COLOUR.base, alpha);
    ctx.lineWidth   = (0.5 + fade * 1.5) * dpr;
    ctx.stroke();
    ctx.restore();
  }

  // ── 3. Snap candidates — priority-aware nearest selection ─────────────────
  const nearby = spatialGrid ? queryGrid(spatialGrid, cx, cy, prox / z) : candidates;

  let nearestC     = null;
  let nearestCDist = Infinity;

  for (const c of nearby) {
    // Distance in screen-px (viewport space)
    const dist = Math.hypot(cx - c.x, cy - c.y) * z;
    if (dist > prox) continue;

    const pri     = SNAP_PRIORITY[c.type] ?? 99;
    const nearPri = nearestC ? (SNAP_PRIORITY[nearestC.type] ?? 99) : 99;
    const tooClose = nearestC !== null && Math.abs(dist - nearestCDist) < 4;

    if (
      nearestC === null ||
      (tooClose && pri < nearPri) ||
      (!tooClose && dist < nearestCDist)
    ) {
      nearestCDist = dist;
      nearestC     = c;
    }
  }

  // ── 3a. Secondary candidates — hollow ring + centre dot + type badge ──────
  for (const c of nearby) {
    if (c === nearestC) continue;
    const dist = Math.hypot(cx - c.x, cy - c.y) * z;
    if (dist > prox) continue;

    const col  = SNAP_COLOURS[c.type] ?? SNAP_COLOURS['endpoint'];
    const fade = Math.max(0, 1 - dist / prox);
    const a    = 0.12 + fade * 0.40;
    const r    = (3 + fade * 3.5) * dpr;
    const cpx2 = toSxPx(c.x), cpy2 = toSyPx(c.y);

    ctx.save();

    // Hollow ring
    ctx.beginPath();
    ctx.arc(cpx2, cpy2, r, 0, Math.PI * 2);
    ctx.strokeStyle = col.fill;
    ctx.globalAlpha = a;
    ctx.lineWidth   = 1 * dpr;
    ctx.stroke();

    // Centre dot
    ctx.beginPath();
    ctx.arc(cpx2, cpy2, 1.5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle   = col.fill;
    ctx.globalAlpha = Math.min(1, a + 0.15);
    ctx.fill();

    // Type badge — appears when cursor is close enough
    if (fade > 0.25) {
      const label = TYPE_LABEL[c.type] ?? '?';
      ctx.globalAlpha  = a * 0.9;
      ctx.fillStyle    = col.fill;
      ctx.font         = Math.round((8 + fade * 3) * dpr) + 'px monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, cpx2, cpy2 - r - 2 * dpr);
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ── 3b. Primary candidate ─────────────────────────────────────────────────
  if (nearestC) {
    const col     = SNAP_COLOURS[nearestC.type] ?? SNAP_COLOURS['endpoint'];
    const sizeMul = SNAP_SIZE[nearestC.type]    ?? 1.0;
    const isSnap  = nearestCDist < thresh;
    const fade    = Math.max(0, 1 - nearestCDist / prox);

    const cpx2 = toSxPx(nearestC.x), cpy2 = toSyPx(nearestC.y);

    ctx.save();

    if (isSnap) {
      // ── LOCKED: filled dot + white ring + crosshair arms ─────────────────
      const r  = 7 * dpr * sizeMul;
      const ch = 11 * dpr;

      // Soft glow halo
      ctx.beginPath();
      ctx.arc(cpx2, cpy2, r, 0, Math.PI * 2);
      ctx.fillStyle   = col.fill;
      ctx.globalAlpha = 0.25;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Filled dot
      ctx.beginPath();
      ctx.arc(cpx2, cpy2, r, 0, Math.PI * 2);
      ctx.fillStyle = col.fill;
      ctx.fill();

      // White ring
      ctx.strokeStyle = 'white';
      ctx.lineWidth   = 2 * dpr;
      ctx.stroke();

      // Crosshair arms
      ctx.beginPath();
      ctx.moveTo(cpx2 - ch, cpy2); ctx.lineTo(cpx2 + ch, cpy2);
      ctx.moveTo(cpx2, cpy2 - ch); ctx.lineTo(cpx2, cpy2 + ch);
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.lineWidth   = 1.5 * dpr;
      ctx.stroke();

    } else {
      // ── APPROACHING: growing crosshair arms + faint ring ─────────────────
      const sz = (2.5 + fade * 4.5) * dpr * sizeMul;
      const a  = 0.20 + fade * 0.65;

      ctx.strokeStyle = col.dot;
      ctx.globalAlpha = a;
      ctx.lineWidth   = (0.8 + fade * 0.8) * dpr;

      ctx.beginPath();
      ctx.moveTo(cpx2 - sz, cpy2); ctx.lineTo(cpx2 + sz, cpy2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cpx2, cpy2 - sz); ctx.lineTo(cpx2, cpy2 + sz);
      ctx.stroke();

      // Faint ring when cursor is more than 35% of the way in
      if (fade > 0.35) {
        ctx.beginPath();
        ctx.arc(cpx2, cpy2, sz + 4 * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = col.ring;
        ctx.globalAlpha = a * 0.35;
        ctx.lineWidth   = 0.8 * dpr;
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // ── 4. Proximity circle guide ─────────────────────────────────────────
    // Dashed ring around cursor — only shown when at least one candidate is
    // within the proximity radius (matches SVG engine behaviour exactly)
    ctx.save();
    ctx.beginPath();
    ctx.arc(cxPx, cyPx, prox * dpr, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(100,100,100,0.08)';
    ctx.lineWidth   = 0.8 * dpr;
    ctx.setLineDash([3 * dpr, 4 * dpr]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

function requestDraw() {
  if (rafHandle !== null) return;
  rafHandle = requestAnimationFrame(draw);
}

// ── Message handler ───────────────────────────────────────────────────────────
self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      canvas = msg.canvas;
      ctx    = canvas.getContext('2d');
      dpr    = msg.dpr    ?? 1;
      vpW    = msg.vpW    ?? 800;
      vpH    = msg.vpH    ?? 600;
      zoom   = msg.zoom   ?? 1;
      panX   = msg.panX   ?? 0;
      panY   = msg.panY   ?? 0;
      snapThreshold   = msg.snapThreshold   ?? 14;
      proximityRadius = msg.proximityRadius ?? 80;
      showPins   = msg.showPins   ?? true;
      activeTool = msg.activeTool ?? 'linear';
      lines      = msg.lines      ?? [];
      curves     = msg.curves     ?? [];
      candidates = msg.candidates ?? [];
      spatialGrid = buildGrid(candidates, proximityRadius / zoom);
      resizeCanvas();
      break;
    }
    case 'data': {
      if (msg.lines      !== undefined) lines      = msg.lines;
      if (msg.curves     !== undefined) curves     = msg.curves;
      if (msg.candidates !== undefined) {
        candidates  = msg.candidates;
        spatialGrid = buildGrid(candidates, proximityRadius / zoom);
      }
      requestDraw();
      break;
    }
    case 'transform': {
      zoom = msg.zoom; panX = msg.panX; panY = msg.panY;
      // Rebuild spatial grid at new zoom (cell size is proximity in PDF-px)
      spatialGrid = buildGrid(candidates, proximityRadius / zoom);
      requestDraw();
      break;
    }
    case 'cursor': {
      cursorX = msg.x; cursorY = msg.y;
      requestDraw();
      break;
    }
    case 'cursor_leave': {
      cursorX = null; cursorY = null;
      requestDraw();
      break;
    }
    case 'clear': {
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      break;
    }
    case 'settings': {
      if (msg.snapThreshold   !== undefined) snapThreshold   = msg.snapThreshold;
      if (msg.proximityRadius !== undefined) {
        proximityRadius = msg.proximityRadius;
        spatialGrid = buildGrid(candidates, proximityRadius / zoom);
      }
      if (msg.showPins   !== undefined) showPins   = msg.showPins;
      if (msg.activeTool !== undefined) activeTool = msg.activeTool;
      requestDraw();
      break;
    }
    case 'resize': {
      vpW = msg.vpW; vpH = msg.vpH;
      if (msg.dpr !== undefined) dpr = msg.dpr;
      resizeCanvas();
      requestDraw();
      break;
    }
  }
};
`;

// ─── Blob URL management ──────────────────────────────────────────────────────

let workerBlobUrl: string | null = null;
let workerBlobRefCount = 0;

function acquireWorkerBlobUrl(): string {
  if (!workerBlobUrl) {
    const blob = new Blob([PROD_WORKER_SOURCE], { type: 'application/javascript' });
    workerBlobUrl = URL.createObjectURL(blob);
  }
  workerBlobRefCount++;
  return workerBlobUrl;
}

function releaseWorkerBlobUrl() {
  workerBlobRefCount--;
  if (workerBlobRefCount <= 0 && workerBlobUrl) {
    URL.revokeObjectURL(workerBlobUrl);
    workerBlobUrl = null;
    workerBlobRefCount = 0;
  }
}

// ─── Transferred-canvas guard ─────────────────────────────────────────────────

const transferredCanvases = new WeakMap<HTMLCanvasElement, true>();

// ─── Main-thread helpers ──────────────────────────────────────────────────────

function closestPointOnSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): { x: number; y: number } {
  const ax = px - x1, ay = py - y1;
  const bx = x2 - x1, by = y2 - y1;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return { x: x1, y: y1 };
  const t = Math.max(0, Math.min(1, (ax * bx + ay * by) / len2));
  return { x: x1 + t * bx, y: y1 + t * by };
}

// ─── Spatial grid (main thread) ───────────────────────────────────────────────

interface Candidate {
  x: number; y: number; type: string; sourceId?: string;
}

interface SpatialGrid {
  cells: Map<string, Candidate[]>;
  cellSize: number;
}

function buildGridMain(candidates: Candidate[], cellSize: number): SpatialGrid {
  const cells = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${Math.floor(c.x / cellSize)},${Math.floor(c.y / cellSize)}`;
    let bucket = cells.get(key);
    if (!bucket) { bucket = []; cells.set(key, bucket); }
    bucket.push(c);
  }
  return { cells, cellSize };
}

function queryGridMain(grid: SpatialGrid, x: number, y: number, radius: number): Candidate[] {
  const { cells, cellSize } = grid;
  const r  = Math.ceil(radius / cellSize);
  const cx = Math.floor(x / cellSize);
  const cy = Math.floor(y / cellSize);
  const out: Candidate[] = [];
  for (let dx = -r; dx <= r; dx++)
    for (let dy = -r; dy <= r; dy++) {
      const b = cells.get(`${cx + dx},${cy + dy}`);
      if (b) out.push(...b);
    }
  return out;
}

// ─── Hook params ──────────────────────────────────────────────────────────────

export interface UseSnapEngineParams {
  pinCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  viewportRef:      React.RefObject<HTMLDivElement | null>;
  snapEnabled:      boolean;
  showPins:         boolean;
  snapThreshold:    number;
  lines?:           PdfLine[];
  curves?:          PdfCurve[];
  snapPoints?:      SnapPoint[];
  activeTool?:      string;
  zoom:             number;
  pan:              { x: number; y: number };
  proximityRadius?: number;
}

export interface UseSnapEngineReturn {
  snapFlashes:      SnapFlash[];
  snapToCorner:     (canvasX: number, canvasY: number) => SnapResult;
  triggerSnapFlash: (x: number, y: number) => void;
  redrawPinCanvas:  () => void;
  cursorPointRef:   React.MutableRefObject<{ x: number; y: number } | null>;
  linearChain:      LinearChainPoint[];
  addChainPoint:    (x: number, y: number, type: string) => void;
  undoChainPoint:   () => void;
  clearChain:       () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSnapEngine({
  pinCanvasRef,
  viewportRef,
  snapEnabled,
  showPins,
  snapThreshold,
  lines      = [],
  curves     = [],
  snapPoints = [],
  activeTool = 'linear',
  zoom,
  pan,
  proximityRadius = 80,
}: UseSnapEngineParams): UseSnapEngineReturn {

  const workerRef      = useRef<Worker | null>(null);
  const workerReadyRef = useRef(false);

  const snapEnabledRef    = useRef(snapEnabled);
  const snapThresholdRef  = useRef(snapThreshold);
  const linesRef          = useRef(lines);
  const proximityRef      = useRef(proximityRadius);
  const showPinsRef       = useRef(showPins);
  const zoomRef           = useRef(zoom);

  useEffect(() => { snapEnabledRef.current   = snapEnabled;    }, [snapEnabled]);
  useEffect(() => { snapThresholdRef.current = snapThreshold;  }, [snapThreshold]);
  useEffect(() => { linesRef.current         = lines;          }, [lines]);
  useEffect(() => { proximityRef.current     = proximityRadius; }, [proximityRadius]);
  useEffect(() => { showPinsRef.current      = showPins;       }, [showPins]);
  useEffect(() => { zoomRef.current          = zoom;           }, [zoom]);

  const candidatesCacheRef = useRef<Candidate[]>([]);
  const spatialGridRef     = useRef<SpatialGrid | null>(null);
  const workerInitedRef    = useRef(false);

  const [snapFlashes, setSnapFlashes] = useState<SnapFlash[]>([]);
  const [linearChain, setLinearChain] = useState<LinearChainPoint[]>([]);

  const cursorPointRef = useRef<{ x: number; y: number } | null>(null);
  const flashIdRef     = useRef(0);

  const post = useCallback((msg: object) => {
    if (workerRef.current && workerReadyRef.current)
      workerRef.current.postMessage(msg);
  }, []);

  // ── Spawn worker ──────────────────────────────────────────────────────────
  useEffect(() => {
    const url    = acquireWorkerBlobUrl();
    const worker = new Worker(url);
    workerRef.current      = worker;
    workerReadyRef.current = true;
    return () => {
      worker.terminate();
      workerRef.current       = null;
      workerReadyRef.current  = false;
      workerInitedRef.current = false;
      const canvas = pinCanvasRef.current;
      if (canvas) transferredCanvases.delete(canvas);
      releaseWorkerBlobUrl();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Transfer OffscreenCanvas + init ───────────────────────────────────────
  useEffect(() => {
    const canvas = pinCanvasRef.current;
    const worker = workerRef.current;
    if (!canvas || !worker) return;

    if (!transferredCanvases.has(canvas)) {
      if (!('transferControlToOffscreen' in canvas)) return;
      try {
        const offscreen = canvas.transferControlToOffscreen();
        const vp        = viewportRef?.current;
        transferredCanvases.set(canvas, true);
        workerInitedRef.current = true;
        worker.postMessage(
          {
            type: 'init', canvas: offscreen,
            dpr:  window.devicePixelRatio || 1,
            vpW:  vp?.clientWidth  ?? 800,
            vpH:  vp?.clientHeight ?? 600,
            zoom, panX: pan.x, panY: pan.y,
            lines, curves,
            candidates:     candidatesCacheRef.current,
            snapThreshold,
            proximityRadius,
            showPins,
            activeTool,
          },
          [offscreen],
        );
      } catch {
        transferredCanvases.set(canvas, true);
        workerInitedRef.current = true;
      }
    } else if (workerInitedRef.current && candidatesCacheRef.current.length > 0) {
      worker.postMessage({
        type: 'data',
        lines,
        curves,
        candidates: candidatesCacheRef.current,
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapPoints.length]);

  // ── Data effect — lines, curves, snapPoints ───────────────────────────────
  const lastLinesRef      = useRef<PdfLine[]>([]);
  const lastCurvesRef     = useRef<PdfCurve[]>([]);
  const lastSnapPointsRef = useRef<SnapPoint[]>([]);

  useEffect(() => {
    const unchanged =
      lines      === lastLinesRef.current &&
      curves     === lastCurvesRef.current &&
      snapPoints === lastSnapPointsRef.current;
    if (unchanged) return;

    lastLinesRef.current      = lines;
    lastCurvesRef.current     = curves;
    lastSnapPointsRef.current = snapPoints;

    // snapPoints carry absolute canvas-space x/y (resolved upstream in Viewer.tsx)
    const cands: Candidate[] = snapPoints.map(sp => ({
      x:        (sp as any).x ?? sp.nx,
      y:        (sp as any).y ?? sp.ny,
      type:     sp.type,
      sourceId: sp.sourceId,
    }));

    candidatesCacheRef.current = cands;
    spatialGridRef.current     = buildGridMain(cands, proximityRadius);

    const canvas = pinCanvasRef.current;
    if (canvas && transferredCanvases.has(canvas)) {
      post({ type: 'data', lines, curves, candidates: cands });
    }
  }, [lines, curves, snapPoints, proximityRadius, post, pinCanvasRef]);

  // ── Transform effect ──────────────────────────────────────────────────────
  useEffect(() => {
    post({ type: 'transform', zoom, panX: pan.x, panY: pan.y });
  }, [zoom, pan.x, pan.y, post]);

  // ── Settings effect ───────────────────────────────────────────────────────
  useEffect(() => {
    post({ type: 'settings', showPins, activeTool, snapThreshold, proximityRadius });
    if (!showPins) {
      post({ type: 'cursor_leave' });
      post({ type: 'clear' });
    }
  }, [showPins, activeTool, snapThreshold, proximityRadius, post]);

  // ── Resize observer ───────────────────────────────────────────────────────
  useEffect(() => {
    const el = viewportRef?.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        post({ type: 'resize', vpW: width, vpH: height, dpr: window.devicePixelRatio || 1 });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewportRef, post]);

  // ── redrawPinCanvas ───────────────────────────────────────────────────────
  const redrawPinCanvas = useCallback(() => {
    if (!showPinsRef.current) {
      post({ type: 'cursor_leave' });
      return;
    }
    const cursor = cursorPointRef.current;
    if (cursor) post({ type: 'cursor', x: cursor.x, y: cursor.y });
    else        post({ type: 'cursor_leave' });
  }, [post]);

  // ── snapToCorner — main thread, synchronous ───────────────────────────────
  const snapToCorner = useCallback((canvasX: number, canvasY: number): SnapResult => {
    if (!snapEnabledRef.current)
      return { point: { x: canvasX, y: canvasY }, snapped: false, type: null };

    const threshC = snapThresholdRef.current / zoomRef.current;
    let best: { x: number; y: number } | null = null;
    let bestDist = threshC;
    let bestType: string | null = null;

    // 1. Snap points (highest priority — endpoint, midpoint, intersection, etc.)
    const nearby = spatialGridRef.current
      ? queryGridMain(spatialGridRef.current, canvasX, canvasY, threshC)
      : candidatesCacheRef.current;

    for (const c of nearby) {
      const d = Math.hypot(canvasX - c.x, canvasY - c.y);
      if (d < bestDist) { bestDist = d; best = { x: c.x, y: c.y }; bestType = c.type; }
    }

    // 2. Nearest point on any line (fallback — gives 'line' type)
    if (!best) {
      for (const line of linesRef.current) {
        const [a, b] = line.vertices;
        const cp = closestPointOnSegment(canvasX, canvasY, a.x, a.y, b.x, b.y);
        const d  = Math.hypot(canvasX - cp.x, canvasY - cp.y);
        if (d < bestDist) { bestDist = d; best = cp; bestType = 'line'; }
      }
    }

    return best
      ? { point: best, snapped: true,  type: bestType }
      : { point: { x: canvasX, y: canvasY }, snapped: false, type: null };
  }, []);

  // ── triggerSnapFlash ──────────────────────────────────────────────────────
  const triggerSnapFlash = useCallback((x: number, y: number) => {
    const id = ++flashIdRef.current;
    setSnapFlashes(prev => [...prev, { x, y, id }]);
    setTimeout(() => setSnapFlashes(prev => prev.filter(f => f.id !== id)), 700);
  }, []);

  // ── Chain ─────────────────────────────────────────────────────────────────
  const addChainPoint  = useCallback((x: number, y: number, type: string) => {
    setLinearChain(prev => [...prev, { x, y, type }]);
  }, []);
  const undoChainPoint = useCallback(() => setLinearChain(prev => prev.slice(0, -1)), []);
  const clearChain     = useCallback(() => setLinearChain([]), []);

  return {
    snapFlashes,
    snapToCorner,
    triggerSnapFlash,
    redrawPinCanvas,
    cursorPointRef,
    linearChain,
    addChainPoint,
    undoChainPoint,
    clearChain,
  };
}
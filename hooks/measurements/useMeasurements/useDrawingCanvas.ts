'use client';
// ─── hooks/useMeasurements/useDrawingCanvas.ts ────────────────────────────────
//
// CHANGES vs previous version:
//
//  POLYARC CLOSE-SNAP + ARC PREVIEW FIX
//  ─────────────────────────────────────
//  Previously the polyarc arc-preview logic (arcRunLen === 2 circumscribed arc,
//  arcRunLen === 1 rubber-band, etc.) lived in the `else` branch of the
//  close-snap `if`. This meant that as soon as the cursor entered the
//  CLOSE_SNAP_THRESHOLD radius around the first point, the arc preview
//  disappeared entirely — replaced by only the close-snap hover overlay.
//
//  Fix: the arc preview block now runs unconditionally whenever `cursor` is
//  present. The close-snap hover is then drawn as a SECOND PASS on top of the
//  arc preview. The two concerns are now fully independent — approaching the
//  start point no longer suppresses the in-progress arc rubber-band.
//
//  CLOSE-SNAP HOVER EFFECT (all path tools)
//  ─────────────────────────────────────────
//  When any path tool (linear, polygon, polyarc) has ≥ 2 points placed and
//  the cursor moves within CLOSE_SNAP_THRESHOLD canvas-px of the first placed
//  point, a visual "close path" hint is rendered.
//
//  startPointSnapRef — NORMALISED COORDS FIX
//  ──────────────────────────────────────────
//  Previously startPointSnapRef stored canvas-pixel coords (tPts[0]), which
//  useMeasurementCommit then passed through toNorm(). This double-conversion
//  broke when the canvas has DPR/CSS scaling because toCanvas() and toNorm()
//  use dim.w/dim.h (logical PDF points), not physical canvas pixels.
//
//  Fix: startPointSnapRef now stores the RAW NORMALISED COORDS of the first
//  placed point (nonSentinelPoints[0].x / .y), which are already in the same
//  space as every other InProgressPoint. useMeasurementCommit uses them
//  directly — no toNorm() conversion needed.
//
//  All other fixes from previous versions are unchanged.
//
// ─────────────────────────────────────────────────────────────────────────────

import { tessellateArc } from '@/lib/geometry/pathShapes';
import { tessellatePoints, isSentinel } from '@/hooks/perimeterOffset/perimeterOffsetGeometry';
import { orthoState } from '@/lib/geometry/ortho';
import { useRef, useEffect, useCallback } from 'react';
import React from 'react';
import { ToolType, TakeoffRow } from '@/types';
import type { PdfDimensions } from '@/types/viewerTypes';
import type { DragState } from './types';
import type { InProgressPoint } from '@/context/TakeoffContext';

/** Pin colours by snap type (match the lab page / legend). */
const PIN_COLOURS: Record<string, string> = {
  endpoint: '#22c55e', corner: '#22c55e', midpoint: '#38bdf8', intersection: '#ef4444',
  centroid: '#8b5cf6', 'curve-node': '#f59e0b', tangent: '#f59e0b', quadrant: '#f59e0b',
  vertex: '#F2C230',   // your own measurements' points
};

/** Canvas can't read CSS variables — resolve the mono font family once. */
let monoFamily: string | null = null;
function canvasMonoFont(): string {
  if (monoFamily === null) {
    const v = typeof window !== 'undefined'
      ? getComputedStyle(document.documentElement).getPropertyValue('--font-jetbrains').trim()
      : '';
    monoFamily = `${v ? `${v}, ` : ''}ui-monospace, monospace`;
  }
  return monoFamily;
}

import {
  splitArcPoints, isArcSentinel,
  splitRadiusPoints, isRadiusSentinel,
  splitPolyarcSegments,
} from './useMeasurementCommit';

interface UseDrawingCanvasParams {
  drawingCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  pdfDimensionsRef: React.RefObject<PdfDimensions | null>;
  scaleRef:         React.RefObject<number>;
  measurements:     TakeoffRow[];
  tempPoints:       InProgressPoint[];
  activeTool:       ToolType;
  scaleFactor:      number;
  isPanning:        boolean;
  pendingBreak:     boolean;
  dragStateRef:     React.RefObject<DragState | null>;
  cursorPointRef:   React.RefObject<{ x: number; y: number } | null>;
  snapToCorner:     ((...args: any[]) => any) | null;
  redrawPinCanvas:  () => void;
  snapEnabledRef:   React.RefObject<boolean>;
  snapCandidates?:  Array<{ x: number; y: number; type: string }>;
  arcDragPreview?:  { start: {x:number;y:number}; mid: {x:number;y:number}; end: {x:number;y:number} } | null;
  /** Draw each measurement's quantity on the drawing (cached with the shapes). */
  showLabels?:      boolean;
  /** Measurement to outline as selected (read per frame; no re-render needed). */
  selectedIdRef?:   React.RefObject<string | null>;
  extraSelectedRef?: React.RefObject<string[]>;
  /**
   * Finds the PDF line/arc under the cursor (canvas px in, canvas px out) so it
   * can be highlighted while drawing. Null = feature off.
   */
  /** Snap points near the cursor (canvas px) to draw as pins; null = pins off. */
  findPinsNear?: ((x: number, y: number) => { x: number; y: number; type: string }[]) | null;
  findHoverGeometry?: ((x: number, y: number) => { kind: 'line'; pts: { x: number; y: number }[] } | { kind: 'curve'; pts: { x: number; y: number }[] } | null) | null;
}

interface UseDrawingCanvasReturn {
  cursorPoint:         { x: number; y: number } | null;
  setCursorPoint:      React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  redrawDrawingCanvas: (pt?: { x: number; y: number }) => void;
  handleCanvasPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  /** True when cursor is within CLOSE_SNAP_THRESHOLD of the first placed point. */
  nearStartPointRef:   React.RefObject<boolean>;
  /**
   * NORMALISED coords { x, y } of the first placed point when nearStartPointRef
   * is true. These are in the same 0-1 normalised space as every InProgressPoint
   * — useMeasurementCommit uses them directly WITHOUT any toNorm() conversion.
   */
  startPointSnapRef:   React.RefObject<{ x: number; y: number } | null>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const COLOUR_ACTIVE        = '#EF9F27';
const COLOUR_ARC           = '#2DD4BF';
const COLOUR_ARC_STAGED    = '#14B8A6';
const COLOUR_POLYARC_LINE  = '#EF9F27';
const COLOUR_POLYARC_ARC   = '#2DD4BF';
const COLOUR_RADIUS        = '#A78BFA';
const COLOUR_RADIUS_STAGED = '#7C3AED';
const COLOUR_UNSNAPPED     = '#EF9F27';
const DOT_RADIUS           = 3.5;
const LINE_WIDTH           = 1.5;
const DASH_ACTIVE          = [6, 4] as number[];
const DASH_PREVIEW         = [4, 4] as number[];

const COMMITTED_LINE_WIDTH  = 3.5;
const COMMITTED_ALPHA       = 1.0;

// ── Close-snap threshold ──────────────────────────────────────────────────────
const CLOSE_SNAP_THRESHOLD = 24;

// ─── Snap visual constants ────────────────────────────────────────────────────

const PROX_RADIUS_PDF = 80;

const SNAP_TYPE_COLOURS: Record<string, { fill: string; ring: string; dot: string }> = {
  endpoint:     { fill: '#f59e0b', ring: 'rgba(245,158,11,0.45)',  dot: 'rgba(245,158,11,0.85)'  },
  midpoint:     { fill: '#10b981', ring: 'rgba(16,185,129,0.45)', dot: 'rgba(16,185,129,0.85)'  },
  centroid:     { fill: '#8b5cf6', ring: 'rgba(139,92,246,0.45)', dot: 'rgba(139,92,246,0.85)'  },
  intersection: { fill: '#f43f5e', ring: 'rgba(244,63,94,0.45)',  dot: 'rgba(244,63,94,0.85)'   },
  'arc-center': { fill: '#22d3ee', ring: 'rgba(34,211,238,0.40)', dot: 'rgba(34,211,238,0.90)'  },
};

const SNAP_PRIORITY: Record<string, number> = {
  endpoint: 0, intersection: 1, midpoint: 2, centroid: 3,
};

function snapColour(type: string): { fill: string; ring: string; dot: string } {
  return SNAP_TYPE_COLOURS[type] ?? SNAP_TYPE_COLOURS['endpoint'];
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function isAngleBetweenCCW(start: number, mid: number, end: number): boolean {
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const s = norm(start), m = norm(mid), e = norm(end);
  if (s <= e) return m >= s && m <= e;
  return m >= s || m <= e;
}

function circumscribedCircleCanvas(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
): { cx: number; cy: number; r: number } | null {
  const ax = p1.x, ay = p1.y;
  const bx = p2.x, by = p2.y;
  const cx = p3.x, cy = p3.y;
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(D) < 1e-6) return null;
  const ux = (
    (ax * ax + ay * ay) * (by - cy) +
    (bx * bx + by * by) * (cy - ay) +
    (cx * cx + cy * cy) * (ay - by)
  ) / D;
  const uy = (
    (ax * ax + ay * ay) * (cx - bx) +
    (bx * bx + by * by) * (ax - cx) +
    (cx * cx + cy * cy) * (bx - ax)
  ) / D;
  const r = Math.hypot(ax - ux, ay - uy);
  return { cx: ux, cy: uy, r };
}

// ─── Snap helpers ─────────────────────────────────────────────────────────────

function findNearest(
  cursor:     { x: number; y: number },
  candidates: Array<{ x: number; y: number; type: string }>,
  proxRadius: number,
): { candidate: typeof candidates[0]; dist: number } | null {
  let nearest:    typeof candidates[0] | null = null;
  let nearestDist = Infinity;

  for (const c of candidates) {
    const dist = Math.hypot(cursor.x - c.x, cursor.y - c.y);
    if (dist > proxRadius) continue;

    const pri     = SNAP_PRIORITY[c.type] ?? 99;
    const nearPri = nearest ? (SNAP_PRIORITY[nearest.type] ?? 99) : 99;
    const tooClose = nearest !== null && Math.abs(dist - nearestDist) < 4;

    if (
      nearest === null ||
      (tooClose && pri < nearPri) ||
      (!tooClose && dist < nearestDist)
    ) {
      nearestDist = dist;
      nearest     = c;
    }
  }

  return nearest ? { candidate: nearest, dist: nearestDist } : null;
}

// ─── Draw helpers ─────────────────────────────────────────────────────────────

function drawSnapLockedDot(
  ctx:  CanvasRenderingContext2D,
  x:    number,
  y:    number,
  type: string,
  r:    number = 7,
): void {
  const col = snapColour(type);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = col.fill;
  ctx.fill();
  ctx.strokeStyle = 'white';
  ctx.lineWidth   = 2;
  ctx.stroke();
  const ch = r + 4;
  ctx.beginPath();
  ctx.moveTo(x - ch, y); ctx.lineTo(x + ch, y);
  ctx.moveTo(x, y - ch); ctx.lineTo(x, y + ch);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth   = 1;
  ctx.stroke();
  ctx.restore();
}

function drawFreeDot(
  ctx:   CanvasRenderingContext2D,
  x:     number,
  y:     number,
  r:     number = DOT_RADIUS,
  color: string = COLOUR_UNSNAPPED,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r + 4, 0, Math.PI * 2);
  ctx.fillStyle = `${color}20`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - 0.5, y - 0.5, r * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = `${color}cc`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - 1, y - 1, r * 0.2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r + 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.restore();
}

function drawPlacedDot(
  ctx:      CanvasRenderingContext2D,
  pt:       { x: number; y: number },
  srcPoint: InProgressPoint | undefined,
  overrideColor?: string,
): void {
  if (srcPoint?.snapped) {
    const snapType = (srcPoint as any).snapType ?? 'endpoint';
    drawSnapLockedDot(ctx, pt.x, pt.y, snapType, 7);
  } else {
    drawFreeDot(ctx, pt.x, pt.y, DOT_RADIUS, overrideColor ?? COLOUR_UNSNAPPED);
  }
}

function drawSnapProximityVisuals(
  ctx:           CanvasRenderingContext2D,
  cursor:        { x: number; y: number },
  candidates:    Array<{ x: number; y: number; type: string }>,
  snapThreshold: number,
  proxRadius:    number = PROX_RADIUS_PDF,
): boolean {
  if (!candidates.length) return false;

  const inRange = candidates
    .map(c => ({ c, dist: Math.hypot(cursor.x - c.x, cursor.y - c.y) }))
    .filter(({ dist }) => dist <= proxRadius);

  if (!inRange.length) return false;

  const nearestResult    = findNearest(cursor, candidates, proxRadius);
  const nearestCandidate = nearestResult?.candidate ?? null;
  const nearestDist      = nearestResult?.dist ?? Infinity;
  const isLocked         = nearestDist < snapThreshold;

  ctx.save();

  if (nearestCandidate) {
    const col  = snapColour(nearestCandidate.type);
    const fade = Math.max(0, 1 - nearestDist / proxRadius);

    if (isLocked) {
      const r  = 7;
      const ch = 11;
      ctx.beginPath();
      ctx.arc(nearestCandidate.x, nearestCandidate.y, r, 0, Math.PI * 2);
      ctx.fillStyle   = col.fill;
      ctx.globalAlpha = 1;
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth   = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(nearestCandidate.x - ch, nearestCandidate.y);
      ctx.lineTo(nearestCandidate.x + ch, nearestCandidate.y);
      ctx.moveTo(nearestCandidate.x, nearestCandidate.y - ch);
      ctx.lineTo(nearestCandidate.x, nearestCandidate.y + ch);
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    } else {
      const sz = 2.5 + fade * 4.5;
      const a  = 0.20 + fade * 0.65;
      ctx.strokeStyle = col.dot.replace(/[\d.]+\)$/, `${a.toFixed(2)})`);
      ctx.lineWidth   = 0.8 + fade * 0.8;
      ctx.beginPath();
      ctx.moveTo(nearestCandidate.x - sz, nearestCandidate.y);
      ctx.lineTo(nearestCandidate.x + sz, nearestCandidate.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(nearestCandidate.x, nearestCandidate.y - sz);
      ctx.lineTo(nearestCandidate.x, nearestCandidate.y + sz);
      ctx.stroke();
      if (fade > 0.35) {
        ctx.beginPath();
        ctx.arc(nearestCandidate.x, nearestCandidate.y, sz + 4, 0, Math.PI * 2);
        ctx.strokeStyle = col.ring.replace(/[\d.]+\)$/, `${(a * 0.35).toFixed(2)})`);
        ctx.lineWidth   = 0.8;
        ctx.stroke();
      }
    }
  }

  ctx.beginPath();
  ctx.arc(cursor.x, cursor.y, proxRadius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(100,100,100,0.08)';
  ctx.lineWidth   = 0.8;
  ctx.setLineDash([3, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  return isLocked;
}

function drawRadiusProximityCircle(
  ctx:        CanvasRenderingContext2D,
  cursor:     { x: number; y: number },
  candidates: Array<{ x: number; y: number; type: string }>,
  proxRadius: number = PROX_RADIUS_PDF,
): void {
  const result = findNearest(cursor, candidates, proxRadius);
  if (!result) return;
  const { dist } = result;
  const fade  = Math.max(0, 1 - dist / proxRadius);
  const alpha = fade * 0.50;
  const r     = 6 + fade * 10;
  const col   = snapColour(result.candidate.type);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cursor.x, cursor.y, r, 0, Math.PI * 2);
  ctx.fillStyle   = col.fill;
  ctx.globalAlpha = alpha;
  ctx.fill();
  ctx.globalAlpha = Math.min(1, alpha + 0.18);
  ctx.strokeStyle = col.fill;
  ctx.lineWidth   = 1;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawArcFromPoints(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
): void {
  if (pts.length !== 3) return;
  const arc = circumscribedCircleCanvas(pts[0], pts[1], pts[2]);
  if (!arc) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.stroke();
    return;
  }
  const a0  = Math.atan2(pts[0].y - arc.cy, pts[0].x - arc.cx);
  const a1  = Math.atan2(pts[1].y - arc.cy, pts[1].x - arc.cx);
  const a2  = Math.atan2(pts[2].y - arc.cy, pts[2].x - arc.cx);
  const ccw = !isAngleBetweenCCW(a0, a1, a2);
  ctx.beginPath();
  ctx.arc(arc.cx, arc.cy, arc.r, a0, a2, ccw);
  ctx.stroke();
}

function drawRect(
  ctx:      CanvasRenderingContext2D,
  p1:       { x: number; y: number },
  p2:       { x: number; y: number },
  dashed:   boolean,
  color:    string,
  fillAlpha = 0.08,
): void {
  const x = Math.min(p1.x, p2.x);
  const y = Math.min(p1.y, p2.y);
  const w = Math.abs(p2.x - p1.x);
  const h = Math.abs(p2.y - p1.y);
  if (w < 1 || h < 1) return;
  ctx.setLineDash(dashed ? DASH_ACTIVE : []);
  ctx.globalAlpha = fillAlpha;
  ctx.fillStyle   = color;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
}

// ─── drawCloseSnapHover ───────────────────────────────────────────────────────

function drawCloseSnapHover(
  ctx:     CanvasRenderingContext2D,
  startPt: { x: number; y: number },
  lastPt:  { x: number; y: number },
  cursor:  { x: number; y: number },
  fade:    number,
  colour:  string,
): void {
  ctx.save();

  // 1. Dashed closing segment (lastPt → startPt)
  ctx.beginPath();
  ctx.moveTo(lastPt.x, lastPt.y);
  ctx.lineTo(startPt.x, startPt.y);
  ctx.strokeStyle = colour;
  ctx.lineWidth   = LINE_WIDTH;
  ctx.setLineDash(DASH_PREVIEW);
  ctx.globalAlpha = 0.35 + fade * 0.45;
  ctx.stroke();
  ctx.setLineDash([]);

  // 2. Pulsing ring on the start point
  const outerR = DOT_RADIUS + 4 + (1 - fade) * 8;
  ctx.beginPath();
  ctx.arc(startPt.x, startPt.y, outerR, 0, Math.PI * 2);
  ctx.strokeStyle = colour;
  ctx.lineWidth   = 1.5;
  ctx.globalAlpha = fade * 0.65;
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Inner filled circle on start point
  ctx.beginPath();
  ctx.arc(startPt.x, startPt.y, DOT_RADIUS + 2, 0, Math.PI * 2);
  ctx.fillStyle   = colour;
  ctx.globalAlpha = 0.20 + fade * 0.60;
  ctx.fill();

  // 3. Solid snap dot — cursor appears to lock onto the start point
  ctx.beginPath();
  ctx.arc(startPt.x, startPt.y, DOT_RADIUS + 1, 0, Math.PI * 2);
  ctx.fillStyle   = colour;
  ctx.globalAlpha = 0.85 + fade * 0.15;
  ctx.fill();
  // White highlight
  ctx.beginPath();
  ctx.arc(startPt.x - 1, startPt.y - 1, DOT_RADIUS * 0.35, 0, Math.PI * 2);
  ctx.fillStyle   = 'rgba(255,255,255,0.85)';
  ctx.globalAlpha = fade * 0.9;
  ctx.fill();

  // 4. "close path" label
  ctx.globalAlpha  = 0.50 + fade * 0.50;
  ctx.fillStyle    = colour;
  ctx.font         = 'bold 10px monospace';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('close path', startPt.x, startPt.y - outerR - 4);

  ctx.globalAlpha  = 1;
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

// ─── Ghost circle preview (arc tool only) ────────────────────────────────────
function drawGhostCirclePreview(
  ctx:    CanvasRenderingContext2D,
  start:  { x: number; y: number },
  mid:    { x: number; y: number },
  fade:   number,
  colour: string,
): void {
  const cx = (start.x + mid.x) / 2;
  const cy = (start.y + mid.y) / 2;
  const r  = Math.hypot(mid.x - start.x, mid.y - start.y) / 2;
  if (r < 1) return;

  ctx.save();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.globalAlpha = fade * 0.07;
  ctx.fillStyle   = colour;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.globalAlpha = fade * 0.35;
  ctx.strokeStyle = colour;
  ctx.lineWidth   = LINE_WIDTH;
  ctx.setLineDash(DASH_PREVIEW);
  ctx.stroke();
  ctx.setLineDash([]);

  const ringR = DOT_RADIUS + 5 + (1 - fade) * 6;
  ctx.beginPath();
  ctx.arc(start.x, start.y, ringR, 0, 2 * Math.PI);
  ctx.globalAlpha = fade * 0.55;
  ctx.strokeStyle = colour;
  ctx.lineWidth   = 1.2;
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.globalAlpha  = fade * 0.85;
  ctx.fillStyle    = colour;
  ctx.font         = 'bold 10px monospace';
  ctx.textAlign    = 'center';
  ctx.fillText('close to circle', cx, cy - r - 10);

  ctx.globalAlpha = 1;
  ctx.restore();
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDrawingCanvas({
  drawingCanvasRef,
  pdfDimensionsRef,
  scaleRef,
  measurements,
  tempPoints,
  activeTool,
  scaleFactor,
  isPanning,
  pendingBreak,
  dragStateRef,
  cursorPointRef,
  snapToCorner,
  redrawPinCanvas,
  snapEnabledRef,
  snapCandidates = [],
  arcDragPreview,
  showLabels = false,
  selectedIdRef,
  extraSelectedRef,
  findHoverGeometry = null,
  findPinsNear = null,
}: UseDrawingCanvasParams): UseDrawingCanvasReturn {
  const pinsRef = useRef<{ x: number; y: number; type: string }[]>([]);
  const findPinsNearRef = useRef(findPinsNear);
  findPinsNearRef.current = findPinsNear;
  const hoverGeomRef = useRef<{ kind: string; pts: { x: number; y: number }[] } | null>(null);
  const findHoverGeometryRef = useRef(findHoverGeometry);
  findHoverGeometryRef.current = findHoverGeometry;
  // The cursor position is render-irrelevant (the canvas reads cursorPointRef),
  // so it lives in a ref. Previously this was useState, which re-rendered the
  // whole Viewer tree on every pointer move.
  const cursorStateRef = useRef<{ x: number; y: number } | null>(null);
  const setCursorPoint = useCallback<React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>>(
    (v) => {
      cursorStateRef.current = typeof v === 'function' ? v(cursorStateRef.current) : v;
      if (cursorStateRef.current === null) { hoverGeomRef.current = null; pinsRef.current = []; }   // pointer left / reset
    },
    [],
  );
  const cursorPoint = cursorStateRef.current;

  // Committed measurements are cached in an offscreen layer and only re-drawn
  // when the measurement list or canvas size changes; each frame just blits it.
  const committedLayerRef = useRef<{
    canvas: HTMLCanvasElement;
    measurements: TakeoffRow[];
    w: number; h: number; dw: number; dh: number;
    labels: boolean;
  } | null>(null);

  const lastCursorRef     = useRef<{ x: number; y: number } | null>(null);
  const snapCandidatesRef = useRef(snapCandidates);
  const arcDragPreviewRef = useRef(arcDragPreview);

  const nearStartPointRef = useRef<boolean>(false);
  /**
   * Stores NORMALISED { x, y } of the first placed point when nearStartPointRef
   * is true. Populated from nonSentinelPoints[0] (the raw InProgressPoint coords)
   * so no toNorm() conversion is required in useMeasurementCommit.
   */
  const startPointSnapRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => { snapCandidatesRef.current = snapCandidates; }, [snapCandidates]);
  useEffect(() => { arcDragPreviewRef.current = arcDragPreview ?? null; }, [arcDragPreview]);

  const snapThresholdRef = useRef(14);

  const moveRafRef          = useRef<number | null>(null);
  const pendingMovePointRef = useRef<{ x: number; y: number } | null>(null);
  const redrawRef           = useRef<(p?: { x: number; y: number }) => void>(() => {});
  const redrawPinRef        = useRef<() => void>(() => {});
  useEffect(() => () => {
    if (moveRafRef.current != null) cancelAnimationFrame(moveRafRef.current);
  }, []);

  const toCanvas = useCallback(
    (nx: number, ny: number): { x: number; y: number } => {
      const dim = pdfDimensionsRef.current;
      if (!dim) return { x: 0, y: 0 };
      return { x: nx * dim.w, y: ny * dim.h };
    },
    [pdfDimensionsRef],
  );

  const CLOSE_SNAP_TOOLS = new Set<ToolType>(['linear', 'polygon', 'polyarc']);

  // ─── MAIN DRAW FUNCTION ───────────────────────────────────────────────────
  const redrawDrawingCanvas = useCallback(
    (overrideCursor?: { x: number; y: number }) => {
      const canvas = drawingCanvasRef.current;
      const dim    = pdfDimensionsRef.current;
      if (!canvas || !dim) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const drawLabels = (ctx: CanvasRenderingContext2D) => {
        ctx.save();
        ctx.font = `600 11px ${canvasMonoFont()}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        for (const m of measurements) {
          if (m.isVisible === false || m.isGroupHeader || !m.points?.length) continue;
          if (m.type === 'Point') continue;
          const pts = m.points.map(p => toCanvas(p.x, p.y));
          let ax: number, ay: number;
          const closed = m.type === 'Area' || m.type === 'Polygon' || m.type === 'Rectangle';
          if (m.type === 'Count') {
            ax = pts[0].x; ay = pts[0].y - 22;
          } else if (closed) {
            ax = pts.reduce((a, p) => a + p.x, 0) / pts.length;
            ay = pts.reduce((a, p) => a + p.y, 0) / pts.length;
          } else {
            const i = Math.max(0, Math.floor((pts.length - 1) / 2));
            const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
            ax = (a.x + b.x) / 2; ay = (a.y + b.y) / 2 - 14;
          }
          const q = Number.isFinite(m.quantity) ? m.quantity : 0;
          const text = `${q.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: m.type === 'Count' ? 0 : 2 })} ${m.unit ?? ''}`.trim();
          const w = ctx.measureText(text).width + 10;
          ctx.fillStyle = 'rgba(29,33,37,0.88)';
          ctx.fillRect(ax - w / 2, ay - 9, w, 18);
          ctx.fillStyle = m.color || '#F2C230';
          ctx.fillRect(ax - w / 2, ay - 9, 2, 18);
          ctx.fillStyle = '#F4F5F6';
          ctx.fillText(text, ax + 1, ay + 0.5);
        }
        ctx.restore();
      };

      const drawCommitted = (ctx: CanvasRenderingContext2D) => {
      for (const m of measurements) {
        if (!m.isVisible || !m.points?.length) continue;
        const pts = m.points.map(p => toCanvas(p.x, p.y));
        const col = m.color ?? COLOUR_ACTIVE;

        ctx.save();
        ctx.strokeStyle = col;
        ctx.fillStyle   = col;
        ctx.lineWidth   = COMMITTED_LINE_WIDTH;
        ctx.globalAlpha = COMMITTED_ALPHA;

        const isArcRow    = m.arcRadius != null && Math.abs((m.sweepAngle ?? 0) - 2 * Math.PI) > 0.01;
        const isRadiusRow = m.arcRadius != null && Math.abs((m.sweepAngle ?? 0) - 2 * Math.PI) < 0.01;

        if (isArcRow && pts.length === 3) {
          ctx.lineWidth = COMMITTED_LINE_WIDTH;
          drawArcFromPoints(ctx, pts);
        } else if (isRadiusRow && pts.length === 2) {
          const r = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
          ctx.lineWidth = COMMITTED_LINE_WIDTH;
          ctx.beginPath();
          ctx.arc(pts[0].x, pts[0].y, r, 0, 2 * Math.PI);
          ctx.stroke();
          ctx.globalAlpha = 0.12;
          ctx.fill();
          ctx.globalAlpha = COMMITTED_ALPHA * 0.5;
          ctx.lineWidth   = 1.5;
          ctx.beginPath();
          ctx.moveTo(pts[0].x - 5, pts[0].y); ctx.lineTo(pts[0].x + 5, pts[0].y);
          ctx.moveTo(pts[0].x, pts[0].y - 5); ctx.lineTo(pts[0].x, pts[0].y + 5);
          ctx.stroke();
        } else if (m.type === 'Rectangle' && pts.length === 4) {
          ctx.lineWidth = COMMITTED_LINE_WIDTH;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
          ctx.stroke();
          ctx.globalAlpha = 0.14;
          ctx.fill();
        } else if (m.type === 'Length') {
          ctx.lineWidth = COMMITTED_LINE_WIDTH;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.stroke();
        } else if (m.type === 'Polygon' || m.type === 'Area') {
          ctx.lineWidth = COMMITTED_LINE_WIDTH;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
          // Cut-outs: left unfilled, outlined like the edge.
          for (const hole of m.holes ?? []) {
            if (hole.length < 3) continue;
            hole.forEach((q, i) => { const c = toCanvas(q.x, q.y); if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y); });
            ctx.closePath();
          }
          ctx.globalAlpha = 0.17;
          ctx.fill('evenodd');
          ctx.globalAlpha = COMMITTED_ALPHA;
          ctx.stroke();
        }

        ctx.restore();
      }
      };

      const cursor =
        overrideCursor ??
        cursorPointRef.current ??
        lastCursorRef.current;

      // ── Committed measurements (cached layer) ─────────────────────────────
      const MAX_LAYER_PIXELS = 16_000_000; // skip caching for enormous canvases
      if (canvas.width * canvas.height <= MAX_LAYER_PIXELS) {
        let layer = committedLayerRef.current;
        const stale =
          !layer ||
          layer.measurements !== measurements ||
          layer.w !== canvas.width || layer.h !== canvas.height ||
          layer.dw !== dim.w || layer.dh !== dim.h ||
          layer.labels !== showLabels;
        if (stale) {
          const off = layer?.canvas ?? document.createElement('canvas');
          if (off.width !== canvas.width || off.height !== canvas.height) {
            off.width = canvas.width; off.height = canvas.height;
          }
          const octx = off.getContext('2d');
          if (octx) {
            octx.clearRect(0, 0, off.width, off.height);
            drawCommitted(octx);
            if (showLabels) drawLabels(octx);
          }
          layer = { canvas: off, measurements, w: canvas.width, h: canvas.height, dw: dim.w, dh: dim.h, labels: showLabels };
          committedLayerRef.current = layer;
        }
        ctx.drawImage(layer!.canvas, 0, 0);
      } else {
        committedLayerRef.current = null;
        drawCommitted(ctx);
        if (showLabels) drawLabels(ctx);
      }

      // ── PINS: snap points near the cursor, colour-coded by type ──────────
      if (findPinsNearRef.current && pinsRef.current.length) {
        ctx.save();
        for (const p of pinsRef.current) {
          const col = PIN_COLOURS[p.type] ?? '#a1a1aa';
          ctx.fillStyle = col;
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (p.type === 'intersection') {        // diamond
            ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x + 4, p.y); ctx.lineTo(p.x, p.y + 4); ctx.lineTo(p.x - 4, p.y); ctx.closePath();
          } else if (p.type === 'midpoint') {     // triangle
            ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x + 4, p.y + 3); ctx.lineTo(p.x - 4, p.y + 3); ctx.closePath();
          } else {                                // dot
            ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
          }
          ctx.fill(); ctx.stroke();
        }
        ctx.restore();
      }

      // ── PDF line / arc under the cursor (what you're about to snap to) ────
      const hv = hoverGeomRef.current;
      if (hv && hv.pts.length >= 2) {
        ctx.save();
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        hv.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.strokeStyle = 'rgba(56,189,248,0.25)'; ctx.lineWidth = 7; ctx.stroke();
        ctx.strokeStyle = 'rgba(56,189,248,0.95)'; ctx.lineWidth = 2; ctx.stroke();
        for (const p of [hv.pts[0], hv.pts[hv.pts.length - 1]]) {
          ctx.fillStyle = '#38bdf8';
          ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
        }
        ctx.restore();
      }

      // ── Selection outline (per frame, cheap: one shape) ───────────────────
      const selIds = [selectedIdRef?.current, ...(extraSelectedRef?.current ?? [])].filter(Boolean) as string[];
      let selNo = 0;
      const selCount = new Set(selIds).size;
      for (const selId of new Set(selIds)) {
        const sel = measurements.find(m => m.id === selId);
        selNo += 1;
        if (sel && sel.isVisible !== false && sel.points?.length) {
          // Curves are stored as three-point arcs between markers: follow the real curve
          // for the highlight, and keep only the real corners for the handles.
          const dim = pdfDimensionsRef.current;
          const corners = sel.points.filter(p => !isSentinel(p)).map(p => toCanvas(p.x, p.y));
          const hasArcs = sel.points.some(isSentinel);
          const fullCircle = sel.arcRadius != null && Math.abs((sel.sweepAngle ?? 0) - 2 * Math.PI) < 0.01;
          let pts = hasArcs
            ? tessellatePoints(sel.points, dim?.w ?? 1, dim?.h ?? 1).map(p => toCanvas(p.x, p.y))
            : corners;
          if (sel.arcRadius != null && !fullCircle && corners.length === 3) {
            // A single arc: start, a point on the curve, end.
            pts = tessellateArc(corners[0], corners[1], corners[2], 3);
          } else if (fullCircle && corners.length === 2) {
            // A circle: centre and a point on the edge.
            const r = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
            pts = Array.from({ length: 73 }, (_, i) => ({
              x: corners[0].x + r * Math.cos((i / 72) * Math.PI * 2), y: corners[0].y + r * Math.sin((i / 72) * Math.PI * 2),
            }));
          }
          const closed = sel.type === 'Area' || sel.type === 'Polygon' || sel.type === 'Rectangle';
          ctx.save();
          if (pts.length === 1 || sel.type === 'Count' || sel.type === 'Point') {
            for (const p of corners) {
              ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
              ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(242,194,48,0.95)'; ctx.stroke();
            }
          } else if (closed) {
            // Areas: a square grid over the shape marks it as selected (no
            // outline, no dots — the shape's own edge stays as it is).
            ctx.beginPath();
            pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
            ctx.closePath();
            for (const hole of sel.holes ?? []) {
              hole.forEach((q, i) => { const c = toCanvas(q.x, q.y); if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y); });
              ctx.closePath();
            }
            ctx.clip('evenodd');
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
            const step = 12;
            ctx.fillStyle = 'rgba(242,194,48,0.10)';
            ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
            ctx.beginPath();
            for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { ctx.moveTo(x + 0.5, y0); ctx.lineTo(x + 0.5, y1); }
            for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) { ctx.moveTo(x0, y + 0.5); ctx.lineTo(x1, y + 0.5); }
            ctx.lineWidth = 1; ctx.setLineDash([]);
            ctx.strokeStyle = 'rgba(40,44,52,0.55)';
            ctx.stroke();
          } else {
            // Lines: dashed highlight along the line, with its points.
            ctx.beginPath();
            pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
            ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(242,194,48,0.28)'; ctx.stroke();
            ctx.lineWidth = 2;  ctx.setLineDash([8, 5]); ctx.strokeStyle = 'rgba(242,194,48,1)'; ctx.stroke();
            if (selCount === 1 && !(sel.arcRadius != null)) {
              ctx.setLineDash([]);
              for (const p of corners) {
                ctx.fillStyle = '#1d2125'; ctx.strokeStyle = 'rgba(242,194,48,1)'; ctx.lineWidth = 1.5;
                ctx.fillRect(p.x - 3.5, p.y - 3.5, 7, 7); ctx.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7);
              }
            }
          }
          ctx.restore();
        }
      }

      const candidates = snapCandidatesRef.current;

      if (tempPoints.length === 0 && !cursor) return;

      const nonSentinelPoints = tempPoints.filter(
        p => !isArcSentinel(p) && !isRadiusSentinel(p)
      );
      const tPts = nonSentinelPoints.map(p => toCanvas(p.x, p.y));

      // ── Compute close-snap state for path tools ───────────────────────────
      let effectiveCursor = cursor;
      let closeSnapActive = false;
      let closeSnapFade   = 0;

      if (
        cursor &&
        CLOSE_SNAP_TOOLS.has(activeTool) &&
        tPts.length >= 2
      ) {
        const startPt      = tPts[0];
        const distToStart  = Math.hypot(cursor.x - startPt.x, cursor.y - startPt.y);
        closeSnapActive    = distToStart < CLOSE_SNAP_THRESHOLD;
        closeSnapFade      = closeSnapActive
          ? Math.max(0, 1 - distToStart / CLOSE_SNAP_THRESHOLD)
          : 0;

        if (closeSnapActive) {
          effectiveCursor = startPt;
          nearStartPointRef.current = true;
          // ── KEY FIX: store NORMALISED coords, not canvas-pixel coords ──────
          // nonSentinelPoints[0] holds the raw InProgressPoint whose .x/.y are
          // already in normalised 0-1 space. useMeasurementCommit uses these
          // directly as the closing vertex — no toNorm() conversion required.
          startPointSnapRef.current = {
            x: nonSentinelPoints[0].x,
            y: nonSentinelPoints[0].y,
          };
        } else {
          nearStartPointRef.current = false;
          startPointSnapRef.current = null;
        }
      } else {
        nearStartPointRef.current = false;
        startPointSnapRef.current = null;
      }

      // ── ARC TOOL ──────────────────────────────────────────────────────────
      if (activeTool === 'arc') {
        ctx.save();
        const arcGroups       = splitArcPoints(tempPoints);
        const inProgressGroup = arcGroups[arcGroups.length - 1];
        const stagedGroups    = arcGroups.slice(0, -1).filter(g => g.length === 3);

        if (stagedGroups.length > 0) {
          ctx.strokeStyle = COLOUR_ARC_STAGED;
          ctx.lineWidth   = LINE_WIDTH + 0.5;
          ctx.setLineDash([]);
          ctx.globalAlpha = 0.85;
          for (const group of stagedGroups) {
            const cPts = group.map(p => toCanvas(p.x, p.y));
            drawArcFromPoints(ctx, cPts);
          }
          ctx.globalAlpha = 1;
          for (const group of stagedGroups) {
            const cPts = group.map(p => toCanvas(p.x, p.y));
            cPts.forEach((pt, i) => drawPlacedDot(ctx, pt, group[i], COLOUR_ARC_STAGED));
          }
        }

        const ipPts = inProgressGroup.map(p => toCanvas(p.x, p.y));
        ctx.strokeStyle = COLOUR_ARC;
        ctx.lineWidth   = LINE_WIDTH;

        if (ipPts.length === 1 && cursor) {
          ctx.setLineDash(DASH_PREVIEW);
          ctx.beginPath();
          ctx.moveTo(ipPts[0].x, ipPts[0].y);
          ctx.lineTo(cursor.x, cursor.y);
          ctx.stroke();
          ctx.setLineDash([]);

        } else if (ipPts.length === 2 && cursor) {
          const distToStart = Math.hypot(cursor.x - ipPts[0].x, cursor.y - ipPts[0].y);
          const nearStart   = distToStart < CLOSE_SNAP_THRESHOLD;

          if (nearStart) {
            const fade = Math.max(0, 1 - distToStart / CLOSE_SNAP_THRESHOLD);
            drawGhostCirclePreview(ctx, ipPts[0], ipPts[1], fade, COLOUR_ARC);
            drawFreeDot(ctx, ipPts[0].x, ipPts[0].y, DOT_RADIUS + 2 * fade, COLOUR_ARC);
            drawFreeDot(ctx, ipPts[1].x, ipPts[1].y, DOT_RADIUS, COLOUR_ARC);
            ctx.fillStyle = COLOUR_ARC;
            ctx.font      = 'bold 9px monospace';
            ctx.fillText('①', ipPts[0].x + 6, ipPts[0].y - 4);
            ctx.fillText('②', ipPts[1].x + 6, ipPts[1].y - 4);
          } else {
            const arc = circumscribedCircleCanvas(ipPts[0], ipPts[1], cursor);
            ctx.setLineDash(DASH_PREVIEW);
            if (arc && arc.r < dim.w * 10) {
              const a0  = Math.atan2(ipPts[0].y - arc.cy, ipPts[0].x - arc.cx);
              const a1  = Math.atan2(ipPts[1].y  - arc.cy, ipPts[1].x  - arc.cx);
              const a2  = Math.atan2(cursor.y     - arc.cy, cursor.x    - arc.cx);
              const ccw = !isAngleBetweenCCW(a0, a1, a2);
              ctx.beginPath();
              ctx.arc(arc.cx, arc.cy, arc.r, a0, a2, ccw);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.globalAlpha = 0.2;
              ctx.fillStyle   = COLOUR_ARC;
              ctx.beginPath();
              ctx.arc(arc.cx, arc.cy, 3, 0, 2 * Math.PI);
              ctx.fill();
              ctx.globalAlpha = 1;
            } else {
              ctx.beginPath();
              ctx.moveTo(ipPts[0].x, ipPts[0].y);
              ctx.lineTo(cursor.x, cursor.y);
              ctx.stroke();
            }
            ctx.setLineDash([]);
            ipPts.forEach((pt, i) => {
              drawPlacedDot(ctx, pt, inProgressGroup[i], COLOUR_ARC);
              ctx.fillStyle = COLOUR_ARC;
              ctx.font      = 'bold 9px monospace';
              ctx.fillText(['①', '②', '③'][i] ?? `${i + 1}`, pt.x + 6, pt.y - 4);
            });
          }
        } else {
          ctx.setLineDash([]);
          ipPts.forEach((pt, i) => {
            drawPlacedDot(ctx, pt, inProgressGroup[i], COLOUR_ARC);
            ctx.fillStyle = COLOUR_ARC;
            ctx.font      = 'bold 9px monospace';
            ctx.fillText(['①', '②', '③'][i] ?? `${i + 1}`, pt.x + 6, pt.y - 4);
          });
        }

        if (stagedGroups.length > 0) {
          const firstPt = toCanvas(stagedGroups[0][0].x, stagedGroups[0][0].y);
          ctx.fillStyle   = COLOUR_ARC_STAGED;
          ctx.font        = 'bold 9px monospace';
          ctx.globalAlpha = 0.9;
          ctx.fillText(`${stagedGroups.length} arc${stagedGroups.length > 1 ? 's' : ''} staged`, firstPt.x, firstPt.y - 10);
          ctx.globalAlpha = 1;
        }

        ctx.restore();

        if (cursor) {
          const locked = drawSnapProximityVisuals(ctx, cursor, candidates, snapThresholdRef.current);
          if (!locked) {
            ctx.save();
            ctx.strokeStyle = COLOUR_ARC;
            ctx.lineWidth   = 1;
            ctx.beginPath();
            ctx.arc(cursor.x, cursor.y, DOT_RADIUS, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.restore();
          }
        }
        return;
      }

      // ── RADIUS TOOL ────────────────────────────────────────────────────────
      if (activeTool === 'radius') {
        ctx.save();

        const radiusGroups    = splitRadiusPoints(tempPoints);
        const stagedCircles   = radiusGroups.slice(0, -1).filter(g => g.length === 2);
        const inProgressGroup = radiusGroups[radiusGroups.length - 1];
        const ipPts           = inProgressGroup.map(p => toCanvas(p.x, p.y));

        if (stagedCircles.length > 0) {
          ctx.strokeStyle = COLOUR_RADIUS_STAGED;
          ctx.lineWidth   = LINE_WIDTH + 0.5;
          ctx.setLineDash([]);

          for (const circle of stagedCircles) {
            const [centre, edge] = circle.map(p => toCanvas(p.x, p.y));
            const r = Math.hypot(edge.x - centre.x, edge.y - centre.y);
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.arc(centre.x, centre.y, r, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.globalAlpha = 0.1;
            ctx.fillStyle   = COLOUR_RADIUS_STAGED;
            ctx.fill();
            ctx.globalAlpha = 0.85;
            ctx.strokeStyle = COLOUR_RADIUS_STAGED;
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            ctx.moveTo(centre.x - 6, centre.y); ctx.lineTo(centre.x + 6, centre.y);
            ctx.moveTo(centre.x, centre.y - 6); ctx.lineTo(centre.x, centre.y + 6);
            ctx.stroke();
            ctx.globalAlpha = 1;
            drawPlacedDot(ctx, centre, circle[0], COLOUR_RADIUS_STAGED);
          }

          const firstCentre = toCanvas(stagedCircles[0][0].x, stagedCircles[0][0].y);
          ctx.fillStyle   = COLOUR_RADIUS_STAGED;
          ctx.font        = 'bold 9px monospace';
          ctx.globalAlpha = 0.9;
          ctx.fillText(
            `${stagedCircles.length} circle${stagedCircles.length > 1 ? 's' : ''} staged`,
            firstCentre.x, firstCentre.y - 10,
          );
          ctx.globalAlpha = 1;
        }

        ctx.strokeStyle = COLOUR_RADIUS;
        ctx.lineWidth   = LINE_WIDTH;

        if (ipPts.length === 1 && cursor) {
          const centre = ipPts[0];
          const r = Math.hypot(cursor.x - centre.x, cursor.y - centre.y);
          ctx.setLineDash(DASH_PREVIEW);
          ctx.beginPath();
          ctx.moveTo(centre.x, centre.y);
          ctx.lineTo(cursor.x, cursor.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(centre.x, centre.y, r, 0, 2 * Math.PI);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 0.12;
          ctx.fillStyle   = COLOUR_RADIUS;
          ctx.fill();
          ctx.globalAlpha = 1;
          const midX  = (centre.x + cursor.x) / 2;
          const midY  = (centre.y + cursor.y) / 2;
          const realR = (r / dim.w) * scaleFactor;
          ctx.fillStyle = COLOUR_RADIUS;
          ctx.font      = 'bold 9px monospace';
          ctx.fillText(`r=${realR.toFixed(3)}m`, midX + 4, midY - 4);
          ctx.globalAlpha = 0.6;
          ctx.strokeStyle = COLOUR_RADIUS;
          ctx.beginPath();
          ctx.moveTo(centre.x - 6, centre.y); ctx.lineTo(centre.x + 6, centre.y);
          ctx.moveTo(centre.x, centre.y - 6); ctx.lineTo(centre.x, centre.y + 6);
          ctx.stroke();
          ctx.globalAlpha = 1;
          drawPlacedDot(ctx, centre, inProgressGroup[0], COLOUR_RADIUS);
        }

        ctx.setLineDash([]);
        ctx.restore();

        if (cursor) {
          drawRadiusProximityCircle(ctx, cursor, candidates, PROX_RADIUS_PDF);
          drawSnapProximityVisuals(ctx, cursor, candidates, snapThresholdRef.current);
        }
        return;
      }

      // ── POLYARC TOOL ──────────────────────────────────────────────────────
      if (activeTool === 'polyarc') {
        ctx.save();

        const allArcPts = tempPoints.filter(p => !isArcSentinel(p) && !isRadiusSentinel(p));

        const segments = splitPolyarcSegments(tempPoints);
        for (const seg of segments) {
          if (seg.type === 'line') {
            const pts = seg.points.map(p => toCanvas(p.x, p.y));
            if (pts.length < 2) continue;
            ctx.strokeStyle = COLOUR_POLYARC_LINE;
            ctx.lineWidth   = LINE_WIDTH;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
            pts.forEach((pt, i) => drawPlacedDot(ctx, pt, seg.points[i], COLOUR_POLYARC_LINE));
          } else {
            const pts = seg.points.map(p => toCanvas(p.x, p.y));
            ctx.strokeStyle = COLOUR_POLYARC_ARC;
            ctx.lineWidth   = LINE_WIDTH;
            ctx.setLineDash([]);
            drawArcFromPoints(ctx, pts);
            pts.forEach((pt, i) => drawPlacedDot(ctx, pt, seg.points[i], COLOUR_POLYARC_ARC));
          }
        }

        const totalArcPts     = allArcPts.filter(p => p.segmentType === 'arc');
        const completedArcPts = segments.filter(s => s.type === 'arc').length * 3;
        const arcRunLen       = totalArcPts.length - completedArcPts;

        const lastPlaced = (() => {
          for (let i = allArcPts.length - 1; i >= 0; i--) {
            return toCanvas(allArcPts[i].x, allArcPts[i].y);
          }
          return null;
        })();

        // ── PASS 1: Arc preview — always drawn when cursor exists ─────────────
        if (cursor && lastPlaced) {
          const dragPrev = arcDragPreviewRef.current;
          if (dragPrev) {
            const startC = dragPrev.start;
            const midC   = dragPrev.mid;
            const endC   = dragPrev.end;
            const arc    = circumscribedCircleCanvas(startC, midC, endC);
            ctx.strokeStyle = COLOUR_POLYARC_ARC;
            ctx.lineWidth   = LINE_WIDTH;
            ctx.setLineDash(DASH_PREVIEW);
            if (arc && arc.r < dim.w * 10) {
              const a0  = Math.atan2(startC.y - arc.cy, startC.x - arc.cx);
              const a1  = Math.atan2(midC.y   - arc.cy, midC.x   - arc.cx);
              const a2  = Math.atan2(endC.y   - arc.cy, endC.x   - arc.cx);
              const ccw = !isAngleBetweenCCW(a0, a1, a2);
              ctx.beginPath();
              ctx.arc(arc.cx, arc.cy, arc.r, a0, a2, ccw);
              ctx.stroke();
            } else if (arc === null) {
              ctx.beginPath();
              ctx.moveTo(startC.x, startC.y);
              ctx.lineTo(endC.x, endC.y);
              ctx.stroke();
            }
            ctx.setLineDash([]);
          } else {
            if (arcRunLen === 0) {
              const lastPtType = allArcPts.length > 0
                ? (allArcPts[allArcPts.length - 1].segmentType ?? 'line')
                : 'line';
              const lineColor = lastPtType === 'arc' ? COLOUR_POLYARC_ARC : COLOUR_POLYARC_LINE;
              ctx.strokeStyle = lineColor;
              ctx.lineWidth   = LINE_WIDTH;
              ctx.setLineDash(DASH_ACTIVE);
              ctx.beginPath();
              ctx.moveTo(lastPlaced.x, lastPlaced.y);
              ctx.lineTo((effectiveCursor ?? cursor).x, (effectiveCursor ?? cursor).y);
              ctx.stroke();
              ctx.setLineDash([]);
            } else if (arcRunLen === 1) {
              ctx.strokeStyle = COLOUR_POLYARC_ARC;
              ctx.lineWidth   = LINE_WIDTH;
              ctx.setLineDash(DASH_ACTIVE);
              ctx.beginPath();
              ctx.moveTo(lastPlaced.x, lastPlaced.y);
              ctx.lineTo(cursor.x, cursor.y);
              ctx.stroke();
              ctx.setLineDash([]);
            } else if (arcRunLen === 2) {
              const inProgressArcPts: { x: number; y: number }[] = [];
              for (let i = allArcPts.length - 1; i >= 0 && inProgressArcPts.length < 2; i--) {
                if (allArcPts[i].segmentType === 'arc') {
                  inProgressArcPts.unshift(toCanvas(allArcPts[i].x, allArcPts[i].y));
                }
              }
              if (inProgressArcPts.length === 2) {
                const arc = circumscribedCircleCanvas(inProgressArcPts[0], inProgressArcPts[1], cursor);
                ctx.strokeStyle = COLOUR_POLYARC_ARC;
                ctx.lineWidth   = LINE_WIDTH;
                ctx.setLineDash(DASH_PREVIEW);
                if (arc && arc.r < dim.w * 10) {
                  const a0  = Math.atan2(inProgressArcPts[0].y - arc.cy, inProgressArcPts[0].x - arc.cx);
                  const a2  = Math.atan2(cursor.y               - arc.cy, cursor.x              - arc.cx);
                  const a1  = Math.atan2(inProgressArcPts[1].y - arc.cy, inProgressArcPts[1].x - arc.cx);
                  const ccw = !isAngleBetweenCCW(a0, a1, a2);
                  ctx.beginPath();
                  ctx.arc(arc.cx, arc.cy, arc.r, a0, a2, ccw);
                  ctx.stroke();
                } else {
                  ctx.beginPath();
                  ctx.moveTo(inProgressArcPts[0].x, inProgressArcPts[0].y);
                  ctx.lineTo(cursor.x, cursor.y);
                  ctx.stroke();
                }
                ctx.setLineDash([]);
              }
            }
          }
        }

        // ── PASS 2: Close-snap hover — drawn on top of arc preview ────────────
        if (closeSnapActive && tPts.length >= 2 && cursor && lastPlaced) {
          drawCloseSnapHover(ctx, tPts[0], lastPlaced, cursor, closeSnapFade, COLOUR_POLYARC_LINE);
        }

        if (arcRunLen > 0) {
          const inProgArcDots = totalArcPts.slice(completedArcPts);
          inProgArcDots.forEach(p => {
            const c = toCanvas(p.x, p.y);
            drawPlacedDot(ctx, c, p, COLOUR_POLYARC_ARC);
          });
        }

        ctx.restore();

        if (cursor) {
          if (!closeSnapActive) {
            const locked = drawSnapProximityVisuals(ctx, cursor, candidates, snapThresholdRef.current);
            if (!locked) drawFreeDot(ctx, cursor.x, cursor.y);
          }
        }
        return;
      }

      // ── GRID-COUNT TOOL ───────────────────────────────────────────────────
      if (activeTool === 'grid-count') return;

      // ── LINEAR TOOL ───────────────────────────────────────────────────────
      if (activeTool === 'linear') {
        if (tPts.length === 0) {
          if (cursor) {
            const locked = drawSnapProximityVisuals(ctx, cursor, candidates, snapThresholdRef.current);
            if (!locked) drawFreeDot(ctx, cursor.x, cursor.y);
          }
          return;
        }

        ctx.save();
        ctx.strokeStyle = COLOUR_ACTIVE;
        ctx.lineWidth   = LINE_WIDTH;

        ctx.beginPath();
        ctx.moveTo(tPts[0].x, tPts[0].y);
        for (let i = 1; i < tPts.length; i++) ctx.lineTo(tPts[i].x, tPts[i].y);
        ctx.stroke();

        if (effectiveCursor) {
          ctx.setLineDash(DASH_ACTIVE);
          const last = tPts[tPts.length - 1];
          ctx.beginPath();
          ctx.moveTo(last.x, last.y);
          ctx.lineTo(effectiveCursor.x, effectiveCursor.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        tPts.forEach((pt, i) => drawPlacedDot(ctx, pt, nonSentinelPoints[i]));

        if (pendingBreak && tPts.length > 0) {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#F87171';
          ctx.lineWidth   = 1;
          const last = tPts[tPts.length - 1];
          ctx.beginPath();
          ctx.moveTo(last.x - 8, last.y); ctx.lineTo(last.x + 8, last.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        ctx.restore();

        if (closeSnapActive && tPts.length >= 2 && cursor) {
          drawCloseSnapHover(ctx, tPts[0], tPts[tPts.length - 1], cursor, closeSnapFade, COLOUR_ACTIVE);
        } else if (cursor) {
          const locked = drawSnapProximityVisuals(ctx, cursor, candidates, snapThresholdRef.current);
          if (!locked) drawFreeDot(ctx, cursor.x, cursor.y);
        }
        return;
      }

      // ── RECTANGLE TOOL ────────────────────────────────────────────────────
      if (activeTool === 'rectangle') {
        ctx.save();
        ctx.strokeStyle = COLOUR_ACTIVE;
        ctx.lineWidth   = LINE_WIDTH;

        const segs: InProgressPoint[][] = [];
        let curSeg: InProgressPoint[]   = [];
        let curSegId: string | undefined;
        for (const p of tempPoints) {
          if (isArcSentinel(p) || isRadiusSentinel(p)) continue;
          const id = p.segmentId || 'default';
          if (curSegId !== undefined && id !== curSegId) {
            segs.push(curSeg);
            curSeg = [];
          }
          curSeg.push(p);
          curSegId = id;
        }
        if (curSeg.length) segs.push(curSeg);

        for (const seg of segs) {
          if (seg.length !== 2) continue;
          const p1c = toCanvas(seg[0].x, seg[0].y);
          const p2c = toCanvas(seg[1].x, seg[1].y);
          drawRect(ctx, p1c, p2c, false, COLOUR_ACTIVE, 0.12);
          drawPlacedDot(ctx, p1c, seg[0]);
          drawPlacedDot(ctx, p2c, seg[1]);
        }

        const inProgressSeg = segs.find(s => s.length === 1);
        if (inProgressSeg && cursor) {
          const p1c = toCanvas(inProgressSeg[0].x, inProgressSeg[0].y);
          drawRect(ctx, p1c, cursor, true, COLOUR_ACTIVE, 0.08);
          drawPlacedDot(ctx, p1c, inProgressSeg[0]);
        }

        ctx.restore();

        if (cursor) {
          const locked = drawSnapProximityVisuals(ctx, cursor, candidates, snapThresholdRef.current);
          if (!locked) drawFreeDot(ctx, cursor.x, cursor.y);
        }
        return;
      }

      // ── POLYGON TOOL ──────────────────────────────────────────────────────
      if (activeTool === 'polygon') {
        if (tPts.length === 0) {
          if (cursor) {
            const locked = drawSnapProximityVisuals(ctx, cursor, candidates, snapThresholdRef.current);
            if (!locked) drawFreeDot(ctx, cursor.x, cursor.y);
          }
          return;
        }

        ctx.save();
        ctx.strokeStyle = COLOUR_ACTIVE;
        ctx.lineWidth   = LINE_WIDTH;

        ctx.beginPath();
        ctx.moveTo(tPts[0].x, tPts[0].y);
        for (let i = 1; i < tPts.length; i++) ctx.lineTo(tPts[i].x, tPts[i].y);

        if (effectiveCursor && tPts.length > 1) {
          ctx.setLineDash(DASH_ACTIVE);
          ctx.lineTo(effectiveCursor.x, effectiveCursor.y);
          if (!closeSnapActive) {
            ctx.lineTo(tPts[0].x, tPts[0].y);
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);

        if (tPts.length > 2) {
          ctx.globalAlpha = 0.08;
          ctx.fillStyle   = COLOUR_ACTIVE;
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        tPts.forEach((pt, i) => drawPlacedDot(ctx, pt, nonSentinelPoints[i]));

        ctx.restore();

        if (closeSnapActive && tPts.length >= 2 && cursor) {
          drawCloseSnapHover(ctx, tPts[0], tPts[tPts.length - 1], cursor, closeSnapFade, COLOUR_ACTIVE);
        } else if (cursor) {
          const locked = drawSnapProximityVisuals(ctx, cursor, candidates, snapThresholdRef.current);
          if (!locked) drawFreeDot(ctx, cursor.x, cursor.y);
        }
        return;
      }

      // ── COUNT TOOL ────────────────────────────────────────────────────────
      if (activeTool === 'count') {
        ctx.save();
        tPts.forEach((pt, idx) => {
          ctx.fillStyle   = COLOUR_ACTIVE;
          ctx.strokeStyle = '#000';
          ctx.lineWidth   = 0.5;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 6, 0, 2 * Math.PI);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle    = '#000';
          ctx.font         = 'bold 7px monospace';
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(idx + 1), pt.x, pt.y);
        });
        ctx.restore();

        if (cursor) {
          const locked = drawSnapProximityVisuals(ctx, cursor, candidates, snapThresholdRef.current);
          if (!locked) drawFreeDot(ctx, cursor.x, cursor.y);
        }
        return;
      }

      // ── POINT TOOL ────────────────────────────────────────────────────────
      if (activeTool === 'point') {
        ctx.save();
        tPts.forEach(pt => {
          ctx.fillStyle = COLOUR_ACTIVE;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 5, 0, 2 * Math.PI);
          ctx.fill();
        });
        ctx.restore();

        if (cursor) {
          const locked = drawSnapProximityVisuals(ctx, cursor, candidates, snapThresholdRef.current);
          if (!locked) drawFreeDot(ctx, cursor.x, cursor.y);
        }
        return;
      }

      // ── SCALE TOOL ────────────────────────────────────────────────────────
      if (activeTool === 'scale') {
        if (tPts.length === 0) {
          if (cursor) drawFreeDot(ctx, cursor.x, cursor.y, DOT_RADIUS, '#FBBF24');
          return;
        }

        ctx.save();
        ctx.strokeStyle = '#FBBF24';
        ctx.lineWidth   = 2;
        ctx.setLineDash([8, 4]);

        if (tPts.length === 1 && cursor) {
          ctx.beginPath();
          ctx.moveTo(tPts[0].x, tPts[0].y);
          ctx.lineTo(cursor.x, cursor.y);
          ctx.stroke();
        } else if (tPts.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(tPts[0].x, tPts[0].y);
          ctx.lineTo(tPts[1].x, tPts[1].y);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        tPts.slice(0, 2).forEach(pt => {
          ctx.fillStyle = '#FBBF24';
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 5, 0, 2 * Math.PI);
          ctx.fill();
        });

        if (cursor) drawFreeDot(ctx, cursor.x, cursor.y, DOT_RADIUS, '#FBBF24');
        ctx.restore();
        return;
      }
    },
    [
      drawingCanvasRef, pdfDimensionsRef, measurements, tempPoints,
      activeTool, scaleFactor, pendingBreak, toCanvas, cursorPointRef,
      showLabels, selectedIdRef,
    ],
  );

  useEffect(() => { redrawRef.current = redrawDrawingCanvas; }, [redrawDrawingCanvas]);
  useEffect(() => { redrawPinRef.current = redrawPinCanvas; }, [redrawPinCanvas]);

  useEffect(() => {
    redrawDrawingCanvas(lastCursorRef.current ?? cursorPointRef.current ?? undefined);
  }, [snapCandidates, arcDragPreview, redrawDrawingCanvas, cursorPointRef]);

  const handleCanvasPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = drawingCanvasRef.current;
      const dim    = pdfDimensionsRef.current;
      if (!canvas || !dim) return;

      const rect    = canvas.getBoundingClientRect();
      const canvasX = (e.clientX - rect.left) * (canvas.width  / rect.width);
      const canvasY = (e.clientY - rect.top)  * (canvas.height / rect.height);

      let snappedCanvas = { x: canvasX, y: canvasY };

      if ((snapEnabledRef.current || orthoState.on) && snapToCorner) {
        const s = snapToCorner(canvasX, canvasY);
        if (s?.point) {
          snappedCanvas = { x: s.point.x, y: s.point.y };
          const snapDist = Math.hypot(canvasX - s.point.x, canvasY - s.point.y);
          if (s.snapped && snapDist > 0) snapThresholdRef.current = snapDist * 1.2;
        }
      }

      // Refs update immediately (clicks read them); painting is batched to
      // at most once per display frame.
      lastCursorRef.current  = snappedCanvas;
      cursorPointRef.current = snappedCanvas;
      cursorStateRef.current = snappedCanvas;
      hoverGeomRef.current   = snapEnabledRef.current && findHoverGeometryRef.current
        ? findHoverGeometryRef.current(canvasX, canvasY)
        : null;
      pinsRef.current = findPinsNearRef.current ? findPinsNearRef.current(canvasX, canvasY) : [];
      pendingMovePointRef.current = snappedCanvas;
      if (moveRafRef.current == null) {
        moveRafRef.current = requestAnimationFrame(() => {
          moveRafRef.current = null;
          const pt = pendingMovePointRef.current;
          if (pt) redrawRef.current(pt);
          redrawPinRef.current();
        });
      }
    },
    [drawingCanvasRef, pdfDimensionsRef, snapEnabledRef, snapToCorner, cursorPointRef],
  );

  useEffect(() => {
    redrawDrawingCanvas(lastCursorRef.current ?? cursorPointRef.current ?? undefined);
  }, [tempPoints, activeTool, measurements, redrawDrawingCanvas, cursorPointRef]);

  return {
    cursorPoint,
    setCursorPoint,
    redrawDrawingCanvas,
    handleCanvasPointerMove,
    nearStartPointRef,
    startPointSnapRef,
  };
}
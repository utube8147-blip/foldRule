'use client';
// ─── hooks/useMeasurements/useMeasurementCommit.ts ───────────────────────────
//
//  FIXES in this version:
//
//  FIX 1: AUTO-SEED ONLY ON LINE→ARC TRANSITION (not on every arc click)
//  FIX 2: splitPolyarcSegments — incomplete arc runs are NOT emitted as segments
//  FIX 3: polyarcHasContent + status bar arc count use COMPLETE arcs only
//  FIX 4: CORRECT SEEDING FOR ALL SEGMENT TRANSITIONS
//  FIX 5: CLOSE-SNAP CLICK — when nearStartPointRef is true, override the
//          click coordinate to the exact first placed point and immediately
//          finish the measurement, guaranteeing a perfectly closed path.
//  FIX 6: CLOSE-SNAP COMMIT — finishMeasurement is called with a patched
//          tempPoints array where the final point is the exact first point,
//          so polyarc/linear/polygon paths close with zero gap even if the
//          user didn't click exactly on the start vertex.
//          Previously finishMeasurement() was called with no args, so it
//          used the raw tempPoints closure which lacked the closing vertex —
//          causing 0.00 quantity or a gap in the committed geometry.
//  FIX 7: CLOSE-SNAP SEGMENT-TYPE FIX — the closing vertex now inherits the
//          segmentType of the LAST placed real point (lastReal), not the
//          first (firstReal). Previously, when the final in-progress run
//          before closing was an 'arc' run, the closing point was tagged
//          with firstReal.segmentType (typically 'line'/undefined). In
//          splitPolyarcSegments, this caused the closing point to start a
//          brand-new 1-point run immediately after an 'arc' run — and runs
//          of length 1 are silently dropped (`if (run.length >= 2)`).
//          Result: the final segment of the polyarc never got committed.
//
//          Additionally, if the in-progress arc run only has 1 point when
//          closing (arcRunLen === 1), tagging the closing point as 'arc'
//          would only bring the run to length 2 — still incomplete, and
//          again silently dropped. In that case we fall back to 'line' so
//          the closing edge is committed as a straight segment instead of
//          vanishing entirely.
//
//  FIX 8: CLOSE-SNAP LINE AFTER COMPLETED ARC — when the last arc run is
//          fully committed (arcRunLen === 0) and the user closes with a
//          straight line back to the start, the closing point alone forms a
//          1-point 'line' run which splitPolyarcSegments silently drops.
//          Fix: insert lastReal re-tagged as 'line' as a seed point before
//          the closing vertex so the line run has length >= 2 and is emitted.
//
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback } from 'react';
import React from 'react';
import { TakeoffRow } from '@/types';
import { PdfDimensions, PendingSnapCandidate } from '@/types/viewerTypes';
import { getNextMeasurementColor } from './colors';
import { toCanvas as toCanvasUtil, toNorm as toNormUtil } from './utils';
import type { InProgressPoint } from '@/context/TakeoffContext';

export interface MeasurementLabelOptions {
  cursorPt: { x: number; y: number } | null;
  toCanvas: (nx: number, ny: number) => { x: number; y: number };
}

// ─── Arc sentinel ─────────────────────────────────────────────────────────────
export const ARC_SENTINEL: InProgressPoint = {
  x: -1, y: -1, snapped: false, segmentId: '__arc_break__',
};
export function isArcSentinel(p: InProgressPoint): boolean {
  return p.segmentId === '__arc_break__';
}
export function splitArcPoints(pts: InProgressPoint[]): InProgressPoint[][] {
  const groups: InProgressPoint[][] = [];
  let cur: InProgressPoint[] = [];
  for (const p of pts) {
    if (isArcSentinel(p)) { groups.push(cur); cur = []; }
    else cur.push(p);
  }
  groups.push(cur);
  return groups;
}
export function stagedArcCount(pts: InProgressPoint[]): number {
  return splitArcPoints(pts).filter(g => g.length === 3).length;
}
export function inProgressArcPoints(pts: InProgressPoint[]): InProgressPoint[] {
  const groups = splitArcPoints(pts);
  return groups[groups.length - 1] ?? [];
}

// ─── Radius sentinel ──────────────────────────────────────────────────────────
export const RADIUS_SENTINEL: InProgressPoint = {
  x: -1, y: -1, snapped: false, segmentId: '__radius_break__',
};
export function isRadiusSentinel(p: InProgressPoint): boolean {
  return p.segmentId === '__radius_break__';
}
export function splitRadiusPoints(pts: InProgressPoint[]): InProgressPoint[][] {
  const groups: InProgressPoint[][] = [];
  let cur: InProgressPoint[] = [];
  for (const p of pts) {
    if (isRadiusSentinel(p)) { groups.push(cur); cur = []; }
    else cur.push(p);
  }
  groups.push(cur);
  return groups;
}
export function stagedRadiusCount(pts: InProgressPoint[]): number {
  return splitRadiusPoints(pts).filter(g => g.length === 2).length;
}

// ─── Polyarc segment splitter ─────────────────────────────────────────────────
export type PolyarcSegment =
  | { type: 'line'; points: InProgressPoint[] }
  | { type: 'arc';  points: [InProgressPoint, InProgressPoint, InProgressPoint] };

export function splitPolyarcSegments(pts: InProgressPoint[]): PolyarcSegment[] {
  const result: PolyarcSegment[] = [];
  const clean = pts.filter(p => !isArcSentinel(p) && !isRadiusSentinel(p));
  if (clean.length === 0) return result;

  let i = 0;
  while (i < clean.length) {
    const p = clean[i];

    if (p.segmentType !== 'arc') {
      const run: InProgressPoint[] = [p];
      while (i + 1 < clean.length && clean[i + 1].segmentType !== 'arc') {
        i++;
        run.push(clean[i]);
      }
      if (run.length >= 2) {
        result.push({ type: 'line', points: run });
      }
      i++;
    } else {
      const arcRun: InProgressPoint[] = [p];
      while (i + 1 < clean.length && clean[i + 1].segmentType === 'arc') {
        i++;
        arcRun.push(clean[i]);
      }
      i++;

      // Emit complete triplets only — leftover 1 or 2 are in-progress previews
      for (let j = 0; j + 2 < arcRun.length; j += 3) {
        result.push({
          type:   'arc',
          points: [arcRun[j], arcRun[j + 1], arcRun[j + 2]] as [InProgressPoint, InProgressPoint, InProgressPoint],
        });
      }
    }
  }
  return result;
}

/**
 * Points to add for one Polyarc click. At a switch between line and arc the
 * previous segment's last point is repeated with the new type, so the new
 * segment starts exactly where the last one ended (no gap).
 */
export function polyarcClickPoints(
  tempPoints: InProgressPoint[],
  segmentType: 'line' | 'arc',
  click: { x: number; y: number; snapped: boolean },
): InProgressPoint[] {
  const out: InProgressPoint[] = [];
  const allReal = tempPoints.filter(p => !isArcSentinel(p) && !isRadiusSentinel(p));
  const lastReal = allReal.length > 0 ? allReal[allReal.length - 1] : null;
  if (lastReal) {
    const lastType = lastReal.segmentType ?? 'line';
    const totalArcCount     = allReal.filter(p => p.segmentType === 'arc').length;
    const completedArcCount = splitPolyarcSegments(tempPoints).filter(s => s.type === 'arc').length * 3;
    const arcRunLen = totalArcCount - completedArcCount;
    const atSegmentBoundary =
      (lastType === 'line' && segmentType === 'arc') ||
      (lastType === 'arc'  && segmentType === 'line' && arcRunLen === 0) ||
      (lastType === 'arc'  && segmentType === 'arc'  && arcRunLen === 0);
    if (atSegmentBoundary) {
      out.push({ x: lastReal.x, y: lastReal.y, snapped: lastReal.snapped, segmentType });
    }
  }
  out.push({ x: click.x, y: click.y, snapped: click.snapped, segmentType });
  return out;
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface UseMeasurementCommitParams {
  pdfDimensionsRef:        React.MutableRefObject<PdfDimensions | null>;
  pageNumberRef:           React.MutableRefObject<number>;
  scaleRef:                React.MutableRefObject<number>;
  activeTool:              string;
  setActiveTool:           (tool: string) => void;
  measurements:            TakeoffRow[];
  tempPoints:              InProgressPoint[];
  pushPoint:               (p: InProgressPoint) => void;
  commitMeasurement:       (m: TakeoffRow) => void;
  batchCommitMeasurements: (ms: TakeoffRow[]) => void;
  clearTempPoints:         () => void;
  scaleFactor:             number;
  onUpdateMeasurement?:    (id: string, updates: Partial<TakeoffRow>) => void;
  snapToCorner:            (x: number, y: number) => { point: { x: number; y: number }; snapped: boolean };
  triggerSnapFlash:        (x: number, y: number) => void;
  snapEnabledRef:          React.MutableRefObject<boolean>;
  snapThresholdRef:        React.MutableRefObject<number>;
  getScaledCorners:        (pageIdx: number) => Array<{ x: number; y: number; confidence: number }>;
  activeDrawingId:         string | null;
  drawingCanvasRef:        React.RefObject<HTMLCanvasElement>;
  cursorPointRef:          React.MutableRefObject<{ x: number; y: number } | null>;
  appendToGroupId?:        string | null;
  onAppendComplete?:       () => void;
  onScalePrompt:           (ptLen: number) => void;
  pendingBreak:            boolean;
  setPendingBreak:         (v: boolean) => void;
  nextSegmentIdRef:        React.MutableRefObject<string | null>;
  setCursorPoint:          (p: { x: number; y: number } | null) => void;
  setPendingSnapCandidates:(c: PendingSnapCandidate[] | null) => void;
  resetBreakState:         () => void;
  polyarcMode:             'line' | 'arc';
  togglePolyarcMode:       () => void;
  forcedPolyarcMode?:      'line' | 'arc';
  // FIX 5 / FIX 6: close-snap refs from useDrawingCanvas
  nearStartPointRef:       React.RefObject<boolean>;
  startPointSnapRef:       React.RefObject<{ x: number; y: number } | null>;
}

// ─── Group points by segment ID ───────────────────────────────────────────────
export function groupPointsBySegment(points: InProgressPoint[]) {
  const segs: { segmentId: string; points: InProgressPoint[] }[] = [];
  let cur: InProgressPoint[] = [];
  let curId: string | undefined;
  for (const pt of points) {
    const id = pt.segmentId || 'default';
    if (curId !== id) {
      if (cur.length) segs.push({ segmentId: curId!, points: cur });
      cur = [pt]; curId = id;
    } else {
      cur.push(pt);
    }
  }
  if (cur.length) segs.push({ segmentId: curId!, points: cur });
  return segs;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────
export function shoelaceArea(
  normPts:     { x: number; y: number }[],
  pdfW:        number,
  pdfH:        number,
  displayScale: number,
  scaleFactor: number,
): number {
  if (normPts.length < 3) return 0;
  const scale1W = pdfW / displayScale;
  const scale1H = pdfH / displayScale;
  let a = 0;
  for (let i = 0; i < normPts.length; i++) {
    const j  = (i + 1) % normPts.length;
    const xi = normPts[i].x * scale1W, yi = normPts[i].y * scale1H;
    const xj = normPts[j].x * scale1W, yj = normPts[j].y * scale1H;
    a += xi * yj - xj * yi;
  }
  return (Math.abs(a) / 2) * (scaleFactor * scaleFactor);
}

export function linearLength(
  normPts:     { x: number; y: number }[],
  pdfW:        number,
  pdfH:        number,
  displayScale: number,
  scaleFactor: number,
): number {
  if (normPts.length < 2) return 0;
  const scale1W = pdfW / displayScale;
  const scale1H = pdfH / displayScale;
  let len = 0;
  for (let i = 1; i < normPts.length; i++) {
    const dx = (normPts[i].x - normPts[i - 1].x) * scale1W;
    const dy = (normPts[i].y - normPts[i - 1].y) * scale1H;
    len += Math.hypot(dx, dy);
  }
  return len * scaleFactor;
}

function circumscribedCircleNorm(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
): { r: number; sweepAngle: number; arcLength: number } | null {
  const ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(D) < 1e-9) return null;
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
  const r  = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const a1 = Math.atan2(by - uy, bx - ux);
  const a2 = Math.atan2(cy - uy, cx - ux);
  const norm  = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const s = norm(a0), m = norm(a1), e = norm(a2);
  let sweep: number;
  if (s <= e) {
    sweep = (m >= s && m <= e) ? (e - s) : (2 * Math.PI - (e - s));
  } else {
    sweep = (m >= s || m <= e) ? (2 * Math.PI - (s - e)) : (s - e);
  }
  return { r, sweepAngle: sweep, arcLength: r * sweep };
}

export function drawMeasurementLabel(
  ctx:         CanvasRenderingContext2D,
  measurement: TakeoffRow,
  cursorPt:    { x: number; y: number },
  toCanvas:    (nx: number, ny: number) => { x: number; y: number },
): void {
  if (!measurement.points?.length) return;
  if (!['Polygon', 'Rectangle', 'Length'].includes(measurement.type)) return;
  const canvasPts = measurement.points.map(p => toCanvas(p.x, p.y));
  if (canvasPts.length === 0) return;
  let isInside = false;
  if (measurement.type === 'Length') {
    for (let i = 1; i < canvasPts.length; i++) {
      const dx = canvasPts[i].x - canvasPts[i - 1].x;
      const dy = canvasPts[i].y - canvasPts[i - 1].y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) continue;
      const t = Math.max(0, Math.min(1,
        ((cursorPt.x - canvasPts[i - 1].x) * dx + (cursorPt.y - canvasPts[i - 1].y) * dy) / lenSq,
      ));
      const dist = Math.hypot(
        cursorPt.x - (canvasPts[i - 1].x + t * dx),
        cursorPt.y - (canvasPts[i - 1].y + t * dy),
      );
      if (dist < 14) { isInside = true; break; }
    }
  } else {
    for (let i = 0, j = canvasPts.length - 1; i < canvasPts.length; j = i++) {
      const xi = canvasPts[i].x, yi = canvasPts[i].y;
      const xj = canvasPts[j].x, yj = canvasPts[j].y;
      if (
        ((yi > cursorPt.y) !== (yj > cursorPt.y)) &&
        (cursorPt.x < (xj - xi) * (cursorPt.y - yi) / (yj - yi) + xi)
      ) isInside = !isInside;
    }
  }
  if (!isInside) return;
  const cx  = canvasPts.reduce((s, p) => s + p.x, 0) / canvasPts.length;
  const cy  = canvasPts.reduce((s, p) => s + p.y, 0) / canvasPts.length;
  const qty = measurement.quantity ?? 0;
  const isArea     = measurement.type !== 'Length';
  const valueLabel = isArea ? `${qty.toFixed(2)} m²` : `${qty.toFixed(2)} m`;
  const desc       = (measurement.label || measurement.description || '').toUpperCase();
  const color      = measurement.color || '#EF9F27';
  ctx.save();
  ctx.font = 'bold 12px ui-monospace, monospace';
  const valueTw = ctx.measureText(valueLabel).width;
  ctx.font      = '9px ui-monospace, monospace';
  const descTw  = ctx.measureText(desc).width;
  const tw      = Math.max(valueTw, descTw) + 20;
  const hasDesc = desc.length > 0;
  const th      = hasDesc ? 38 : 24;
  ctx.fillStyle = 'rgba(10,10,10,0.88)';
  const rx = cx - tw / 2, ry = cy - th / 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(rx, ry, tw, th, 5); else ctx.rect(rx, ry, tw, th);
  ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (hasDesc) {
    ctx.font = '9px ui-monospace, monospace'; ctx.fillStyle = 'rgba(160,160,160,0.75)';
    ctx.fillText(desc, cx, cy - 10);
    ctx.font = 'bold 12px ui-monospace, monospace'; ctx.fillStyle = color;
    ctx.fillText(valueLabel, cx, cy + 8);
  } else {
    ctx.font = 'bold 12px ui-monospace, monospace'; ctx.fillStyle = color;
    ctx.fillText(valueLabel, cx, cy);
  }
  ctx.restore();
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useMeasurementCommit({
  pdfDimensionsRef, pageNumberRef, scaleRef,
  activeTool, setActiveTool,
  measurements, tempPoints, pushPoint,
  commitMeasurement, batchCommitMeasurements, clearTempPoints,
  scaleFactor, onUpdateMeasurement,
  snapToCorner, triggerSnapFlash,
  snapEnabledRef, snapThresholdRef, getScaledCorners,
  activeDrawingId, drawingCanvasRef, cursorPointRef,
  appendToGroupId, onAppendComplete, onScalePrompt,
  pendingBreak, setPendingBreak, nextSegmentIdRef,
  setCursorPoint, setPendingSnapCandidates, resetBreakState,
  polyarcMode,
  nearStartPointRef,
  startPointSnapRef,
}: UseMeasurementCommitParams) {

  const toCanvas = useCallback(
    (normX: number, normY: number) => toCanvasUtil(normX, normY, pdfDimensionsRef.current),
    [pdfDimensionsRef],
  );
  const toNorm = useCallback(
    (canvasX: number, canvasY: number) => toNormUtil(canvasX, canvasY, pdfDimensionsRef.current),
    [pdfDimensionsRef],
  );
  const calcArea = useCallback((normPts: { x: number; y: number }[]): number => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return 0;
    return shoelaceArea(normPts, dims.w, dims.h, scaleRef.current, scaleFactor);
  }, [pdfDimensionsRef, scaleRef, scaleFactor]);

  const calcLength = useCallback((normPts: { x: number; y: number }[]): number => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return 0;
    return linearLength(normPts, dims.w, dims.h, scaleRef.current, scaleFactor);
  }, [pdfDimensionsRef, scaleRef, scaleFactor]);

  const rectNormPoints = useCallback((
    p1n: { x: number; y: number },
    p2n: { x: number; y: number },
  ): { x: number; y: number }[] => ([
    { x: p1n.x, y: p1n.y }, { x: p2n.x, y: p1n.y },
    { x: p2n.x, y: p2n.y }, { x: p1n.x, y: p2n.y },
  ]), []);

  const calcArcLength = useCallback((
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
  ): { arcLengthM: number; radiusM: number; sweepAngle: number } | null => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return null;
    const scale1W = dims.w / scaleRef.current;
    const scale1H = dims.h / scaleRef.current;
    const s1 = { x: p1.x * scale1W, y: p1.y * scale1H };
    const s2 = { x: p2.x * scale1W, y: p2.y * scale1H };
    const s3 = { x: p3.x * scale1W, y: p3.y * scale1H };
    const result = circumscribedCircleNorm(s1, s2, s3);
    if (!result) return null;
    return {
      arcLengthM: result.arcLength * scaleFactor,
      radiusM:    result.r         * scaleFactor,
      sweepAngle: result.sweepAngle,
    };
  }, [pdfDimensionsRef, scaleRef, scaleFactor]);

  const calcRadiusM = useCallback((
    centre: { x: number; y: number },
    edge:   { x: number; y: number },
  ): number => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return 0;
    const scale1W = dims.w / scaleRef.current;
    const scale1H = dims.h / scaleRef.current;
    return Math.hypot(
      (edge.x - centre.x) * scale1W,
      (edge.y - centre.y) * scale1H,
    ) * scaleFactor;
  }, [pdfDimensionsRef, scaleRef, scaleFactor]);

  const checkSnapCandidates = useCallback((pts: InProgressPoint[], measurementId: string) => {
    if (!snapEnabledRef.current || !pdfDimensionsRef.current) return;
    const free    = pts.map((p, i) => ({ ...p, index: i })).filter(p => !p.snapped);
    if (free.length === 0) return;
    const corners = getScaledCorners(pageNumberRef.current);
    const cands: PendingSnapCandidate[] = [];
    for (const fp of free) {
      const fc = toCanvas(fp.x, fp.y);
      let best = snapThresholdRef.current * 2;
      let tgt: { x: number; y: number } | null = null;
      for (const c of corners) {
        const d = Math.hypot(fc.x - c.x, fc.y - c.y);
        if (d < best) { best = d; tgt = { x: c.x, y: c.y }; }
      }
      if (tgt) cands.push({ pointIndex: fp.index, measurementId, snapTarget: toNorm(tgt.x, tgt.y) });
    }
    if (cands.length) setPendingSnapCandidates(cands);
  }, [getScaledCorners, toCanvas, toNorm, pdfDimensionsRef, pageNumberRef,
      snapEnabledRef, snapThresholdRef, setPendingSnapCandidates]);

  const buildArcRow = useCallback((
    pts3:       InProgressPoint[],
    groupColor: string,
    groupId?:   string,
    label?:     string,
    idx?:       number,
  ): TakeoffRow => {
    const [p1, p2, p3] = pts3;
    const arcResult    = calcArcLength(p1, p2, p3);
    const rowLabel     = label ?? (idx !== undefined ? `Arc ${idx + 1}` : 'Arc');
    if (!arcResult) {
      return {
        id: crypto.randomUUID(), drawingId: activeDrawingId || '',
        description: rowLabel, label: rowLabel,
        type: 'Length', quantity: +calcLength([p1, p2, p3]).toFixed(4),
        unit: 'm', unitRate: 0, notes: 'Arc (collinear fallback)',
        points: [p1, p2, p3], isOverridden: false,
        color: groupColor, isVisible: true, childIds: [],
        ...(groupId ? { parentId: groupId } : {}),
      };
    }
    return {
      id: crypto.randomUUID(), drawingId: activeDrawingId || '',
      description: rowLabel, label: rowLabel,
      type: 'Length', quantity: +arcResult.arcLengthM.toFixed(4),
      unit: 'm', unitRate: 0,
      notes: `Arc: r=${arcResult.radiusM.toFixed(3)}m θ=${(arcResult.sweepAngle * 180 / Math.PI).toFixed(1)}°`,
      points: [p1, p2, p3], isOverridden: false,
      color: groupColor, isVisible: true, childIds: [],
      arcRadius:  +arcResult.radiusM.toFixed(4),
      sweepAngle: +arcResult.sweepAngle.toFixed(4),
      ...(groupId ? { parentId: groupId } : {}),
    };
  }, [calcArcLength, calcLength, activeDrawingId]);

  // ─── finishMeasurement ────────────────────────────────────────────────────
  const finishMeasurement = useCallback((
    currentTempPoints?: InProgressPoint[],
    meta?: { label?: string; icon?: string; appendToGroupId?: string },
  ) => {
    const pts = currentTempPoints ?? tempPoints;
    resetBreakState();

    const resolvedAppendTarget = appendToGroupId ?? meta?.appendToGroupId ?? null;

    // ── APPEND MODE ───────────────────────────────────────────────────────────
    if (resolvedAppendTarget) {
      const targetGroup = measurements.find(m => m.id === resolvedAppendTarget);
      if (!targetGroup) { clearTempPoints(); return; }

      const activeType = activeTool === 'linear'    ? 'Length'
        : activeTool === 'polygon'   ? 'Polygon'
        : activeTool === 'rectangle' ? 'Rectangle'
        : activeTool === 'count'     ? 'Count'
        : activeTool === 'point'     ? 'Point'
        : null;

      if (activeType !== targetGroup.type) {
        console.warn(`Cannot append ${activeType} to ${targetGroup.type} group`);
        clearTempPoints(); return;
      }

      if (activeTool === 'point') {
        if (pts.length < 1) { clearTempPoints(); return; }
        const newChildId  = crypto.randomUUID();
        const childNumber = (targetGroup.childIds?.length ?? 0) + 1;
        commitMeasurement({
          id: newChildId, drawingId: activeDrawingId || '',
          description: `${targetGroup.label || targetGroup.description} ${childNumber}`,
          label: targetGroup.label || targetGroup.description,
          type: 'Point', quantity: 1, unit: 'PT', unitRate: 0, notes: '',
          points: [{ x: pts[0].x, y: pts[0].y }],
          isOverridden: false, color: targetGroup.color, isVisible: true,
          parentId: targetGroup.id, childIds: [],
        });
        onUpdateMeasurement?.(targetGroup.id, {
          childIds: [...(targetGroup.childIds ?? []), newChildId],
          quantity: (targetGroup.quantity ?? 0) + 1,
        });
        clearTempPoints(); setCursorPoint(null); onAppendComplete?.(); return;
      }

      if (activeTool === 'count') {
        if (pts.length < 1) { clearTempPoints(); return; }
        const newChildId  = crypto.randomUUID();
        const childNumber = (targetGroup.childIds?.length ?? 0) + 1;
        commitMeasurement({
          id: newChildId, drawingId: activeDrawingId || '',
          description: `${targetGroup.label || targetGroup.description} ${childNumber}`,
          label: targetGroup.label || targetGroup.description,
          type: 'Count', quantity: 1, unit: 'EA', unitRate: 0, notes: '',
          points: [{ x: pts[0].x, y: pts[0].y }],
          isOverridden: false, color: targetGroup.color, isVisible: true,
          parentId: targetGroup.id, childIds: [],
        });
        onUpdateMeasurement?.(targetGroup.id, {
          childIds: [...(targetGroup.childIds ?? []), newChildId],
          quantity: (targetGroup.quantity ?? 0) + 1,
        });
        clearTempPoints(); setCursorPoint(null); onAppendComplete?.(); return;
      }

      if (activeTool === 'linear') {
        if (pts.length < 2) { clearTempPoints(); return; }
        const quantity   = calcLength(pts.map(p => ({ x: p.x, y: p.y })));
        const newChildId = crypto.randomUUID();
        commitMeasurement({
          id: newChildId, drawingId: activeDrawingId || '',
          description: `Section ${(targetGroup.childIds?.length ?? 0) + 1}`,
          label: `Section ${(targetGroup.childIds?.length ?? 0) + 1}`,
          type: 'Length', quantity, unit: 'm', unitRate: 0, notes: '',
          points: pts.map(p => ({ x: p.x, y: p.y })),
          isOverridden: false, color: targetGroup.color, isVisible: true,
          parentId: targetGroup.id, childIds: [],
        });
        onUpdateMeasurement?.(targetGroup.id, {
          childIds: [...(targetGroup.childIds ?? []), newChildId],
          quantity: (targetGroup.quantity ?? 0) + quantity,
        });
        clearTempPoints(); setCursorPoint(null); onAppendComplete?.(); return;
      }

      if (activeTool === 'polygon') {
        const allSegs   = groupPointsBySegment(pts);
        const validSegs = allSegs.filter(s => s.points.length >= 3);
        if (validSegs.length === 0) { clearTempPoints(); return; }
        const newPoints   = validSegs[0].points.map(p => ({ x: p.x, y: p.y }));
        const newQuantity = calcArea(newPoints);
        const newChildId  = crypto.randomUUID();
        commitMeasurement({
          id: newChildId, drawingId: activeDrawingId || '',
          description: `Shape ${(targetGroup.childIds?.length ?? 0) + 1}`,
          label: targetGroup.label || targetGroup.description,
          type: 'Polygon', quantity: newQuantity, unit: 'sq m', unitRate: 0, notes: '',
          points: newPoints, isOverridden: false, color: targetGroup.color,
          isVisible: true, parentId: targetGroup.id, childIds: [],
        });
        onUpdateMeasurement?.(targetGroup.id, {
          childIds: [...(targetGroup.childIds ?? []), newChildId],
          quantity: (targetGroup.quantity ?? 0) + newQuantity,
        });
        clearTempPoints(); setCursorPoint(null); onAppendComplete?.(); return;
      }

      if (activeTool === 'rectangle') {
        const allSegs   = groupPointsBySegment(pts);
        const validSegs = allSegs.filter(s => s.points.length === 2);
        if (validSegs.length === 0) { clearTempPoints(); return; }
        const normPts    = rectNormPoints(validSegs[0].points[0], validSegs[0].points[1]);
        const area       = calcArea(normPts);
        const newChildId = crypto.randomUUID();
        commitMeasurement({
          id: newChildId, drawingId: activeDrawingId || '',
          description: `Rectangle ${(targetGroup.childIds?.length ?? 0) + 1}`,
          label: targetGroup.label || targetGroup.description,
          type: 'Rectangle', quantity: area, unit: 'sq m', unitRate: 0, notes: '',
          points: normPts, isOverridden: false, color: targetGroup.color,
          isVisible: true, parentId: targetGroup.id, childIds: [],
        });
        onUpdateMeasurement?.(targetGroup.id, {
          childIds: [...(targetGroup.childIds ?? []), newChildId],
          quantity: (targetGroup.quantity ?? 0) + area,
        });
        clearTempPoints(); setCursorPoint(null); onAppendComplete?.(); return;
      }
    }

    // ── REGULAR FINISH ────────────────────────────────────────────────────────

    if (activeTool === 'point') {
      if (pts.length < 1) { clearTempPoints(); setCursorPoint(null); return; }
      const label = meta?.label || 'Point';
      commitMeasurement({
        id: crypto.randomUUID(), drawingId: activeDrawingId || '',
        description: label, label, type: 'Point',
        quantity: 1, unit: 'PT', unitRate: 0, notes: '',
        points: [{ x: pts[0].x, y: pts[0].y }],
        isOverridden: false, color: getNextMeasurementColor(), isVisible: true, childIds: [],
      });
      clearTempPoints(); setCursorPoint(null); return;
    }

    if (activeTool === 'count') {
      if (pts.length < 1) { clearTempPoints(); setCursorPoint(null); return; }
      const groupId    = crypto.randomUUID();
      const groupColor = getNextMeasurementColor();
      const groupLabel = meta?.label || 'New Count Group';
      const groupIcon  = meta?.icon;
      const childIds: string[] = [];
      const children: TakeoffRow[] = [];
      for (let i = 0; i < pts.length; i++) {
        const cid = crypto.randomUUID();
        childIds.push(cid);
        children.push({
          id: cid, drawingId: activeDrawingId || '',
          description: `${groupLabel} ${i + 1}`, label: groupLabel, icon: groupIcon,
          type: 'Count', quantity: 1, unit: 'EA', unitRate: 0, notes: '',
          points: [{ x: pts[i].x, y: pts[i].y }],
          isOverridden: false, color: groupColor, isVisible: true, parentId: groupId, childIds: [],
        });
      }
      batchCommitMeasurements([{
        id: groupId, drawingId: activeDrawingId || '',
        description: groupLabel, label: groupLabel, icon: groupIcon, type: 'Count',
        quantity: pts.length, unit: 'EA', unitRate: 0, notes: '', points: [],
        isOverridden: false, color: groupColor, isVisible: true, isGroupHeader: true, childIds,
      }, ...children]);
      clearTempPoints(); setCursorPoint(null); return;
    }

    if (activeTool === 'scale') {
      if (tempPoints.length === 0) { clearTempPoints(); setCursorPoint(null); return; }
      const p0    = toCanvas(tempPoints[0].x, tempPoints[0].y);
      const p1    = toCanvas(pts[pts.length - 1].x, pts[pts.length - 1].y);
      const ptLen = Math.hypot(p1.x - p0.x, p1.y - p0.y) / scaleRef.current;
      clearTempPoints(); setCursorPoint(null);
      cursorPointRef.current = null;
      resetBreakState(); setActiveTool('select'); onScalePrompt(ptLen);
      return;
    }

    // ── Arc tool ──────────────────────────────────────────────────────────────
    if (activeTool === 'arc') {
      const groups    = splitArcPoints(pts);
      const validArcs = groups.filter(g => g.length === 3);
      if (validArcs.length === 0) { clearTempPoints(); setCursorPoint(null); return; }
      const groupColor = getNextMeasurementColor();
      const groupLabel = meta?.label || 'Arc Group';
      if (validArcs.length === 1) {
        commitMeasurement(buildArcRow(validArcs[0], groupColor, undefined, meta?.label ?? 'Arc'));
      } else {
        const groupId  = crypto.randomUUID();
        const children: TakeoffRow[] = [];
        const childIds: string[] = [];
        for (let i = 0; i < validArcs.length; i++) {
          const child = buildArcRow(validArcs[i], groupColor, groupId, `Arc ${i + 1}`, i);
          childIds.push(child.id); children.push(child);
        }
        const totalLength = children.reduce((s, c) => s + (c.quantity ?? 0), 0);
        batchCommitMeasurements([{
          id: crypto.randomUUID(), drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Length', quantity: +totalLength.toFixed(4),
          unit: 'm', unitRate: 0, notes: `${validArcs.length} arcs`,
          points: [], isOverridden: false, color: groupColor,
          isVisible: true, isGroupHeader: true, childIds,
        }, ...children]);
      }
      clearTempPoints(); setCursorPoint(null); return;
    }

    // ── Radius tool ───────────────────────────────────────────────────────────
    if (activeTool === 'radius') {
      const groups       = splitRadiusPoints(pts);
      const validCircles = groups.filter(g => g.length === 2);
      if (validCircles.length === 0) { clearTempPoints(); setCursorPoint(null); return; }
      const groupColor = getNextMeasurementColor();
      const groupLabel = meta?.label || 'Circle Group';
      if (validCircles.length === 1) {
        const [centre, edge] = validCircles[0];
        const rMetres = calcRadiusM(centre, edge);
        const circ    = +(2 * Math.PI * rMetres).toFixed(4);
        commitMeasurement({
          id: crypto.randomUUID(), drawingId: activeDrawingId || '',
          description: meta?.label || 'Circle', label: meta?.label || 'Circle',
          type: 'Length', quantity: circ, unit: 'm', unitRate: 0,
          notes: `Circle: r=${rMetres.toFixed(3)}m  circ=${circ}m`,
          points: [centre, edge], isOverridden: false,
          color: groupColor, isVisible: true, childIds: [],
          arcRadius: +rMetres.toFixed(4), sweepAngle: +(2 * Math.PI).toFixed(4),
        });
      } else {
        const groupId  = crypto.randomUUID();
        const children: TakeoffRow[] = [];
        const childIds: string[] = [];
        for (let i = 0; i < validCircles.length; i++) {
          const [centre, edge] = validCircles[i];
          const rMetres = calcRadiusM(centre, edge);
          const circ    = +(2 * Math.PI * rMetres).toFixed(4);
          const cid     = crypto.randomUUID();
          childIds.push(cid);
          children.push({
            id: cid, drawingId: activeDrawingId || '',
            description: `Circle ${i + 1}`, label: `Circle ${i + 1}`,
            type: 'Length', quantity: circ, unit: 'm', unitRate: 0,
            notes: `Circle: r=${rMetres.toFixed(3)}m  circ=${circ}m`,
            points: [centre, edge], isOverridden: false,
            color: groupColor, isVisible: true, childIds: [], parentId: groupId,
            arcRadius: +rMetres.toFixed(4), sweepAngle: +(2 * Math.PI).toFixed(4),
          });
        }
        batchCommitMeasurements([{
          id: groupId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Length', quantity: +children.reduce((s, c) => s + (c.quantity ?? 0), 0).toFixed(4),
          unit: 'm', unitRate: 0, notes: `${validCircles.length} circles`,
          points: [], isOverridden: false, color: groupColor,
          isVisible: true, isGroupHeader: true, childIds,
        }, ...children]);
      }
      clearTempPoints(); setCursorPoint(null); return;
    }

    // ── POLYARC TOOL ─────────────────────────────────────────────────────────
    if (activeTool === 'polyarc') {
      const segments = splitPolyarcSegments(pts);
      if (segments.length === 0) { clearTempPoints(); setCursorPoint(null); return; }

      const groupColor = getNextMeasurementColor();
      const groupLabel = meta?.label || 'Polyarc';

      let totalLength = 0;
      for (const seg of segments) {
        if (seg.type === 'line') {
          totalLength += calcLength(seg.points.map(p => ({ x: p.x, y: p.y })));
        } else {
          const arcResult = calcArcLength(seg.points[0], seg.points[1], seg.points[2]);
          totalLength += arcResult ? arcResult.arcLengthM : calcLength(seg.points.map(p => ({ x: p.x, y: p.y })));
        }
      }

      if (segments.length === 1) {
        const seg = segments[0];
        if (seg.type === 'line') {
          commitMeasurement({
            id: crypto.randomUUID(), drawingId: activeDrawingId || '',
            description: groupLabel, label: groupLabel,
            type: 'Length', quantity: +totalLength.toFixed(4),
            unit: 'm', unitRate: 0, notes: '',
            points: seg.points.map(p => ({ x: p.x, y: p.y })),
            isOverridden: false, color: groupColor, isVisible: true, childIds: [],
          });
        } else {
          commitMeasurement(buildArcRow(seg.points, groupColor, undefined, groupLabel));
        }
      } else {
        const groupId  = crypto.randomUUID();
        const children: TakeoffRow[] = [];
        const childIds: string[] = [];
        let segIdx = 0;
        for (const seg of segments) {
          const cid   = crypto.randomUUID();
          const label = seg.type === 'arc' ? `Arc ${segIdx + 1}` : `Line ${segIdx + 1}`;
          let child: TakeoffRow;
          if (seg.type === 'arc') {
            child = buildArcRow(seg.points, groupColor, groupId, label, segIdx);
          } else {
            const qty = calcLength(seg.points.map(p => ({ x: p.x, y: p.y })));
            child = {
              id: cid, drawingId: activeDrawingId || '',
              description: label, label,
              type: 'Length', quantity: +qty.toFixed(4),
              unit: 'm', unitRate: 0, notes: 'Straight segment',
              points: seg.points.map(p => ({ x: p.x, y: p.y })),
              isOverridden: false, color: groupColor, isVisible: true,
              parentId: groupId, childIds: [],
            };
          }
          childIds.push(child.id);
          children.push(child);
          segIdx++;
        }
        batchCommitMeasurements([{
          id: groupId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Length', quantity: +totalLength.toFixed(4),
          unit: 'm', unitRate: 0,
          notes: `${segments.filter(s => s.type === 'line').length} line + ${segments.filter(s => s.type === 'arc').length} arc segments`,
          points: [], isOverridden: false, color: groupColor,
          isVisible: true, isGroupHeader: true, childIds,
        }, ...children]);
      }
      clearTempPoints(); setCursorPoint(null); return;
    }

    if (pts.length < 2) { clearTempPoints(); setCursorPoint(null); return; }

    const newId      = crypto.randomUUID();
    const groupColor = getNextMeasurementColor();

    // ── Linear ────────────────────────────────────────────────────────────────
    if (activeTool === 'linear') {
      const allSegs   = groupPointsBySegment(pts);
      const validSegs = allSegs.filter(s => s.points.length >= 2);
      if (validSegs.length === 0) { clearTempPoints(); setCursorPoint(null); return; }
      const groupLabel = meta?.label || 'New Length';
      const segLength  = (seg: typeof validSegs[0]) =>
        calcLength(seg.points.map(p => ({ x: p.x, y: p.y })));
      const totalQty = validSegs.reduce((sum, seg) => sum + segLength(seg), 0);
      if (validSegs.length === 1) {
        commitMeasurement({
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Length', quantity: totalQty, unit: 'm', unitRate: 0, notes: '',
          points: validSegs[0].points.map(p => ({ x: p.x, y: p.y })),
          isOverridden: false, color: groupColor, isVisible: true, childIds: [],
        });
      } else {
        const childIds: string[] = [];
        const children: TakeoffRow[] = [];
        validSegs.forEach((seg, idx) => {
          const cid = crypto.randomUUID();
          childIds.push(cid);
          children.push({
            id: cid, drawingId: activeDrawingId || '',
            description: `Section ${idx + 1}`, label: `Section ${idx + 1}`,
            type: 'Length', quantity: segLength(seg), unit: 'm', unitRate: 0, notes: '',
            points: seg.points.map(p => ({ x: p.x, y: p.y })),
            isOverridden: false, color: groupColor, isVisible: true, parentId: newId, childIds: [],
          });
        });
        batchCommitMeasurements([{
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Length', quantity: totalQty, unit: 'm', unitRate: 0, notes: '', points: [],
          isOverridden: false, color: groupColor, isVisible: true, isGroupHeader: true, childIds,
        }, ...children]);
      }
      clearTempPoints(); setCursorPoint(null);
      checkSnapCandidates(pts, newId); return;
    }

    // ── Polygon ───────────────────────────────────────────────────────────────
    if (activeTool === 'polygon') {
      const allSegs   = groupPointsBySegment(pts);
      const validSegs = allSegs.filter(s => s.points.length >= 3);
      if (validSegs.length === 0) { clearTempPoints(); setCursorPoint(null); return; }
      const groupLabel = meta?.label || 'New Polygon';
      const segArea    = (seg: typeof validSegs[0]) =>
        calcArea(seg.points.map(p => ({ x: p.x, y: p.y })));
      const totalArea = validSegs.reduce((sum, seg) => sum + segArea(seg), 0);
      if (validSegs.length === 1) {
        commitMeasurement({
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Polygon', quantity: totalArea, unit: 'sq m', unitRate: 0, notes: '',
          points: validSegs[0].points.map(p => ({ x: p.x, y: p.y })),
          isOverridden: false, color: groupColor, isVisible: true, childIds: [],
        });
      } else {
        const childIds: string[] = [];
        const children: TakeoffRow[] = [];
        validSegs.forEach((seg, idx) => {
          const cid = crypto.randomUUID();
          childIds.push(cid);
          children.push({
            id: cid, drawingId: activeDrawingId || '',
            description: `Shape ${idx + 1}`, label: `Shape ${idx + 1}`,
            type: 'Polygon', quantity: segArea(seg), unit: 'sq m', unitRate: 0, notes: '',
            points: seg.points.map(p => ({ x: p.x, y: p.y })),
            isOverridden: false, color: groupColor, isVisible: true, parentId: newId, childIds: [],
          });
        });
        batchCommitMeasurements([{
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Polygon', quantity: totalArea, unit: 'sq m', unitRate: 0, notes: '', points: [],
          isOverridden: false, color: groupColor, isVisible: true, isGroupHeader: true, childIds,
        }, ...children]);
      }
      clearTempPoints(); setCursorPoint(null);
      checkSnapCandidates(pts, newId); return;
    }

    // ── Rectangle ─────────────────────────────────────────────────────────────
    if (activeTool === 'rectangle') {
      const allSegs   = groupPointsBySegment(pts);
      const validSegs = allSegs.filter(s => s.points.length === 2);
      if (validSegs.length === 0) { clearTempPoints(); setCursorPoint(null); return; }
      const groupLabel  = meta?.label || 'New Rectangle';
      const segAreaRect = (seg: typeof validSegs[0]) => {
        const normPts = rectNormPoints(seg.points[0], seg.points[1]);
        return { normPts, area: calcArea(normPts) };
      };
      const totalArea = validSegs.reduce((s, seg) => s + segAreaRect(seg).area, 0);
      if (validSegs.length === 1) {
        const { normPts, area } = segAreaRect(validSegs[0]);
        commitMeasurement({
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Rectangle', quantity: area, unit: 'sq m', unitRate: 0, notes: '',
          points: normPts, isOverridden: false, color: groupColor, isVisible: true, childIds: [],
        });
      } else {
        const childIds: string[] = [];
        const children: TakeoffRow[] = [];
        validSegs.forEach((seg, idx) => {
          const cid = crypto.randomUUID();
          childIds.push(cid);
          const { normPts, area } = segAreaRect(seg);
          children.push({
            id: cid, drawingId: activeDrawingId || '',
            description: `Rectangle ${idx + 1}`, label: `Rectangle ${idx + 1}`,
            type: 'Rectangle', quantity: area, unit: 'sq m', unitRate: 0, notes: '',
            points: normPts, isOverridden: false, color: groupColor, isVisible: true,
            parentId: newId, childIds: [],
          });
        });
        batchCommitMeasurements([{
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Rectangle', quantity: totalArea, unit: 'sq m', unitRate: 0, notes: '', points: [],
          isOverridden: false, color: groupColor, isVisible: true, isGroupHeader: true, childIds,
        }, ...children]);
      }
      clearTempPoints(); setCursorPoint(null);
      checkSnapCandidates(pts, newId); return;
    }
  }, [
    tempPoints, activeTool, scaleFactor, commitMeasurement, batchCommitMeasurements,
    clearTempPoints, setActiveTool, checkSnapCandidates, toCanvas, toNorm,
    activeDrawingId, scaleRef, resetBreakState, onUpdateMeasurement, measurements,
    onScalePrompt, cursorPointRef, onAppendComplete, appendToGroupId, setCursorPoint,
    calcArea, calcLength, calcArcLength, calcRadiusM, rectNormPoints, buildArcRow,
  ]);

  // ─── handleCanvasClick ────────────────────────────────────────────────────
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === 'select') return;
    if (e.button !== 0) return;

    if (e.detail === 2) {
      const multiPointTools = ['linear', 'polygon', 'count', 'polyarc'];
      if (multiPointTools.includes(activeTool) && tempPoints.length > 0) {
        finishMeasurement(); return;
      }
    }

    const canvas = drawingCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const rawX = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const rawY = (e.clientY - rect.top)  * (canvas.height / rect.height);

    // ── FIX 5 + FIX 6 + FIX 7 + FIX 8: Close-snap override ─────────────────
    //
    //  FIX 5: intercept click when nearStartPointRef is true.
    //  FIX 6: pass patched points array (with closing vertex) to finishMeasurement.
    //  FIX 7: closing vertex inherits segmentType from lastReal, not firstReal.
    //  FIX 8: when last arc run is COMPLETE (arcRunLen === 0) and user closes
    //         with a line, insert lastReal re-tagged as 'line' as a seed so
    //         the closing line run has length >= 2 and is not dropped by
    //         splitPolyarcSegments.
    //
    const CLOSE_SNAP_TOOLS = new Set(['linear', 'polygon', 'polyarc']);
    if (
      nearStartPointRef.current &&
      startPointSnapRef.current &&
      CLOSE_SNAP_TOOLS.has(activeTool) &&
      tempPoints.length >= 2
    ) {
      const snapNorm = startPointSnapRef.current;

      const realPts   = tempPoints.filter(p => !isArcSentinel(p) && !isRadiusSentinel(p));
      const firstReal = realPts[0];
      const lastReal  = realPts[realPts.length - 1];

      // ── POLYARC-specific segment-type resolution ──────────────────────────
      if (activeTool === 'polyarc') {
        const completedArcCount = splitPolyarcSegments(tempPoints)
          .filter(s => s.type === 'arc').length * 3;
        const totalArcCount = realPts.filter(p => p.segmentType === 'arc').length;
        const arcRunLen     = totalArcCount - completedArcCount;

        if (lastReal?.segmentType === 'arc' && arcRunLen === 0) {
          // FIX 8: last arc run fully committed, user closes with a straight
          // line. A lone 'line' closing point forms a 1-point run which is
          // dropped. Seed the run by re-inserting lastReal tagged as 'line'.
          const seedPoint: InProgressPoint = {
            x:           lastReal.x,
            y:           lastReal.y,
            snapped:     lastReal.snapped,
            segmentId:   lastReal.segmentId,
            segmentType: 'line',
          };
          const closingPoint: InProgressPoint = {
            x:           snapNorm.x,
            y:           snapNorm.y,
            snapped:     true,
            segmentId:   firstReal?.segmentId,
            segmentType: 'line',
          };
          finishMeasurement([...tempPoints, seedPoint, closingPoint]);
          return;
        }

        if (lastReal?.segmentType === 'arc' && arcRunLen >= 2) {
          // Closing point completes the arc triplet.
          const closingPoint: InProgressPoint = {
            x:           snapNorm.x,
            y:           snapNorm.y,
            snapped:     true,
            segmentId:   firstReal?.segmentId,
            segmentType: 'arc',
          };
          finishMeasurement([...tempPoints, closingPoint]);
          return;
        }

        if (lastReal?.segmentType === 'arc' && arcRunLen === 1) {
          // Only 1 arc point in run — completing as arc leaves a 2-point run
          // which is still incomplete. Close as line instead.
          const closingPoint: InProgressPoint = {
            x:           snapNorm.x,
            y:           snapNorm.y,
            snapped:     true,
            segmentId:   firstReal?.segmentId,
            segmentType: 'line',
          };
          finishMeasurement([...tempPoints, closingPoint]);
          return;
        }

        // Default polyarc case: last run is 'line', closing point extends it.
        const closingPoint: InProgressPoint = {
          x:           snapNorm.x,
          y:           snapNorm.y,
          snapped:     true,
          segmentId:   firstReal?.segmentId,
          segmentType: lastReal?.segmentType ?? 'line',
        };
        finishMeasurement([...tempPoints, closingPoint]);
        return;
      }

      // ── linear / polygon ──────────────────────────────────────────────────
      const closingPoint: InProgressPoint = {
        x:           snapNorm.x,
        y:           snapNorm.y,
        snapped:     true,
        segmentId:   firstReal?.segmentId,
        segmentType: lastReal?.segmentType,
      };
      finishMeasurement([...tempPoints, closingPoint]);
      return;
    }

    const snap = snapToCorner(rawX, rawY);
    if (snap.snapped) triggerSnapFlash(snap.point.x, snap.point.y);
    const norm = toNorm(snap.point.x, snap.point.y);

    if (activeTool === 'point') {
      commitMeasurement({
        id: crypto.randomUUID(), drawingId: activeDrawingId || '',
        description: 'Point Marker', type: 'Point',
        quantity: 1, unit: 'PT', unitRate: 0, notes: '',
        points: [norm], isOverridden: false, color: getNextMeasurementColor(),
        isVisible: true, label: '', childIds: [],
      });
      return;
    }

    if (activeTool === 'count') {
      pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped });
      return;
    }

    if (activeTool === 'linear') {
      let segmentId: string;
      if (tempPoints.length === 0) segmentId = crypto.randomUUID();
      else if (pendingBreak) {
        segmentId = nextSegmentIdRef.current ?? crypto.randomUUID();
        nextSegmentIdRef.current = null;
        setPendingBreak(false);
      } else segmentId = tempPoints[tempPoints.length - 1].segmentId!;
      pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped, segmentId });
      return;
    }

    if (activeTool === 'polygon') {
      let segmentId: string;
      if (tempPoints.length === 0) segmentId = crypto.randomUUID();
      else if (pendingBreak) {
        segmentId = nextSegmentIdRef.current ?? crypto.randomUUID();
        nextSegmentIdRef.current = null;
        setPendingBreak(false);
      } else segmentId = tempPoints[tempPoints.length - 1].segmentId!;
      pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped, segmentId });
      return;
    }

    // ── POLYARC ───────────────────────────────────────────────────────────────
    if (activeTool === 'polyarc') {
      const segmentType: 'line' | 'arc' = (e.shiftKey || polyarcMode === 'arc') ? 'arc' : 'line';
      for (const p of polyarcClickPoints(tempPoints, segmentType, { x: norm.x, y: norm.y, snapped: snap.snapped })) {
        pushPoint(p);
      }
      return;
    }

    // ── Rectangle: 2-click auto-commit ───────────────────────────────────────
    if (activeTool === 'rectangle') {
      const segs    = groupPointsBySegment(tempPoints);
      const lastSeg = segs.length > 0 ? segs[segs.length - 1] : null;
      const needsNewSeg =
        !lastSeg || lastSeg.points.length === 0 || lastSeg.points.length >= 2 || pendingBreak;
      if (needsNewSeg) {
        const segmentId = pendingBreak
          ? (nextSegmentIdRef.current ?? crypto.randomUUID())
          : crypto.randomUUID();
        if (pendingBreak) { nextSegmentIdRef.current = null; setPendingBreak(false); }
        pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped, segmentId });
      } else {
        const segmentId = lastSeg!.points[0].segmentId!;
        pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped, segmentId });
        const p1 = lastSeg!.points[0];
        const p2: InProgressPoint = { x: norm.x, y: norm.y, snapped: snap.snapped, segmentId };
        setTimeout(() => { finishMeasurement([p1, p2]); }, 0);
      }
      return;
    }

    if (activeTool === 'arc') {
      const inProgress = inProgressArcPoints(tempPoints);
      if (inProgress.length < 2) {
        pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped }); return;
      }
      pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped });
      setTimeout(() => { pushPoint({ ...ARC_SENTINEL }); }, 0);
      return;
    }

    if (activeTool === 'radius') {
      const groups     = splitRadiusPoints(tempPoints);
      const inProgress = groups[groups.length - 1];
      if (inProgress.length < 1) {
        pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped }); return;
      }
      pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped });
      setTimeout(() => { pushPoint({ ...RADIUS_SENTINEL }); }, 0);
      return;
    }

    if (activeTool === 'scale') {
      if (tempPoints.length === 0) {
        pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped });
      } else {
        const p0    = toCanvas(tempPoints[0].x, tempPoints[0].y);
        const p1    = { x: snap.point.x, y: snap.point.y };
        const ptLen = Math.hypot(p1.x - p0.x, p1.y - p0.y) / scaleRef.current;
        clearTempPoints(); setCursorPoint(null);
        cursorPointRef.current = null;
        resetBreakState(); setActiveTool('select'); onScalePrompt(ptLen);
      }
      return;
    }

    pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped });
  }, [
    activeTool, snapToCorner, triggerSnapFlash, toNorm, toCanvas,
    commitMeasurement, pushPoint, clearTempPoints, drawingCanvasRef, activeDrawingId,
    tempPoints, pendingBreak, scaleRef, resetBreakState,
    setActiveTool, cursorPointRef, onScalePrompt, nextSegmentIdRef, setPendingBreak,
    setCursorPoint, finishMeasurement,
    polyarcMode,
    nearStartPointRef, startPointSnapRef,
  ]);

  // ─── handleContextMenu ────────────────────────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (activeTool === 'select') return;

    if (activeTool === 'count' || activeTool === 'point') {
      finishMeasurement(); return;
    }

    if (activeTool === 'linear' || activeTool === 'polygon') {
      if (tempPoints.length === 0) return;
      if (appendToGroupId && tempPoints.length >= (activeTool === 'linear' ? 2 : 3)) {
        finishMeasurement(); return;
      }
      nextSegmentIdRef.current = crypto.randomUUID();
      setPendingBreak(true); return;
    }

    if (activeTool === 'polyarc') {
      const segments = splitPolyarcSegments(tempPoints);
      const hasContent = segments.some(s =>
        (s.type === 'line' && s.points.length >= 2) ||
        (s.type === 'arc'  && s.points.length === 3)
      );
      if (hasContent) { finishMeasurement(); return; }
      clearTempPoints(); setCursorPoint(null); return;
    }

    if (activeTool === 'rectangle') {
      if (tempPoints.length === 0) return;
      clearTempPoints(); setCursorPoint(null); return;
    }

    if (activeTool === 'arc') {
      const groups = splitArcPoints(tempPoints);
      const staged = groups.filter(g => g.length === 3);
      if (staged.length === 0) {
        clearTempPoints(); setCursorPoint(null); setActiveTool('select');
      } else {
        clearTempPoints();
        const rebuilt: InProgressPoint[] = [];
        staged.forEach((arc, i) => {
          rebuilt.push(...arc);
          if (i < staged.length - 1) rebuilt.push({ ...ARC_SENTINEL });
        });
        rebuilt.push({ ...ARC_SENTINEL });
        const toRepush = [...rebuilt];
        const repush   = (i: number) => {
          if (i >= toRepush.length) return;
          pushPoint(toRepush[i]);
          setTimeout(() => repush(i + 1), 0);
        };
        setTimeout(() => repush(0), 0);
      }
      return;
    }

    if (activeTool === 'radius') {
      const groups = splitRadiusPoints(tempPoints);
      const staged = groups.filter(g => g.length === 2);
      if (staged.length === 0) {
        clearTempPoints(); setCursorPoint(null); setActiveTool('select');
      } else {
        clearTempPoints();
        const rebuilt: InProgressPoint[] = [];
        staged.forEach((circle, i) => {
          rebuilt.push(...circle);
          if (i < staged.length - 1) rebuilt.push({ ...RADIUS_SENTINEL });
        });
        rebuilt.push({ ...RADIUS_SENTINEL });
        const toRepush = [...rebuilt];
        const repush   = (i: number) => {
          if (i >= toRepush.length) return;
          pushPoint(toRepush[i]);
          setTimeout(() => repush(i + 1), 0);
        };
        setTimeout(() => repush(0), 0);
      }
      return;
    }
  }, [
    activeTool, tempPoints, finishMeasurement, appendToGroupId, nextSegmentIdRef,
    setPendingBreak, clearTempPoints, setCursorPoint, setActiveTool, pushPoint,
  ]);

  return { finishMeasurement, handleCanvasClick, handleContextMenu, checkSnapCandidates };
}
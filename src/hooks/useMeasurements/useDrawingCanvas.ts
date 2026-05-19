// ─── hooks/useMeasurements/useDrawingCanvas.ts ────────────────────────────────

import { useRef, useEffect, useCallback, useState } from 'react';
import React from 'react';
import { ToolType, TakeoffRow } from '@/types';
import type { PdfDimensions } from '@/types/viewerTypes';
import type { DragState } from './types';
import type { InProgressPoint } from '@/context/TakeoffContext';

import {
  splitArcPoints, isArcSentinel,
  splitRadiusPoints, isRadiusSentinel,
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
}

interface UseDrawingCanvasReturn {
  cursorPoint:    { x: number; y: number } | null;
  setCursorPoint: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  redrawDrawingCanvas: (pt?: { x: number; y: number }) => void;
  handleCanvasPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
}

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

const COLOUR_ACTIVE     = '#EF9F27';
const COLOUR_ARC        = '#2DD4BF';
const COLOUR_ARC_STAGED = '#14B8A6';
const COLOUR_RADIUS     = '#A78BFA';
const COLOUR_RADIUS_STAGED = '#7C3AED';
const COLOUR_SNAP       = '#4ADE80';
const COLOUR_UNSNAPPED  = '#EF9F27';
const DOT_RADIUS        = 3.5;
const SNAP_DOT_RADIUS   = 4.5;
const LINE_WIDTH        = 1.5;
const DASH_ACTIVE       = [6, 4] as number[];
const DASH_PREVIEW      = [4, 4] as number[];

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
}: UseDrawingCanvasParams): UseDrawingCanvasReturn {
  const [cursorPoint, setCursorPoint] = useState<{ x: number; y: number } | null>(null);

  const toCanvas = useCallback(
    (nx: number, ny: number): { x: number; y: number } => {
      const dim = pdfDimensionsRef.current;
      if (!dim) return { x: 0, y: 0 };
      return { x: nx * dim.w, y: ny * dim.h };
    },
    [pdfDimensionsRef],
  );

  const redrawDrawingCanvas = useCallback(
    (overrideCursor?: { x: number; y: number }) => {
      const canvas = drawingCanvasRef.current;
      const dim    = pdfDimensionsRef.current;
      if (!canvas || !dim) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const cursor = overrideCursor ?? cursorPointRef.current;

      // ── Draw committed measurements ──────────────────────────────────────
      for (const m of measurements) {
        if (!m.isVisible || !m.points?.length) continue;
        const pts = m.points.map(p => toCanvas(p.x, p.y));
        const col = m.color ?? COLOUR_ACTIVE;

        ctx.save();
        ctx.strokeStyle = col;
        ctx.fillStyle   = col;
        ctx.lineWidth   = 1;
        ctx.globalAlpha = 0.7;

        const isArcRow    = m.arcRadius != null && Math.abs((m.sweepAngle ?? 0) - 2 * Math.PI) > 0.01;
        const isRadiusRow = m.arcRadius != null && Math.abs((m.sweepAngle ?? 0) - 2 * Math.PI) < 0.01;

        if (isArcRow && pts.length === 3) {
          drawArcFromPoints(ctx, pts);
        } else if (isRadiusRow && pts.length === 2) {
          const r = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
          ctx.beginPath();
          ctx.arc(pts[0].x, pts[0].y, r, 0, 2 * Math.PI);
          ctx.stroke();
          ctx.globalAlpha = 0.4;
          ctx.beginPath();
          ctx.moveTo(pts[0].x - 5, pts[0].y); ctx.lineTo(pts[0].x + 5, pts[0].y);
          ctx.moveTo(pts[0].x, pts[0].y - 5); ctx.lineTo(pts[0].x, pts[0].y + 5);
          ctx.stroke();
        } else if (m.type === 'Length') {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.stroke();
        } else if (m.type === 'Polygon' || m.type === 'Area') {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
          ctx.globalAlpha = 0.15;
          ctx.fill();
          ctx.globalAlpha = 0.7;
          ctx.stroke();
        }

        ctx.restore();
      }

      if (tempPoints.length === 0 && !cursor) return;

      const nonSentinelPoints = tempPoints.filter(
        p => !isArcSentinel(p) && !isRadiusSentinel(p)
      );
      const tPts = nonSentinelPoints.map(p => toCanvas(p.x, p.y));

      // ── ARC TOOL ────────────────────────────────────────────────────────
      if (activeTool === 'arc') {
        ctx.save();
        const arcGroups      = splitArcPoints(tempPoints);
        const inProgressGroup = arcGroups[arcGroups.length - 1];
        const stagedGroups   = arcGroups.slice(0, -1).filter(g => g.length === 3);

        if (stagedGroups.length > 0) {
          ctx.strokeStyle = COLOUR_ARC_STAGED;
          ctx.lineWidth   = LINE_WIDTH + 0.5;
          ctx.setLineDash([]);
          ctx.globalAlpha = 0.85;
          for (const group of stagedGroups) {
            const cPts = group.map(p => toCanvas(p.x, p.y));
            drawArcFromPoints(ctx, cPts);
          }
          for (const group of stagedGroups) {
            const cPts = group.map(p => toCanvas(p.x, p.y));
            cPts.forEach((pt, i) => {
              ctx.fillStyle   = i === 0 || i === 2 ? COLOUR_ARC_STAGED : COLOUR_SNAP;
              ctx.globalAlpha = 0.6;
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, DOT_RADIUS, 0, 2 * Math.PI);
              ctx.fill();
            });
          }
          ctx.globalAlpha = 1;
        }

        const ipPts = inProgressGroup.map(p => toCanvas(p.x, p.y));
        ctx.strokeStyle = COLOUR_ARC;
        ctx.lineWidth   = LINE_WIDTH;
        ctx.setLineDash(DASH_PREVIEW);

        if (ipPts.length === 1 && cursor) {
          ctx.beginPath();
          ctx.moveTo(ipPts[0].x, ipPts[0].y);
          ctx.lineTo(cursor.x, cursor.y);
          ctx.stroke();
        } else if (ipPts.length === 2 && cursor) {
          const arc = circumscribedCircleCanvas(ipPts[0], ipPts[1], cursor);
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
            ctx.fillStyle = COLOUR_ARC;
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
        }

        ctx.setLineDash([]);
        ipPts.forEach((pt, i) => {
          const srcPt  = inProgressGroup[i];
          const isSnap = srcPt?.snapped ?? false;
          ctx.fillStyle   = isSnap ? COLOUR_SNAP : COLOUR_ARC;
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, isSnap ? SNAP_DOT_RADIUS : DOT_RADIUS, 0, 2 * Math.PI);
          ctx.fill();
          ctx.fillStyle = COLOUR_ARC;
          ctx.font = 'bold 9px monospace';
          ctx.fillText(['①', '②', '③'][i] ?? `${i + 1}`, pt.x + 6, pt.y - 4);
        });

        if (stagedGroups.length > 0) {
          const firstPt = toCanvas(stagedGroups[0][0].x, stagedGroups[0][0].y);
          ctx.fillStyle   = COLOUR_ARC_STAGED;
          ctx.font        = 'bold 9px monospace';
          ctx.globalAlpha = 0.9;
          ctx.fillText(`${stagedGroups.length} arc${stagedGroups.length > 1 ? 's' : ''} staged`, firstPt.x, firstPt.y - 10);
          ctx.globalAlpha = 1;
        }

        if (cursor) {
          ctx.strokeStyle = COLOUR_ARC;
          ctx.lineWidth   = 1;
          ctx.beginPath();
          ctx.arc(cursor.x, cursor.y, DOT_RADIUS, 0, 2 * Math.PI);
          ctx.stroke();
        }

        ctx.restore();
        return;
      }

      // ── RADIUS TOOL ──────────────────────────────────────────────────────
      if (activeTool === 'radius') {
        ctx.save();

        const radiusGroups   = splitRadiusPoints(tempPoints);
        const stagedCircles  = radiusGroups.slice(0, -1).filter(g => g.length === 2);
        const inProgressGroup = radiusGroups[radiusGroups.length - 1];
        const ipPts          = inProgressGroup.map(p => toCanvas(p.x, p.y));

        // Draw staged circles (solid purple)
        if (stagedCircles.length > 0) {
          ctx.strokeStyle = COLOUR_RADIUS_STAGED;
          ctx.lineWidth   = LINE_WIDTH + 0.5;
          ctx.setLineDash([]);
          ctx.globalAlpha = 0.85;

          for (const circle of stagedCircles) {
            const [centre, edge] = circle.map(p => toCanvas(p.x, p.y));
            const r = Math.hypot(edge.x - centre.x, edge.y - centre.y);
            ctx.beginPath();
            ctx.arc(centre.x, centre.y, r, 0, 2 * Math.PI);
            ctx.stroke();
            // Centre crosshair
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            ctx.moveTo(centre.x - 6, centre.y); ctx.lineTo(centre.x + 6, centre.y);
            ctx.moveTo(centre.x, centre.y - 6); ctx.lineTo(centre.x, centre.y + 6);
            ctx.stroke();
            ctx.globalAlpha = 0.85;
            // Centre dot
            ctx.fillStyle = COLOUR_RADIUS_STAGED;
            ctx.beginPath();
            ctx.arc(centre.x, centre.y, DOT_RADIUS, 0, 2 * Math.PI);
            ctx.fill();
          }

          // Staged count badge
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

        // Draw in-progress circle preview (dashed)
        ctx.strokeStyle = COLOUR_RADIUS;
        ctx.lineWidth   = LINE_WIDTH;

        if (ipPts.length === 0 && cursor) {
          // No points yet — ghost circle at cursor
          ctx.setLineDash(DASH_PREVIEW);
          ctx.beginPath();
          ctx.arc(cursor.x, cursor.y, 16, 0, 2 * Math.PI);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cursor.x - 8, cursor.y); ctx.lineTo(cursor.x + 8, cursor.y);
          ctx.moveTo(cursor.x, cursor.y - 8); ctx.lineTo(cursor.x, cursor.y + 8);
          ctx.stroke();
        } else if (ipPts.length === 1 && cursor) {
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

          // Radius label
          const realR = (r / dim.w) * scaleFactor;
          ctx.fillStyle = COLOUR_RADIUS;
          ctx.font = 'bold 9px monospace';
          const midX = (centre.x + cursor.x) / 2;
          const midY = (centre.y + cursor.y) / 2;
          ctx.fillText(`r=${realR.toFixed(3)}m`, midX + 4, midY - 4);

          // Centre crosshair + dot
          ctx.globalAlpha = 0.6;
          ctx.beginPath();
          ctx.moveTo(centre.x - 6, centre.y); ctx.lineTo(centre.x + 6, centre.y);
          ctx.moveTo(centre.x, centre.y - 6); ctx.lineTo(centre.x, centre.y + 6);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = COLOUR_RADIUS;
          ctx.beginPath();
          ctx.arc(centre.x, centre.y, DOT_RADIUS, 0, 2 * Math.PI);
          ctx.fill();
        }

        ctx.setLineDash([]);
        ctx.restore();
        return;
      }

      // ── GRID-COUNT TOOL ──────────────────────────────────────────────────
      if (activeTool === 'grid-count') return;

      // ── LINEAR TOOL ──────────────────────────────────────────────────────
      if (activeTool === 'linear') {
        if (tPts.length === 0) return;
        ctx.save();
        ctx.strokeStyle = COLOUR_ACTIVE;
        ctx.lineWidth   = LINE_WIDTH;

        ctx.beginPath();
        ctx.moveTo(tPts[0].x, tPts[0].y);
        for (let i = 1; i < tPts.length; i++) ctx.lineTo(tPts[i].x, tPts[i].y);
        ctx.stroke();

        if (cursor) {
          ctx.setLineDash(DASH_ACTIVE);
          const last = tPts[tPts.length - 1];
          ctx.beginPath();
          ctx.moveTo(last.x, last.y);
          ctx.lineTo(cursor.x, cursor.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        tPts.forEach((pt, i) => {
          const isSnapped = nonSentinelPoints[i]?.snapped ?? false;
          ctx.fillStyle = isSnapped ? COLOUR_SNAP : COLOUR_UNSNAPPED;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, isSnapped ? SNAP_DOT_RADIUS : DOT_RADIUS, 0, 2 * Math.PI);
          ctx.fill();
        });

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
        return;
      }

      // ── POLYGON / RECTANGLE TOOL ─────────────────────────────────────────
      if (activeTool === 'polygon' || activeTool === 'rectangle') {
        if (tPts.length === 0) return;
        ctx.save();
        ctx.strokeStyle = COLOUR_ACTIVE;
        ctx.lineWidth   = LINE_WIDTH;

        ctx.beginPath();
        ctx.moveTo(tPts[0].x, tPts[0].y);
        for (let i = 1; i < tPts.length; i++) ctx.lineTo(tPts[i].x, tPts[i].y);

        if (cursor && tPts.length > 1) {
          ctx.setLineDash(DASH_ACTIVE);
          ctx.lineTo(cursor.x, cursor.y);
          ctx.lineTo(tPts[0].x, tPts[0].y);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        if (tPts.length > 2) {
          ctx.globalAlpha = 0.08;
          ctx.fillStyle   = COLOUR_ACTIVE;
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        tPts.forEach((pt, i) => {
          const isSnapped = nonSentinelPoints[i]?.snapped ?? false;
          ctx.fillStyle = isSnapped ? COLOUR_SNAP : COLOUR_UNSNAPPED;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, isSnapped ? SNAP_DOT_RADIUS : DOT_RADIUS, 0, 2 * Math.PI);
          ctx.fill();
        });

        if (cursor) {
          ctx.strokeStyle = COLOUR_ACTIVE;
          ctx.lineWidth   = 1;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(cursor.x, cursor.y, DOT_RADIUS, 0, 2 * Math.PI);
          ctx.stroke();
        }

        ctx.restore();
        return;
      }

      // ── COUNT TOOL ───────────────────────────────────────────────────────
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
        return;
      }

      // ── POINT TOOL ───────────────────────────────────────────────────────
      if (activeTool === 'point') {
        ctx.save();
        tPts.forEach(pt => {
          ctx.fillStyle = COLOUR_ACTIVE;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 5, 0, 2 * Math.PI);
          ctx.fill();
        });
        ctx.restore();
        return;
      }

      // ── SCALE TOOL ───────────────────────────────────────────────────────
      if (activeTool === 'scale') {
        if (tPts.length === 0) return;
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

        ctx.restore();
        return;
      }
    },
    [
      drawingCanvasRef, pdfDimensionsRef, measurements, tempPoints,
      activeTool, scaleFactor, pendingBreak, toCanvas, cursorPointRef,
    ],
  );

  const handleCanvasPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = drawingCanvasRef.current;
      const dim    = pdfDimensionsRef.current;
      if (!canvas || !dim) return;

      const rect    = canvas.getBoundingClientRect();
      const canvasX = (e.clientX - rect.left) * (canvas.width  / rect.width);
      const canvasY = (e.clientY - rect.top)  * (canvas.height / rect.height);

      let snappedCanvas = { x: canvasX, y: canvasY };

      if (snapEnabledRef.current && snapToCorner) {
        const s = snapToCorner(canvasX, canvasY);
        if (s) snappedCanvas = { x: s.x, y: s.y };
      }

      cursorPointRef.current = snappedCanvas;
      setCursorPoint(snappedCanvas);
      redrawDrawingCanvas(snappedCanvas);
      redrawPinCanvas();
    },
    [
      drawingCanvasRef, pdfDimensionsRef, snapEnabledRef,
      snapToCorner, cursorPointRef, redrawDrawingCanvas, redrawPinCanvas,
    ],
  );

  useEffect(() => {
    redrawDrawingCanvas(cursorPointRef.current ?? undefined);
  }, [tempPoints, activeTool, measurements, redrawDrawingCanvas, cursorPointRef]);

  return {
    cursorPoint,
    setCursorPoint,
    redrawDrawingCanvas,
    handleCanvasPointerMove,
  };
}
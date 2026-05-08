// ─── hooks/useMeasurements/useDrawingCanvas.ts ────────────────────────────────
//
//  Extracted from useMeasurements.ts — #2 / #5 hook split.
//  Owns all canvas drawing: committed measurements, drag preview, in-progress
//  temp point drawing, and the RAF-throttled pointer move handler.
//
//  Fixes preserved from original:
//    #1  — RAF cleanup on every effect re-run
//    #9  — drawCommittedMeasurements is a single shared helper (no duplication)
//    #10 — RAF throttle on pointer move (200+ Hz → ~60 Hz)
//
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useEffect, useCallback, useState } from 'react';
import React from 'react';
import { TakeoffRow } from '@/types';
import { PdfDimensions, CanvasPoint, canvasPt } from '@/types/viewerTypes';
import { DragState } from './types';
import { toCanvas as toCanvasUtil, toNorm as toNormUtil } from './utils';
import type { InProgressPoint } from '@/context/TakeoffContext';

interface UseDrawingCanvasParams {
  drawingCanvasRef:  React.RefObject<HTMLCanvasElement>;
  pdfDimensionsRef:  React.MutableRefObject<PdfDimensions | null>;
  scaleRef:          React.MutableRefObject<number>;
  measurements:      TakeoffRow[];
  tempPoints:        InProgressPoint[];
  activeTool:        string;
  scaleFactor:       number;
  isPanning:         boolean;
  pendingBreak:      boolean;
  dragStateRef:      React.MutableRefObject<DragState | null>;
  cursorPointRef:    React.MutableRefObject<{ x: number; y: number } | null>;
  snapToCorner:      (x: number, y: number) => { point: { x: number; y: number }; snapped: boolean };
  redrawPinCanvas:   () => void;
  snapEnabledRef:    React.MutableRefObject<boolean>;
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
}: UseDrawingCanvasParams) {

  const [cursorPoint, setCursorPoint] = useState<{ x: number; y: number } | null>(null);

  // FIX #10 — RAF ref for pointer move throttle
  const pointerRafRef = useRef<number | null>(null);
  // FIX #1 — RAF ref for main draw effect
  const rafIdRef = useRef<number | null>(null);

    const toCanvas = useCallback((normX: number, normY: number) => {
    return toCanvasUtil(normX, normY, pdfDimensionsRef.current);
    }, [pdfDimensionsRef]);

  const toNorm = useCallback((canvasX: number, canvasY: number) => {
    return toNormUtil(canvasX, canvasY, pdfDimensionsRef.current);
  }, [pdfDimensionsRef]);

  // ── FIX #9: single shared draw helper — used by both redrawDrawingCanvas and main effect ──
  const drawCommittedMeasurements = useCallback((
    ctx: CanvasRenderingContext2D,
    overridePoint?: { measurementId: string; pointIndex: number; point: { x: number; y: number } },
  ) => {
    measurements.forEach(m => {
      if (m.isGroupHeader && m.childIds && m.childIds.length > 0) return;
      if (!m.isVisible || m.points.length === 0) return;

      let pts = m.points.map(p => toCanvas(p.x, p.y));
      if (overridePoint && overridePoint.measurementId === m.id) {
        pts = pts.map((p, i) =>
          i === overridePoint.pointIndex ? overridePoint.point : p
        );
      }

      if (m.type === 'Count' || m.type === 'Point') {
        pts.forEach(p => {
          ctx.save();
          ctx.beginPath();
          ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
          ctx.fillStyle = m.color + '18';
          ctx.fill();
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = m.color;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.6)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.restore();
        });
      } else {
        ctx.strokeStyle = m.color;
        ctx.fillStyle   = m.color + '55';
        ctx.lineWidth   = 2.5;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));

        const measurementType = m.type as string;
        if (measurementType === 'Polygon' || measurementType === 'Rectangle') {
          ctx.closePath();
          ctx.fill();
        }
        ctx.stroke();

        pts.forEach((p, idx) => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, activeTool === 'select' ? 6 : 4, 0, Math.PI * 2);
          ctx.fillStyle = m.color + (activeTool === 'select' ? 'CC' : '88');
          ctx.fill();
          ctx.strokeStyle = m.color;
          ctx.lineWidth = activeTool === 'select' ? 1.5 : 1;
          ctx.stroke();

          const activeOverride = overridePoint ?? (dragStateRef.current ?? null);
          const isActivePoint = activeOverride
            && 'measurementId' in activeOverride
            && activeOverride.measurementId === m.id
            && ('pointIndex' in activeOverride ? activeOverride.pointIndex === idx : false);

          if (isActivePoint) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
            ctx.strokeStyle = '#F59E0B';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        });
      }
    });
  }, [measurements, toCanvas, activeTool, dragStateRef]);

  // ── Imperative redraw for drag preview ────────────────────────────────────
  const redrawDrawingCanvas = useCallback((draggedPointCanvas?: { x: number; y: number }) => {
    const canvas = drawingCanvasRef.current;
    const dims   = pdfDimensionsRef.current;
    if (!canvas || !dims) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const override = draggedPointCanvas && dragStateRef.current ? {
      measurementId: dragStateRef.current.measurementId,
      pointIndex:    dragStateRef.current.pointIndex,
      point:         draggedPointCanvas,
    } : undefined;

    drawCommittedMeasurements(ctx, override);

    if (draggedPointCanvas) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(draggedPointCanvas.x, draggedPointCanvas.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#F59E0B44';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(draggedPointCanvas.x, draggedPointCanvas.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#F59E0B';
      ctx.fill();
      ctx.restore();
    }
  }, [drawingCanvasRef, pdfDimensionsRef, drawCommittedMeasurements, dragStateRef]);

  // ── FIX #10: RAF-throttled pointer move ───────────────────────────────────
  const handleCanvasPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // drag move is handled by usePointDrag — don't intercept it here
    if (dragStateRef.current?.isDragging) return;
    if (activeTool === 'select' || isPanning) return;

    const canvas = drawingCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    // capture coords synchronously — synthetic event is pooled and nullified before RAF fires
    const rawX = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const rawY = (e.clientY - rect.top)  * (canvas.height / rect.height);

    if (pointerRafRef.current !== null) cancelAnimationFrame(pointerRafRef.current);

    pointerRafRef.current = requestAnimationFrame(() => {
      pointerRafRef.current = null;
      cursorPointRef.current = { x: rawX, y: rawY };
      redrawPinCanvas();
      const snap = snapToCorner(rawX, rawY);
      setCursorPoint(snap.point);
      cursorPointRef.current = snap.point;
    });
  }, [activeTool, isPanning, snapToCorner, redrawPinCanvas, cursorPointRef, drawingCanvasRef, dragStateRef]);

  // ── FIX #1: main draw effect with RAF cleanup ─────────────────────────────
  useEffect(() => {
    // cancel any pending frame before scheduling a new one
    if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);

    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;

      const canvas = drawingCanvasRef.current;
      const dims   = pdfDimensionsRef.current;
      if (!canvas || !dims) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const override = dragStateRef.current && cursorPoint ? {
        measurementId: dragStateRef.current.measurementId,
        pointIndex:    dragStateRef.current.pointIndex,
        point:         cursorPoint,
      } : undefined;

      drawCommittedMeasurements(ctx, override);

      // amber drag handle dot
      if (dragStateRef.current && cursorPoint) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cursorPoint.x, cursorPoint.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#F59E0B44';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cursorPoint.x, cursorPoint.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#F59E0B';
        ctx.fill();
        ctx.restore();
      }

      if (!dragStateRef.current) {
        const tempPx = tempPoints.map(p => ({
          ...toCanvas(p.x, p.y),
          snapped:   p.snapped,
          segmentId: p.segmentId,
        }));

        const hasTemp   = tempPx.length > 0;
        const hasCursor = !!cursorPoint && activeTool !== 'select';
        if (!hasTemp && !hasCursor) return;

        const strokeColor = '#F59E0B';

        if (activeTool === 'count') {
          const DOT_R = 5;
          tempPx.forEach((p, idx) => {
            ctx.save();
            ctx.beginPath();
            ctx.arc(p.x, p.y, DOT_R * 1.8, 0, Math.PI * 2);
            ctx.fillStyle = (p.snapped ? '#22C55E' : strokeColor) + '22';
            ctx.fill();
            if (!p.snapped) {
              ctx.beginPath();
              ctx.arc(p.x, p.y, DOT_R + 4, 0, Math.PI * 2);
              ctx.strokeStyle = strokeColor + '60';
              ctx.lineWidth = 1;
              ctx.setLineDash([3, 3]);
              ctx.stroke();
              ctx.setLineDash([]);
            }
            ctx.beginPath();
            ctx.arc(p.x, p.y, DOT_R, 0, Math.PI * 2);
            ctx.fillStyle = p.snapped ? '#22C55E' : strokeColor;
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.7)';
            ctx.lineWidth = 1.2;
            ctx.stroke();
            const bx = p.x + DOT_R + 2;
            const by = p.y - DOT_R - 2;
            ctx.beginPath();
            ctx.arc(bx, by, 6, 0, Math.PI * 2);
            ctx.fillStyle = p.snapped ? '#22C55E' : strokeColor;
            ctx.fill();
            ctx.fillStyle    = 'black';
            ctx.font         = 'bold 8px monospace';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText((idx + 1).toString(), bx, by);
            ctx.restore();
          });
          if (cursorPoint) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(cursorPoint.x, cursorPoint.y, DOT_R, 0, Math.PI * 2);
            ctx.strokeStyle = strokeColor + '70';
            ctx.lineWidth   = 1.5;
            ctx.setLineDash([3, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
          }
          if (cursorPoint && tempPx.length > 0) {
            const text = `${tempPx.length} placed — click Finish to commit`;
            ctx.save();
            ctx.font         = 'bold 11px monospace';
            ctx.textAlign    = 'left';
            ctx.textBaseline = 'alphabetic';
            const tw = ctx.measureText(text).width;
            ctx.fillStyle = strokeColor;
            ctx.fillRect(cursorPoint.x + DOT_R + 8, cursorPoint.y - 20, tw + 10, 19);
            ctx.fillStyle = 'black';
            ctx.fillText(text, cursorPoint.x + DOT_R + 13, cursorPoint.y - 5);
            ctx.restore();
          }
          return;
        }

        ctx.strokeStyle = strokeColor;
        ctx.setLineDash([5, 5]);
        ctx.lineWidth   = 2;

        const segGroups: { id: string | undefined; pts: typeof tempPx }[] = [];
        for (const p of tempPx) {
          const last = segGroups[segGroups.length - 1];
          if (!last || last.id !== p.segmentId) {
            segGroups.push({ id: p.segmentId, pts: [p] });
          } else {
            last.pts.push(p);
          }
        }

        if (activeTool === 'linear' || activeTool === 'polygon' || activeTool === 'rectangle') {
          for (const seg of segGroups) {
            if (seg.pts.length === 0) continue;
            const isLastSeg = seg === segGroups[segGroups.length - 1];
            const showRubberBand = isLastSeg && !!cursorPoint && !pendingBreak;

            if (activeTool === 'rectangle') {
              if (seg.pts.length === 2) {
                const [p1, p2] = seg.pts;
                ctx.strokeStyle = strokeColor;
                ctx.setLineDash([5, 5]);
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p1.y);
                ctx.lineTo(p2.x, p2.y); ctx.lineTo(p1.x, p2.y);
                ctx.closePath();
                ctx.fillStyle = strokeColor + '30';
                ctx.fill();
                ctx.stroke();
              } else if (seg.pts.length === 1 && showRubberBand) {
                const p1 = seg.pts[0];
                const p2 = cursorPoint!;
                ctx.strokeStyle = strokeColor + '80';
                ctx.setLineDash([3, 3]);
                ctx.lineWidth   = 2;
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p1.y);
                ctx.lineTo(p2.x, p2.y); ctx.lineTo(p1.x, p2.y);
                ctx.closePath();
                ctx.fillStyle = strokeColor + '15';
                ctx.fill();
                ctx.stroke();
                ctx.strokeStyle = strokeColor;
                ctx.setLineDash([5, 5]);
                ctx.lineWidth   = 2;
              }
            } else if (activeTool === 'polygon') {
              ctx.beginPath();
              ctx.moveTo(seg.pts[0].x, seg.pts[0].y);
              for (let i = 1; i < seg.pts.length; i++) ctx.lineTo(seg.pts[i].x, seg.pts[i].y);
              if (showRubberBand) ctx.lineTo(cursorPoint!.x, cursorPoint!.y);
              if (seg.pts.length >= 2) {
                ctx.lineTo(seg.pts[0].x, seg.pts[0].y);
                ctx.fillStyle = strokeColor + '30';
                ctx.fill();
              }
              ctx.stroke();
            } else {
              ctx.beginPath();
              ctx.moveTo(seg.pts[0].x, seg.pts[0].y);
              for (let i = 1; i < seg.pts.length; i++) ctx.lineTo(seg.pts[i].x, seg.pts[i].y);
              if (showRubberBand) ctx.lineTo(cursorPoint!.x, cursorPoint!.y);
              ctx.stroke();
            }
          }
          ctx.setLineDash([]);
        } else {
          const allPts = [...tempPx.map(p => ({ x: p.x, y: p.y }))];
          if (cursorPoint && hasTemp) allPts.push(cursorPoint);
          if (allPts.length > 1) {
            ctx.beginPath();
            ctx.moveTo(allPts[0].x, allPts[0].y);
            allPts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }

        tempPx.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.snapped ? 6 : 4, 0, Math.PI * 2);
          ctx.fillStyle = p.snapped ? '#22C55E' : strokeColor;
          ctx.fill();
          if (p.snapped) {
            ctx.strokeStyle = '#22C55E';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        });

        if (cursorPoint) {
          ctx.beginPath();
          ctx.arc(cursorPoint.x, cursorPoint.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = pendingBreak ? '#60A5FA' : strokeColor;
          ctx.fill();
        }

        const allPtsForLabel = [...tempPx.map(p => ({ x: p.x, y: p.y }))];
        if (cursorPoint && hasTemp && !pendingBreak) allPtsForLabel.push(cursorPoint);

        if (allPtsForLabel.length > 1 && cursorPoint) {
          const zoom = scaleRef.current;
          let text = '';

          if (activeTool === 'rectangle') {
            const lastSeg = segGroups[segGroups.length - 1];
            if (lastSeg?.pts.length === 1 && !pendingBreak) {
              const w = Math.abs(cursorPoint.x - lastSeg.pts[0].x);
              const h = Math.abs(cursorPoint.y - lastSeg.pts[0].y);
              text = `${(w * h / (zoom * zoom) * scaleFactor * scaleFactor).toFixed(3)} sq m`;
            }
          } else if (activeTool === 'polygon' && allPtsForLabel.length > 2) {
            let a = 0;
            for (let i = 0; i < allPtsForLabel.length; i++) {
              const j = (i + 1) % allPtsForLabel.length;
              a += allPtsForLabel[i].x * allPtsForLabel[j].y - allPtsForLabel[j].x * allPtsForLabel[i].y;
            }
            text = `${(Math.abs(a) / 2 / (zoom * zoom) * scaleFactor * scaleFactor).toFixed(3)} sq m`;
          } else if (activeTool === 'linear' || activeTool === 'scale') {
            let len = 0;
            if (activeTool === 'linear' && tempPx.length > 0) {
              for (const seg of segGroups) {
                for (let i = 1; i < seg.pts.length; i++) {
                  len += Math.hypot(seg.pts[i].x - seg.pts[i-1].x, seg.pts[i].y - seg.pts[i-1].y);
                }
              }
              if (!pendingBreak) {
                const lastSeg = segGroups[segGroups.length - 1];
                if (lastSeg && lastSeg.pts.length > 0) {
                  const last = lastSeg.pts[lastSeg.pts.length - 1];
                  len += Math.hypot(cursorPoint.x - last.x, cursorPoint.y - last.y);
                }
              }
            } else {
              for (let i = 1; i < allPtsForLabel.length; i++) {
                len += Math.hypot(
                  allPtsForLabel[i].x - allPtsForLabel[i-1].x,
                  allPtsForLabel[i].y - allPtsForLabel[i-1].y,
                );
              }
            }
            text = activeTool === 'scale'
              ? `${(len / zoom).toFixed(3)} pts`
              : `${(len / zoom * scaleFactor).toFixed(3)} m`;
          }

          if (text) {
            ctx.font         = 'bold 12px monospace';
            ctx.textAlign    = 'left';
            ctx.textBaseline = 'alphabetic';
            const tw = ctx.measureText(text).width;
            ctx.fillStyle = strokeColor;
            ctx.fillRect(cursorPoint.x + 10, cursorPoint.y - 22, tw + 10, 20);
            ctx.fillStyle = 'black';
            ctx.fillText(text, cursorPoint.x + 15, cursorPoint.y - 7);
          }
        }
      }
    });

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [
    measurements, tempPoints, cursorPoint, activeTool, scaleFactor,
    toCanvas, pdfDimensionsRef, scaleRef, drawingCanvasRef, pendingBreak,
    drawCommittedMeasurements, dragStateRef,
  ]);

  // cleanup pointer RAF on unmount
  useEffect(() => {
    return () => {
      if (pointerRafRef.current !== null) cancelAnimationFrame(pointerRafRef.current);
    };
  }, []);

  return {
    cursorPoint,
    setCursorPoint,
    toCanvas,
    toNorm,
    redrawDrawingCanvas,
    handleCanvasPointerMove,
    drawCommittedMeasurements,
  };
}
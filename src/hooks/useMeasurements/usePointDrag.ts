import { useRef, useCallback } from 'react';
import React from 'react';
import { TakeoffRow } from '@/types';
import { PdfDimensions } from '@/types/viewerTypes';  // removed CanvasPoint, canvasPt
import { DragState, PointHitResult } from './types';
import { toCanvas as toCanvasUtil, toNorm as toNormUtil, recalculateMeasurementQuantity } from './utils';

// Plain coordinate pair — no brand required here.
// The brand on CanvasPoint guards against mixing norm/canvas coords at the
// rendering layer; it has no meaning in hit-test arithmetic.
type Point = { x: number; y: number };

interface UsePointDragParams {
  drawingCanvasRef:     React.RefObject<HTMLCanvasElement>;
  pdfDimensionsRef:     React.MutableRefObject<PdfDimensions | null>;
  scaleRef:             React.MutableRefObject<number>;
  measurements:         TakeoffRow[];
  activeTool:           string;
  activeDrawingId:      string | null;
  scaleFactor:          number;
  snapEnabledRef:       React.MutableRefObject<boolean>;
  snapToCorner:         (x: number, y: number) => { point: Point; snapped: boolean };
  triggerSnapFlash:     (x: number, y: number) => void;
  redrawPinCanvas:      () => void;
  cursorPointRef:       React.MutableRefObject<Point | null>;
  onUpdateMeasurement?: (id: string, updates: Partial<TakeoffRow>) => void;
  redrawDrawingCanvas:  (draggedPoint?: Point) => void;
}

export function usePointDrag({
  drawingCanvasRef,
  pdfDimensionsRef,
  scaleRef,
  measurements,
  activeTool,
  activeDrawingId,
  scaleFactor,
  snapEnabledRef,
  snapToCorner,
  triggerSnapFlash,
  redrawPinCanvas,
  cursorPointRef,
  onUpdateMeasurement,
  redrawDrawingCanvas,
}: UsePointDragParams) {

  const dragStateRef = useRef<DragState | null>(null);

  const toCanvas = useCallback(
    (normX: number, normY: number): Point =>
      toCanvasUtil(normX, normY, pdfDimensionsRef.current),
    [pdfDimensionsRef],
  );

  const toNorm = useCallback(
    (canvasX: number, canvasY: number): Point =>
      toNormUtil(canvasX, canvasY, pdfDimensionsRef.current),
    [pdfDimensionsRef],
  );

  const findPointUnderCursor = useCallback((
    canvasX: number,
    canvasY: number,
    hitRadius: number = 8,
  ): PointHitResult | null => {
    if (activeTool !== 'select') return null;

    const dims = pdfDimensionsRef.current;
    if (!dims) return null;

    const normCursor  = toNorm(canvasX, canvasY);
    const normRadiusX = hitRadius / dims.w;
    const normRadiusY = hitRadius / dims.h;
    const normRadius  = Math.max(normRadiusX, normRadiusY);

    for (const m of measurements) {
      if (!m.isVisible)                    continue;
      if (m.drawingId !== activeDrawingId) continue;
      if (m.isGroupHeader)                 continue;
      if (m.points.length === 0)           continue;

      let minX = Infinity,  maxX = -Infinity;
      let minY = Infinity,  maxY = -Infinity;
      for (const pt of m.points) {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
      }
      if (
        normCursor.x < minX - normRadius ||
        normCursor.x > maxX + normRadius ||
        normCursor.y < minY - normRadius ||
        normCursor.y > maxY + normRadius
      ) continue;

      for (let i = 0; i < m.points.length; i++) {
        const pt = toCanvas(m.points[i].x, m.points[i].y); // Point — no brand needed
        const dx = pt.x - canvasX;
        const dy = pt.y - canvasY;
        if (Math.hypot(dx, dy) <= hitRadius) {
          return {
            measurementId: m.id,
            pointIndex:    i,
            pointCanvas:   pt,
            measurement:   m,
          };
        }
      }
    }
    return null;
  }, [measurements, activeDrawingId, activeTool, toCanvas, toNorm, pdfDimensionsRef]);

  const handlePointDragStart = useCallback((
    e: React.PointerEvent<HTMLCanvasElement>,
    hit: PointHitResult,
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const canvas = drawingCanvasRef.current;
    if (!canvas) return;

    const rect    = canvas.getBoundingClientRect();
    const canvasX = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const canvasY = (e.clientY - rect.top)  * (canvas.height / rect.height);

    canvas.setPointerCapture(e.pointerId);

    // Plain object literal — DragState.originalPoint should be typed as Point,
    // not CanvasPoint, since DragState lives in types.ts which also has no
    // reason to import the brand. See types.ts fix below.
    dragStateRef.current = {
      isDragging:    true,
      measurementId: hit.measurementId,
      pointIndex:    hit.pointIndex,
      originalPoint: { x: canvasX, y: canvasY },
      parentId:      hit.measurement.parentId,
    };

    canvas.style.cursor = 'grabbing';
  }, [drawingCanvasRef]);

  const handlePointDragMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragStateRef.current?.isDragging) return;

    const canvas = drawingCanvasRef.current;
    if (!canvas) return;
    const rect    = canvas.getBoundingClientRect();
    const canvasX = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const canvasY = (e.clientY - rect.top)  * (canvas.height / rect.height);

    let livePoint: Point = { x: canvasX, y: canvasY };
    if (snapEnabledRef.current) {
      const snapResult = snapToCorner(canvasX, canvasY);
      if (snapResult.snapped) triggerSnapFlash(snapResult.point.x, snapResult.point.y);
      livePoint = snapResult.point;
    }

    cursorPointRef.current = livePoint;
    redrawDrawingCanvas(livePoint);
    redrawPinCanvas();
  }, [drawingCanvasRef, snapEnabledRef, snapToCorner, triggerSnapFlash,
      redrawPinCanvas, redrawDrawingCanvas, cursorPointRef]);

  const handlePointDragEnd = useCallback(() => {
    if (!dragStateRef.current?.isDragging) return;

    const drag             = dragStateRef.current;
    const finalCanvasPoint = cursorPointRef.current;

    if (finalCanvasPoint && onUpdateMeasurement) {
      const measurement = measurements.find(m => m.id === drag.measurementId);
      if (measurement && measurement.points[drag.pointIndex]) {
        const newNormPoint  = toNorm(finalCanvasPoint.x, finalCanvasPoint.y);
        const updatedPoints = [...measurement.points];
        updatedPoints[drag.pointIndex] = newNormPoint;

        const zoom = scaleRef.current;
        const { quantity, unit } = recalculateMeasurementQuantity(
          measurement,
          updatedPoints,
          toCanvas,
          zoom,
          scaleFactor,
        );

        onUpdateMeasurement(drag.measurementId, { points: updatedPoints, quantity, unit });
      }
    }

    dragStateRef.current   = null;
    cursorPointRef.current = null;

    if (drawingCanvasRef.current) {
      drawingCanvasRef.current.style.cursor = '';
    }

    redrawPinCanvas();
  }, [measurements, onUpdateMeasurement, toNorm, toCanvas, scaleRef, scaleFactor,
      drawingCanvasRef, redrawPinCanvas, cursorPointRef]);

  const handleCanvasPointerDown = useCallback((
    e: React.PointerEvent<HTMLCanvasElement>,
  ): boolean => {
    if (activeTool !== 'select') return false;

    const canvas = drawingCanvasRef.current;
    if (!canvas) return false;
    const rect    = canvas.getBoundingClientRect();
    const canvasX = (e.clientX - rect.left) * (canvas.width  / rect.width);
    const canvasY = (e.clientY - rect.top)  * (canvas.height / rect.height);

    const hit = findPointUnderCursor(canvasX, canvasY);
    if (hit) {
      handlePointDragStart(e, hit);
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    return false;
  }, [activeTool, drawingCanvasRef, findPointUnderCursor, handlePointDragStart]);

  const handleCanvasPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragStateRef.current?.isDragging) {
      handlePointDragEnd();
      e.preventDefault();
      e.stopPropagation();
    }
  }, [handlePointDragEnd]);

  return {
    dragStateRef,
    handleCanvasPointerDown,
    handleCanvasPointerMove: handlePointDragMove,
    handleCanvasPointerUp,
    isDragging: () => !!dragStateRef.current?.isDragging,
  };
}
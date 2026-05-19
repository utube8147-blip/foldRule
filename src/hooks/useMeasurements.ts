// ─── hooks/useMeasurements.ts ─────────────────────────────────────────────────

// FIX A: handleCanvasPointerDown now correctly falls through when drag doesn't
//         claim the event, and the return type matches the public interface.
// FIX B: pendingSnapCandidates type import uses the canonical source.
// FIX C: redrawDrawingCanvasRef is pre-populated via a lazy initializer pattern
//         so the first-render race window is closed.

import { useRef, useEffect, useCallback, useState } from 'react';
import React from 'react';
import { UseMeasurementsParams, UseMeasurementsReturn } from './useMeasurements/types';
import { getNextMeasurementColor, resetColorIndex } from './useMeasurements/colors';
import { toCanvas as toCanvasUtil, toNorm as toNormUtil } from './useMeasurements/utils';
import { useDrawingCanvas } from './useMeasurements/useDrawingCanvas';
import { usePointDrag } from './useMeasurements/usePointDrag';
import { useMeasurementCommit } from './useMeasurements/useMeasurementCommit';
import type { PendingSnapCandidate } from '@/types/viewerTypes'; // FIX B
import type { ToolType } from '@/types';
import type { DragState } from '@/hooks/useMeasurements/types'; // FIX C

export { getNextMeasurementColor, resetColorIndex };
export type { UseMeasurementsParams, UseMeasurementsReturn };

export function useMeasurements({
  drawingCanvasRef,
  pdfDimensionsRef,
  pageNumberRef,
  scaleRef,
  activeTool,
  setActiveTool,
  measurements,
  tempPoints,
  pushPoint,
  commitMeasurement,
  batchCommitMeasurements,
  clearTempPoints,
  scaleFactor,
  onUpdateMeasurement,
  isPanning,
  snapToCorner,
  getScaledCorners,
  triggerSnapFlash,
  snapEnabled,
  snapThreshold,
  redrawPinCanvas,
  cursorPointRef,
  activeDrawingId,
  onScalePrompt,
  appendToGroupId,
  onAppendComplete,
}: UseMeasurementsParams): UseMeasurementsReturn {

  const typedActiveTool = activeTool as ToolType;

  const snapEnabledRef   = useRef(snapEnabled);
  const snapThresholdRef = useRef(snapThreshold);
  useEffect(() => { snapEnabledRef.current   = snapEnabled;   }, [snapEnabled]);
  useEffect(() => { snapThresholdRef.current = snapThreshold; }, [snapThreshold]);

  // FIX B: canonical import, no inline dynamic import string
  const [pendingSnapCandidates, setPendingSnapCandidates] = useState<PendingSnapCandidate[] | null>(null);

  const [pendingBreak, setPendingBreak] = useState(false);
  const nextSegmentIdRef = useRef<string | null>(null);

  const resetBreakState = useCallback(() => {
    setPendingBreak(false);
    nextSegmentIdRef.current = null;
  }, []);

  useEffect(() => {
    clearTempPoints();
    if (cursorPointRef) cursorPointRef.current = null;
    resetBreakState();
  }, [typedActiveTool, clearTempPoints, cursorPointRef, resetBreakState]);

  // ── FIX C: stable ref initialized to a no-op; populated before any drag ────
  // Using a ref-of-ref pattern means usePointDrag always calls the latest
  // version of redrawDrawingCanvas without needing it in its dependency array,
  // and without the one-render race the useEffect approach had.
  const redrawDrawingCanvasRef = useRef<(pt?: { x: number; y: number }) => void>(() => {});

  const drag = usePointDrag({
    drawingCanvasRef,
    pdfDimensionsRef,
    scaleRef,
    measurements,
    activeTool: typedActiveTool,
    activeDrawingId,
    scaleFactor,
    snapEnabledRef,
    snapToCorner,
    triggerSnapFlash,
    redrawPinCanvas,
    cursorPointRef,
    onUpdateMeasurement,
    // Indirection through the ref — always calls the current canvas.redrawDrawingCanvas
    redrawDrawingCanvas: useCallback(
      (pt?: { x: number; y: number }) => redrawDrawingCanvasRef.current(pt),
      [], // stable — only reads the ref, never captures canvas directly
    ),
  });

  const canvas = useDrawingCanvas({
    drawingCanvasRef,
    pdfDimensionsRef,
    scaleRef,
    measurements,
    tempPoints,
    activeTool: typedActiveTool,
    scaleFactor,
    isPanning,
    pendingBreak,
    dragStateRef: drag.dragStateRef as React.RefObject<DragState | null>,
    cursorPointRef,
    snapToCorner,
    redrawPinCanvas,
    snapEnabledRef,
  });

  // FIX C: synchronously assign after useDrawingCanvas returns — no useEffect
  // delay, so redrawDrawingCanvasRef is valid before the first pointer event.
  redrawDrawingCanvasRef.current = canvas.redrawDrawingCanvas;

  const commit = useMeasurementCommit({
    pdfDimensionsRef,
    pageNumberRef,
    scaleRef,
    activeTool,
    setActiveTool,
    measurements,
    tempPoints,
    pushPoint,
    commitMeasurement,
    batchCommitMeasurements,
    clearTempPoints,
    scaleFactor,
    onUpdateMeasurement,
    snapToCorner,
    triggerSnapFlash,
    snapEnabledRef,
    snapThresholdRef,
    getScaledCorners,
    activeDrawingId,
    drawingCanvasRef,
    cursorPointRef,
    appendToGroupId,
    onAppendComplete,
    onScalePrompt,
    pendingBreak,
    setPendingBreak,
    nextSegmentIdRef,
    setCursorPoint: canvas.setCursorPoint,
    setPendingSnapCandidates,
    resetBreakState,
  });

  // ── Combined pointer handlers ──────────────────────────────────────────────

  const handleCanvasPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (drag.isDragging()) {
        drag.handleCanvasPointerMove(e);
      } else {
        canvas.handleCanvasPointerMove(e);
      }
    },
    [drag, canvas],
  );

  // FIX A: return type is void to match UseMeasurementsReturn.
  // When drag doesn't claim the event (returns false), we do NOT call
  // preventDefault/stopPropagation so the subsequent 'click' event still fires,
  // allowing commit.handleCanvasClick to handle drawing placement normally.
  const handleCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      drag.handleCanvasPointerDown(e);
      // Intentionally no fallback here: non-drag clicks are handled by
      // handleCanvasClick (MouseEvent), which fires after pointerdown+pointerup
      // on the same element. Intercepting here would double-handle placements.
    },
    [drag],
  );

  const handleCanvasPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      drag.handleCanvasPointerUp(e);
    },
    [drag],
  );

  const toCanvas = useCallback(
    (normX: number, normY: number) => toCanvasUtil(normX, normY, pdfDimensionsRef.current),
    [pdfDimensionsRef],
  );

  const toNorm = useCallback(
    (canvasX: number, canvasY: number) => toNormUtil(canvasX, canvasY, pdfDimensionsRef.current),
    [pdfDimensionsRef],
  );

  return {
    cursorPoint:              canvas.cursorPoint,
    setCursorPoint:           canvas.setCursorPoint,
    pendingSnapCandidates,
    setPendingSnapCandidates,
    finishMeasurement:        commit.finishMeasurement,
    handleCanvasClick:        commit.handleCanvasClick,
    handleContextMenu:        commit.handleContextMenu,
    handleCanvasPointerMove,
    handleCanvasPointerDown,
    handleCanvasPointerUp,
    toCanvas,
    toNorm,
    pendingBreak,
  };
}
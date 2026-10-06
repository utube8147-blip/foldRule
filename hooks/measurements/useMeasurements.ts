'use client';
// ─── hooks/useMeasurements.ts ─────────────────────────────────────────────────
//
//  FIX A: handleCanvasPointerDown returns boolean | undefined (not void) so
//         ViewerCanvas's prop type is satisfied and fall-through works.
//  FIX B: pendingSnapCandidates type import uses the canonical source.
//  FIX C: redrawDrawingCanvasRef pre-populated so first-render race is closed.
//  FIX D: snapCandidates wired to useDrawingCanvas for proximity visuals.
//  FIX E: polyarcMode + togglePolyarcMode RETURNED so Viewer can destructure.
//  FIX F: forcedPolyarcMode accepted and forwarded to useMeasurementCommit.
//  FIX 5: nearStartPointRef + startPointSnapRef sourced from useDrawingCanvas
//         and forwarded to useMeasurementCommit so close-snap click works.

import { useRef, useEffect, useCallback, useState } from 'react';
import React from 'react';
import type { UseMeasurementsParams, UseMeasurementsReturn } from '@/hooks/measurements/useMeasurements/types';
import { getNextMeasurementColor, resetColorIndex } from './useMeasurements/colors';
import { toCanvas as toCanvasUtil, toNorm as toNormUtil } from './useMeasurements/utils';
import { useDrawingCanvas } from './useMeasurements/useDrawingCanvas';
import { usePointDrag } from './useMeasurements/usePointDrag';
import { useMeasurementCommit } from './useMeasurements/useMeasurementCommit';
import type { PendingSnapCandidate } from '@/types/viewerTypes';
import type { ToolType } from '@/types';
import type { DragState } from '@/hooks/measurements/useMeasurements/types';

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
  polyarcMode,
  togglePolyarcMode,
  // FIX D: snap candidates in PDF-pixel space forwarded from Viewer
  snapCandidates,
  // FIX F: forcedPolyarcMode from Viewer's handleSetActiveTool
  forcedPolyarcMode,
  showLabels,
  selectedIdRef,
  extraSelectedRef,
  findHoverGeometry,
  findPinsNear,
}: UseMeasurementsParams & {
  snapCandidates?:    Array<{ x: number; y: number; type: string }>;
  forcedPolyarcMode?: 'line' | 'arc';
  showLabels?:        boolean;
  selectedIdRef?:     React.RefObject<string | null>;
  extraSelectedRef?:  React.RefObject<string[]>;
  findPinsNear?:      ((x: number, y: number) => { x: number; y: number; type: string }[]) | null;
  findHoverGeometry?: ((x: number, y: number) => { kind: 'line' | 'curve'; pts: { x: number; y: number }[] } | null) | null;
}): UseMeasurementsReturn & {
  redrawDrawingCanvas: () => void;
  polyarcMode:      'line' | 'arc';
  togglePolyarcMode: () => void;
} {

  const typedActiveTool = activeTool as ToolType;

  const snapEnabledRef   = useRef(snapEnabled);
  const snapThresholdRef = useRef(snapThreshold);
  useEffect(() => { snapEnabledRef.current   = snapEnabled;   }, [snapEnabled]);
  useEffect(() => { snapThresholdRef.current = snapThreshold; }, [snapThreshold]);

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
    redrawDrawingCanvas: useCallback(
      (pt?: { x: number; y: number }) => redrawDrawingCanvasRef.current(pt),
      [],
    ),
  });

  // ── useDrawingCanvas ───────────────────────────────────────────────────────
  // FIX 5: useDrawingCanvas exposes nearStartPointRef and startPointSnapRef
  //        which track whether the live cursor is within close-snap distance
  //        of the first placed point. We capture both refs here and forward
  //        them to useMeasurementCommit below.
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
    // FIX D: wire snap candidates through so proximity visuals render
    snapCandidates: snapCandidates ?? [],
    showLabels,
    selectedIdRef,
    extraSelectedRef,
    findHoverGeometry: findHoverGeometry as never,
    findPinsNear,
  });

  redrawDrawingCanvasRef.current = canvas.redrawDrawingCanvas;

  // ── FIX 5: Extract close-snap refs from canvas ─────────────────────────────
  // useDrawingCanvas must expose these two refs. If it doesn't yet, we provide
  // stable fallback refs so useMeasurementCommit never receives undefined.
  // Hooks must run unconditionally — create the fallbacks every render.
  const fallbackNearStartRef = useRef(false);
  const fallbackStartSnapRef = useRef<{ x: number; y: number } | null>(null);
  const nearStartPointRef  = (canvas.nearStartPointRef  ?? fallbackNearStartRef) as React.RefObject<boolean>;
  const startPointSnapRef  = (canvas.startPointSnapRef  ?? fallbackStartSnapRef) as React.RefObject<{ x: number; y: number } | null>;

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
    // FIX E: both polyarc values forwarded so useMeasurementCommit can use them
    polyarcMode,
    togglePolyarcMode,
    // FIX F: forward forcedPolyarcMode so click handler respects toolbar switch
    forcedPolyarcMode,
    appendToGroupId,
    onAppendComplete,
    onScalePrompt,
    pendingBreak,
    setPendingBreak,
    nextSegmentIdRef,
    setCursorPoint: canvas.setCursorPoint,
    setPendingSnapCandidates,
    resetBreakState,
    // FIX 5: close-snap refs so handleCanvasClick can snap-close a path
    nearStartPointRef,
    startPointSnapRef,
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

  // FIX A: return boolean | undefined so ViewerCanvas's typed prop is satisfied.
  // drag.handleCanvasPointerDown returns true when it claims the event, otherwise
  // undefined — both values must flow through unchanged.
  const handleCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): boolean | undefined => {
      return drag.handleCanvasPointerDown(e) as boolean | undefined;
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

  // Stable function that repaints the drawing canvas (e.g. after a selection change).
  const redrawDrawingCanvas = useCallback(() => redrawDrawingCanvasRef.current(), []);

  return {
    redrawDrawingCanvas,
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
    // FIX E: expose so Viewer.tsx can destructure them directly
    polyarcMode,
    togglePolyarcMode,
  };
}
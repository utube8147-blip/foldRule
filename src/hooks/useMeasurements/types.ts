import React from 'react';
import { TakeoffRow } from '@/types';
import { SnapResult, PendingSnapCandidate, PdfDimensions } from '@/types/viewerTypes';
import type { InProgressPoint } from '@/context/TakeoffContext';

// ─── Hook params ──────────────────────────────────────────────────────────────

export interface UseMeasurementsParams {
  drawingCanvasRef:     React.RefObject<HTMLCanvasElement>;
  pdfDimensionsRef:     React.MutableRefObject<PdfDimensions | null>;
  pageNumberRef:        React.MutableRefObject<number>;
  scaleRef:             React.MutableRefObject<number>;
  onScalePrompt: (ptLen: number) => void;
  activeTool:           string;
  setActiveTool:        (tool: string) => void;
  measurements:         TakeoffRow[];
  tempPoints:           InProgressPoint[];
  pushPoint:            (point: InProgressPoint) => void;
  commitMeasurement:    (m: TakeoffRow) => void;
  batchCommitMeasurements: (measurements: TakeoffRow[]) => void;
  clearTempPoints:      () => void;
  onAppendComplete?: () => void;
  scaleFactor:          number;
  onUpdateMeasurement?: (id: string, updates: Partial<TakeoffRow>) => void;
  isPanning:            boolean;
  snapToCorner:         (rawX: number, rawY: number) => SnapResult;
  getScaledCorners:     (pageIdx: number) => Array<{ x: number; y: number; confidence: number }>;
  triggerSnapFlash:     (x: number, y: number) => void;
  snapEnabled:          boolean;
  snapThreshold:        number;
  redrawPinCanvas:      () => void;
  cursorPointRef:       React.MutableRefObject<{ x: number; y: number } | null>;
  activeDrawingId:      string | null;
  appendToGroupId?: string | null;
}

// ─── Hook return ──────────────────────────────────────────────────────────────

export interface UseMeasurementsReturn {
  cursorPoint:              { x: number; y: number } | null;
  setCursorPoint:           React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  pendingSnapCandidates:    PendingSnapCandidate[] | null;
  setPendingSnapCandidates: React.Dispatch<React.SetStateAction<PendingSnapCandidate[] | null>>;
  finishMeasurement: (pts?: InProgressPoint[], meta?: { label?: string; icon?: string; appendToGroupId?: string }) => void;
  handleCanvasClick:        (e: React.MouseEvent<HTMLCanvasElement>) => void;
  handleContextMenu:        (e: React.MouseEvent<HTMLCanvasElement>) => void;
  handleCanvasPointerMove:  (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handleCanvasPointerDown:  (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handleCanvasPointerUp:    (e: React.PointerEvent<HTMLCanvasElement>) => void;
  toCanvas:                 (normX: number, normY: number) => { x: number; y: number };
  toNorm:                   (canvasX: number, canvasY: number) => { x: number; y: number };
  pendingBreak:             boolean;
}

// ─── Point relocation state ───────────────────────────────────────────────────

export interface DragState {
  isDragging: boolean;
  measurementId: string;
  pointIndex: number;
  originalPoint: { x: number; y: number };
  parentId?: string;
}


// ─── Helper to find point under cursor ────────────────────────────────────────

export interface PointHitResult {
  measurementId: string;
  pointIndex: number;
  pointCanvas: { x: number; y: number };
  measurement: TakeoffRow;
}

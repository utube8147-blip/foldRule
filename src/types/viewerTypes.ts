// ─── viewerTypes.ts ───────────────────────────────────────────────────────────
// All shared interfaces for the Viewer feature split.

// ── FIX #7: Branded coordinate types ─────────────────────────────────────────
// CanvasPoint is fully branded — passing a norm coord to a canvas drawing
// function silently draws in the wrong position, so we enforce this strictly.
// NormPoint is a plain structural alias — it stays compatible with all existing
// { x: number; y: number } declarations (e.g. PendingSnapCandidate.snapTarget).
declare const __canvasBrand: unique symbol;

export type CanvasPoint = { x: number; y: number; readonly [__canvasBrand]: never };
export type NormPoint   = { x: number; y: number };

export const canvasPt = (x: number, y: number): CanvasPoint => ({ x, y } as CanvasPoint);
export const normPt   = (x: number, y: number): NormPoint   => ({ x, y });

// ─────────────────────────────────────────────────────────────────────────────

export interface DetectedCorner {
  x: number; y: number;
  confidence: number;
  nx: number; ny: number;
}

export interface DetectedLine {
  x1: number; y1: number;
  x2: number; y2: number;
  angle: number; length: number;
}

export interface ExtractionResult {
  pageIndex: number;
  corners: DetectedCorner[];
  lines: DetectedLine[];
  intersections: DetectedCorner[];
  width: number; height: number;
}

export interface PageExtractionState {
  status: 'idle' | 'pending' | 'processing' | 'done' | 'error';
  step?: string;
  corners: DetectedCorner[];
  lines: DetectedLine[];
  intersections: DetectedCorner[];
  width: number; height: number;
}

export interface SnapResult {
  point: CanvasPoint;   // was { x: number; y: number } — now branded
  snapped: boolean;
}

export interface SnapFlash {
  x: number; y: number; id: number;
}

export interface PendingSnapCandidate {
  pointIndex: number;
  measurementId: string;
  /** Stored in normalized [0,1] space — survives zoom changes */
  snapTarget: NormPoint;   // structurally identical to { x: number; y: number } — no breaking change
}

export interface PdfDimensions {
  w: number;
  h: number;
}
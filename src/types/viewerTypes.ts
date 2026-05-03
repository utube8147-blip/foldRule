// ─── viewerTypes.ts ───────────────────────────────────────────────────────────
// All shared interfaces for the Viewer feature split.

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
  point: { x: number; y: number };
  snapped: boolean;
}

export interface SnapFlash {
  x: number; y: number; id: number;
}

export interface PendingSnapCandidate {
  pointIndex: number;
  measurementId: string;
  /** Stored in normalized [0,1] space — survives zoom changes */
  snapTarget: { x: number; y: number };
}

export interface PdfDimensions {
  w: number;
  h: number;
}
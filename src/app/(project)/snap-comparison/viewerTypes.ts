// ─── viewerTypes.ts ───────────────────────────────────────────────────────────

export type canvasPt = { x: number; y: number };

export interface PdfDimensions {
  w: number;
  h: number;
}

// ─── Raw detected corner (worker output, normalised coords) ───────────────────
export interface DetectedCorner {
  x: number;
  y: number;
  confidence: number;
  /** Normalised [0,1] position within the extraction-render frame */
  nx: number;
  ny: number;
}

// ─── Raw detected line (worker output, pixel coords in extraction frame) ──────
export interface DetectedLine {
  x1: number; y1: number;
  x2: number; y2: number;
  angle: number;   // 0 = horizontal, 90 = vertical
  length: number;
}

// ─── Wall line (merged structural edge, normalised coords) ────────────────────
export interface DetectedWallLine {
  x1: number; y1: number;
  x2: number; y2: number;
  angle: number;
  length: number;
  /** Normalised [0,1] endpoints — multiply by canvas dims to get pixel coords */
  nx1: number; ny1: number;
  nx2: number; ny2: number;
}

// ─── Wall corner (intersection of two wall lines, normalised coords) ──────────
export interface DetectedWallCorner {
  x: number; y: number;
  confidence: number;
  nx: number; ny: number;
  /** Indices into the wallLines array for the two lines that meet here */
  lineIndices: number[];
}

// ─── Full result returned by the worker for one page ─────────────────────────
export interface ExtractionResult {
  pageIndex: number;
  corners: DetectedCorner[];
  lines: DetectedLine[];
  intersections: DetectedCorner[];   // reuses corner shape (nx/ny + confidence)
  width: number;                      // extraction-frame pixel width
  height: number;                     // extraction-frame pixel height
  /** Merged structural wall lines — REQUIRED for wall overlay */
  wallLines: DetectedWallLine[];
  /** Intersections of wall lines — REQUIRED for wall-corner snap */
  wallCorners: DetectedWallCorner[];
}

// ─── Per-page state held in the React hook ────────────────────────────────────
export interface PageExtractionState {
  status: 'idle' | 'processing' | 'done' | 'error';
  /** Current processing step label (shown in loading UI) */
  step?: string;
  corners: DetectedCorner[];
  lines: DetectedLine[];
  intersections: DetectedCorner[];
  width: number;
  height: number;
  /** Merged structural wall lines — populated after worker result */
  wallLines: DetectedWallLine[];
  /** Wall-line intersections used for structural snapping */
  wallCorners: DetectedWallCorner[];
}

// ─── Snap result returned by snapToCorner() ───────────────────────────────────
export interface SnapResult {
  point: canvasPt;
  snapped: boolean;
}

// ─── Snap flash animation entry ───────────────────────────────────────────────
export interface SnapFlash {
  id: number;
  x: number;
  y: number;
}
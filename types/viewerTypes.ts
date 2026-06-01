// ─── viewerTypes.ts ───────────────────────────────────────────────────────────
// All shared interfaces for the Viewer feature split.

// ── Branded coordinate types ──────────────────────────────────────────────────
// CanvasPoint is fully branded — passing a norm coord to a canvas drawing
// function silently draws in the wrong position, so we enforce this strictly.
// NormPoint is a plain structural alias — it stays compatible with all existing
// { x: number; y: number } declarations (e.g. PendingSnapCandidate.snapTarget).
declare const __canvasBrand: unique symbol;
export type CanvasPoint = { x: number; y: number; readonly [__canvasBrand]: never };
export type NormPoint   = { x: number; y: number };
export const canvasPt = (x: number, y: number): CanvasPoint => ({ x, y } as CanvasPoint);
export const normPt   = (x: number, y: number): NormPoint   => ({ x, y });

// ── Extraction method ─────────────────────────────────────────────────────────
export type ExtractionMethod = 'vector' | 'raster';

// ── Basic geometry ────────────────────────────────────────────────────────────
export interface DetectedCorner {
  x: number; y: number;
  confidence: number;
  nx: number; ny: number;
}

export interface DetectedLine {
  x1: number; y1: number;
  x2: number; y2: number;
  angle: number;
  length: number;
}

// ── Wall-specific types ───────────────────────────────────────────────────────
// Stored in normalised [0,1] space — canvas-pixel coords are derived on demand
// by getScaledWallLines() / getScaledWallCorners() in useSnapEngine.

export interface WallLineNorm {
  nx1: number; ny1: number;
  nx2: number; ny2: number;
  angle: 0 | 90 | 'diagonal';
  length: number;           // canvas pixels at extraction scale
  thicknessPx: number;      // wall thickness in canvas pixels
  thicknessNorm: number;    // wall thickness as fraction of page height
  isFilled: boolean;        // true = filled rect (CAD), false = stroked line
}

export interface WallCornerNorm {
  nx: number; ny: number;
  confidence: number;       // 0–1; vector corners are always 1.0
  lineIndices: number[];    // indices into the wallLines array
}

// ── Extraction result (cached per-page) ───────────────────────────────────────
export interface ExtractionResult {
  pageIndex: number;
  corners: DetectedCorner[];
  lines: DetectedLine[];
  intersections: DetectedCorner[];
  width: number;
  height: number;
  wallLines: WallLineNorm[];
  wallCorners: WallCornerNorm[];
  extractionMethod: ExtractionMethod;
  vectorScore: number;      // 0–1; fraction of ops that were vector geometry
}

// ── Per-page live state ───────────────────────────────────────────────────────
export interface PageExtractionState {
  status: 'idle' | 'pending' | 'processing' | 'done' | 'error';
  step?: string;
  corners: DetectedCorner[];
  lines: DetectedLine[];
  intersections: DetectedCorner[];
  width: number;
  height: number;
  wallLines: WallLineNorm[];
  wallCorners: WallCornerNorm[];
  extractionMethod: ExtractionMethod;
  vectorScore: number;
}

// ── Snap ──────────────────────────────────────────────────────────────────────
export interface SnapResult {
  point: CanvasPoint;
  snapped: boolean;
}

export interface SnapFlash {
  x: number; y: number; id: number;
}

export interface PendingSnapCandidate {
  pointIndex: number;
  measurementId: string;
  /** Stored in normalised [0,1] space — survives zoom changes */
  snapTarget: NormPoint;
}

// ── Canvas dimensions ─────────────────────────────────────────────────────────
export interface PdfDimensions {
  w: number;
  h: number;
}
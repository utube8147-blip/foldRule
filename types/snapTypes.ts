export interface PdfDimensions {
  w: number;
  h: number;
}

export interface PdfPageInfo {
  pageNumber: number;
  pageCount: number;
}

export type SnapPointType =
  | 'endpoint'
  | 'midpoint'
  | 'centroid'
  | 'intersection'
  | 'curve-node';

/** What a piece of geometry belongs to — used to show each tool only what fits it. */
export type GeometryShape = 'line' | 'arc' | 'circle';

export interface SnapPoint {
  nx: number;
  ny: number;
  type: SnapPointType;
  shape?: GeometryShape;
  sourceId: string;
  strokeWidth: number;
}

export interface PdfLine {
  id: string;
  shape?: GeometryShape;
  vertices: [{ x: number; y: number }, { x: number; y: number }];
  layer: string;
  strokeWidth: number;
  length: number;
  fromStroke: boolean;
}

export interface BezierPoints {
  p0: { x: number; y: number };
  p1: { x: number; y: number };
  p2: { x: number; y: number };
  p3: { x: number; y: number };
}

export interface PdfCurve {
  id: string;
  shape?: GeometryShape;
  center: { x: number; y: number };
  radius: number;
  startAngle: number;
  endAngle: number;
  isCircle: boolean;
  layer: string;
  strokeWidth: number;
  approxLength: number;
  fromStroke: boolean;
  bezier?: BezierPoints;
}

export interface ChainPoint {
  x: number;
  y: number;
  type: SnapPointType | 'free';
}

export interface SelectedEntity {
  kind: 'line' | 'curve' | 'snap';
  sourceId: string;
  x: number;
  y: number;
  strokeWidth: number;
  length?: number;
  approxLength?: number;
  snapType?: SnapPointType;
}

/**
 * A closed region extracted from drawing vector geometry, used by the
 * symbol-clustering lab code (lib/shapes, hooks/viewer/useSymbolSelection).
 * Coordinates are normalized (0–1) page fractions.
 */
export interface SvgArea {
  id: string;
  nx: number;
  ny: number;
  points: { nx: number; ny: number }[];
  bounds: { minNX: number; minNY: number; maxNX: number; maxNY: number };
  vertexCount?: number;
  hasArc?: boolean;
  [key: string]: unknown;
}

/** A full circle found on the page (centre + radius, normalised to page size). */
export interface PdfCircle {
  nx: number;
  ny: number;
  /** Radius as a fraction of page width / height. */
  nrx: number;
  nry: number;
  /** Radius in PDF points (page space at scale 1). */
  r: number;
}

/** A drawn arc (not a full circle): centre, radius, start angle and sweep. */
export interface PdfArc extends PdfCircle {
  /** Start angle in radians (page coordinates, y down). */
  start: number;
  /** Sweep in radians, counter-clockwise from `start` (always ≥ 0). */
  sweep: number;
}

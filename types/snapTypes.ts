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

export interface SnapPoint {
  nx: number;
  ny: number;
  type: SnapPointType;
  sourceId: string;
  strokeWidth: number;
}

export interface PdfLine {
  id: string;
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
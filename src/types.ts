export type ToolType = 'select' | 'point' | 'linear' | 'area' | 'count' | 'scale';

export type MeasurementType = 'Point' | 'Length' | 'Area' | 'Count';

export interface Point {
  x: number;
  y: number;
}

export interface TakeoffRow {
  id: string;
  drawingId: string;
  description: string;
  type: MeasurementType;
  quantity: number;
  unit: string;
  unitRate: number;
  notes: string;
  points: Point[];
  isOverridden: boolean;
  color: string;
  isVisible: boolean;
}

export interface Drawing {
  id: string;
  name: string;
  fileUrl: string | null;
  file?: File;
  scaleFactor: number; // 1px = X units
}

export interface MaterialSpec {
  id: string;
  code: string;
  name: string;
  unit: string;
  materialCost: number;
  laborCost: number;
  equipmentCost: number;
  division: string;
}

export interface ProjectState {
  projectName: string;
  projectNumber: string;
  unit: string;
  drawings: Drawing[];
  activeDrawingId: string | null;
  measurements: TakeoffRow[];
  materials: MaterialSpec[];
}

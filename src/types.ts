export type ToolType = 'select' | 'point' | 'linear' | 'area' | 'count' | 'scale' | 'polygon' | 'rectangle';


export interface Point {
  x: number;
  y: number;
}

export interface ProjectState {
  projectName: string;
  projectNumber: string;
  unit: string;
  drawings: Drawing[];
  activeDrawingId: string | null;
  measurements: TakeoffRow[];
  materials: Material[];  // Use consistent type
}

export type MaterialSpec = Material;

export interface TakeoffRow {
  id: string;
  drawingId: string;
  description: string;
  type: MeasurementType;
  quantity: number;
  unit: string;
  unitRate: number;
  notes: string;
  points: Array<{ x: number; y: number }>;
  isOverridden: boolean;
  presetData?: Record<string, any>;
  presetId?: string;
  groupId?: string;
  groupName?: string;
  groupType?: string;
  parentId?: string;
  isGroupHeader?: boolean;
  isExpanded?: boolean;
  category?: string;
  color: string;
  isVisible: boolean;
}

export type MeasurementType = 'Length' | 'Area' | 'Count' | 'Point';



export interface Drawing {
  id: string;
  name: string;
  fileUrl: string;
  file?: File;
  scaleFactor: number;
  pageCount: number;
}

export interface Material {
  id: string;
  name: string;
  category: string;
  unit: string;
  unitRate: number;
  supplier?: string;
  sku?: string;
}



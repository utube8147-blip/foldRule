// ─── Tool Types ────────────────────────────────────────────────────────────────
export type ToolType = 'select' | 'point' | 'linear' | 'polygon' | 'rectangle' | 'count' | 'scale' | 'text';

// ─── Basic Types ───────────────────────────────────────────────────────────────
export interface Point {
  x: number;
  y: number;
}

// ─── Material Types ────────────────────────────────────────────────────────────
export interface Material {
  id: string;
  code: string;
  name: string;
  category: string;
  unit: string;
  unitRate: number;
  materialCost: number;
  laborCost: number;
  equipmentCost: number;
  supplier?: string;
  sku?: string;
}

// Alias for backward compatibility
export type MaterialSpec = Material;

// ─── Drawing Types ─────────────────────────────────────────────────────────────
export interface Drawing {
  id: string;
  name: string;
  fileUrl: string;
  file?: File;
  scaleFactor: number;
  pageCount: number;
}

// ─── Measurement Types ─────────────────────────────────────────────────────────
export type MeasurementType = 'Length' | 'Polygon' | 'Rectangle' | 'Count' | 'Point';

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
  materialId?: string;
  childIds?: string[];  // For group headers, list of child measurement IDs
  label?: string;       // Custom name/label for count measurements
  icon?: string;        // Icon type for count measurements (door, window, fan, ac, etc.)
}

export interface GroupMeasurement {
  id: string;
  drawingId: string;
  groupName: string;
  groupType: 'mixed' | 'lineals' | 'polygons' | 'rectangles';  // Can contain mixed types
  description: string;
  childMeasurementIds: string[];  // References to measurements in this group
  isExpanded: boolean;
  quantity: number;  // Aggregated from children
  unit: string;
  color: string;
  isVisible: boolean;
  createdAt: number;
}

// ─── Project State ─────────────────────────────────────────────────────────────
export interface ProjectState {
  projectName: string;
  projectNumber: string;
  unit: string;
  drawings: Drawing[];
  activeDrawingId: string | null;
  measurements: TakeoffRow[];
  materials: Material[];
}



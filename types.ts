export type ToolType = 'select' | 'point' | 'linear' | 'area' | 'count' | 'scale' | 'polygon' | 'rectangle' | 'magic-fill' | 'polyarc'                       // ← new: 2-click polyarc (auto-radius)
  | 'arc'                          // ← new: 3-point arc
  | 'radius'                       // ← new: centre + edge
  | 'grid-count'                  // ← new: grid overlay;
  | 'volume'
  | 'symbol-detect'
  | 'perimeter-offset'
  | 'annotations'
  | 'polar-mode'


export interface Point {
  x: number;
  y: number;
}

export interface Material {
  id: string;
  name: string;
  code: string;           // ← ADD
  category: string;
  unit: string;
  unitRate: number;
  materialCost: number;   // ← ADD
  laborCost: number;      // ← ADD
  equipmentCost: number;  // ← ADD
  supplier?: string;
  sku?: string;
}

export type MaterialSpec = Material;

export interface TakeoffRow {
  label?: string;
  childIds: string[];
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
  materialId?: string;  // ← ADD THIS
  icon?: string;  // ← Add this line

    // Arc-specific
  arcRadius?:   number;   // metres, stored for reference
  sweepAngle?:  number;   // radians

  // Pitch/slope multiplier (applies to Length and Arc rows)
  pitchFactor?: number;   // e.g. 1.118 for 6:12 pitch. Default 1.

  // Grid count
  gridSpacing?: number;   // real-world mm between grid lines
  gridCols?:    number;
  gridRows?:    number;
}

export type MeasurementType = 'Length' | 'Area' | 'Count' | 'Point' | 'Polygon' | 'Rectangle';



export interface Drawing {
  id: string;
  name: string;
  fileUrl: string;
  file?: File;
  scaleFactor: number;
  pageCount: number;
}




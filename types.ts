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
  /** Two-digit MasterFormat division ("06"). Derived from `category` when missing. */
  division?: string;
  /** Came from the built-in catalogue (data/materials.ts). */
  builtIn?: boolean;
}

export type MaterialSpec = Material;

export interface TakeoffRow {
  label?: string;
  childIds: string[];
  id: string;
  drawingId: string;
  /** 1-based PDF page this measurement was taken on. Undefined = page 1 (legacy rows). */
  pageNumber?: number;
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
  /** Object URL for the PDF blob. Recreated on load; never persisted. */
  fileUrl: string;
  file?: File;
  /**
   * Legacy single scale for the whole drawing. Kept for backward compatibility;
   * new code reads/writes `pageScales` via getPageScale / setPageScale.
   */
  scaleFactor: number;
  /** Calibrated real-world units per PDF point, keyed by 1-based page number. */
  pageScales?: Record<number, number>;
  pageCount: number;
}




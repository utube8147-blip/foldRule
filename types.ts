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
  /** Material bought but not billed (offcuts, breakage), as a percentage. It goes into the rate. */
  wastePercent?: number;
  /**
   * How it is bought, when that differs from how it is measured: tiles by the box, blocks by
   * the piece. `materialCost` is then the price of one buying unit, which `covers` this many takeoff units.
   */
  purchase?: { unit: string; covers: number };
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
  /** Cut-outs inside an area. Each is an outline; its area is deducted. */
  holes?: Array<Array<{ x: number; y: number }>>;
  /** A quantity worked out from another row (source quantity × factor). Follows the source. */
  derived?: {
    sourceId: string; factor: number; what: string;
    /** Deductions: each counted item in `sourceId` takes `each` off the quantity. */
    less?: Array<{ sourceId: string; each: number; what: string }>;
    /** Name of the assembly that produced this row. */
    assembly?: string;
  };
  isOverridden: boolean;
  /** Set when a drawing revision was accepted and this row sat on a change: check it, then tick it off. */
  review?: {
    revision: string; status: 'check' | 'done';
    /** Outline proposed from the new revision's linework (corners moved to where they went). */
    suggest?: { points: Array<{ x: number; y: number }>; quantity: number };
  };
  /** POMI work section letter chosen by hand (otherwise worked out from the material or wording). */
  section?: string;
  /** Timesing: this row (or, on a group header, every row in the group) is billed this many times. */
  times?: number;
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

export type MeasurementType = 'Length' | 'Area' | 'Count' | 'Point' | 'Polygon' | 'Rectangle' | 'Volume';



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
  /** This sheet replaced that drawing (an accepted revision). */
  revisionOf?: string;
  /** This sheet was replaced by that drawing; it is kept as history. */
  supersededBy?: string;
  /** Timesing per page (1-based): everything drawn on the page is billed this many times. */
  pageTimes?: Record<number, number>;
}




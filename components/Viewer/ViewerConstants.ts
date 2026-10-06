// ─── ViewerConstants.ts ───────────────────────────────────────────────────────
//
// CHANGES:
//   VIEWER_TOOLS reorganised into logical groups with UX-rational ordering:
//     Group 1 — Navigation/Selection: select, multi-select (disabled)
//     Group 2 — Area tools: polygon, rectangle, magic-fill
//     Group 3 — Linear tools: linear, arc, polyarc
//     Group 4 — Point tools: count, point
//
//   Each tool now carries an optional `disabled` flag and `group` label so the
//   toolbar can render dividers between groups and grey out unbuilt tools.
//
//   New tools added as disabled stubs (enable one by one as you build them):
//     - multi-select   (group: selection)
//     - point          (group: point — was missing from VIEWER_TOOLS before)
//
//   Shortcuts reassigned to avoid conflicts:
//     - polygon:    was A (stolen by polyarc toggle), now G
//     - multi-select: X  (easy to reach, not in use)
//     - point:      O    (O for "one point")
//
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';

import {
  MousePointer2,
  MousePointer,
  Pencil,
  Square,
  Pentagon,
  Hash,
  MapPin,
  Wand2,
  CircleDot,
  Circle,
  Spline,
} from 'lucide-react';

import type { ToolType, TakeoffRow } from '@/types';
import type { PresetTemplate } from '@/components/presets/PresetTemplates';

// ─── Canvas constants ─────────────────────────────────────────────────────────

export const CANVAS_PADDING = 400;
export const ZOOM_SENSITIVITY = 0.15;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

// PDF.js is configured in one place: lib/pdf/pdfClient.ts

// ─── Tool group labels (used for dividers in toolbar) ─────────────────────────

export type ToolGroup = 'selection' | 'area' | 'linear' | 'point';

// ─── Viewer tools ─────────────────────────────────────────────────────────────
//
// ORDER RATIONALE:
//   1. select       — always first, the safe/neutral mode, shortcut V (industry standard)
//   2. multi-select — right next to select, same family, shortcut X
//      [divider]
//   3. polygon      — primary area tool (most used), shortcut G
//   4. rectangle    — fast area shortcut for rectangular rooms, shortcut R
//   5. magic-fill   — AI area fill, same family as polygon/rectangle, shortcut M
//      [divider]
//   6. linear       — primary length tool, shortcut L
//   7. arc          — arc variant of linear, shortcut B
//   8. polyarc      — combined line+arc, upgrade from linear/arc, shortcut Y
//      [divider]
//   9. count        — point-based tool, shortcut N
//  10. point        — single reference point, shortcut O
//
// UX REASONING:
//   - Area tools cluster together so estimators doing room takeoff don't jump
//     across the toolbar between polygon/rectangle/magic-fill.
//   - Linear tools cluster together so pipe/wall runs stay in one zone.
//   - Count and point are at the end — used less frequently and conceptually
//     "smaller" than area or length tools.
//   - select is always first (Escape / V) and multi-select is right beside it
//     so the user's eye always finds "safe mode" at the far left.

export const VIEWER_TOOLS = [
  // ── Group 1: Selection ────────────────────────────────────────────────────
  {
    id:       'select',
    label:    'Select',
    shortcut: 'V',
    icon:     MousePointer2,
    group:    'selection' as ToolGroup,
    disabled: false,
  },
  {
    id:       'multi-select',
    label:    'Multi-select',
    shortcut: 'X',
    icon:     MousePointer,
    group:    'selection' as ToolGroup,
    disabled: true,   // TODO: implement — see todos.md
  },

  // ── Group 2: Area ─────────────────────────────────────────────────────────
  {
    id:       'polygon',
    label:    'Polygon',
    shortcut: 'P',
    icon:     Pentagon,
    group:    'area' as ToolGroup,
    disabled: false,
  },
  {
    id:       'rectangle',
    label:    'Rectangle',
    shortcut: 'R',
    icon:     Square,
    group:    'area' as ToolGroup,
    disabled: false,
  },
  {
    id:       'magic-fill',
    label:    'Magic fill',
    shortcut: 'M',
    icon:     Wand2,
    group:    'area' as ToolGroup,
    disabled: false,
  },

  // ── Group 3: Linear ───────────────────────────────────────────────────────
  {
    id:       'linear',
    label:    'Linear',
    shortcut: 'L',
    icon:     Pencil,
    group:    'linear' as ToolGroup,
    disabled: false,
  },
  {
    id:       'arc',
    label:    'Arc',
    shortcut: 'B',
    icon:     CircleDot,
    group:    'linear' as ToolGroup,
    disabled: false,
  },
  {
    id:       'polyarc',
    label:    'Polyarc',
    shortcut: 'Y',
    icon:     Spline,
    group:    'linear' as ToolGroup,
    disabled: false,
  },
  {
    id:       'radius',
    label:    'Circle (centre, then edge)',
    shortcut: 'C',
    icon:     Circle,
    group:    'linear' as ToolGroup,
    disabled: false,
  },

  // ── Group 4: Point ────────────────────────────────────────────────────────
  {
    id:       'count',
    label:    'Count',
    shortcut: 'N',
    icon:     Hash,
    group:    'point' as ToolGroup,
    disabled: false,
  },
  {
    id:       'point',
    label:    'Point',
    shortcut: 'T',
    icon:     MapPin,
    group:    'point' as ToolGroup,
    disabled: false,
  },
] as const;

// ─── Advanced canvas tools ────────────────────────────────────────────────────
//
// ORDER RATIONALE:
//   Pitch factor row is always first — it's the most-used advanced feature
//   (roofing estimates). Below it, tools are ordered by how commonly needed:
//
//   1. radius/circle   — fairly common (columns, circular features)
//   2. grid-count      — common for tiles, ceiling grids
//   3. perimeter-offset — common for formwork, edge details  [disabled]
//   4. volume          — less common, needs area first        [disabled]
//   5. symbol-detect   — AI feature, powerful but occasional [disabled]
//   6. polar-mode      — toggle, lives here rather than main bar to save space
//                        [disabled]
//   7. annotation      — markup layer, separate concern       [disabled]

export type AdvancedToolMeta = {
  id:       ToolType;
  label:    string;
  sub:      string;
  shortcut: string;
  disabled: boolean;
  badge?:   string;
};

export const ADVANCED_CANVAS_TOOLS: AdvancedToolMeta[] = [
  {
    id:       'grid-count',
    label:    'Grid count',
    sub:      'Draw polygon, grid auto-counts tiles',
    shortcut: 'G',
    disabled: false,
  },
  {
    id:       'perimeter-offset',
    label:    'Perimeter offset',
    sub:      'Auto-offset line from any closed polygon',
    shortcut: 'O',
    disabled: false,
    // badge:    'Soon',
  },
  {
    id:       'volume',
    label:    'Volume',
    sub:      'Polygon boundary + depth → cubic m³',
    shortcut: 'V2',
    disabled: true,
    badge:    'Soon',
  },
  {
    id:       'symbol-detect',
    label:    'Symbol detect',
    sub:      'Click one symbol — AI finds all matches',
    shortcut: 'D',
    disabled: true,
    badge:    'Soon',
  },
  // (Angle lock — 0° / 45° / 90° — shipped as the F8 toggle under the drawing.)
  {
    id:       'annotation' as ToolType,
    label:    'Annotation',
    sub:      'Place text labels and callouts on drawing',
    shortcut: 'T',
    disabled: true,
    badge:    'Soon',
  },
];

// ─── Viewer props ─────────────────────────────────────────────────────────────

export interface ViewerProps {
  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;

  measurements: TakeoffRow[];

  onAddMeasurement?: (m: any) => void;

  onUpdateMeasurement?: (
    id: string,
    updates: Partial<TakeoffRow>
  ) => void;

  onDeleteMeasurement?: (id: string) => void;
  scaleFactor: number;
  onScaleSet: (factor: number) => void;

  activeDrawing?: {
    id: string;
    fileUrl?: string;
    file?: File;
    scaleFactor: number;
  } | null;

  onDrawingAdded: (
    name: string,
    url: string,
    file?: File
  ) => void;

  showPresetDrawer?: boolean;
  onClosePresetDrawer?: () => void;

  onSelectPreset?: (
    data: Record<string, any>,
    template: PresetTemplate
  ) => void;

  hideToolbar?: boolean;

  svgUrl?: string;
  /** False when the visible page has no scale yet — shows a calibration prompt. */
  isPageCalibrated?: boolean;

  showPins?: boolean;
  onShowPinsChange?: (v: boolean) => void;

  appendToGroupId?: string | null;
  onAppendComplete?: () => void;

  onToolbarReady?: (api: ViewerToolbarAPI) => void;
}

// ─── Toolbar API ──────────────────────────────────────────────────────────────

export interface ViewerToolbarAPI {
  tools: typeof VIEWER_TOOLS;

  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;

  scale: number;
  setScale: React.Dispatch<React.SetStateAction<number>>;

  scaleFactor: number;

  snapEnabled: boolean;
  setSnapEnabled: (v: boolean) => void;
  orthoEnabled?: boolean;
  setOrthoEnabled?: (v: boolean) => void;
  /** How the active tool is being used (Area vs Length, regular polygon…). */
  drawMode?: import('@/lib/geometry/pathShapes').DrawMode;
  /** Pick a tool together with its mode (used by the rail and the mode strip). */
  setToolMode?: (tool: ToolType, mode?: Partial<import('@/lib/geometry/pathShapes').DrawMode>) => void;

  showSnapSettings: boolean;
  setShowSnapSettings: (v: boolean) => void;

  showPins: boolean;
  setShowPins: (v: boolean) => void;

  snapThreshold: number;
  setSnapThreshold: (v: number) => void;

  confidenceFilter: number;
  setConfidenceFilter: (v: number) => void;

  analysisStatus: string;

  analysisPage: {
    current: number;
    total: number;
  } | null;

  currentPageCorners: number;

  pdf: any;

  pageNumber: number;

  fitToScreen: () => void;
  handleManualScale: () => void;

  canUndo: boolean;
  canRedo: boolean;

  handleUndo: () => void;
  handleRedo: () => void;

  // Polyarc mode pill
  polyarcMode?: 'line' | 'arc';
  togglePolyarcMode?: () => void;

  // Live in-progress point count (fixes hardcoded 0 bug)
  tempPointsCount: number;
  /** Size of the visible page in PDF points (for scale presets). */
  pageSizePt?: { w: number; h: number } | null;
}
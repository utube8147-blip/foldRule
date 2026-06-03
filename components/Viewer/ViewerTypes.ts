// ─── ViewerTypes.ts ────────────────────────────────────────────────────────────
//  All shared types, interfaces, and constants for the Viewer module.
// ──────────────────────────────────────────────────────────────────────────────

import React from 'react';
import type * as pdfjsLib from "pdfjs-dist";
import {
  ZoomIn, ZoomOut, Maximize, Hash, Square, Minus,
  Activity, MousePointer, Ruler, MapPin,
} from 'lucide-react';
import { ToolType, TakeoffRow, Drawing } from '@/types';
import { PresetTemplate } from '../presets/PresetTemplates';
import type { PdfDimensions } from '@/types/viewerTypes';

// ── Tool definitions ──────────────────────────────────────────────────────────

export const VIEWER_TOOLS = [
  { id: 'select',    icon: MousePointer, label: 'Select',    shortcut: 'V' },
  { id: 'scale',     icon: Ruler,        label: 'Calibrate', shortcut: 'C' },
  { id: 'linear',    icon: Minus,        label: 'Linear',    shortcut: 'L' },
  { id: 'rectangle', icon: Square,       label: 'Rectangle', shortcut: 'R' },
  { id: 'polygon',   icon: Activity,     label: 'Polygon',   shortcut: 'P' },
  { id: 'count',     icon: Hash,         label: 'Count',     shortcut: 'N' },
  { id: 'point',     icon: MapPin,       label: 'Point',     shortcut: 'T' },
] as const;

export type ViewerTool = typeof VIEWER_TOOLS[number];

// ── Zoom constants ────────────────────────────────────────────────────────────

export const CANVAS_PADDING   = 24;
export const ZOOM_SENSITIVITY = 0.25;
export const MIN_ZOOM         = 0.05;
export const MAX_ZOOM         = 10;

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ViewerProps {
  activeTool:           ToolType;
  setActiveTool:        (tool: ToolType) => void;
  measurements:         TakeoffRow[];
  onAddMeasurement:     (m: Omit<TakeoffRow, 'color' | 'isVisible' | 'drawingId'>) => void;
  onUpdateMeasurement?: (id: string, updates: Partial<TakeoffRow>) => void;
  onDeleteMeasurement: (id: string) => void; // 👈 add this
  scaleFactor:          number;
  onScaleSet:           (factor: number) => void;
  activeDrawing:        Drawing | null;
  onDrawingAdded:       (name: string, fileUrl: string, file?: File) => void;
  showPresetDrawer:     boolean;
  onClosePresetDrawer:  () => void;
  onSelectPreset:       (data: Record<string, any>, template: PresetTemplate) => void;
  hideToolbar?:         boolean;
  onToolbarReady?:      (api: ViewerToolbarAPI) => void;
  appendToGroupId?:     string | null;
  onAppendComplete?:    () => void;
}

// ── Toolbar API (exposed to parent) ──────────────────────────────────────────

export interface ViewerToolbarAPI {
  tools:               { id: string; icon: React.ElementType; label: string; shortcut: string }[];
  activeTool:          ToolType;
  setActiveTool:       (t: ToolType) => void;
  scale:               number;
  setScale:            React.Dispatch<React.SetStateAction<number>>;
  scaleFactor:         number;
  snapEnabled:         boolean;
  setSnapEnabled:      React.Dispatch<React.SetStateAction<boolean>>;
  showSnapSettings:    boolean;
  setShowSnapSettings: React.Dispatch<React.SetStateAction<boolean>>;
  showPins:            boolean;
  setShowPins:         React.Dispatch<React.SetStateAction<boolean>>;
  snapThreshold:       number;
  setSnapThreshold:    React.Dispatch<React.SetStateAction<number>>;
  confidenceFilter:    number;
  setConfidenceFilter: React.Dispatch<React.SetStateAction<number>>;
  analysisStatus:      string;
  analysisPage:        { current: number; total: number } | null;
  currentPageCorners:  number;
  pdf:                 pdfjsLib.PDFDocumentProxy | null;
  pageNumber:          number;
  fitToScreen:         () => void;
  handleManualScale:   () => void;
  canUndo:             boolean;
  canRedo:             boolean;
  handleUndo:          () => void;
  handleRedo:          () => void;
}

// ── Internal shared state passed between sub-components ──────────────────────

export interface ViewerInternalState {
  pdf:           pdfjsLib.PDFDocumentProxy | null;
  pageNumber:    number;
  scale:         number;
  pdfDimensions: PdfDimensions | null;
  loading:       boolean;
  isPanning:     boolean;
}

export interface PendingMeasurementMeta {
  id:          string;
  type:        string;
  description: string;
}

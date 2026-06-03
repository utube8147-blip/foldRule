// ─── ViewerConstants.ts ───────────────────────────────────────────────────────
//
// CHANGES:
// - Added 'magic-fill' tool with Wand2 icon + shortcut M
// - Removed SVG / room / wall / vector / cluster props from ViewerToolbarAPI
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import pdfjsLib from "@/lib/pdf/pdfClient";

import {
  MousePointer2,
  Pencil,
  Square,
  Pentagon,
  Hash,
  MapPin,
  Ruler,
  Wand2,
  CircleDot
} from 'lucide-react';

import type { ToolType, TakeoffRow } from '@/types';
import type { PresetTemplate } from '@/components/presets/PresetTemplates';

// ─── Canvas constants ─────────────────────────────────────────────────────────

export const CANVAS_PADDING = 400;
export const ZOOM_SENSITIVITY = 0.15;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

// ─── PDF worker ───────────────────────────────────────────────────────────────

export const pdfWorkerUrl =
  `/pdf.worker.min.js`;

export function initPdfWorker() {
  if (typeof window === "undefined") return;
  const lib = require("pdfjs-dist/legacy/build/pdf");
  lib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

// ─── Viewer tools ────────────────────────────────────────────────────────────

export const VIEWER_TOOLS = [
  { id: 'select',     label: 'Select',     shortcut: 'V', icon: MousePointer2 },
  { id: 'linear',     label: 'Linear',     shortcut: 'L', icon: Pencil },
  { id: 'arc',        label: 'Arc',        shortcut: 'B', icon: CircleDot    }, // ← new
  { id: 'rectangle',  label: 'Rectangle',  shortcut: 'R', icon: Square },
  { id: 'polygon',    label: 'Polygon',    shortcut: 'P', icon: Pentagon },
  { id: 'count',      label: 'Count',      shortcut: 'N', icon: Hash },
  { id: 'magic-fill', label: 'Magic Fill', shortcut: 'M', icon: Wand2 },
] as const;

// ─── Viewer props ────────────────────────────────────────────────────────────

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

  showPins?: boolean;
  onShowPinsChange?: (v: boolean) => void;

  appendToGroupId?: string | null;
  onAppendComplete?: () => void;

  onToolbarReady?: (api: ViewerToolbarAPI) => void;
}

// ─── Toolbar API ─────────────────────────────────────────────────────────────

export interface ViewerToolbarAPI {
  tools: typeof VIEWER_TOOLS;

  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;

  scale: number;
  setScale: React.Dispatch<React.SetStateAction<number>>;

  scaleFactor: number;

  snapEnabled: boolean;
  setSnapEnabled: (v: boolean) => void;

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
}

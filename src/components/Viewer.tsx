'use client';

// ─── Viewer.tsx ───────────────────────────────────────────────────────────────
//
//  FIX: Measurements are no longer stored in the undo stack.
//  TakeoffContext is the single source of truth for measurements[].
//  The undo stack only tracks tempPoints and measurements atomically.
//
//  Ctrl+Z behaviour:
//    • Undo/Redo handled entirely by TakeoffContext
//    • No special case logic needed in Viewer
//
//  ADDED: Group append support for all measurement types
//    • Linear, Polygon, Rectangle, Count, Point all supported
//    • Receives appendToGroupId and onAppendComplete from parent
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
  ZoomIn, ZoomOut, Maximize, ChevronLeft, ChevronRight,
  MousePointer2, CircleDot, Ruler, Square, Hash, FolderOpen,
  Check, Scaling, Target, Settings2, Undo2, Redo2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType, TakeoffRow, Drawing } from '@/types';
import { PresetTemplate } from './presets/PresetTemplates';
import { PresetDrawer } from './presets/PresetDrawer';
import { Minimap } from './Minimap';
import { MeasurementDetailsDialog } from './MeasurementDetailsDialog';
import { CountPinOverlay } from './CountPinOverlay';

const pdfWorkerUrl = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();
import { SnapSettingsPanel } from './SnapSettingsPanel';
import { useSnapEngine } from '@/hooks/useSnapEngine';
import { useMeasurements } from '@/hooks/useMeasurements';
import { useTakeoffContext } from '@/context/TakeoffContext';
import type { InProgressPoint } from '@/context/TakeoffContext';
import type { PdfDimensions } from '@/types/viewerTypes';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ─── Static tool definitions (moved outside component to prevent recreation) ───
const VIEWER_TOOLS = [
  { id: 'select',    icon: MousePointer2, label: 'Select (Pan)',  shortcut: 'V' },
  { id: 'point',     icon: CircleDot,     label: 'Point',         shortcut: 'P' },
  { id: 'linear',    icon: Ruler,         label: 'Linear',        shortcut: 'L' },
  { id: 'polygon',   icon: Square,        label: 'Polygon',       shortcut: 'A' },
  { id: 'rectangle', icon: Square,        label: 'Rectangle',     shortcut: 'R' },
  { id: 'count',     icon: Hash,          label: 'Count',         shortcut: 'C' },
  { id: 'scale',     icon: Scaling,       label: 'Calibrate',     shortcut: 'S' },
] as const;

// ─── Snap Candidate Dialog ────────────────────────────────────────────────────

interface SnapCandidateDialogProps {
  count: number;
  onAccept: () => void;
  onDismiss: () => void;
}

function SnapCandidateDialog({ count, onAccept, onDismiss }: SnapCandidateDialogProps) {
  return (
    <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-50 bg-zinc-900 border border-amber-400/60 shadow-xl shadow-amber-400/10 p-4 flex items-center gap-4 font-mono">
      <Target className="w-4 h-4 text-amber-400 flex-shrink-0" />
      <div>
        <div className="text-[11px] font-bold text-zinc-200">
          {count} point{count > 1 ? 's' : ''} can be snapped to nearby corners
        </div>
        <div className="text-[9px] text-zinc-500 uppercase tracking-wider mt-0.5">
          Auto-fix detected loose placements
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={onAccept}
          className="text-[10px] font-bold px-3 py-1.5 bg-amber-400 text-black uppercase tracking-widest hover:bg-amber-300 transition-all"
        >
          FIX
        </button>
        <button
          onClick={onDismiss}
          className="text-[10px] font-bold px-3 py-1.5 border border-zinc-700 text-zinc-400 uppercase tracking-widest hover:border-zinc-500 transition-all"
        >
          KEEP
        </button>
      </div>
    </div>
  );
}

// ─── Viewer Props ─────────────────────────────────────────────────────────────

interface ViewerProps {
  activeTool:          ToolType;
  setActiveTool:       (tool: ToolType) => void;
  measurements:        TakeoffRow[];
  onAddMeasurement:    (m: Omit<TakeoffRow, 'color' | 'isVisible' | 'drawingId'>) => void;
  onUpdateMeasurement?: (id: string, updates: Partial<TakeoffRow>) => void;
  scaleFactor:         number;
  onScaleSet:          (factor: number) => void;
  activeDrawing:       Drawing | null;
  onDrawingAdded:      (name: string, fileUrl: string, file?: File) => void;
  showPresetDrawer:    boolean;
  onClosePresetDrawer: () => void;
  onSelectPreset:      (data: Record<string, any>, template: PresetTemplate) => void;
  hideToolbar?:        boolean;
  onToolbarReady?:     (api: ViewerToolbarAPI) => void;
  appendToGroupId?:    string | null;
  onAppendComplete?:   () => void;
}

export interface ViewerToolbarAPI {
  tools: { id: string; icon: React.ElementType; label: string; shortcut: string }[];
  activeTool: ToolType;
  setActiveTool: (t: ToolType) => void;
  scale: number;
  setScale: React.Dispatch<React.SetStateAction<number>>;
  scaleFactor: number;
  snapEnabled: boolean;
  setSnapEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  showSnapSettings: boolean;
  setShowSnapSettings: React.Dispatch<React.SetStateAction<boolean>>;
  showPins: boolean;
  setShowPins: React.Dispatch<React.SetStateAction<boolean>>;
  snapThreshold: number;
  setSnapThreshold: React.Dispatch<React.SetStateAction<number>>;
  confidenceFilter: number;
  setConfidenceFilter: React.Dispatch<React.SetStateAction<number>>;
  analysisStatus: string;
  analysisPage: { current: number; total: number } | null;
  currentPageCorners: number;
  pdf: pdfjsLib.PDFDocumentProxy | null;
  pageNumber: number;
  fitToScreen: () => void;
  handleManualScale: () => void;
  canUndo: boolean;
  canRedo: boolean;
  handleUndo: () => void;
  handleRedo: () => void;
}

// ─── Main Viewer Component ────────────────────────────────────────────────────

export function Viewer({
  activeTool, setActiveTool,
  measurements,
  onAddMeasurement: onAddMeasurementProp,
  onUpdateMeasurement: onUpdateMeasurementProp,
  scaleFactor, onScaleSet, activeDrawing, onDrawingAdded,
  showPresetDrawer, onClosePresetDrawer, onSelectPreset,
  hideToolbar = false,
  appendToGroupId: propAppendToGroupId,
  onAppendComplete,
  onToolbarReady,
}: ViewerProps) {
  const pdfCanvasRef     = useRef<HTMLCanvasElement>(null);
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null);
  const pinCanvasRef     = useRef<HTMLCanvasElement>(null);
  const containerRef     = useRef<HTMLDivElement>(null);

  const [pdf, setPdf]               = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale]           = useState(1.5);
  const [loading, setLoading]       = useState(false);
  const [isPanning, setIsPanning]   = useState(false);

  // ── Space bar pan state ───────────────────────────────────────────────────
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceHeldRef = useRef(false);

  const [pdfDimensions, setPdfDimensions] = useState<PdfDimensions | null>(null);
  const pdfDimensionsRef = useRef<PdfDimensions | null>(null);
  useEffect(() => { pdfDimensionsRef.current = pdfDimensions; }, [pdfDimensions]);

  const pageNumberRef = useRef(pageNumber);
  useEffect(() => { pageNumberRef.current = pageNumber; }, [pageNumber]);

  const scaleRef = useRef(scale);
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(pdf);
  useEffect(() => { pdfRef.current = pdf; }, [pdf]);

  const onScaleSetRef = useRef(onScaleSet);
  useEffect(() => { onScaleSetRef.current = onScaleSet; }, [onScaleSet]);

  const activeDrawingId  = activeDrawing?.id     ?? null;
  const activeDrawingUrl = activeDrawing?.fileUrl ?? null;

  const activeDrawingFileRef = useRef<File | undefined>(activeDrawing?.file);
  useEffect(() => { activeDrawingFileRef.current = activeDrawing?.file; }, [activeDrawing?.file]);

  const startExtractionRef = useRef<((...args: any[]) => void) | null>(null);

  // ── Snap Settings ───────────────────────────────────────────────────────────
  const [snapEnabled, setSnapEnabled]           = useState(true);
  const [showPins, setShowPins]                 = useState(true);
  const [snapThreshold, setSnapThreshold]       = useState(14);
  const [confidenceFilter, setConfidenceFilter] = useState(0.1);
  const [showSnapSettings, setShowSnapSettings] = useState(false);

  // ── Calibration dialog state ───────────────────────────────────────────────
  const [showCalibrationDialog, setShowCalibrationDialog] = useState(false);
  const [pendingPtLen, setPendingPtLen] = useState<number>(0);
  const [calibrationInput, setCalibrationInput] = useState('');

  // ── Measurement Details Dialog ───────────────────────────────────────────────
  const [showMeasurementDialog, setShowMeasurementDialog] = useState(false);
  const [pendingMeasurementData, setPendingMeasurementData] = useState<{
    id: string;
    type: string;
    description: string;
  } | null>(null);
  const pendingMeasurementRef = useRef<{
    id: string;
    type: string;
    description: string;
    name: string;
    material: string;
  } | null>(null);

  // Use the prop from parent
  const appendToGroupId = propAppendToGroupId;

  // ── Wrap parent callbacks — stable refs ──────────────────────────────────────
  const onAddMeasurement = useCallback((
    m: Omit<TakeoffRow, 'color' | 'isVisible' | 'drawingId'>
  ) => {
    onAddMeasurementProp(m);
  }, [onAddMeasurementProp]);

  const onUpdateMeasurement = useCallback((id: string, updates: Partial<TakeoffRow>) => {
    onUpdateMeasurementProp?.(id, updates);
  }, [onUpdateMeasurementProp]);

  // ── Get context actions ─────────────────────────────────────────────────────
  const {
    tempPoints,
    pushPoint,
    commitMeasurement,
    batchCommitMeasurements,
    clearTempPoints,
    undo,
    redo,
    canUndo,
    canRedo,
    pendingMeasurement,
    setPendingMeasurement,
  } = useTakeoffContext();

  // ── Wrap undo/redo for consistent API ───────────────────────────────────────
  const undoRedoRef = useRef<{ setCursorPoint: (p: any) => void }>({ setCursorPoint: () => {} });
  
  const handleUndo = useCallback(() => {
    undo();
    undoRedoRef.current.setCursorPoint(null);
  }, [undo]);
  
  const handleRedo = useCallback(() => {
    redo();
    undoRedoRef.current.setCursorPoint(null);
  }, [redo]);

  // ── Snap Engine ─────────────────────────────────────────────────────────────
  const snapEngine = useSnapEngine({
    pinCanvasRef: pinCanvasRef as React.RefObject<HTMLCanvasElement>,
    pdfDimensionsRef: pdfDimensionsRef as React.RefObject<PdfDimensions>,
    pageNumberRef: pageNumberRef as React.RefObject<number>,
    snapEnabled,
    showPins,
    snapThreshold,
    confidenceFilter,
  });

  const {
    pageData,
    analysisStatus,
    analysisPage,
    snapFlashes,
    startExtraction,
    getScaledCorners,
    snapToCorner,
    triggerSnapFlash,
    redrawPinCanvas,
    cursorPointRef,
  } = snapEngine;

  useEffect(() => { startExtractionRef.current = startExtraction; }, [startExtraction]);

  // ── Measurements Engine ─────────────────────────────────────────────────────
  const setActiveToolString = useCallback((tool: string) => {
    setActiveTool(tool as ToolType);
  }, [setActiveTool]);

  const handleScalePrompt = useCallback((ptLen: number) => {
    setPendingPtLen(ptLen);
    setCalibrationInput('');
    setShowCalibrationDialog(true);
  }, []);

  const handleCalibrationConfirm = useCallback(() => {
    const r = parseFloat(calibrationInput);
    if (!isNaN(r) && r > 0 && pendingPtLen > 0) {
      onScaleSetRef.current(r / pendingPtLen);
    }
    setShowCalibrationDialog(false);
  }, [calibrationInput, pendingPtLen]);

  const measureEngine = useMeasurements({
    drawingCanvasRef: drawingCanvasRef as React.RefObject<HTMLCanvasElement>,
    pdfDimensionsRef: pdfDimensionsRef as React.RefObject<PdfDimensions>,
    pageNumberRef:    pageNumberRef    as React.RefObject<number>,
    scaleRef:         scaleRef        as React.RefObject<number>,
    activeTool,
    setActiveTool:    setActiveToolString,
    measurements,
    tempPoints,
    pushPoint,
    commitMeasurement,
    batchCommitMeasurements,
    appendToGroupId,
    onAppendComplete,
    onScalePrompt: handleScalePrompt,
    clearTempPoints,
    scaleFactor,
    onUpdateMeasurement,
    isPanning,
    snapToCorner,
    getScaledCorners,
    triggerSnapFlash,
    snapEnabled,
    snapThreshold,
    redrawPinCanvas,
    cursorPointRef,
    activeDrawingId,
  });

  const {
    pendingSnapCandidates,
    setPendingSnapCandidates,
    finishMeasurement,
    handleCanvasClick,
    handleContextMenu,
    handleCanvasPointerMove,
    handleCanvasPointerDown,
    handleCanvasPointerUp,
    toCanvas,
    setCursorPoint,
  } = measureEngine;

  // Bind setCursorPoint to ref so undo/redo can clear the cursor
  useEffect(() => {
    undoRedoRef.current.setCursorPoint = setCursorPoint;
  }, [setCursorPoint]);

  // Fix: Safely set the onScaleSet ref
  useEffect(() => {
    if (useMeasurements && (useMeasurements as any)._onScaleSetRef) {
      (useMeasurements as any)._onScaleSetRef.current = onScaleSet;
    }
  }, [onScaleSet]);

  // Use static tools array defined outside component
  const tools = VIEWER_TOOLS;

  const CANVAS_PADDING   = 24;
  const ZOOM_SENSITIVITY = 0.25;
  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 10;

  // ── Wrap finishMeasurement to show dialog ───────────────────────────────────
  const handleFinishMeasurement = useCallback(() => {
    // For count/point: need at least 1 point; for others need at least 2 points
    const minPoints = (activeTool === 'count' || activeTool === 'point') ? 1 : 2;
    if (tempPoints.length < minPoints) {
      finishMeasurement();
      return;
    }

    if (appendToGroupId) {
      // Skip the dialog, go straight to appending
      finishMeasurement(undefined, { appendToGroupId });
      onAppendComplete?.();
      return;
    }

    // Show dialog to collect name and material for all tools that collect measurements
    const typeStr = activeTool === 'polygon' || activeTool === 'rectangle' ? 'Polygon' : activeTool === 'linear' ? 'Length' : activeTool === 'count' ? 'Count' : 'Point';
    setPendingMeasurementData({
      id: `temp-${Date.now()}`,
      type: typeStr,
      description: `New ${typeStr}`,
    });
    setShowMeasurementDialog(true);

    // Store reference to finish callback
    pendingMeasurementRef.current = {
      id: `temp-${Date.now()}`,
      type: typeStr,
      description: `New ${typeStr}`,
      name: '',
      material: '',
    };
  }, [tempPoints.length, activeTool, finishMeasurement, appendToGroupId, onAppendComplete]);

  const handleDialogConfirm = useCallback((name: string, material: string, icon?: string) => {
    setShowMeasurementDialog(false);
    const label = name.trim() || `New ${pendingMeasurementData?.type || 'Measurement'}`;
    finishMeasurement(undefined, { label, icon });
  }, [finishMeasurement, pendingMeasurementData]);

  const handleDialogSkip = useCallback(() => {
    setShowMeasurementDialog(false);
    finishMeasurement();
  }, [finishMeasurement]);

  // ── Center the document in the viewport ─────────────────────────────────────
  const centerDocumentInViewport = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    requestAnimationFrame(() => {
      const viewW = container.clientWidth;
      const viewH = container.clientHeight;
      container.scrollLeft = Math.round((container.scrollWidth  - viewW) / 2);
      container.scrollTop  = Math.round((container.scrollHeight - viewH) / 2);
    });
  }, []);

  // ── Fit to screen ──────────────────────────────────────────────────────────
  const fitToScreen = useCallback(async (
    pdfDoc?: pdfjsLib.PDFDocumentProxy,
    pageNum?: number,
  ) => {
    const doc  = pdfDoc ?? pdfRef.current;
    const page = pageNum ?? pageNumberRef.current;
    if (!doc || !containerRef.current) return;
    try {
      const p        = await doc.getPage(page);
      const viewport = p.getViewport({ scale: 1 });
      const vW = containerRef.current.clientWidth  - CANVAS_PADDING * 2;
      const vH = containerRef.current.clientHeight - CANVAS_PADDING * 2;
      const newScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(vW / viewport.width, vH / viewport.height) * 0.97));
      setScale(newScale);
      setTimeout(() => centerDocumentInViewport(), 150);
    } catch (err) {
      console.error('Fit error', err);
    }
  }, [centerDocumentInViewport]);

  // ── Manual Scale ─────────────────────────────────────────────────────────
  const handleManualScale = useCallback(() => {
    const ratioStr = window.prompt('Enter scale ratio (e.g. 1:100) or pixels per unit (e.g. 0.05):');
    if (!ratioStr) return;
    if (ratioStr.includes(':')) {
      const [paper, real] = ratioStr.split(':').map(parseFloat);
      if (!isNaN(paper) && !isNaN(real) && real > 0) {
        alert('Ratio parsing applied. Use Draw Calibration for pixel-accurate mapping.');
        onScaleSetRef.current(real / paper);
      }
    } else {
      const factor = parseFloat(ratioStr);
      if (!isNaN(factor) && factor > 0) onScaleSetRef.current(factor);
    }
  }, []);

  // ── Create memoized toolbar API object to prevent infinite loop ────────────
  const toolbarAPI = useMemo(() => {
    const currentPageData = pageData.get(pageNumber - 1);
    return {
      tools: [...VIEWER_TOOLS],
      activeTool,
      setActiveTool,
      scale,
      setScale,
      scaleFactor,
      snapEnabled,
      setSnapEnabled,
      showSnapSettings,
      setShowSnapSettings,
      showPins,
      setShowPins,
      snapThreshold,
      setSnapThreshold,
      confidenceFilter,
      setConfidenceFilter,
      analysisStatus,
      analysisPage: analysisPage ?? null,
      currentPageCorners: currentPageData?.corners.length ?? 0,
      pdf,
      pageNumber,
      fitToScreen: () => fitToScreen(),
      handleManualScale,
      canUndo,
      canRedo,
      handleUndo,
      handleRedo,
    };
  }, [
    activeTool,
    setActiveTool,
    scale,
    scaleFactor,
    snapEnabled,
    showSnapSettings,
    showPins,
    snapThreshold,
    confidenceFilter,
    analysisStatus,
    analysisPage,
    pageData,
    pageNumber,
    pdf,
    fitToScreen,
    handleManualScale,
    canUndo,
    canRedo,
    handleUndo,
    handleRedo,
  ]);

  // ── Expose toolbar API to parent ─────────────────────────────────
  useEffect(() => {
    if (!onToolbarReady) return;
    onToolbarReady(toolbarAPI);
  }, [onToolbarReady, toolbarAPI]);

  // ── File Upload ──────────────────────────────────────────────────────────
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    Array.from(files).forEach(file => {
      const url = URL.createObjectURL(file);
      onDrawingAdded(file.name, url, file);
    });
  };

  // ── PDF Load ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let isMounted = true;
    if (!activeDrawingUrl) {
      setPdf(null);
      setPdfDimensions(null);
      return;
    }
    setLoading(true);

    const handlePdfLoad = async (pdfDoc: pdfjsLib.PDFDocumentProxy) => {
      if (!isMounted) return;
      const page     = await pdfDoc.getPage(1);
      const viewport = page.getViewport({ scale: 1 });

      let fitScale = 1.5;
      if (containerRef.current) {
        const vW = (containerRef.current.clientWidth  || containerRef.current.offsetWidth)  - CANVAS_PADDING * 2;
        const vH = (containerRef.current.clientHeight || containerRef.current.offsetHeight) - CANVAS_PADDING * 2;
        if (vW > 0 && vH > 0) {
          fitScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(vW / viewport.width, vH / viewport.height) * 0.97));
        }
      }

      setPdf(pdfDoc);
      setPageNumber(1);
      setScale(fitScale);

      setTimeout(() => {
        if (!isMounted) return;
        startExtractionRef.current?.(pdfDoc, activeDrawingFileRef.current);
        setTimeout(() => {
          if (isMounted) {
            centerDocumentInViewport();
            setLoading(false);
          }
        }, 150);
      }, 50);
    };

    const file = activeDrawingFileRef.current;
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        if (!isMounted) return;
        pdfjsLib
          .getDocument({ data: new Uint8Array(reader.result as ArrayBuffer) })
          .promise.then(handlePdfLoad)
          .catch(err => { console.error(err); if (isMounted) setLoading(false); });
      };
      reader.readAsArrayBuffer(file);
    } else if (activeDrawingUrl) {
      pdfjsLib
        .getDocument(activeDrawingUrl)
        .promise.then(handlePdfLoad)
        .catch(err => { console.error(err); if (isMounted) setLoading(false); });
    }

    return () => { isMounted = false; };
  }, [activeDrawingId, activeDrawingUrl]);

  // ── PDF Rendering ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pdf) return;
    let active = true;
    let renderTask: any = null;

    const renderPage = async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (!active) return;

        const MAX_CANVAS_PIXELS = 16_000_000;
        const rawDpr = window.devicePixelRatio || 1;
        const logicalVP = page.getViewport({ scale });
        const logicalPx = logicalVP.width * logicalVP.height;
        const safeDpr = Math.sqrt(MAX_CANVAS_PIXELS / logicalPx);
        const dpr = Math.min(rawDpr, safeDpr, 3);
        const physicalVP = page.getViewport({ scale: scale * dpr });

        const cssW = logicalVP.width;
        const cssH = logicalVP.height;
        const phyW = physicalVP.width;
        const phyH = physicalVP.height;

        const canvas = pdfCanvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext('2d');
        if (!context) return;

        canvas.width = phyW;
        canvas.height = phyH;
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;

        if (drawingCanvasRef.current) {
          const dc = drawingCanvasRef.current;
          dc.width = cssW;
          dc.height = cssH;
          dc.style.width = `${cssW}px`;
          dc.style.height = `${cssH}px`;
        }

        if (pinCanvasRef.current) {
          const pc = pinCanvasRef.current;
          pc.width = cssW;
          pc.height = cssH;
          pc.style.width = `${cssW}px`;
          pc.style.height = `${cssH}px`;
        }

        setPdfDimensions({ w: cssW, h: cssH });

        renderTask = page.render({
          canvasContext: context,
          viewport: physicalVP,
          canvas: canvas as any
        } as any);
        await renderTask.promise;
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') console.error('Render error:', err);
      }
    };

    renderPage();
    return () => { active = false; if (renderTask) renderTask.cancel(); };
  }, [pdf, pageNumber, scale]);

  // ── Re-center whenever page or dimensions change ──────────────────────────
  useEffect(() => {
    if (pdf && pdfDimensions) centerDocumentInViewport();
  }, [pageNumber, pdfDimensions, centerDocumentInViewport, pdf]);

  // ── Wheel Zoom (cursor-anchored) ──────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();

      const delta = e.deltaY > 0 ? -ZOOM_SENSITIVITY : ZOOM_SENSITIVITY;
      const momentum = Math.min(Math.abs(e.deltaY) / 100, 1);
      const adjustedDelta = delta * (1 + momentum * 0.5);

      const containerRect = container.getBoundingClientRect();
      const cursorX = e.clientX - containerRect.left + container.scrollLeft;
      const cursorY = e.clientY - containerRect.top + container.scrollTop;

      setScale(prevScale => {
        const newScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prevScale + adjustedDelta));
        if (newScale === prevScale) return prevScale;

        const ratio = newScale / prevScale;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const c = containerRef.current;
            const d = pdfDimensionsRef.current;
            if (!c || !d) return;
            c.scrollLeft = cursorX * ratio - (e.clientX - containerRect.left);
            c.scrollTop = cursorY * ratio - (e.clientY - containerRect.top);
          });
        });

        return newScale;
      });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Zoom
      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        setScale(s => Math.min(MAX_ZOOM, s + ZOOM_SENSITIVITY));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        setScale(s => Math.max(MIN_ZOOM, s - ZOOM_SENSITIVITY));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        fitToScreen();
        return;
      }

      // Undo: Ctrl+Z
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Redo: Ctrl+Y or Ctrl+Shift+Z
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'y' || (e.key === 'z' && e.shiftKey))
      ) {
        e.preventDefault();
        handleRedo();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fitToScreen, handleUndo, handleRedo]);

  // ── Space bar — pan mode ───────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      if (!e.repeat) {
        spaceHeldRef.current = true;
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceHeldRef.current = false;
      setSpaceHeld(false);
      setIsPanning(false);
      if (containerRef.current) containerRef.current.style.cursor = '';
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
    };
  }, []);

  // ── Shared pan initiator ───────────────────────────────────────────────────
  const startPan = useCallback((e: React.PointerEvent, targetElement: HTMLElement) => {
    if (!pdfRef.current) return;
    e.preventDefault();
    targetElement.setPointerCapture(e.pointerId);
    setIsPanning(true);
    if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    const isMiddleMouse = e.button === 1;
    const isSpacePan    = e.button === 0 && spaceHeldRef.current;
    const isSelectPan   = e.button === 0 && activeTool === 'select';
    if (isMiddleMouse || isSpacePan || isSelectPan) {
      startPan(e, e.currentTarget as HTMLElement);
    }
  };

  const handlePointerUp = (_e: React.PointerEvent) => {
    setIsPanning(false);
    if (containerRef.current) containerRef.current.style.cursor = '';
  };

  const handleContainerPointerMove = (e: React.PointerEvent) => {
    if (isPanning && containerRef.current) {
      containerRef.current.scrollLeft -= e.movementX;
      containerRef.current.scrollTop  -= e.movementY;
    }
  };

  const handleDrawingCanvasPointerDown = (e: React.PointerEvent) => {
    const isMiddleMouse = e.button === 1;
    const isSpacePan    = e.button === 0 && spaceHeldRef.current;
    if (isMiddleMouse || isSpacePan) {
      e.stopPropagation();
      if (containerRef.current) startPan(e, containerRef.current);
    }
  };

  const currentPageData = pageData.get(pageNumber - 1);
  const isAnalyzing     = analysisStatus === 'analyzing';

  const drawingCanvasCursor = spaceHeld
    ? isPanning ? 'cursor-grabbing' : 'cursor-grab'
    : activeTool !== 'select' && !isPanning
    ? 'cursor-crosshair'
    : isPanning
    ? 'cursor-grabbing'
    : 'cursor-grab';

  // ── Toolbar JSX ────────────────────────────────────────────────────────────
  const ToolbarContent = (
    <>
      <div className="flex gap-1">
        {tools.map(tool => (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id as ToolType)}
            className={cn(
              'w-9 h-9 flex items-center justify-center transition-all relative group border',
              activeTool === tool.id
                ? 'bg-zinc-800 border-amber-400 text-amber-400'
                : 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200',
            )}
            title={`${tool.label} (${tool.shortcut})`}
          >
            <tool.icon className="w-4 h-4" />
            <div className="absolute top-10 transform -translate-x-1/2 left-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[9px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-50">
              {tool.label} [{tool.shortcut}]
            </div>
          </button>
        ))}

        {/* Divider */}
        <div className="w-px h-5 bg-zinc-700/60 self-center mx-0.5" />

        {/* Undo button */}
        <button
          onClick={handleUndo}
          disabled={!canUndo}
          className={cn(
            'w-9 h-9 flex items-center justify-center transition-all relative group border',
            canUndo
              ? 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200 hover:border-zinc-700'
              : 'bg-transparent border-transparent text-zinc-700 cursor-not-allowed',
          )}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 className="w-4 h-4" />
          {canUndo && (
            <div className="absolute top-10 transform -translate-x-1/2 left-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[9px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-50">
              Undo [Ctrl+Z]
              {tempPoints.length > 0 && (
                <span className="text-amber-400 ml-1">· pop point</span>
              )}
            </div>
          )}
        </button>

        {/* Redo button */}
        <button
          onClick={handleRedo}
          disabled={!canRedo}
          className={cn(
            'w-9 h-9 flex items-center justify-center transition-all relative group border',
            canRedo
              ? 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200 hover:border-zinc-700'
              : 'bg-transparent border-transparent text-zinc-700 cursor-not-allowed',
          )}
          title="Redo (Ctrl+Y)"
        >
          <Redo2 className="w-4 h-4" />
          {canRedo && (
            <div className="absolute top-10 transform -translate-x-1/2 left-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[9px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-50">
              Redo [Ctrl+Y]
            </div>
          )}
        </button>
      </div>

      <div className="flex flex-row items-center gap-2 flex-1 justify-center flex-wrap">
        {isAnalyzing && analysisPage && (
          <div className="flex items-center gap-1.5 border border-blue-500/40 bg-blue-500/10 px-2 py-1">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[9px] font-mono text-blue-400 uppercase tracking-widest">
              Analyzing plan… {analysisPage.current}/{analysisPage.total}
            </span>
          </div>
        )}
        {analysisStatus === 'done' && (
          <div className="flex items-center gap-1.5 border border-green-500/40 bg-green-500/10 px-2 py-1">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span className="text-[9px] font-mono text-green-400 uppercase tracking-widest">
              {currentPageData?.corners.length ?? 0} corners detected
            </span>
          </div>
        )}

        <button
          onClick={() => setSnapEnabled(s => !s)}
          className={cn(
            'flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-widest px-2 py-1 border transition-all',
            snapEnabled
              ? 'bg-green-500/10 border-green-500/50 text-green-400 hover:bg-green-500/20'
              : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
          )}
          title="Toggle corner snapping"
        >
          <Target className="w-3 h-3" />
          {snapEnabled ? 'SNAP ON' : 'SNAP OFF'}
        </button>

        <button
          onClick={() => setShowSnapSettings(s => !s)}
          className={cn(
            'flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-widest px-2 py-1 border transition-all',
            showSnapSettings
              ? 'bg-zinc-800 border-zinc-500 text-zinc-200'
              : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
          )}
          title="Snap settings"
        >
          <Settings2 className="w-3 h-3" />
          SNAP
        </button>

        <div className="flex items-center gap-1 border border-industrial-border bg-stone-900 px-2 py-1">
          <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-tighter">Scale:</span>
          <span className="text-[10px] font-mono font-bold text-amber-400 tracking-tighter whitespace-nowrap">
            {scaleFactor === 1 ? 'NOT CALIBRATED' : `1pt = ${scaleFactor.toFixed(4)}m`}
          </span>
        </div>

        <button
          onClick={() => setActiveTool('scale')}
          className={cn(
            'text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 transition-all border',
            activeTool === 'scale'
              ? 'bg-amber-400 text-black border-amber-400'
              : 'text-amber-400 border-amber-400 hover:bg-amber-400 hover:text-black',
          )}
        >
          DRAW CALIBRATION
        </button>

        <button
          onClick={handleManualScale}
          className="text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 transition-all border text-amber-400 border-amber-400 hover:bg-amber-400 hover:text-black"
        >
          MANUAL SCALE
        </button>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => setScale(s => Math.max(MIN_ZOOM, s - ZOOM_SENSITIVITY))}
          className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
          title="Zoom Out (Ctrl/Cmd + -)"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="text-[10px] font-mono text-zinc-400 w-12 text-center font-bold">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => setScale(s => Math.min(MAX_ZOOM, s + ZOOM_SENSITIVITY))}
          className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
          title="Zoom In (Ctrl/Cmd + +)"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-industrial-border mx-1" />
        <button
          onClick={() => fitToScreen()}
          className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
          title="Fit to Screen (Ctrl/Cmd + 0)"
        >
          <Maximize className="w-4 h-4" />
        </button>
      </div>
    </>
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 relative bg-industrial-black blueprint-grid flex flex-col overflow-hidden h-full">

      {!hideToolbar && (
        <div className="h-12 bg-industrial-panel border-b border-industrial-border flex flex-shrink-0 items-center justify-between px-4 z-20 shadow-sm relative">
          {ToolbarContent}
        </div>
      )}

      {showSnapSettings && (
        <SnapSettingsPanel
          showPins={showPins}
          onShowPinsChange={setShowPins}
          snapThreshold={snapThreshold}
          onSnapThresholdChange={setSnapThreshold}
          confidenceFilter={confidenceFilter}
          onConfidenceFilterChange={setConfidenceFilter}
          snapEnabled={snapEnabled}
          onSnapEnabledChange={setSnapEnabled}
        />
      )}

      {/* Scroll container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto custom-scrollbar relative outline-none select-none"
        onKeyDown={e => {
          if (e.code === 'Space') e.preventDefault();
          if (e.key === 'Escape') {
            if (tempPoints.length > 0) handleFinishMeasurement();
            else setActiveTool('select');
          }
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handleContainerPointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        tabIndex={0}
      >
        <div
          className={cn(!pdf ? 'min-h-full min-w-full flex items-center justify-center p-8' : 'relative')}
          style={pdf && pdfDimensions ? (() => {
            const vw = containerRef.current?.clientWidth ?? 0;
            const vh = containerRef.current?.clientHeight ?? 0;
            const wrapW = Math.max(pdfDimensions.w + CANVAS_PADDING * 2, vw * 3);
            const wrapH = Math.max(pdfDimensions.h + CANVAS_PADDING * 2, vh * 3);
            return { width: wrapW, height: wrapH };
          })() : undefined}
        >
          {!pdf && !loading && (
            <div className="flex flex-col items-center gap-6 p-12 border-2 border-dashed border-industrial-border bg-industrial-panel/50 backdrop-blur-sm max-w-xl w-full text-center">
              <FolderOpen className="w-12 h-12 text-zinc-700" />
              <div>
                <h2 className="text-xl font-mono font-bold tracking-tighter text-zinc-200 mb-2">
                  IMPORT PROJECT DRAWING
                </h2>
                <p className="text-xs text-zinc-500 font-mono leading-relaxed uppercase tracking-widest">
                  DRAG AND DROP OR SELECT A PDF, DWG, OR IMAGE FILE TO BEGIN MEASURING QUANTITIES.
                </p>
              </div>
              <label className="bg-amber-400 hover:bg-amber-300 text-black px-10 py-3 font-mono font-bold text-xs uppercase tracking-widest cursor-pointer transition-all shadow-xl shadow-amber-400/10 active:scale-95">
                Select File(s)
                <input
                  type="file"
                  multiple
                  className="hidden"
                  accept=".pdf,.png,.jpg,.jpeg,.dwg"
                  onChange={handleFileUpload}
                />
              </label>
            </div>
          )}

          {loading && (
            <div className="flex flex-col items-center gap-4">
              <div className="w-12 h-12 border-4 border-zinc-800 border-t-amber-400 rounded-full animate-spin" />
              <span className="text-[10px] font-mono font-bold text-amber-400 tracking-[0.2em] uppercase animate-pulse">
                Processing Vector Data...
              </span>
            </div>
          )}

          {pdf && (
            <div
              className="relative shadow-2xl border border-industrial-border bg-white"
              style={pdfDimensions && containerRef.current ? (() => {
                const vw = containerRef.current.clientWidth;
                const vh = containerRef.current.clientHeight;
                const wrapW = Math.max(pdfDimensions.w + CANVAS_PADDING * 2, vw * 3);
                const wrapH = Math.max(pdfDimensions.h + CANVAS_PADDING * 2, vh * 3);
                const left = Math.round((wrapW - pdfDimensions.w) / 2);
                const top  = Math.round((wrapH - pdfDimensions.h) / 2);
                return {
                  position: 'absolute' as const,
                  left, top,
                  width:  pdfDimensions.w,
                  height: pdfDimensions.h,
                };
              })() : {}}
            >
              <canvas ref={pdfCanvasRef} className="absolute inset-0 z-0 pointer-events-none" />

              <canvas
                ref={drawingCanvasRef}
                onClick={handleCanvasClick}
                onContextMenu={handleContextMenu}
                onPointerMove={handleCanvasPointerMove}
                onPointerDown={(e) => {
                  const handled = handleCanvasPointerDown(e);
                  if (!handled) {
                    handleDrawingCanvasPointerDown(e);
                  }
                }}
                onPointerUp={handleCanvasPointerUp}
                onPointerLeave={() => {
                  setCursorPoint(null);
                  cursorPointRef.current = null;
                  redrawPinCanvas();
                }}
                className={cn(
                  'absolute inset-0 z-10 w-full h-full mix-blend-multiply',
                  drawingCanvasCursor,
                )}
              />

              <canvas
                ref={pinCanvasRef}
                className="absolute inset-0 z-20 w-full h-full pointer-events-none"
                style={{
                  opacity: showPins && activeTool !== 'select' ? 1 : 0,
                  transition: 'opacity 0.2s',
                }}
              />
                        
              <CountPinOverlay
                measurements={measurements}
                pdfDimensions={pdfDimensions}
                toCanvas={toCanvas}
                activeDrawingId={activeDrawingId}
                activeTool={activeTool}
              />
        
              {snapFlashes.map(flash => (
                <div
                  key={flash.id}
                  className="absolute pointer-events-none z-30"
                  style={{ left: flash.x, top: flash.y, transform: 'translate(-50%,-50%)' }}
                >
                  <div
                    className="w-8 h-8 rounded-full border-2 border-green-400"
                    style={{ animation: 'snapPulse 0.6s ease-out forwards' }}
                  />
                </div>
              ))}

              {tempPoints.length > 0 && (activeTool === 'count') && (() => {
                const lastPt = toCanvas(
                  tempPoints[tempPoints.length - 1].x,
                  tempPoints[tempPoints.length - 1].y,
                );
                return (
                  <button
                    className="absolute z-30 flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                    style={{ left: lastPt.x + 15, top: lastPt.y + 15 }}
                    onClick={e => { e.stopPropagation(); handleFinishMeasurement(); }}
                    onPointerDown={e => e.stopPropagation()}
                  >
                    <Check className="w-3 h-3" />
                    Finish ({tempPoints.length} counts)
                  </button>
                );
              })()}

              {tempPoints.length > 1 && (activeTool === 'polygon' || activeTool === 'rectangle' || activeTool === 'linear') && (() => {
                const lastPt = toCanvas(
                  tempPoints[tempPoints.length - 1].x,
                  tempPoints[tempPoints.length - 1].y,
                );
                return (
                  <button
                    className="absolute z-30 flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                    style={{ left: lastPt.x + 15, top: lastPt.y + 15 }}
                    onClick={e => { e.stopPropagation(); handleFinishMeasurement(); }}
                    onPointerDown={e => e.stopPropagation()}
                  >
                    <Check className="w-3 h-3" />
                    Finish ({tempPoints.filter(p => p.snapped).length}/{tempPoints.length} snapped)
                  </button>
                );
              })()}
            </div>
          )}
        </div>

        {pendingSnapCandidates && pendingSnapCandidates.length > 0 && (
          <SnapCandidateDialog
            count={pendingSnapCandidates.length}
            onAccept={() => {
              if (onUpdateMeasurement && pendingSnapCandidates.length > 0) {
                const byId = new Map<string, typeof pendingSnapCandidates>();
                for (const cand of pendingSnapCandidates) {
                  if (!byId.has(cand.measurementId)) byId.set(cand.measurementId, []);
                  byId.get(cand.measurementId)!.push(cand);
                }
                byId.forEach((candidates, measurementId) => {
                  const target =
                    measurements.find(m => m.id === measurementId) ??
                    measurements[measurements.length - 1];
                  if (!target) return;
                  const updatedPoints = [...target.points];
                  for (const c of candidates) {
                    if (c.pointIndex < updatedPoints.length) {
                      updatedPoints[c.pointIndex] = c.snapTarget;
                    }
                  }
                  onUpdateMeasurement(target.id, { points: updatedPoints });
                });
              }
              setPendingSnapCandidates(null);
            }}
            onDismiss={() => setPendingSnapCandidates(null)}
          />
        )}

        {/* Minimap */}
        {pdf && pdfDimensions && (
          <div className="sticky bottom-2 left-2 z-40 w-0 h-0 pointer-events-none">
            <div className="pointer-events-auto">
              <Minimap
                pdf={pdf}
                pageNumber={pageNumber}
                containerRef={containerRef as React.RefObject<HTMLDivElement>}
                pdfDimensions={pdfDimensions}
                canvasPadding={CANVAS_PADDING}
                activeTool={activeTool}
              />
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      {pdf && (
        <div className="h-10 flex-shrink-0 bg-industrial-panel border-t border-industrial-border px-4 flex items-center justify-between z-20 font-mono relative shadow-sm">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setPageNumber(p => Math.max(1, p - 1))}
              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
              disabled={pageNumber <= 1}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-tighter">
              PAGE {pageNumber} OF {pdf.numPages}
            </span>
            <button
              onClick={() => setPageNumber(p => Math.min(pdf.numPages, p + 1))}
              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
              disabled={pageNumber >= pdf.numPages}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="hidden md:flex items-center gap-4 text-[9px] text-zinc-500 uppercase tracking-widest">
            <span>Right-click to finish · ESC to cancel · Space+drag or middle-mouse to pan</span>
            <div className="w-px h-3 bg-industrial-border" />
            <span>RENDER_ENGINE: PDF.JS V{pdfjsLib.version}</span>
          </div>
        </div>
      )}

      <MeasurementDetailsDialog
        isOpen={showMeasurementDialog}
        defaultName={pendingMeasurementData?.description || ''}
        defaultMaterial=""
        measurementType={pendingMeasurementData?.type}
        onConfirm={handleDialogConfirm}
        onSkip={handleDialogSkip}
      />

      <PresetDrawer
        isOpen={showPresetDrawer}
        onClose={onClosePresetDrawer}
        onSelectPreset={onSelectPreset}
      />

      {appendToGroupId && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-50 bg-blue-500/20 border border-blue-400/60 px-4 py-2 font-mono text-[10px] text-blue-300 uppercase tracking-widest flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          Adding segment to group — draw line then right-click or press Finish
          <button onClick={() => onAppendComplete?.()} className="ml-2 text-blue-500 hover:text-blue-300">✕</button>
        </div>
      )}

      {/* Calibration Dialog */}
      {showCalibrationDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-amber-400/40 shadow-2xl shadow-amber-400/10 p-6 w-80 font-mono">
            <div className="flex items-center gap-2 mb-4">
              <Scaling className="w-4 h-4 text-amber-400 flex-shrink-0" />
              <span className="text-[11px] font-bold text-amber-400 uppercase tracking-widest">
                Calibrate Scale
              </span>
            </div>
            <p className="text-[10px] text-zinc-400 uppercase tracking-wider mb-4 leading-relaxed">
              You drew a line across a known distance.<br />
              Enter the real-world length in meters.
            </p>
            <input
              autoFocus
              type="number"
              min="0.001"
              step="any"
              placeholder="e.g. 5"
              value={calibrationInput}
              onChange={e => setCalibrationInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCalibrationConfirm();
                if (e.key === 'Escape') setShowCalibrationDialog(false);
              }}
              className="w-full bg-zinc-800 border border-zinc-600 focus:border-amber-400 text-zinc-100 text-sm font-mono px-3 py-2 outline-none mb-4 transition-colors"
            />
            <div className="flex gap-2">
              <button
                onClick={handleCalibrationConfirm}
                disabled={!calibrationInput || isNaN(parseFloat(calibrationInput))}
                className="flex-1 bg-amber-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-black font-bold text-[10px] uppercase tracking-widest py-2 transition-all hover:bg-amber-300"
              >
                Set Scale
              </button>
              <button
                onClick={() => setShowCalibrationDialog(false)}
                className="flex-1 border border-zinc-700 text-zinc-400 font-bold text-[10px] uppercase tracking-widest py-2 hover:border-zinc-500 transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes snapPulse {
          0%   { transform: translate(-50%,-50%) scale(0.5); opacity: 1; }
          100% { transform: translate(-50%,-50%) scale(2.5); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
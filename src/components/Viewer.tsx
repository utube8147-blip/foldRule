import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
  ZoomIn, ZoomOut, Maximize, ChevronLeft, ChevronRight,
  MousePointer2, CircleDot, Ruler, Square, Hash, FolderOpen,
  Check, Scaling, Target, Settings2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType, TakeoffRow, Drawing } from '@/types';
import { PresetTemplate } from './presets/PresetTemplates';
import { PresetDrawer } from './presets/PresetDrawer';

const pdfWorkerUrl = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();
import { SnapSettingsPanel } from './SnapSettingsPanel';
import { useSnapEngine } from '@/hooks/useSnapEngine';
import { useMeasurements } from '@/hooks/useMeasurements';
import type { PdfDimensions } from '@/types/viewerTypes';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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
  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;
  measurements: TakeoffRow[];
  onAddMeasurement: (m: Omit<TakeoffRow, 'id' | 'color' | 'isVisible' | 'drawingId'>) => void;
  onUpdateMeasurement?: (id: string, updates: Partial<TakeoffRow>) => void;
  scaleFactor: number;
  onScaleSet: (factor: number) => void;
  activeDrawing: Drawing | null;
  onDrawingAdded: (name: string, fileUrl: string, file?: File) => void;
  // Preset drawer
  showPresetDrawer: boolean;
  onClosePresetDrawer: () => void;
  onSelectPreset: (data: Record<string, any>, template: PresetTemplate) => void;
  // NEW: when true the internal toolbar strip is hidden — parent renders it instead
  hideToolbar?: boolean;
  // NEW: expose snap/zoom state so parent toolbar can render controls
  onToolbarReady?: (api: ViewerToolbarAPI) => void;
}

// API object passed up to the parent so workspace can render the toolbar controls
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
}

// ─── Main Viewer Component ────────────────────────────────────────────────────

export function Viewer({
  activeTool, setActiveTool, measurements, onAddMeasurement,
  onUpdateMeasurement, scaleFactor, onScaleSet, activeDrawing, onDrawingAdded,
  showPresetDrawer, onClosePresetDrawer, onSelectPreset,
  hideToolbar = false,
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

  const [pdfDimensions, setPdfDimensions] = useState<PdfDimensions | null>(null);
  const pdfDimensionsRef = useRef<PdfDimensions | null>(null);
  useEffect(() => { pdfDimensionsRef.current = pdfDimensions; }, [pdfDimensions]);

  const pageNumberRef = useRef(pageNumber);
  useEffect(() => { pageNumberRef.current = pageNumber; }, [pageNumber]);

  const scaleRef = useRef(scale);
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  // ── Snap Settings ───────────────────────────────────────────────────────────
  const [snapEnabled, setSnapEnabled]           = useState(true);
  const [showPins, setShowPins]                 = useState(true);
  const [snapThreshold, setSnapThreshold]       = useState(14);
  const [confidenceFilter, setConfidenceFilter] = useState(0.1);
  const [showSnapSettings, setShowSnapSettings] = useState(false);

  // ── Snap Engine ─────────────────────────────────────────────────────────────
  const snapEngine = useSnapEngine({
    pinCanvasRef,
    pdfDimensionsRef,
    pageNumberRef,
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

  // ── Measurements Engine ─────────────────────────────────────────────────────
  const measureEngine = useMeasurements({
    drawingCanvasRef,
    pdfDimensionsRef,
    pageNumberRef,
    scaleRef,
    activeTool,
    setActiveTool,
    measurements,
    scaleFactor,
    onAddMeasurement,
    onUpdateMeasurement,
    isPanning,
    snapToCorner,
    getScaledCorners,
    triggerSnapFlash,
    snapEnabled,
    snapThreshold,
    redrawPinCanvas,
    cursorPointRef,
  });

  const {
    tempPoints,
    pendingSnapCandidates,
    setPendingSnapCandidates,
    finishMeasurement,
    handleCanvasClick,
    handleContextMenu,
    handleCanvasPointerMove,
    toCanvas,
  } = measureEngine;

  useEffect(() => {
    (useMeasurements as any)._onScaleSetRef.current = onScaleSet;
  }, [onScaleSet]);

  // ── Tools list (shared between internal toolbar and parent toolbar) ──────────
  const tools = [
    { id: 'select', icon: MousePointer2, label: 'Select (Pan)', shortcut: 'V' },
    { id: 'point',  icon: CircleDot,     label: 'Point',        shortcut: 'P' },
    { id: 'linear', icon: Ruler,         label: 'Linear',       shortcut: 'L' },
    { id: 'area',   icon: Square,        label: 'Area',         shortcut: 'A' },
    { id: 'count',  icon: Hash,          label: 'Count',        shortcut: 'C' },
    { id: 'scale',  icon: Scaling,       label: 'Calibrate',    shortcut: 'S' },
  ];

  // ── Fit to screen ─────────────────────────────────────────────────────────────
  const fitToScreen = useCallback(async (pdfDoc?: pdfjsLib.PDFDocumentProxy, pageNum?: number) => {
    const doc  = pdfDoc  ?? pdf;
    const page = pageNum ?? pageNumber;
    if (!doc) return;
    try {
      const p        = await doc.getPage(page);
      const viewport = p.getViewport({ scale: 1 });
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        const fitScale = Math.min((width - 64) / viewport.width, (height - 64) / viewport.height);
        setScale(Math.max(0.1, fitScale));
      }
    } catch (err) { console.error('Fit error', err); }
  }, [pdf, pageNumber]);

  // ── Manual Scale ──────────────────────────────────────────────────────────────
  const handleManualScale = useCallback(() => {
    const ratioStr = window.prompt('Enter scale ratio (e.g. 1:100) or pixels per unit (e.g. 0.05):');
    if (!ratioStr) return;
    if (ratioStr.includes(':')) {
      const [paper, real] = ratioStr.split(':').map(parseFloat);
      if (!isNaN(paper) && !isNaN(real) && real > 0) {
        alert('Ratio parsing applied. Use Draw Calibration for pixel-accurate mapping.');
        onScaleSet(real / paper);
      }
    } else {
      const factor = parseFloat(ratioStr);
      if (!isNaN(factor) && factor > 0) onScaleSet(factor);
    }
  }, [onScaleSet]);

  // ── Expose toolbar API to parent ──────────────────────────────────────────────
  useEffect(() => {
    if (!onToolbarReady) return;
    const currentPageData = pageData.get(pageNumber - 1);
    onToolbarReady({
      tools,
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
    });
  }, [
    activeTool, scale, scaleFactor, snapEnabled, showSnapSettings,
    showPins, snapThreshold, confidenceFilter, analysisStatus, analysisPage,
    pageData, pageNumber, pdf, fitToScreen, handleManualScale,
  ]);

  // ── File Upload ───────────────────────────────────────────────────────────────
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    Array.from(files).forEach(file => {
      const url = URL.createObjectURL(file);
      onDrawingAdded(file.name, url, file);
    });
  };

  // ── PDF Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let isMounted = true;
    if (!activeDrawing?.fileUrl) { setPdf(null); return; }
    setLoading(true);

    const handlePdfLoad = (pdfDoc: pdfjsLib.PDFDocumentProxy) => {
      if (!isMounted) return;
      setPdf(pdfDoc);
      setPageNumber(1);
      fitToScreen(pdfDoc, 1);
      setLoading(false);
      startExtraction(pdfDoc, activeDrawing.file);
    };

    if (activeDrawing.file) {
      const reader = new FileReader();
      reader.onload = () => {
        if (!isMounted) return;
        pdfjsLib.getDocument({ data: new Uint8Array(reader.result as ArrayBuffer) }).promise
          .then(handlePdfLoad)
          .catch(err => { console.error(err); if (isMounted) setLoading(false); });
      };
      reader.readAsArrayBuffer(activeDrawing.file);
    } else {
      pdfjsLib.getDocument(activeDrawing.fileUrl).promise
        .then(handlePdfLoad)
        .catch(err => { console.error(err); if (isMounted) setLoading(false); });
    }

    return () => { isMounted = false; };
  }, [activeDrawing, fitToScreen, startExtraction]);

  // ── PDF Rendering ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pdf) return;
    let active = true;
    let renderTask: any = null;

    const renderPage = async () => {
      try {
        const page     = await pdf.getPage(pageNumber);
        if (!active) return;
        const viewport = page.getViewport({ scale });
        const canvas   = pdfCanvasRef.current;
        if (!canvas) return;
        const context  = canvas.getContext('2d');
        if (!context) return;
        canvas.height  = viewport.height;
        canvas.width   = viewport.width;
        if (drawingCanvasRef.current) {
          drawingCanvasRef.current.width  = viewport.width;
          drawingCanvasRef.current.height = viewport.height;
        }
        if (pinCanvasRef.current) {
          pinCanvasRef.current.width  = viewport.width;
          pinCanvasRef.current.height = viewport.height;
        }
        setPdfDimensions({ w: viewport.width, h: viewport.height });
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') console.error('Render error:', err);
      }
    };

    renderPage();
    return () => { active = false; if (renderTask) renderTask.cancel(); };
  }, [pdf, pageNumber, scale]);

  // ── Wheel Zoom ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        setScale(s => {
          const newScale = Math.max(0.1, s + delta);
          if (newScale !== s) {
            const ratio      = newScale / s;
            const canvasRect = drawingCanvasRef.current?.getBoundingClientRect();
            if (canvasRect) {
              setTimeout(() => {
                if (containerRef.current) {
                  containerRef.current.scrollLeft += (e.clientX - canvasRect.left) * (ratio - 1);
                  containerRef.current.scrollTop  += (e.clientY - canvasRect.top)  * (ratio - 1);
                }
              }, 0);
            }
          }
          return newScale;
        });
      }
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // ── Panning ───────────────────────────────────────────────────────────────────
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && activeTool === 'select')) {
      e.preventDefault();
      setIsPanning(true);
      if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
    }
  };
  const handlePointerUp = () => {
    setIsPanning(false);
    if (containerRef.current) containerRef.current.style.cursor = '';
  };
  const handleContainerPointerMove = (e: React.PointerEvent) => {
    if (isPanning && containerRef.current) {
      containerRef.current.scrollLeft -= e.movementX;
      containerRef.current.scrollTop  -= e.movementY;
    }
  };

  const currentPageData = pageData.get(pageNumber - 1);
  const isAnalyzing     = analysisStatus === 'analyzing';

  // ── Toolbar JSX (reused in both internal and via parent) ──────────────────────
  const ToolbarContent = (
    <>
      {/* Tool buttons */}
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
      </div>

      {/* Middle controls */}
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

      {/* Zoom controls */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <button onClick={() => setScale(s => Math.max(0.1, s - 0.1))} className="p-1.5 text-zinc-500 hover:text-zinc-200">
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="text-[10px] font-mono text-zinc-400 w-12 text-center">{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale(s => s + 0.1)} className="p-1.5 text-zinc-500 hover:text-zinc-200">
          <ZoomIn className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-industrial-border mx-1" />
        <button onClick={() => fitToScreen()} className="p-1.5 text-zinc-500 hover:text-zinc-200">
          <Maximize className="w-4 h-4" />
        </button>
      </div>
    </>
  );

  return (
    <div className="flex-1 relative bg-industrial-black blueprint-grid flex flex-col overflow-hidden">

      {/* ── Internal toolbar — only rendered when hideToolbar is false ──────── */}
      {!hideToolbar && (
        <div className="h-12 bg-industrial-panel border-b border-industrial-border flex flex-shrink-0 items-center justify-between px-4 z-20 shadow-sm relative">
          {ToolbarContent}
        </div>
      )}

      {/* ── Snap Settings Panel ──────────────────────────────────────────────── */}
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

      {/* ── Canvas Scroll Area ───────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto custom-scrollbar relative outline-none select-none"
        onKeyDown={e => {
          if (e.key === 'Escape') {
            if (tempPoints.length > 0) finishMeasurement();
            else setActiveTool('select');
          }
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handleContainerPointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        tabIndex={0}
      >
        <div className={cn(
          'min-h-full min-w-full flex w-max h-max',
          !pdf ? 'items-center justify-center p-8' : 'p-[50vh] xl:p-[100vh]',
        )}>
          {/* Empty state */}
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

          {/* Loading spinner */}
          {loading && (
            <div className="flex flex-col items-center gap-4 m-auto">
              <div className="w-12 h-12 border-4 border-zinc-800 border-t-amber-400 rounded-full animate-spin" />
              <span className="text-[10px] font-mono font-bold text-amber-400 tracking-[0.2em] uppercase animate-pulse">
                Processing Vector Data...
              </span>
            </div>
          )}

          {/* PDF canvas stack */}
          {pdf && (
            <div
              className="relative shadow-2xl border border-industrial-border bg-white transition-all flex-shrink-0 m-auto"
              style={pdfDimensions ? { width: pdfDimensions.w, height: pdfDimensions.h } : {}}
            >
              <canvas ref={pdfCanvasRef} className="absolute inset-0 z-0 pointer-events-none" />

              <canvas
                ref={drawingCanvasRef}
                onClick={handleCanvasClick}
                onContextMenu={handleContextMenu}
                onPointerMove={handleCanvasPointerMove}
                onPointerLeave={() => {
                  measureEngine.setCursorPoint(null);
                  cursorPointRef.current = null;
                  redrawPinCanvas();
                }}
                className={cn(
                  'absolute inset-0 z-10 w-full h-full mix-blend-multiply',
                  activeTool !== 'select' && !isPanning
                    ? 'cursor-crosshair'
                    : isPanning
                    ? 'cursor-grabbing'
                    : 'cursor-grab',
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

              {tempPoints.length > 1 && (activeTool === 'area' || activeTool === 'linear') && (() => {
                const lastPt = toCanvas(
                  tempPoints[tempPoints.length - 1].x,
                  tempPoints[tempPoints.length - 1].y,
                );
                return (
                  <button
                    className="absolute z-30 flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                    style={{ left: lastPt.x + 15, top: lastPt.y + 15 }}
                    onClick={e => { e.stopPropagation(); finishMeasurement(); }}
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

        {/* Snap correction dialog */}
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
      </div>

      {/* ── Page Footer ─────────────────────────────────────────────────────── */}
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
            <span>Right-click to finish · ESC to cancel</span>
            <div className="w-px h-3 bg-industrial-border" />
            {snapEnabled && (
              <>
                <span className="text-green-500">⦿ SNAP ACTIVE {snapThreshold}px</span>
                <div className="w-px h-3 bg-industrial-border" />
              </>
            )}
            <span>RENDER_ENGINE: PDF.JS V{pdfjsLib.version}</span>
          </div>
        </div>
      )}

      {/* ── Preset Drawer ────────────────────────────────────────────────────── */}
      <PresetDrawer
        isOpen={showPresetDrawer}
        onClose={onClosePresetDrawer}
        onSelectPreset={onSelectPreset}
      />

      <style>{`
        @keyframes snapPulse {
          0%   { transform: translate(-50%,-50%) scale(0.5); opacity: 1; }
          100% { transform: translate(-50%,-50%) scale(2.5); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
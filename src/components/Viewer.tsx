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
  showPresetDrawer: boolean;
  onClosePresetDrawer: () => void;
  onSelectPreset: (data: Record<string, any>, template: PresetTemplate) => void;
  hideToolbar?: boolean;
  onToolbarReady?: (api: ViewerToolbarAPI) => void;
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

  useEffect(() => { startExtractionRef.current = startExtraction; }, [startExtraction]);

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

  // ── Tools list ───────────────────────────────────────────────────────────────
  const tools = [
    { id: 'select', icon: MousePointer2, label: 'Select (Pan)', shortcut: 'V' },
    { id: 'point',  icon: CircleDot,     label: 'Point',        shortcut: 'P' },
    { id: 'linear', icon: Ruler,         label: 'Linear',       shortcut: 'L' },
    { id: 'area',   icon: Square,        label: 'Area',         shortcut: 'A' },
    { id: 'count',  icon: Hash,          label: 'Count',        shortcut: 'C' },
    { id: 'scale',  icon: Scaling,       label: 'Calibrate',    shortcut: 'S' },
  ];

  // Padding constant kept in sync between centering logic, fitToScreen, and CSS class.
  // p-6 = 24px in Tailwind.
  const CANVAS_PADDING = 24;

  // ── Center the document in the viewport ─────────────────────────────────────
  // The inner wrapper is now a plain block with padding (not flex-centered).
  // margin:auto on the document div handles centering when it fits the viewport.
  // When the document is LARGER than the viewport we still want to start centered
  // (not at the top-left corner) so we set scrollLeft/scrollTop explicitly.
  // scrollWidth/scrollHeight are used (not canvas.offsetWidth) because they
  // always reflect the true scrollable area including padding.
  const centerDocumentInViewport = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    requestAnimationFrame(() => {
      // The wrapper is always large (max(doc+padding, viewport*3)).
      // Scrolling to (scrollWidth-viewWidth)/2 and (scrollHeight-viewHeight)/2
      // lands us exactly at the center of the wrapper, which is where the
      // document is positioned (both small and large docs).
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

      // Subtract padding from both axes so the fitted doc never touches edges
      const vW = containerRef.current.clientWidth  - CANVAS_PADDING * 2;
      const vH = containerRef.current.clientHeight - CANVAS_PADDING * 2;

      const newScale = Math.max(0.1, Math.min(5, Math.min(vW / viewport.width, vH / viewport.height) * 0.97));
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

  // ── Expose toolbar API to parent ──────────────────────────────────────────
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
          fitScale = Math.max(0.3, Math.min(5, Math.min(vW / viewport.width, vH / viewport.height) * 0.97));
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
    } else {
      pdfjsLib
        .getDocument(activeDrawingUrl)
        .promise.then(handlePdfLoad)
        .catch(err => { console.error(err); if (isMounted) setLoading(false); });
    }

    return () => { isMounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDrawingId, activeDrawingUrl]);

  // ── PDF Rendering ─────────────────────────────────────────────────────────
  // DPR-aware rendering: we render the PDF canvas at physical pixel resolution
  // (scale × devicePixelRatio, adaptively capped so canvas never exceeds 16M physical pixels)
  // but set CSS width/height to the logical size so the document div stays the
  // correct size for layout, mouse events, and coordinate math.
  //
  // drawingCanvasRef and pinCanvasRef are also sized at physical pixels and their
  // 2D contexts are pre-scaled by DPR so all measurement/snap drawing code
  // continues to use logical CSS-pixel coordinates unchanged.
  //
  // setPdfDimensions always stores LOGICAL (CSS) pixel sizes — this is what
  // the document wrapper div, centerDocumentInViewport, and the snap/measure
  // hooks all depend on. Never store physical pixel sizes there.
  useEffect(() => {
    if (!pdf) return;
    let active     = true;
    let renderTask: any = null;

    const renderPage = async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (!active) return;

        // Adaptive DPR — scales with canvas size to protect memory.
        // Never let any single canvas exceed 16M physical pixels.
        // At low zoom (small canvas) → full screen DPR sharpness (up to 3×).
        // At high zoom (large canvas) → DPR is automatically reduced.
        //
        // Why this matters on your laptop:
        //   DPR 3, 200% zoom, A1 PDF → ~147M px × 3 canvases ≈ 1.7 GB → crash
        //   With adaptive cap       → ~16M px × 3 canvases ≈ 185 MB  → safe
        const MAX_CANVAS_PIXELS = 16_000_000;
        const rawDpr     = window.devicePixelRatio || 1;
        const logicalVP  = page.getViewport({ scale });
        const logicalPx  = logicalVP.width * logicalVP.height;
        const safeDpr    = Math.sqrt(MAX_CANVAS_PIXELS / logicalPx);
        const dpr        = Math.min(rawDpr, safeDpr, 3); // never exceed screen DPR or 3×
        const physicalVP = page.getViewport({ scale: scale * dpr }); // physical pixels

        const cssW = logicalVP.width;
        const cssH = logicalVP.height;
        const phyW = physicalVP.width;
        const phyH = physicalVP.height;

        // ── PDF canvas: render at physical resolution, display at CSS size ──
        const canvas  = pdfCanvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext('2d');
        if (!context) return;
        canvas.width        = phyW;
        canvas.height       = phyH;
        canvas.style.width  = `${cssW}px`;
        canvas.style.height = `${cssH}px`;

        // ── Drawing canvas: CSS pixel size only — NOT scaled by DPR ──
        // The useMeasurements and useSnapEngine hooks do all their coordinate
        // math in CSS pixels (based on getBoundingClientRect + clientX/Y).
        // If we size this canvas at physical pixels, every click lands at the
        // wrong position (offset by the DPR factor). Keep it at logical size
        // so coordinate math stays correct. The measurement overlay lines are
        // thin enough that DPR sharpness here is not noticeable.
        if (drawingCanvasRef.current) {
          const dc = drawingCanvasRef.current;
          dc.width        = cssW;
          dc.height       = cssH;
          dc.style.width  = `${cssW}px`;
          dc.style.height = `${cssH}px`;
        }

        // ── Pin canvas: same — CSS pixel size, no DPR scaling ──
        if (pinCanvasRef.current) {
          const pc = pinCanvasRef.current;
          pc.width        = cssW;
          pc.height       = cssH;
          pc.style.width  = `${cssW}px`;
          pc.style.height = `${cssH}px`;
        }

        // Store LOGICAL dimensions — everything else (layout, events, snap) uses CSS px
        setPdfDimensions({ w: cssW, h: cssH });

        renderTask = page.render({ canvasContext: context, viewport: physicalVP });
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
    if (pdf && pdfDimensions) {
      centerDocumentInViewport();
    }
  }, [pageNumber, pdfDimensions, centerDocumentInViewport, pdf]);

  // ── Wheel Zoom (zoom toward cursor) ──────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        setScale(s => {
          const newScale = Math.max(0.1, Math.min(5, s + delta));
          if (newScale !== s) {
            const rect = drawingCanvasRef.current?.getBoundingClientRect();
            if (rect) {
              const mouseX = e.clientX - rect.left;
              const mouseY = e.clientY - rect.top;
              const ratio  = newScale / s;
              setTimeout(() => {
                if (containerRef.current) {
                  containerRef.current.scrollLeft += mouseX * (ratio - 1);
                  containerRef.current.scrollTop  += mouseY * (ratio - 1);
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

  // ── FIX 3: Panning with pointer capture ───────────────────────────────────
  // setPointerCapture ensures movementX/Y events keep firing even when the
  // pointer drifts outside the container boundary mid-pan.
  //
  // IMPORTANT: we only preventDefault + capture when a PDF is actually loaded.
  // Calling preventDefault on the empty-state upload UI blocks the browser's
  // label→input activation, which prevents the file picker dialog from opening.
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && activeTool === 'select')) {
      // Only intercept if there is a PDF loaded — otherwise let clicks on the
      // upload label/input fall through to the browser's native file dialog.
      if (!pdfRef.current) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsPanning(true);
      if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
    }
  };
  const handlePointerUp = (e: React.PointerEvent) => {
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

  // ── Toolbar JSX ───────────────────────────────────────────────────────────
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

      {/*
        THE SCROLL CONTAINER
        ─────────────────────
        flex-1 → fills all remaining vertical space between toolbar and footer.
        overflow-auto → scrollbars appear only when the document overflows.

        THE INNER WRAPPER
        ──────────────────
        FIX 2: When a PDF is loaded we use `items-start` instead of
        `items-center`. flex `items-center` on an overflow container pushes the
        excess content equally above AND below the viewport — the top of the
        document ends up above scrollTop=0 and is unreachable. `items-start`
        anchors the document to the top of the scroll area so scrollTop=0 always
        shows the beginning of the document. Centering is then handled explicitly
        by centerDocumentInViewport() via scrollLeft/scrollTop arithmetic.

        The empty-state (no PDF) keeps `items-center justify-center` because the
        upload prompt always fits the viewport and looks better centered.
      */}
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
        {/*
          Empty state → flex centered (upload prompt always fits viewport).
          PDF loaded  → plain block with padding. The document div inside uses
          margin:auto which centers it when it fits and does nothing when it
          overflows — overflow goes right/down and is always scrollable.
          flex justify-center must NOT be used here: it places half the
          horizontal overflow to the LEFT of scrollLeft=0, making that half
          permanently unreachable.
        */}
        <div
          className={cn(!pdf ? 'min-h-full min-w-full flex items-center justify-center p-8' : 'relative')}
          style={pdf && pdfDimensions ? (() => {
            // Always give the wrapper a large canvas around the document so:
            // 1. When doc > viewport: both sides are scrollable (no clipping).
            // 2. When doc < viewport: user can still pan/drag in all directions.
            // We use max(docSize + 2*padding, viewportSize * 3) so the doc is
            // always centered with plenty of scrollable space on every edge.
            const vw = containerRef.current?.clientWidth  ?? 0;
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
                // Position the document in the absolute center of the large wrapper.
                // This ensures the doc is centered on load and the user can pan equally
                // in all directions regardless of whether the doc is smaller or larger
                // than the viewport.
                const vw = containerRef.current.clientWidth;
                const vh = containerRef.current.clientHeight;
                const wrapW = Math.max(pdfDimensions.w + CANVAS_PADDING * 2, vw * 3);
                const wrapH = Math.max(pdfDimensions.h + CANVAS_PADDING * 2, vh * 3);
                const left = Math.round((wrapW - pdfDimensions.w) / 2);
                const top  = Math.round((wrapH - pdfDimensions.h) / 2);
                return {
                  position: 'absolute' as const,
                  left,
                  top,
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

      {/* Footer — flex-shrink-0 pins it to the bottom of the flex column always */}
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
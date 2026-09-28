// ─── components/Viewer/Viewer.tsx ─────────────────────────────────────────────
//
//  SNAP PIPELINE CHANGE
//  ─────────────────────
//  Replaced SVG-based snap extraction (useSvgSnapPoints + svgUrl fetch) with
//  PDF-native extraction (usePdfDocument). The new hook runs a CTM-aware inline
//  worker that emits PdfLine[], PdfCurve[], and SnapPoint[] where:
//    - PdfLine vertices are already in absolute canvas-space px (from applyMatrix)
//    - SnapPoint nx/ny are normalized fractions (v.x / dims.w) — must multiply
//
//  resolvedSnapPoints: pdfSnapPoints mapped to absolute px via nx*dims.w, ny*dims.h
//  pdfLines / pdfCurves: passed through as-is (already absolute px)
//
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  useRef, useEffect, useState, useCallback, useMemo,
} from 'react';
import { ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import pdfjsLib from '@/lib/pdf/pdfClient';
import { ToolType, TakeoffRow } from '@/types';
import { Minimap }           from '@/components/features/overlays/Minimap';
import { SnapSettingsPanel } from '@/components/features/dialogs/SnapSettingsPanel';
import { useSnapEngine }     from '@/hooks/snapEngine/useSnapEngine';
import { usePdfDocument, hasSnapGeometry } from '@/hooks/snapEngine/usePdfDocument';
import { useMeasurements }   from '@/hooks/measurements/useMeasurements';
import { useTakeoffContext }  from '@/context/TakeoffContext';
import { useViewerPdf }      from '@/hooks/viewer/useViewerPdf';
import { useMagicFillSession } from '@/hooks/fill/useMagicFillSession';
import { usePerimeterOffset, isEffectivelyClosed } from '@/hooks/perimeterOffset/usePerimeterOffset';
import {
  tessellatePoints,
  getEffectivePoints,
} from '@/hooks/perimeterOffset/perimeterOffsetGeometry';
import {
  hitTestMeasurement,
  HIT_RADIUS,
} from '@/hooks/perimeterOffset/perimeterOffsetHitTest';
import { ViewerToolbar }  from './ViewerToolbar';
import { ViewerCanvas }   from './ViewerCanvas';
import type { OffsetEligibleShape } from './ViewerCanvas';
import {
  CalibrationDialog, AppendGroupBanner,
  SnapCandidateWired, MeasurementDetailsWired, PresetDrawerWired,
} from './ViewerDialogs';
import {
  CANVAS_PADDING, ZOOM_SENSITIVITY, MIN_ZOOM, MAX_ZOOM, VIEWER_TOOLS,
} from './ViewerConstants';
import { MagicFillCanvas } from '@/components/Viewer/MagicFillCanvas';
import {
  MagicFillProgressOverlay,
  MagicFillHoverTooltip,
  MagicFillGroupPanel,
  MagicFillSelectedPanel,
  fmtArea,
} from '@/components/Viewer/MagicFillUI';
import { PerimeterOffsetPanel } from '@/components/Viewer/PerimeterOffsetPanel';
import {
  stagedArcCount as calcStagedArcCount,
  stagedRadiusCount,
  splitPolyarcSegments,
} from '@/hooks/measurements/useMeasurements/useMeasurementCommit';
import type {
  CommitOffsetParams,
  CommitOpenPathParams,
  CommitOffsetResult,
  OffsetOutputType,
  OpenOutputType,
  BatchCommitOptions,
} from '@/hooks/perimeterOffset/usePerimeterOffset';
import type { OpenEndStyle } from '@/hooks/perimeterOffset/perimeterOffsetGeometry';

export type { ViewerProps, ViewerToolbarAPI } from './ViewerConstants';

interface PendingMeasurementData {
  id: string;
  type: string;
  description: string;
}

interface UndoRedoRefValue {
  setCursorPoint: (p: React.SetStateAction<{ x: number; y: number } | null>) => void;
}

export function Viewer(props: import('./ViewerConstants').ViewerProps) {
  const {
    activeTool, setActiveTool,
    measurements: drawingMeasurements,
    isPageCalibrated = true,
    onAddMeasurement: onAddMeasurementProp,
    onUpdateMeasurement: onUpdateMeasurementProp,
    scaleFactor, onScaleSet, activeDrawing, onDrawingAdded,
    showPresetDrawer, onClosePresetDrawer, onSelectPreset,
    hideToolbar = false,
    appendToGroupId: propAppendToGroupId,
    onAppendComplete,
    onToolbarReady,
    showPins: externalShowPins,
    onShowPinsChange: externalOnShowPinsChange,
    onDeleteMeasurement: onDeleteMeasurementProp,
  } = props;

  // ── Canvas refs ───────────────────────────────────────────────────────────
  const pdfCanvasRef     = useRef<HTMLCanvasElement>(null!);
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null!);
  const pinCanvasRef     = useRef<HTMLCanvasElement>(null!);
  const vectorCanvasRef  = useRef<HTMLCanvasElement>(null!);
  const fillCanvasRef    = useRef<HTMLCanvasElement>(null!);
  const containerRef     = useRef<HTMLDivElement>(null!);

  const activeDrawingId  = activeDrawing?.id     ?? null;
  const activeDrawingUrl = activeDrawing?.fileUrl ?? null;

  // ── Settings ──────────────────────────────────────────────────────────────
  const [snapEnabled,      setSnapEnabled]      = useState(true);
  const [internalShowPins, setInternalShowPins] = useState(true);
  const [snapThreshold,    setSnapThreshold]    = useState(14);
  const [confidenceFilter, setConfidenceFilter] = useState(0.1);
  const [showSnapSettings, setShowSnapSettings] = useState(false);

  const showPins    = externalShowPins         !== undefined ? externalShowPins         : internalShowPins;
  const setShowPins = externalOnShowPinsChange !== undefined ? externalOnShowPinsChange : setInternalShowPins;

  // ── Dialog state ──────────────────────────────────────────────────────────
  const [showCalibrationDialog,  setShowCalibrationDialog]  = useState(false);
  const [pendingPtLen,           setPendingPtLen]           = useState(0);
  const [calibrationInput,       setCalibrationInput]       = useState('');
  const [showMeasurementDialog,  setShowMeasurementDialog]  = useState(false);
  const [pendingMeasurementData, setPendingMeasurementData] = useState<PendingMeasurementData | null>(null);

  // ── Context ───────────────────────────────────────────────────────────────
  const {
    tempPoints, pushPoint, commitMeasurement, batchCommitMeasurements,
    clearTempPoints, retagTempPoints,
    undo, redo, canUndo, canRedo,
    selectedId, setSelectedId, projectState, updateMeasurement,
    setActivePage, showLabels, pendingPage, clearPendingPage,
    setDrawingPageCount, focusSeq, setNextMaterial,
  } = useTakeoffContext();
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  const [showTechInfo, setShowTechInfo] = useState(false);
  const [dragOver,     setDragOver]     = useState(false);

  const undoRedoRef = useRef<UndoRedoRefValue>({ setCursorPoint: () => {} });
  const handleUndo  = useCallback(() => { undo();  undoRedoRef.current.setCursorPoint(null); }, [undo]);
  const handleRedo  = useCallback(() => { redo();  undoRedoRef.current.setCursorPoint(null); }, [redo]);

  const isMagicFillActiveRef = useRef(activeTool === 'magic-fill');
  isMagicFillActiveRef.current = activeTool === 'magic-fill';

  // ── PDF document + geometry extraction ───────────────────────────────────
  //
  //  usePdfDocument worker emits:
  //    lines      — vertices in absolute canvas-space px (from applyMatrix, no normalization)
  //    curves     — center/bezier in absolute canvas-space px
  //    snapPoints — nx/ny are NORMALIZED fractions (v.x / dims.w)
  //
  //  We must multiply snapPoints by dims before passing to useSnapEngine.
  //  Lines and curves are passed through unchanged.
  //
  const {
    loadPage:    loadPdfPage,
    clear:       clearSnapGeometry,
    lines:       pdfLines,
    curves:      pdfCurves,
    snapPoints:  pdfSnapPoints,
    stage:       pdfStage,
    dims:        pdfDocDims,
  } = usePdfDocument();

  // ── PDF viewer hook ───────────────────────────────────────────────────────
  const {
    pdf, pageNumber, setPageNumber, loading,
    scale, setScale, committedScale,
    pdfDimensions, pdfRenderCount,
    isPanning, spaceHeld, spaceHeldRef,
    wrapStyle, fitToScreen, centerDocumentInViewport, handleManualScale,
    handleContainerPointerDown: pdfContainerPointerDown,
    handleContainerPointerMove,
    handleContainerPointerUp,
    handleDrawingCanvasPointerDown,
    pdfRef, pageNumberRef, scaleRef, dimsScaleRef, pdfDimensionsRef, onScaleSetRef,
    pan, currentPdfPageRef,
  } = useViewerPdf({
    containerRef,
    pdfCanvasRef,
    drawingCanvasRef,
    pinCanvasRef,
    vectorCanvasRef,
    fillCanvasRef,
    activeDrawingId,
    activeDrawingUrl,
    activeDrawingFile: activeDrawing?.file,
    onScaleSet,
    shouldPreserveFillCanvas: isMagicFillActiveRef,
  });

  const appendToGroupId = propAppendToGroupId ?? undefined;

  // ── Page scoping ──────────────────────────────────────────────────────────
  // Only measurements taken on the page on screen are drawn / hit-tested.
  const measurements = useMemo(
    () => drawingMeasurements.filter(m => (m.pageNumber ?? 1) === pageNumber),
    [drawingMeasurements, pageNumber],
  );

  // Tell the rest of the app which page is showing (per-page scale, new rows).
  useEffect(() => { setActivePage(pageNumber); }, [pageNumber, setActivePage]);

  // Record the real page count of the open PDF on its drawing.
  const pdfOwnerRef = useRef<string | null>(null);
  useEffect(() => {
    pdfOwnerRef.current = pdf ? activeDrawingId : null;
    if (pdf && activeDrawingId) setDrawingPageCount(activeDrawingId, pdf.numPages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf]);

  // Jump to a page requested elsewhere (page chips, table row clicks).
  // Only once the PDF on screen belongs to the requested drawing.
  useEffect(() => {
    if (pendingPage == null || !pdf || pdfOwnerRef.current !== activeDrawingId) return;
    setPageNumber(Math.min(Math.max(1, pendingPage), pdf.numPages));
    clearPendingPage();
  }, [pendingPage, pdf, activeDrawingId, setPageNumber, clearPendingPage]);

  // Snap geometry follows the visible page, reusing the already-open document.
  // It's heavy, so it waits until the page has finished drawing and the
  // browser is idle — the drawing is usable (pan, zoom, click) meanwhile.
  const snapWaitRef = useRef<{ key: string; renderAt: number; done: boolean }>({ key: '', renderAt: -1, done: false });
  useEffect(() => {
    if (!pdf) return;
    const key = `${activeDrawingId}:${pageNumber}`;
    const w = snapWaitRef.current;
    if (w.key !== key) {
      // Seen this page before: its geometry is cached — use it right away.
      if (hasSnapGeometry(key)) {
        snapWaitRef.current = { key, renderAt: pdfRenderCount, done: true };
        void loadPdfPage(pdf, pageNumber, key);
        return;
      }
      // New page: forget the previous page's snap points right away, then
      // wait for this page's first render to finish.
      snapWaitRef.current = { key, renderAt: pdfRenderCount, done: false };
      clearSnapGeometry();
      return;
    }
    if (w.done || pdfRenderCount <= w.renderAt) return;
    w.done = true;
    let ran = false;
    const run = () => { ran = true; void loadPdfPage(pdf, pageNumber, key); };
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (win.requestIdleCallback) {
      const id = win.requestIdleCallback(run, { timeout: 1200 });
      return () => { if (!ran) { win.cancelIdleCallback?.(id); w.done = false; } };
    }
    const t = window.setTimeout(run, 50);
    return () => { if (!ran) { clearTimeout(t); w.done = false; } };
  }, [pdf, pageNumber, activeDrawingId, pdfRenderCount, loadPdfPage, clearSnapGeometry]);

  // ── Stable pan ────────────────────────────────────────────────────────────
  const stablePan = useMemo(
    () => pan ?? { x: 0, y: 0 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pan?.x, pan?.y],
  );

  // ── Stable PDF dimensions ─────────────────────────────────────────────────
  const stablePdfDimRef = useRef<{ w: number; h: number } | null>(null);
  const stablePdfDimensions = useMemo(() => {
    if (!pdfDimensions) return null;
    if (
      stablePdfDimRef.current &&
      stablePdfDimRef.current.w === pdfDimensions.w &&
      stablePdfDimRef.current.h === pdfDimensions.h
    ) {
      return stablePdfDimRef.current;
    }
    stablePdfDimRef.current = { w: pdfDimensions.w, h: pdfDimensions.h };
    return stablePdfDimRef.current;
  }, [pdfDimensions?.w, pdfDimensions?.h]);

  // ── Resolved snap points (nx/ny fractions → absolute canvas-space px) ────
  //
  //  pdfLines / pdfCurves: vertices already in absolute px — pass through as-is.
  //  pdfSnapPoints: nx/ny are normalized fractions — multiply by dims once here.
  //
  const resolvedSnapPoints = useMemo(() => {
    if (!pdfDimensions || !pdfSnapPoints.length) return [];
    const { w, h } = pdfDimensions;
    return pdfSnapPoints.map(sp => ({
      ...sp,
      x: sp.nx * w,
      y: sp.ny * h,
    }));
  }, [pdfSnapPoints, pdfDimensions?.w, pdfDimensions?.h]);

  // ── Snap engine ───────────────────────────────────────────────────────────
  const {
    snapFlashes,
    snapToCorner,
    triggerSnapFlash,
    redrawPinCanvas,
    cursorPointRef,
    linearChain,
    addChainPoint,
    undoChainPoint,
    clearChain,
  } = useSnapEngine({
    pinCanvasRef:    pinCanvasRef  as React.RefObject<HTMLCanvasElement | null>,
    viewportRef:     containerRef  as React.RefObject<HTMLDivElement | null>,
    snapEnabled,
    showPins,
    snapThreshold,
    lines:      pdfLines,           // absolute canvas-space px — no conversion needed
    curves:     pdfCurves,          // absolute canvas-space px — no conversion needed
    snapPoints: resolvedSnapPoints, // converted from nx/ny fractions → absolute px
    activeTool,
    proximityRadius: 80,
    zoom:            scale,
    pan:             stablePan,
  });

  const stagedArcs = calcStagedArcCount(tempPoints);

  // ── setActiveTool — raw passthrough ───────────────────────────────────────
  const setActiveToolString = useCallback(
    (t: string) => setActiveTool(t as ToolType),
    [setActiveTool],
  );

  // ── handleSetActiveTool — with linear↔arc→polyarc upgrade ────────────────
  const pendingPolyarcModeRef = useRef<'line' | 'arc' | null>(null);
  const [forcedPolyarcMode, setForcedPolyarcMode] = useState<'line' | 'arc' | null>(null);

  const handleSetActiveTool = useCallback((newTool: ToolType) => {
    const LINEAR_ARC = new Set<string>(['linear', 'arc']);

    if (activeTool === 'polyarc' && LINEAR_ARC.has(newTool)) {
      const nextMode: 'line' | 'arc' = newTool === 'linear' ? 'line' : 'arc';
      pendingPolyarcModeRef.current = nextMode;
      setForcedPolyarcMode(nextMode);
      return;
    }

    if (
      tempPoints.length > 0 &&
      LINEAR_ARC.has(activeTool) &&
      LINEAR_ARC.has(newTool) &&
      activeTool !== newTool
    ) {
      const existingSegType: 'line' | 'arc' = activeTool === 'linear' ? 'line' : 'arc';
      const nextMode: 'line' | 'arc'        = newTool === 'linear'    ? 'line' : 'arc';
      pendingPolyarcModeRef.current = nextMode;
      setForcedPolyarcMode(nextMode);
      retagTempPoints(pts => pts.map(p => ({ ...p, segmentType: existingSegType })));
      setActiveTool('polyarc' as ToolType);
      return;
    }

    pendingPolyarcModeRef.current = null;
    setForcedPolyarcMode(null);
    setActiveTool(newTool);
  }, [activeTool, tempPoints, retagTempPoints, setActiveTool]);

  useEffect(() => {
    if (activeTool !== 'polyarc') {
      setForcedPolyarcMode(null);
      pendingPolyarcModeRef.current = null;
    }
  }, [activeTool]);

  // ── Polyarc mode ──────────────────────────────────────────────────────────
  const [polyarcMode, setPolyarcMode] = useState<'line' | 'arc'>('line');
  const togglePolyarcMode = useCallback(() => {
    setPolyarcMode(m => m === 'line' ? 'arc' : 'line');
  }, []);

  // ── Calibration ───────────────────────────────────────────────────────────
  const handleScalePrompt = useCallback((ptLen: number) => {
    setPendingPtLen(ptLen);
    setCalibrationInput('');
    setShowCalibrationDialog(true);
  }, []);

  const handleCalibrationConfirm = useCallback(() => {
    const r = parseFloat(calibrationInput);
    if (!isNaN(r) && r > 0 && pendingPtLen > 0) onScaleSetRef.current(r / pendingPtLen);
    setShowCalibrationDialog(false);
  }, [calibrationInput, pendingPtLen, onScaleSetRef]);

  const onUpdateMeasurement = useCallback(
    (id: string, updates: Partial<TakeoffRow>) => onUpdateMeasurementProp?.(id, updates),
    [onUpdateMeasurementProp],
  );

  // ── Measurements engine ───────────────────────────────────────────────────
  const {
    pendingSnapCandidates, setPendingSnapCandidates,
    finishMeasurement, handleCanvasClick, handleContextMenu,
    handleCanvasPointerMove, handleCanvasPointerDown,
    handleCanvasPointerUp, toCanvas, setCursorPoint,
    redrawDrawingCanvas,
  } = useMeasurements({
    drawingCanvasRef: drawingCanvasRef as React.RefObject<HTMLCanvasElement>,
    pdfDimensionsRef: pdfDimensionsRef as React.RefObject<NonNullable<typeof pdfDimensions>>,
    pageNumberRef:    pageNumberRef    as React.RefObject<number>,
    // Quantities convert canvas px → PDF points using the zoom the canvas was
    // laid out at (not the live, still-debouncing zoom) — see useViewerPdf.
    scaleRef:         dimsScaleRef    as React.RefObject<number>,
    activeTool, setActiveTool: setActiveToolString,
    measurements, tempPoints, pushPoint,
    commitMeasurement, batchCommitMeasurements,
    appendToGroupId, onAppendComplete,
    onScalePrompt: handleScalePrompt,
    clearTempPoints, scaleFactor, onUpdateMeasurement,
    isPanning, snapToCorner: snapToCorner as any, getScaledCorners: () => [],
    triggerSnapFlash, snapEnabled, snapThreshold,
    redrawPinCanvas, cursorPointRef, activeDrawingId,
    snapCandidates: [],
    polyarcMode,
    togglePolyarcMode,
    forcedPolyarcMode: forcedPolyarcMode ?? undefined,
    showLabels,
    selectedIdRef,
  } as any);

  const safePolyarcMode: 'line' | 'arc' = polyarcMode ?? 'line';

  useEffect(() => { undoRedoRef.current.setCursorPoint = setCursorPoint; }, [setCursorPoint]);

  const wrappedPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const dims = pdfDimensionsRef.current;
      if (dims) {
        const rect = e.currentTarget.getBoundingClientRect();
        cursorPointRef.current = {
          x: (e.clientX - rect.left) * (dims.w / rect.width),
          y: (e.clientY - rect.top)  * (dims.h / rect.height),
        };
      }
      handleCanvasPointerMove(e);
      redrawPinCanvas();
    },
    [handleCanvasPointerMove, redrawPinCanvas, cursorPointRef, pdfDimensionsRef],
  );

  const wrappedPointerLeave = useCallback(() => {
    cursorPointRef.current = null;
    setCursorPoint(null);
    redrawPinCanvas();
    setHoveredOffsetId(null);
  }, [cursorPointRef, setCursorPoint, redrawPinCanvas]);

  // ── Grid-count commit ─────────────────────────────────────────────────────
  const handleGridCountCommit = useCallback((
    count: number, spacingMm: number, cols: number, rows: number,
  ) => {
    commitMeasurement({
      id:          crypto.randomUUID(),
      drawingId:   activeDrawingId || '',
      description: `Grid Count (${cols}×${rows})`,
      label:       'Grid Count',
      type:        'Count',
      quantity:    count,
      unit:        'intersections',
      unitRate:    0,
      notes:       `Grid spacing: ${spacingMm}mm  |  ${cols} cols × ${rows} rows`,
      points:      [],
      isOverridden: true,
      color:       '#4ADE80',
      isVisible:   true,
      childIds:    [],
      gridSpacing: spacingMm,
    });
    setTimeout(() => setActiveTool('select'), 0);
  }, [commitMeasurement, activeDrawingId, setActiveTool]);

  // ── Magic Fill session ────────────────────────────────────────────────────
  const {
    allVisibleFills, magicFills, mfStagedCount,
    mfSelectedId, setMfSelectedId,
    mfSelectedGroup, setMfSelectedGroup,
    mfHoveredId, mfHoverPos,
    mfHolesClosed, mfHiddenIds,
    mfIsFilling, mfIsRepainting,
    mfFillMsg, mfFillSub, mfFillProgress,
    mfMetersPerPixel, mfLastFillPos,
    showMfNameDialog, pendingMfData,
    activeColor,
    handleMagicSingleClick,
    handleMagicBatchRect,
    handleMagicPolygonFill,
    maskW, maskH,
    handleMagicHover, handleMagicHoverLeave,
    handleMagicFillHoles, handleMagicUndo,
    handleMagicClear, handleMagicDelete,
    handleMagicToggleHide, handleMagicAbortSession,
    handleMagicFinish, handleMfNameConfirm, handleMfNameSkip,
  } = useMagicFillSession({
    fillCanvasRef,
    magicFillActive: activeTool === 'magic-fill',
    pdfRenderCount,
    pdfCanvasRef,
    pdfDimensions,
    scaleFactor,
    isMagicFillActiveRef,
    activeDrawingId,
    measurements,
    propAppendToGroupId: appendToGroupId,
    onAddMeasurementProp,
    onUpdateMeasurementProp,
    onDeleteMeasurementProp,
    onAppendComplete,
    batchCommitMeasurements,
    currentPdfPageRef,
  });

  // ── Perimeter offset state ────────────────────────────────────────────────
  const [offsetPreviewPolygons, setOffsetPreviewPolygons] =
    useState<Array<{ x: number; y: number }[]> | null>(null);
  const [offsetCommitError, setOffsetCommitError] = useState<string | null>(null);
  const [offsetCommitWarn,  setOffsetCommitWarn]  = useState<string | null>(null);
  const [hoveredOffsetId,   setHoveredOffsetId]   = useState<string | null>(null);
  const [offsetOutputType,  setOffsetOutputType]  = useState<OffsetOutputType>('length');
  const [offsetOpenEndStyle,   setOffsetOpenEndStyle]   = useState<OpenEndStyle>('square');
  const [offsetOpenOutputType, setOffsetOpenOutputType] = useState<OpenOutputType>('parallel-length');

  const {
    commitOffset,
    batchCommitOffsets,
    commitOpenPathOffset,
    previewOffset,
    previewOpenOffset,
    isValidSource:     isValidOffsetSource,
    isValidOpenSource: isValidOffsetOpenSource,
    getCollapseRadius,
  } = usePerimeterOffset({
    measurements,
    batchCommitMeasurements,
    updateMeasurement: onUpdateMeasurement,
    pdfDimensionsRef:  pdfDimensionsRef as React.RefObject<NonNullable<typeof pdfDimensions>>,
    scaleRef:          scaleRef         as React.RefObject<number>,
    scaleFactor,
    activeDrawingId,
  });

  const offsetSourceMeasurement = useMemo(() => {
    if (activeTool !== 'perimeter-offset') return null;
    if (!selectedId) return null;
    return measurements.find(m => m.id === selectedId) ?? null;
  }, [activeTool, selectedId, measurements]);

  const offsetCollapseRadius = useMemo(() => {
    if (!offsetSourceMeasurement) return 0;
    if (!isValidOffsetSource(offsetSourceMeasurement)) return 0;
    return getCollapseRadius(offsetSourceMeasurement);
  }, [offsetSourceMeasurement, isValidOffsetSource, getCollapseRadius]);

  const offsetEligiblePolygons = useMemo((): OffsetEligibleShape[] | null => {
    if (activeTool !== 'perimeter-offset') return null;
    const result: OffsetEligibleShape[] = [];
    const scaleW = stablePdfDimensions?.w ?? 1;
    const scaleH = stablePdfDimensions?.h ?? 1;

    for (const m of measurements) {
      if (!isValidOffsetSource(m) && !isValidOffsetOpenSource(m))       continue;
      if (activeDrawingId != null && m.drawingId !== activeDrawingId)   continue;
      if (!(m.isVisible ?? true))                                       continue;

      const isClosed =
        m.type === 'Polygon'   ||
        m.type === 'Rectangle' ||
        m.type === 'Area'      ||
        isEffectivelyClosed(m, measurements);

      const isPolygonType =
        m.type === 'Polygon'   ||
        m.type === 'Rectangle' ||
        m.type === 'Area';

      const effectivePts = getEffectivePoints(m, measurements);
      const pts          = tessellatePoints(effectivePts, scaleW, scaleH);

      if (pts.length >= 2) {
        result.push({ id: m.id, pts, isClosed, isPolygonType });
      }
    }
    return result.length > 0 ? result : null;
  }, [
    activeTool, measurements, isValidOffsetSource, isValidOffsetOpenSource,
    activeDrawingId, stablePdfDimensions,
  ]);

  const offsetSourcePolygon = useMemo((): Array<{ x: number; y: number }> | null => {
    if (!offsetSourceMeasurement) return null;
    if (!offsetEligiblePolygons)  return null;
    const shape = offsetEligiblePolygons.find(s => s.id === offsetSourceMeasurement.id);
    return shape?.pts ?? null;
  }, [offsetSourceMeasurement, offsetEligiblePolygons]);

  const offsetIsOpenPath = useMemo(() => {
    if (!offsetSourceMeasurement) return false;
    if (!isValidOffsetOpenSource(offsetSourceMeasurement)) return false;
    return offsetOpenEndStyle === 'none';
  }, [offsetSourceMeasurement, isValidOffsetOpenSource, offsetOpenEndStyle]);

  // ── Shared offset hit-finder ───────────────────────────────────────────────
  const findOffsetHit = useCallback((nx: number, ny: number): TakeoffRow | undefined => {
    const zoomAdjustedRadius = HIT_RADIUS / Math.max(0.25, scale);
    const dim    = pdfDimensionsRef.current;
    const scaleW = dim?.w ?? 1;
    const scaleH = dim?.h ?? 1;

    return [...measurements]
      .reverse()
      .find(m => {
        if (!isValidOffsetSource(m) && !isValidOffsetOpenSource(m))     return false;
        if (activeDrawingId != null && m.drawingId !== activeDrawingId) return false;
        if (!(m.isVisible ?? true))                                     return false;

        const isClosed =
          m.type === 'Polygon'   ||
          m.type === 'Rectangle' ||
          m.type === 'Area'      ||
          isEffectivelyClosed(m, measurements);

        const effectivePts = getEffectivePoints(m, measurements);
        const pts          = tessellatePoints(effectivePts, scaleW, scaleH);
        if (pts.length < 2) return false;

        return hitTestMeasurement(nx, ny, pts, isClosed, zoomAdjustedRadius);
      });
  }, [measurements, isValidOffsetSource, isValidOffsetOpenSource, activeDrawingId, scale, pdfDimensionsRef]);

  const handleOffsetCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const dim  = pdfDimensionsRef.current;
    if (!dim) return;
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top)  / rect.height;
    const hit = findOffsetHit(nx, ny);
    if (hit) setSelectedId(hit.id);
  }, [findOffsetHit, setSelectedId, pdfDimensionsRef]);

  const handleOffsetCanvasPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    wrappedPointerMove(e);
    const rect = e.currentTarget.getBoundingClientRect();
    const dim  = pdfDimensionsRef.current;
    if (!dim) return;
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top)  / rect.height;
    const hit = findOffsetHit(nx, ny);
    setHoveredOffsetId(hit?.id ?? null);
  }, [wrappedPointerMove, findOffsetHit, pdfDimensionsRef]);

  const handleOffsetCommit = useCallback((params: CommitOffsetParams): CommitOffsetResult => {
    const result = commitOffset(params);
    setOffsetCommitError(result.error);
    setOffsetCommitWarn(result.warning);
    if (!result.error) { setOffsetPreviewPolygons(null); setActiveTool('select' as ToolType); }
    return result;
  }, [commitOffset, setActiveTool]);

  const handleOffsetBatchCommit = useCallback((
    params:   CommitOffsetParams[],
    options?: BatchCommitOptions,
  ): CommitOffsetResult => {
    const result = batchCommitOffsets(params, options);
    setOffsetCommitError(result.error);
    setOffsetCommitWarn(result.warning);
    if (!result.error) { setOffsetPreviewPolygons(null); setActiveTool('select' as ToolType); }
    return result;
  }, [batchCommitOffsets, setActiveTool]);

  const handleOffsetOpenCommit = useCallback((params: CommitOpenPathParams): CommitOffsetResult => {
    const result = commitOpenPathOffset(params);
    setOffsetCommitError(result.error);
    setOffsetCommitWarn(result.warning);
    if (!result.error) { setOffsetPreviewPolygons(null); setActiveTool('select' as ToolType); }
    return result;
  }, [commitOpenPathOffset, setActiveTool]);

  const handleOffsetCancel = useCallback(() => {
    setOffsetPreviewPolygons(null);
    setOffsetCommitError(null);
    setOffsetCommitWarn(null);
    setActiveTool('select' as ToolType);
  }, [setActiveTool]);

  // ── Tool-switch side effects ───────────────────────────────────────────────
  const prevToolRef = useRef(activeTool);
  useEffect(() => {
    const prev = prevToolRef.current;
    if (prev === activeTool) return;
    prevToolRef.current = activeTool;

    if (prev === 'perimeter-offset') {
      setOffsetPreviewPolygons(null);
      setOffsetCommitError(null);
      setOffsetCommitWarn(null);
      setHoveredOffsetId(null);
      setOffsetOutputType('length');
      setOffsetOpenEndStyle('square');
      setOffsetOpenOutputType('parallel-length');
    }

    if (prev === 'magic-fill' && activeTool !== 'magic-fill') {
      handleMagicAbortSession();
    }

    if (activeTool !== 'magic-fill') {
      const clearFillCanvas = () => {
        const canvas = fillCanvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      };
      clearFillCanvas();
      const rafId = requestAnimationFrame(() => {
        if (!isMagicFillActiveRef.current) {
          clearFillCanvas();
          requestAnimationFrame(() => {
            if (!isMagicFillActiveRef.current) {
              clearFillCanvas();
              requestAnimationFrame(() => {
                if (!isMagicFillActiveRef.current) clearFillCanvas();
              });
            }
          });
        }
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [activeTool, handleMagicAbortSession]);

  // ── Finish + measurement name dialog ──────────────────────────────────────
  const handleFinishMeasurement = useCallback(() => {
    const minPts = activeTool === 'count' || activeTool === 'point' ? 1 : 2;
    if (tempPoints.length < minPts) { finishMeasurement(); return; }
    if (propAppendToGroupId) { finishMeasurement(); onAppendComplete?.(); return; }
    const type =
      activeTool === 'polygon'   || activeTool === 'rectangle' ? 'Polygon' :
      activeTool === 'linear'    ? 'Length' :
      activeTool === 'arc'       ? 'Length' :
      activeTool === 'radius'    ? 'Length' :
      activeTool === 'polyarc'   ? 'Length' :
      activeTool === 'count'     ? 'Count'  : 'Point';
    setPendingMeasurementData({ id: `temp-${Date.now()}`, type, description: `New ${type}` });
    setShowMeasurementDialog(true);
  }, [tempPoints.length, activeTool, finishMeasurement, propAppendToGroupId, onAppendComplete]);

  const handleDialogConfirm = useCallback((name: string, materialId: string, icon?: string) => {
    setShowMeasurementDialog(false);
    // The chosen material (and its rate) is attached to the rows committed now.
    setNextMaterial(materialId || null);
    try {
      finishMeasurement(undefined, {
        label: name.trim() || `New ${pendingMeasurementData?.type || 'Measurement'}`,
        icon,
      });
    } finally {
      setNextMaterial(null);
    }
  }, [finishMeasurement, pendingMeasurementData, setNextMaterial]);

  const handleDialogSkip = useCallback(() => {
    setShowMeasurementDialog(false);
    finishMeasurement();
  }, [finishMeasurement]);

  // ── Pitch factor ──────────────────────────────────────────────────────────
  const handleApplyPitchFactor = useCallback((factor: number) => {
    if (!selectedId) return;
    const row = projectState?.measurements?.find((m: TakeoffRow) => m.id === selectedId);
    if (!row || (row as any).isGroupHeader || row.type !== 'Length') return;
    updateMeasurement(row.id, {
      quantity:     +(row.quantity * factor).toFixed(4),
      isOverridden: true,
      notes: [(row as any).notes, `Pitch ×${factor.toFixed(4)} applied`].filter(Boolean).join(' | '),
    });
  }, [selectedId, projectState, updateMeasurement]);

  // ── Toolbar API ───────────────────────────────────────────────────────────
  const toolbarAPI = useMemo(() => ({
    tools: VIEWER_TOOLS as any,
    activeTool, setActiveTool: handleSetActiveTool, scale, setScale, scaleFactor,
    snapEnabled, setSnapEnabled, showSnapSettings, setShowSnapSettings,
    showPins, setShowPins,
    snapThreshold, setSnapThreshold,
    confidenceFilter, setConfidenceFilter,
    analysisStatus: pdfStage === 'done' ? 'done' : pdfStage === 'error' ? 'done' : 'analyzing' as const,
    analysisPage:   null,
    currentPageCorners: resolvedSnapPoints.filter(p => p.type === 'endpoint').length,
    pdf, pageNumber,
    fitToScreen: () => fitToScreen(),
    handleManualScale,
    canUndo, canRedo, handleUndo, handleRedo,
    polyarcMode: safePolyarcMode, togglePolyarcMode,
    tempPointsCount: tempPoints.length,
    pageSizePt: pdfDimensions ? { w: pdfDimensions.w / (dimsScaleRef.current || 1), h: pdfDimensions.h / (dimsScaleRef.current || 1) } : null,
  }), [
    activeTool, handleSetActiveTool, scale, scaleFactor,
    snapEnabled, showSnapSettings,
    showPins, setShowPins,
    snapThreshold, confidenceFilter,
    pdfStage, resolvedSnapPoints,
    pageNumber, pdf,
    fitToScreen, handleManualScale, canUndo, canRedo, handleUndo, handleRedo,
    safePolyarcMode, togglePolyarcMode, tempPoints.length,
  , pdfDimensions]);

  useEffect(() => { onToolbarReady?.(toolbarAPI); }, [onToolbarReady, toolbarAPI]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (activeTool === 'magic-fill' && mfStagedCount > 0) { handleMagicAbortSession(); return; }
        if (activeTool === 'perimeter-offset') { handleOffsetCancel(); return; }
      }
      if (e.key === 'Enter' && activeTool === 'perimeter-offset') return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target?.isContentEditable;
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
      if (e.key === 'Escape' && !isTyping && tempPoints.length === 0 && activeTool !== 'select') {
        handleSetActiveTool('select' as ToolType); return;
      }
      if (!isTyping && !hasModifier) {
        if (e.key.toLowerCase() === 'a' && activeTool === 'polyarc') {
          e.preventDefault(); togglePolyarcMode(); return;
        }
        if (e.key.toLowerCase() === 's') {
          e.preventDefault(); setSnapEnabled(!snapEnabled); return;
        }
        const map: Record<string, ToolType> = {
          v: 'select',    l: 'linear',   r: 'rectangle',
          p: 'polygon',   n: 'count',    t: 'point',
          b: 'arc',       g: 'grid-count',
          y: 'polyarc',   o: 'perimeter-offset',
          m: 'magic-fill', k: 'scale',  c: 'radius',
        };
        if (map[e.key.toLowerCase()]) {
          e.preventDefault(); handleSetActiveTool(map[e.key.toLowerCase()]); return;
        }
      }
      if (isTyping) return;
      const cm = e.ctrlKey || e.metaKey;
      if (cm && (e.key === '+' || e.key === '='))                 { e.preventDefault(); setScale(s => Math.min(MAX_ZOOM, s + ZOOM_SENSITIVITY)); return; }
      if (cm && e.key === '-')                                     { e.preventDefault(); setScale(s => Math.max(MIN_ZOOM, s - ZOOM_SENSITIVITY)); return; }
      if (cm && e.key === '0')                                     { e.preventDefault(); fitToScreen(); return; }
      if (cm && e.key === 'z' && !e.shiftKey)                     { e.preventDefault(); handleUndo(); return; }
      if (cm && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); handleRedo(); return; }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeTool, mfStagedCount, fitToScreen, handleUndo, handleRedo,
    handleSetActiveTool, handleMagicAbortSession, handleOffsetCancel,
    setScale, togglePolyarcMode, tempPoints.length, snapEnabled, setSnapEnabled,
  ]);

  // ── Selection ↔ table linking ─────────────────────────────────────────────
  // Repaint the selection outline when the selection changes (cheap: the
  // committed shapes come from the cached layer).
  useEffect(() => { redrawDrawingCanvas(); }, [selectedId, redrawDrawingCanvas]);

  // When a row asks for focus, scroll the drawing so the shape is in view.
  const centeredSeqRef = useRef(0);
  useEffect(() => {
    if (focusSeq === centeredSeqRef.current || !selectedId) return;
    const m = measurements.find(x => x.id === selectedId);
    const dim = pdfDimensions;
    const canvas = drawingCanvasRef.current;
    const box = containerRef.current;
    if (!m || !m.points?.length || !dim || !canvas || !box) return;  // wait for page/drawing
    centeredSeqRef.current = focusSeq;
    const xs = m.points.map(p => p.x), ys = m.points.map(p => p.y);
    const cx = ((Math.min(...xs) + Math.max(...xs)) / 2);
    const cy = ((Math.min(...ys) + Math.max(...ys)) / 2);
    const cr = canvas.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    box.scrollTo({
      left: box.scrollLeft + (cr.left - br.left) + cx * cr.width  - box.clientWidth  / 2,
      top:  box.scrollTop  + (cr.top  - br.top)  + cy * cr.height - box.clientHeight / 2,
      behavior: 'smooth',
    });
  }, [focusSeq, selectedId, measurements, pdfDimensions]);

  // Select tool: clicking a shape selects it (and its table row); clicking
  // empty drawing clears the selection.
  const findShapeAt = useCallback((nx: number, ny: number): TakeoffRow | undefined => {
    const radius = HIT_RADIUS / Math.max(0.25, scale);
    const dim = pdfDimensionsRef.current;
    const w = dim?.w ?? 1, h = dim?.h ?? 1;
    return [...measurements].reverse().find(m => {
      if (m.isGroupHeader || !(m.isVisible ?? true) || !m.points?.length) return false;
      const closed = m.type === 'Polygon' || m.type === 'Rectangle' || m.type === 'Area' || isEffectivelyClosed(m, measurements);
      const pts = tessellatePoints(getEffectivePoints(m, measurements), w, h);
      if (pts.length === 1) {
        return Math.hypot((pts[0].x - nx) * w, (pts[0].y - ny) * h) <= radius * 1.6;
      }
      return pts.length >= 2 && hitTestMeasurement(nx, ny, pts, closed, radius);
    });
  }, [measurements, scale, pdfDimensionsRef]);

  const handleCanvasClickWithSelect = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === 'select') {
      const r = e.currentTarget.getBoundingClientRect();
      const hit = findShapeAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      setSelectedId(hit ? (hit.parentId && !hit.points?.length ? hit.parentId : hit.id) : null);
      return;
    }
    handleCanvasClick(e);
  }, [activeTool, findShapeAt, setSelectedId, handleCanvasClick]);

  // ── Drag & drop PDFs onto the drawing area ────────────────────────────────
  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  }, [dragOver]);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragOver(false);
    const pdfs = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    pdfs.forEach(f => onDrawingAdded(f.name, URL.createObjectURL(f), f));
  }, [onDrawingAdded]);

  // ── Pan handler ───────────────────────────────────────────────────────────
  const handleContainerPointerDown = useCallback((e: React.PointerEvent) => {
    if (activeTool === 'grid-count') return;
    // Select tool: left-drag on empty drawing pans (after a small move, so a
    // click still selects). Middle button / Space+drag pan with any tool.
    pdfContainerPointerDown(e, activeTool === 'select');
  }, [activeTool, pdfContainerPointerDown]);

  // ── File upload ───────────────────────────────────────────────────────────
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) =>
    Array.from(e.target.files ?? []).forEach(f =>
      onDrawingAdded(f.name, URL.createObjectURL(f), f));

  // ── Derived state ─────────────────────────────────────────────────────────
  const isMagicFillTool = activeTool === 'magic-fill';
  const isGridCountTool = activeTool === 'grid-count';
  const isOffsetTool    = activeTool === 'perimeter-offset';
  const mfHoveredFill   = allVisibleFills.find(f => f.id === mfHoveredId)  ?? null;
  const mfSelectedFill  = allVisibleFills.find(f => f.id === mfSelectedId) ?? null;
  const mfGroupFills    = mfSelectedGroup != null
    ? magicFills.filter(f => f.groupId === mfSelectedGroup)
    : [];

  const polyarcSegments   = activeTool === 'polyarc' ? splitPolyarcSegments(tempPoints) : [];
  const polyarcHasContent = polyarcSegments.some(s =>
    (s.type === 'line' && s.points.length >= 2) ||
    (s.type === 'arc'  && s.points.length === 3),
  );
  const polyarcLineCount = polyarcSegments.filter(s => s.type === 'line').length;
  const polyarcArcCount  = polyarcSegments.filter(s => s.type === 'arc').length;

  // ── Snap status text ──────────────────────────────────────────────────────
  const snapStatusText = useMemo(() => {
    if (pdfStage === 'idle')               return 'No drawing loaded';
    if (pdfStage === 'reading-file'   ||
        pdfStage === 'parsing-pdf'    ||
        pdfStage === 'rendering-page' ||
        pdfStage === 'extracting-geometry' ||
        pdfStage === 'computing-snaps')    return 'Extracting snap geometry…';
    if (pdfStage === 'error')              return 'Snap extraction failed';
    if (!snapEnabled)                      return 'Snap disabled';
    if (resolvedSnapPoints.length > 0)
      return `${resolvedSnapPoints.length} snap pts · ${pdfLines.length} segs — hover to snap`;
    return 'No snap geometry found in PDF';
  }, [pdfStage, snapEnabled, resolvedSnapPoints.length, pdfLines.length]);

  const pdfLibVersion = (pdfjsLib as { version?: string } | null)?.version ?? '?';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="flex-1 relative bg-industrial-black blueprint-grid flex flex-col overflow-hidden h-full"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="absolute inset-3 z-[80] pointer-events-none border-2 border-dashed border-amber-accent bg-amber-accent/10 flex items-center justify-center">
          <span className="bg-industrial-panel border border-amber-accent/60 px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest text-amber-accent">
            Drop PDF to add it as a drawing
          </span>
        </div>
      )}
      {!hideToolbar && (
        <div className="relative z-30 flex-shrink-0">
          <ViewerToolbar
            activeTool={activeTool} setActiveTool={handleSetActiveTool}
            canUndo={canUndo} canRedo={canRedo} handleUndo={handleUndo} handleRedo={handleRedo}
            tempPointsCount={tempPoints.length}
            snapEnabled={snapEnabled} setSnapEnabled={setSnapEnabled}
            showSnapSettings={showSnapSettings} setShowSnapSettings={setShowSnapSettings}
            showPins={showPins} setShowPins={setShowPins}
            scaleFactor={scaleFactor} handleManualScale={handleManualScale}
            analysisStatus={pdfStage === 'done' ? 'done' : pdfStage === 'error' ? 'done' : 'analyzing'}
            analysisPage={null}
            currentPageCorners={resolvedSnapPoints.filter(p => p.type === 'endpoint').length}
            scale={scale} setScale={setScale} fitToScreen={() => fitToScreen()}
            MIN_ZOOM={MIN_ZOOM} MAX_ZOOM={MAX_ZOOM} ZOOM_SENSITIVITY={ZOOM_SENSITIVITY}
            polyarcMode={safePolyarcMode}
            togglePolyarcMode={togglePolyarcMode}
          />
        </div>
      )}

      {showSnapSettings && (
        <SnapSettingsPanel
          showPins={showPins}                 onShowPinsChange={setShowPins}
          snapThreshold={snapThreshold}       onSnapThresholdChange={setSnapThreshold}
          confidenceFilter={confidenceFilter} onConfidenceFilterChange={setConfidenceFilter}
          snapEnabled={snapEnabled}           onSnapEnabledChange={setSnapEnabled}
        />
      )}

      <div className="flex flex-1 overflow-hidden min-h-0 relative isolate">
        {isMagicFillTool && (
          <MagicFillProgressOverlay
            active={mfIsFilling || mfIsRepainting}
            message={mfIsRepainting ? 'Updating fills…' : mfFillMsg}
            sub={mfIsRepainting ? undefined : mfFillSub}
            progress={mfIsRepainting ? null : mfFillProgress}
          />
        )}

        <div
          ref={containerRef}
          className="flex-1 overflow-auto custom-scrollbar relative outline-none select-none"
          onKeyDown={e => {
            if (e.code === 'Space') e.preventDefault();
            if (e.key === 'Escape') {
              if (activeTool === 'magic-fill' && mfStagedCount > 0) {
                handleMagicAbortSession();
              } else if (activeTool === 'perimeter-offset') {
                handleOffsetCancel();
              } else if (tempPoints.length > 0) {
                handleFinishMeasurement();
              } else {
                setActiveTool('select');
              }
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              if (activeTool === 'magic-fill' && mfStagedCount > 0) {
                handleMagicFinish();
              } else if (tempPoints.length > 0) {
                handleFinishMeasurement();
              }
            }
          }}
          onPointerDown={handleContainerPointerDown}
          onPointerMove={handleContainerPointerMove}
          onPointerUp={handleContainerPointerUp}
          onPointerLeave={handleContainerPointerUp}
          tabIndex={0}
        >
          <div
            className={cn(!pdf ? 'min-h-full min-w-full flex items-center justify-center p-8' : 'relative')}
            style={wrapStyle}
          >
            <ViewerCanvas
              pdfCanvasRef={pdfCanvasRef}
              drawingCanvasRef={drawingCanvasRef}
              pinCanvasRef={pinCanvasRef}
              vectorCanvasRef={vectorCanvasRef}
              fillCanvasRef={fillCanvasRef}
              pdf={pdf} loading={loading} pdfDimensions={pdfDimensions}
              activeTool={activeTool} showPins={showPins} isPanning={isPanning} spaceHeld={spaceHeld}
              tempPoints={tempPoints} measurements={measurements} activeDrawingId={activeDrawingId}
              snapFlashes={snapFlashes.map(f => ({ ...f, id: String(f.id) }))} toCanvas={toCanvas}
              readyToDraw={true}
              handleCanvasClick={isOffsetTool ? handleOffsetCanvasClick : handleCanvasClickWithSelect}
              handleContextMenu={handleContextMenu}
              handleCanvasPointerMove={isOffsetTool ? handleOffsetCanvasPointerMove : wrappedPointerMove}
              handleCanvasPointerDown={handleCanvasPointerDown as (e: React.PointerEvent<HTMLCanvasElement>) => boolean | undefined}
              handleCanvasPointerUp={handleCanvasPointerUp}
              handleDrawingCanvasPointerDown={handleDrawingCanvasPointerDown}
              setCursorPoint={setCursorPoint} cursorPointRef={cursorPointRef}
              redrawPinCanvas={redrawPinCanvas}
              onDrawingCanvasPointerLeave={wrappedPointerLeave}
              handleFinishMeasurement={handleFinishMeasurement}
              handleFileUpload={handleFileUpload}
              containerRef={containerRef} CANVAS_PADDING={CANVAS_PADDING}
              isGridCountActive={isGridCountTool}
              scaleFactor={scaleFactor}
              onGridCountCommit={handleGridCountCommit}
              stagedArcCount={stagedArcs}
              polyarcHasContent={polyarcHasContent}
              polyarcMode={safePolyarcMode}
              offsetEligiblePolygons={offsetEligiblePolygons}
              offsetHoveredId={hoveredOffsetId}
              offsetSelectedId={offsetSourceMeasurement?.id ?? null}
              offsetOutputType={offsetOutputType}
              offsetPreviewPolygons={offsetPreviewPolygons}
              offsetSourcePolygon={offsetSourcePolygon}
              offsetIsOpenPath={offsetIsOpenPath}
              offsetOpenEndStyle={offsetOpenEndStyle}
              offsetOpenOutputType={offsetOpenOutputType}
            >
              <MagicFillCanvas
                pdfDimensions={pdfDimensions}
                active={isMagicFillTool}
                isFilling={mfIsFilling || mfIsRepainting}
                fills={allVisibleFills}
                hiddenIds={mfHiddenIds}
                maskW={maskW}
                maskH={maskH}
                selectedId={mfSelectedId}
                selectedGroup={mfSelectedGroup}
                activeColor={activeColor}
                onSingleClick={handleMagicSingleClick}
                onPolygonLasso={handleMagicPolygonFill}
                onHover={handleMagicHover}
                onHoverLeave={handleMagicHoverLeave}
              />

              {isMagicFillTool &&
                mfStagedCount > 0 &&
                !mfIsFilling &&
                !mfIsRepainting &&
                !propAppendToGroupId &&
                mfLastFillPos && (
                  <button
                    className="absolute z-[70] flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                    style={{ left: mfLastFillPos.x + 15, top: mfLastFillPos.y + 15 }}
                    onClick={e => { e.stopPropagation(); handleMagicFinish(); }}
                    onPointerDown={e => e.stopPropagation()}
                  >
                    <Check className="w-3 h-3" />
                    Finish ({mfStagedCount} fill{mfStagedCount !== 1 ? 's' : ''})
                  </button>
                )}

              {isMagicFillTool && mfHoveredFill && !mfIsFilling && !mfIsRepainting && (
                <MagicFillHoverTooltip
                  fill={mfHoveredFill}
                  metersPerPixel={mfMetersPerPixel}
                  holesClosed={mfHolesClosed}
                  viewportPos={mfHoverPos}
                />
              )}

              {isMagicFillTool && mfSelectedGroup != null && mfGroupFills.length > 0 && !mfHoveredFill && !mfIsRepainting && (
                <MagicFillGroupPanel
                  groupFills={mfGroupFills}
                  groupId={mfSelectedGroup}
                  metersPerPixel={mfMetersPerPixel}
                  holesClosed={mfHolesClosed}
                />
              )}

              {isMagicFillTool && mfSelectedFill && mfSelectedGroup == null && !mfHoveredFill && !mfIsRepainting && (
                <MagicFillSelectedPanel
                  fill={mfSelectedFill}
                  metersPerPixel={mfMetersPerPixel}
                  holesClosed={mfHolesClosed}
                />
              )}
            </ViewerCanvas>
          </div>

          <SnapCandidateWired
            pendingSnapCandidates={pendingSnapCandidates}
            setPendingSnapCandidates={setPendingSnapCandidates}
            measurements={measurements} onUpdateMeasurement={onUpdateMeasurement}
          />
        </div>

        {isOffsetTool && (
          <PerimeterOffsetPanel
            sourceMeasurement={offsetSourceMeasurement}
            isValidSource={isValidOffsetSource}
            isValidOpenSource={isValidOffsetOpenSource}
            isEffectivelyClosed={row => isEffectivelyClosed(row, measurements)}
            collapseRadius={offsetCollapseRadius}
            onCommit={handleOffsetCommit}
            onOpenCommit={handleOffsetOpenCommit}
            onBatchCommit={handleOffsetBatchCommit}
            onCancel={handleOffsetCancel}
            onPreviewChange={setOffsetPreviewPolygons}
            previewFn={previewOffset}
            previewOpenFn={previewOpenOffset}
            commitError={offsetCommitError}
            onOutputTypeChange={setOffsetOutputType}
            onOpenEndStyleChange={setOffsetOpenEndStyle}
            onOpenOutputTypeChange={setOffsetOpenOutputType}
          />
        )}
      </div>

      {pdf && pdfDimensions && (
        <div className="absolute bottom-12 left-2 z-40">
          <Minimap
            pdf={pdf} pageNumber={pageNumber}
            containerRef={containerRef as React.RefObject<HTMLDivElement>}
            pdfDimensions={pdfDimensions} canvasPadding={CANVAS_PADDING}
            activeTool={activeTool}
          />
        </div>
      )}

      {pdf && (
        <div className="h-10 flex-shrink-0 bg-industrial-panel border-t border-industrial-border px-4 flex items-center justify-between z-20 font-mono relative shadow-sm">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setPageNumber(Math.max(1, pageNumber - 1))}
              disabled={pageNumber <= 1}
              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-tighter">
              PAGE {pageNumber} OF {pdf.numPages}
            </span>
            <button
              onClick={() => setPageNumber(Math.min(pdf.numPages, pageNumber + 1))}
              disabled={pageNumber >= pdf.numPages}
              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="hidden md:flex items-center gap-4 text-[9px] text-zinc-500 uppercase tracking-widest">
            {isMagicFillTool ? (
              <>
                <span className={mfStagedCount > 0 ? 'text-amber-400' : ''}>
                  ⊕ Magic Fill
                  {mfStagedCount > 0
                    ? ` — ${mfStagedCount} staged`
                    : magicFills.length > 0
                    ? ` — ${magicFills.length} committed`
                    : ''}
                </span>
                {magicFills.length > 0 && mfStagedCount === 0 && (
                  <>
                    <div className="w-px h-3 bg-industrial-border" />
                    <span>Total: {fmtArea(magicFills.reduce((s, f) => s + f.areaPx, 0), mfMetersPerPixel)}</span>
                  </>
                )}
                <div className="w-px h-3 bg-industrial-border" />
                {mfStagedCount > 0
                  ? <span className="text-amber-400">Click Finish or press Enter to commit · Esc to discard</span>
                  : <span>Click: fill · Space+click: polygon lasso</span>
                }
              </>
            ) : isGridCountTool ? (
              <span className="text-green-400">
                Grid Count — drag to define area · Enter spacing · click Commit
              </span>
            ) : isOffsetTool ? (
              <span className="text-teal-400">
                Perimeter Offset
                {offsetSourceMeasurement && (isValidOffsetSource(offsetSourceMeasurement) || isValidOffsetOpenSource(offsetSourceMeasurement))
                  ? ` — "${offsetSourceMeasurement.label ?? offsetSourceMeasurement.description}" selected`
                  : ' — click a highlighted shape to select it'
                }
                {offsetCommitWarn && ` · ⚠ ${offsetCommitWarn}`}
                {' '}· Esc to cancel
              </span>
            ) : activeTool === 'arc' ? (
              <span className="text-teal-400">
                {calcStagedArcCount(tempPoints) > 0
                  ? `Arc — ${calcStagedArcCount(tempPoints)} staged · click to add more · Finish or Enter to commit · Right-click cancels current arc`
                  : `Arc — click ${tempPoints.length === 0 ? 'start' : tempPoints.length === 1 ? 'midpoint' : 'end'} point · Right-click to cancel`
                }
              </span>
            ) : activeTool === 'radius' ? (
              <span className="text-purple-400">
                {stagedRadiusCount(tempPoints) > 0
                  ? `Radius — ${stagedRadiusCount(tempPoints)} staged · click to add more · Finish or Enter to commit · Right-click cancels current`
                  : `Radius — click ${tempPoints.filter((p: any) => p.segmentId !== '__radius_break__').length === 0 ? 'centre' : 'edge'} point · Right-click to cancel`
                }
              </span>
            ) : activeTool === 'polyarc' ? (
              <span className="text-orange-400">
                Polyarc
                {polyarcHasContent
                  ? ` — ${polyarcLineCount} line${polyarcLineCount !== 1 ? 's' : ''} · ${polyarcArcCount} arc${polyarcArcCount !== 1 ? 's' : ''}`
                  : ''
                }
                {' '}· Mode: <span className="text-amber-300 font-bold">{safePolyarcMode.toUpperCase()}</span>
                {' '}· Press A to toggle · Drag for arc · Double-click or Enter to finish
              </span>
            ) : (
              <span className={
                pdfStage !== 'done' && pdfStage !== 'idle' && pdfStage !== 'error'
                  ? 'text-amber-400'
                  : pdfStage === 'idle' || resolvedSnapPoints.length === 0
                  ? 'text-zinc-600'
                  : ''
              }>
                {showTechInfo || (pdfStage !== 'done' && pdfStage !== 'idle')
                  ? snapStatusText
                  : snapEnabled ? 'Snapping to drawing lines' : 'Snap off — press S to turn on'}
              </span>
            )}
            {showTechInfo && <span>RENDER_ENGINE: PDF.JS V{pdfLibVersion} · BUILD {process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev'}</span>}
            <button
              type="button"
              onClick={() => setShowTechInfo(v => !v)}
              aria-pressed={showTechInfo}
              title={showTechInfo ? 'Hide technical details' : 'Show technical details'}
              className="w-4 h-4 inline-flex items-center justify-center border border-zinc-700 text-[9px] text-zinc-500 hover:text-zinc-200 hover:border-zinc-500"
            >
              i
            </button>
          </div>
        </div>
      )}

      <CalibrationDialog
        show={showCalibrationDialog} calibrationInput={calibrationInput}
        setCalibrationInput={setCalibrationInput}
        onConfirm={handleCalibrationConfirm} onCancel={() => setShowCalibrationDialog(false)}
      />
      <MeasurementDetailsWired
        show={showMeasurementDialog} pendingMeasurementData={pendingMeasurementData}
        onConfirm={handleDialogConfirm} onSkip={handleDialogSkip}
      />
      <MeasurementDetailsWired
        show={showMfNameDialog} pendingMeasurementData={pendingMfData}
        onConfirm={(name: string, materialId: string) => {
          setNextMaterial(materialId || null);
          try { handleMfNameConfirm(name); } finally { setNextMaterial(null); }
        }}
        onSkip={handleMfNameSkip}
      />
      <PresetDrawerWired
        showPresetDrawer={showPresetDrawer ?? false}
        onClosePresetDrawer={onClosePresetDrawer ?? (() => {})}
        onSelectPreset={onSelectPreset ?? (() => {})}
      />
      <AppendGroupBanner
        appendToGroupId={propAppendToGroupId}
        onCancel={() => onAppendComplete?.()}
      />

      {pdf && !isPageCalibrated && activeTool !== 'scale' && !propAppendToGroupId && (
        <div
          role="status"
          className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 border border-amber-400/60 bg-amber-400/10 px-3 py-1.5 text-[11px] text-amber-200 backdrop-blur"
        >
          <span>
            Page {pageNumber} isn’t calibrated — quantities are in drawing units until you set the scale.
          </span>
          <button
            type="button"
            onClick={() => handleSetActiveTool('scale' as ToolType)}
            className="border border-amber-400/70 px-2 py-0.5 font-semibold text-amber-300 hover:bg-amber-400 hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
          >
            Set scale (K)
          </button>
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
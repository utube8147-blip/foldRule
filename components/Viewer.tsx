'use client';
// ─── components/Viewer/Viewer.tsx ─────────────────────────────────────────────
//
//  FIXES in this revision (on top of previous fixes)
//  ──────────────────────────────────────────────────
//  1. MagicFillCanvas now receives onPolygonLasso (was incorrectly onBatchRect).
//  2. MagicFillCanvas now receives activeColor (was missing entirely).
//  3. handleMagicPolygonFill destructured from useMagicFillSession and wired up.
//  4. polyarcMode null-guarded everywhere (?.toUpperCase() ?? 'LINE').
//  5. offsetOpenOutputType forwarded to ViewerCanvas.
//  6. offsetOpenEndStyle forwarded to ViewerCanvas.
//  7. offsetIsOpenPath: true ONLY when source is open AND endStyle === 'none'.
//  8. polyarcMode + togglePolyarcMode owned locally so never undefined.
//
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  useRef, useEffect, useState, useCallback, useMemo,
} from 'react';
import { ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType, TakeoffRow } from '@/types';
import { Minimap }           from '@/components/features/overlays/Minimap';
import { SnapSettingsPanel } from '@/components/features/dialogs/SnapSettingsPanel';
import { useSnapEngine }     from '@/hooks/snapEngine/useSnapEngine';
import { useSvgSnapPoints }  from '@/hooks/snapEngine/useSvgSnapPoints';
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
import { ViewerToolbar }  from './Viewer/ViewerToolbar';
import { ViewerCanvas }   from './Viewer/ViewerCanvas';
import type { OffsetEligibleShape } from './Viewer/ViewerCanvas';
import {
  CalibrationDialog, AppendGroupBanner,
  SnapCandidateWired, MeasurementDetailsWired, PresetDrawerWired,
} from './Viewer/ViewerDialogs';
import {
  CANVAS_PADDING, ZOOM_SENSITIVITY, MIN_ZOOM, MAX_ZOOM, VIEWER_TOOLS,
} from './Viewer/ViewerConstants';
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
import type { InProgressPoint } from '@/context/TakeoffContext';
import type { OpenEndStyle } from '@/hooks/perimeterOffset/perimeterOffsetGeometry';

export type { ViewerProps, ViewerToolbarAPI } from './Viewer/ViewerConstants';

// ── PDF.js version helper ─────────────────────────────────────────────────────
function getPdfLibVersion(): string {
  try {
    const lib = require('pdfjs-dist/legacy/build/pdf') as { version?: string };
    return lib.version ?? '?';
  } catch {
    return '?';
  }
}

interface PendingMeasurementData {
  id: string;
  type: string;
  description: string;
}

interface UndoRedoRefValue {
  setCursorPoint: (p: React.SetStateAction<{ x: number; y: number } | null>) => void;
}

const svgFetchCache = new Map<string, string>();

export function Viewer(props: import('./Viewer/ViewerConstants').ViewerProps) {
  const {
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
    svgUrl,
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

  const showPins    = externalShowPins    !== undefined ? externalShowPins    : internalShowPins;
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
  } = useTakeoffContext();

  const undoRedoRef = useRef<UndoRedoRefValue>({ setCursorPoint: () => {} });
  const handleUndo  = useCallback(() => { undo();  undoRedoRef.current.setCursorPoint(null); }, [undo]);
  const handleRedo  = useCallback(() => { redo();  undoRedoRef.current.setCursorPoint(null); }, [redo]);

  const isMagicFillActiveRef = useRef(activeTool === 'magic-fill');
  isMagicFillActiveRef.current = activeTool === 'magic-fill';

  // ── PDF hook ──────────────────────────────────────────────────────────────
  const startExtractionRef = useRef<((pdf: any, file?: File) => void) | null>(null);
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
    pdfRef, pageNumberRef, scaleRef, pdfDimensionsRef, onScaleSetRef,
    pan, currentPdfPageRef,   // ← ADD THIS
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
    onPdfLoaded: (doc: any, file: any) => startExtractionRef.current?.(doc, file),
    onScaleSet,
    shouldPreserveFillCanvas: isMagicFillActiveRef,
  });

  const appendToGroupId = propAppendToGroupId ?? undefined;

  // ── SVG fetch ─────────────────────────────────────────────────────────────
  const [svgContent, setSvgContent] = useState<string | null>(null);
  const [svgLoading, setSvgLoading] = useState(false);

  useEffect(() => {
    if (!svgUrl) { setSvgContent(null); return; }
    if (svgFetchCache.has(svgUrl)) {
      setSvgContent(svgFetchCache.get(svgUrl) ?? null);
      return;
    }
    setSvgLoading(true);
    let cancelled = false;
    fetch(svgUrl)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then(text => {
        if (cancelled) return;
        svgFetchCache.set(svgUrl, text);
        setSvgContent(text);
        console.log(`[Viewer] SVG loaded — ${text.length} chars`);
      })
      .catch(err => {
        if (cancelled) return;
        console.warn(`[Viewer] Failed to load SVG from ${svgUrl}:`, err);
        setSvgContent(null);
      })
      .finally(() => { if (!cancelled) setSvgLoading(false); });
    return () => { cancelled = true; };
  }, [svgUrl]);

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

  // ── Stable pan ────────────────────────────────────────────────────────────
  const stablePan = useMemo(
    () => pan ?? { x: 0, y: 0 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pan?.x, pan?.y],
  );

  // ── Snap points, curves, and lines from SVG ───────────────────────────────
  const {
    snapPoints: _svgSnapPoints,
    svgCurves:  _svgCurves,
    svgLines:   _svgLines,
  } = useSvgSnapPoints(svgContent, stablePdfDimensions, snapEnabled);

  const svgSnapPointsRef = useRef(_svgSnapPoints);
  const svgCurvesRef     = useRef(_svgCurves);
  const svgLinesRef      = useRef(_svgLines);

  if (_svgSnapPoints !== svgSnapPointsRef.current) svgSnapPointsRef.current = _svgSnapPoints;
  if (_svgCurves     !== svgCurvesRef.current)     svgCurvesRef.current     = _svgCurves;
  if (_svgLines      !== svgLinesRef.current)       svgLinesRef.current      = _svgLines;

  const svgSnapPoints = svgSnapPointsRef.current;
  const svgCurves     = svgCurvesRef.current;
  const svgLines      = svgLinesRef.current;

  // ── Snap candidates in PDF-pixel space ───────────────────────────────────
  const snapCandidates = useMemo(() => {
    if (!stablePdfDimensions) return [];
    return svgSnapPoints.map(p => ({
      x:    p.nx * stablePdfDimensions.w,
      y:    p.ny * stablePdfDimensions.h,
      type: p.type,
    }));
  }, [svgSnapPoints, stablePdfDimensions]);

  // ── Snap engine ───────────────────────────────────────────────────────────
  const {
    pageData, analysisStatus, analysisPage, snapFlashes,
    startExtraction, getScaledCorners,
    snapToCorner, triggerSnapFlash,
    redrawPinCanvas,
    cursorPointRef,
  } = useSnapEngine({
    pinCanvasRef:     pinCanvasRef         as React.RefObject<HTMLCanvasElement>,
    pdfDimensionsRef: pdfDimensionsRef     as React.RefObject<NonNullable<typeof pdfDimensions>>,
    pageNumberRef:    pageNumberRef        as React.RefObject<number>,
    scaleRef:         scaleRef            as React.RefObject<number>,
    snapEnabled,
    showPins,
    snapThreshold,
    confidenceFilter,
    svgSnapPoints,
    svgLines,
    svgCurves,
    activeTool,
    proximityRadius: 80,
    viewportRef: containerRef as React.RefObject<HTMLDivElement>,
    zoom:        scale,
    pan:         stablePan,
  });

  const stagedArcs = calcStagedArcCount(tempPoints);
  useEffect(() => { startExtractionRef.current = startExtraction; }, [startExtraction]);

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

  // ── Polyarc mode — owned locally so togglePolyarcMode is always a function ─
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
  } = useMeasurements({
    drawingCanvasRef: drawingCanvasRef as React.RefObject<HTMLCanvasElement>,
    pdfDimensionsRef: pdfDimensionsRef as React.RefObject<NonNullable<typeof pdfDimensions>>,
    pageNumberRef:    pageNumberRef    as React.RefObject<number>,
    scaleRef:         scaleRef        as React.RefObject<number>,
    activeTool, setActiveTool: setActiveToolString,
    measurements, tempPoints, pushPoint,
    commitMeasurement, batchCommitMeasurements,
    appendToGroupId, onAppendComplete,
    onScalePrompt: handleScalePrompt,
    clearTempPoints, scaleFactor, onUpdateMeasurement,
    isPanning, snapToCorner: snapToCorner as any, getScaledCorners,
    triggerSnapFlash, snapEnabled, snapThreshold,
    redrawPinCanvas, cursorPointRef, activeDrawingId,
    snapCandidates,
    polyarcMode,
    togglePolyarcMode,
    forcedPolyarcMode: forcedPolyarcMode ?? undefined,
  } as any);

  // Safe fallback so status bar never crashes before polyarcMode is set
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
    // FIX: destructure activeColor and handleMagicPolygonFill
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
    currentPdfPageRef,   // ← ADD THIS — already returned by useViewerPdf
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

  // Currently selected measurement (if valid offset source)
  const offsetSourceMeasurement = useMemo(() => {
    if (activeTool !== 'perimeter-offset') return null;
    if (!selectedId) return null;
    return measurements.find(m => m.id === selectedId) ?? null;
  }, [activeTool, selectedId, measurements]);

  // Inscribed circle radius for collapse warning
  const offsetCollapseRadius = useMemo(() => {
    if (!offsetSourceMeasurement) return 0;
    if (!isValidOffsetSource(offsetSourceMeasurement)) return 0;
    return getCollapseRadius(offsetSourceMeasurement);
  }, [offsetSourceMeasurement, isValidOffsetSource, getCollapseRadius]);

  // ── offsetEligiblePolygons ────────────────────────────────────────────────
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

  // Tessellated source polygon for donut ring clipping in ViewerCanvas
  const offsetSourcePolygon = useMemo((): Array<{ x: number; y: number }> | null => {
    if (!offsetSourceMeasurement) return null;
    if (!offsetEligiblePolygons)  return null;
    const shape = offsetEligiblePolygons.find(s => s.id === offsetSourceMeasurement.id);
    return shape?.pts ?? null;
  }, [offsetSourceMeasurement, offsetEligiblePolygons]);

  // offsetIsOpenPath: true ONLY when source is open AND endStyle === 'none'
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

  // ── Offset canvas click ────────────────────────────────────────────────────
  const handleOffsetCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const dim  = pdfDimensionsRef.current;
    if (!dim) return;
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top)  / rect.height;
    const hit = findOffsetHit(nx, ny);
    if (hit) setSelectedId(hit.id);
  }, [findOffsetHit, setSelectedId, pdfDimensionsRef]);

  // ── Offset canvas hover ────────────────────────────────────────────────────
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

  // ── handleOffsetCommit ────────────────────────────────────────────────────
  const handleOffsetCommit = useCallback((params: CommitOffsetParams): CommitOffsetResult => {
    const result = commitOffset(params);
    setOffsetCommitError(result.error);
    setOffsetCommitWarn(result.warning);
    if (!result.error) {
      setOffsetPreviewPolygons(null);
      setActiveTool('select' as ToolType);
    }
    return result;
  }, [commitOffset, setActiveTool]);

  // ── handleOffsetBatchCommit ───────────────────────────────────────────────
  const handleOffsetBatchCommit = useCallback((
    params:   CommitOffsetParams[],
    options?: BatchCommitOptions,
  ): CommitOffsetResult => {
    const result = batchCommitOffsets(params, options);
    setOffsetCommitError(result.error);
    setOffsetCommitWarn(result.warning);
    if (!result.error) {
      setOffsetPreviewPolygons(null);
      setActiveTool('select' as ToolType);
    }
    return result;
  }, [batchCommitOffsets, setActiveTool]);

  // ── handleOffsetOpenCommit ─────────────────────────────────────────────────
  const handleOffsetOpenCommit = useCallback((params: CommitOpenPathParams): CommitOffsetResult => {
    const result = commitOpenPathOffset(params);
    setOffsetCommitError(result.error);
    setOffsetCommitWarn(result.warning);
    if (!result.error) {
      setOffsetPreviewPolygons(null);
      setActiveTool('select' as ToolType);
    }
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

  const handleDialogConfirm = useCallback((name: string, _: string, icon?: string) => {
    setShowMeasurementDialog(false);
    finishMeasurement(undefined, {
      label: name.trim() || `New ${pendingMeasurementData?.type || 'Measurement'}`,
      icon,
    });
  }, [finishMeasurement, pendingMeasurementData]);

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
    confidenceFilter, setConfidenceFilter, analysisStatus,
    analysisPage: analysisPage ?? null,
    currentPageCorners: pageData.get(pageNumber - 1)?.corners.length ?? 0,
    pdf, pageNumber,
    fitToScreen: () => fitToScreen(),
    handleManualScale,
    canUndo, canRedo, handleUndo, handleRedo,
    polyarcMode: safePolyarcMode, togglePolyarcMode,
    tempPointsCount: tempPoints.length,
  }), [
    activeTool, handleSetActiveTool, scale, scaleFactor,
    snapEnabled, showSnapSettings,
    showPins, setShowPins,
    snapThreshold, confidenceFilter,
    analysisStatus, analysisPage, pageData, pageNumber, pdf,
    fitToScreen, handleManualScale, canUndo, canRedo, handleUndo, handleRedo,
    safePolyarcMode, togglePolyarcMode, tempPoints,
  ]);

  useEffect(() => { onToolbarReady?.(toolbarAPI); }, [onToolbarReady, toolbarAPI]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (activeTool === 'magic-fill' && mfStagedCount > 0) {
          handleMagicAbortSession(); return;
        }
        if (activeTool === 'perimeter-offset') {
          handleOffsetCancel(); return;
        }
      }
      if (e.key === 'Enter' && activeTool === 'perimeter-offset') return;

      const tag = (e.target as HTMLElement).tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
        if (e.key.toLowerCase() === 'a' && activeTool === 'polyarc') {
          e.preventDefault();
          togglePolyarcMode();
          return;
        }

        const map: Record<string, ToolType> = {
          v: 'select',    l: 'linear',   r: 'rectangle',
          p: 'polygon',   n: 'count',    t: 'point',
          b: 'arc',       g: 'grid-count',
          y: 'polyarc',
          o: 'perimeter-offset',
        };
        if (map[e.key.toLowerCase()]) {
          e.preventDefault();
          handleSetActiveTool(map[e.key.toLowerCase()]);
          return;
        }
      }
      const cm = e.ctrlKey || e.metaKey;
      if (cm && (e.key === '+' || e.key === '='))                   { e.preventDefault(); setScale(s => Math.min(MAX_ZOOM, s + ZOOM_SENSITIVITY)); return; }
      if (cm && e.key === '-')                                       { e.preventDefault(); setScale(s => Math.max(MIN_ZOOM, s - ZOOM_SENSITIVITY)); return; }
      if (cm && e.key === '0')                                       { e.preventDefault(); fitToScreen(); return; }
      if (cm && e.key === 'z' && !e.shiftKey)                       { e.preventDefault(); handleUndo(); return; }
      if (cm && (e.key === 'y' || (e.key === 'z' && e.shiftKey)))   { e.preventDefault(); handleRedo(); return; }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeTool, mfStagedCount, fitToScreen, handleUndo, handleRedo,
    handleSetActiveTool, handleMagicAbortSession, handleOffsetCancel,
    setScale, togglePolyarcMode,
  ]);

  // ── Pan handler ───────────────────────────────────────────────────────────
  const handleContainerPointerDown = useCallback((e: React.PointerEvent) => {
    if (activeTool === 'grid-count') return;
    if (
      e.button === 1 ||
      (e.button === 0 && spaceHeldRef.current) ||
      (e.button === 0 && activeTool === 'select')
    ) {
      pdfContainerPointerDown(e);
    }
  }, [activeTool, spaceHeldRef, pdfContainerPointerDown]);

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

  // ── Polyarc status helpers ────────────────────────────────────────────────
  const polyarcSegments   = activeTool === 'polyarc' ? splitPolyarcSegments(tempPoints) : [];
  const polyarcHasContent = polyarcSegments.some(s =>
    (s.type === 'line' && s.points.length >= 2) ||
    (s.type === 'arc'  && s.points.length === 3),
  );
  const polyarcLineCount = polyarcSegments.filter(s => s.type === 'line').length;
  const polyarcArcCount  = polyarcSegments.filter(s => s.type === 'arc').length;

  // ── Snap status text ──────────────────────────────────────────────────────
  const snapStatusText = useMemo(() => {
    if (svgLoading)               return 'Loading snap layout…';
    if (!svgUrl)                  return 'No snap layout — pass svgUrl prop to enable snapping';
    if (!svgContent)              return 'Snap layout failed to load';
    if (!snapEnabled)             return 'Snap disabled';
    if (svgSnapPoints.length > 0) return `${svgSnapPoints.length} snap pts · ${svgLines.length} segs — hover to snap`;
    return 'Parsing snap data…';
  }, [svgLoading, svgUrl, svgContent, snapEnabled, svgSnapPoints.length, svgLines.length]);

  // ── PDF.js version ────────────────────────────────────────────────────────
  const [pdfLibVersion] = useState<string>(() =>
    typeof window !== 'undefined' ? getPdfLibVersion() : '?'
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 relative bg-industrial-black blueprint-grid flex flex-col overflow-hidden h-full">
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
            analysisStatus={analysisStatus} analysisPage={analysisPage ?? null}
            currentPageCorners={pageData.get(pageNumber - 1)?.corners.length ?? 0}
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
              handleCanvasClick={isOffsetTool ? handleOffsetCanvasClick : handleCanvasClick}
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
              {/* FIX: onPolygonLasso (was onBatchRect) and activeColor now correctly passed */}
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

        {/* ── Perimeter Offset panel ── */}
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
              <span className={svgLoading ? 'text-amber-400' : !svgContent ? 'text-zinc-600' : ''}>
                {snapStatusText}
              </span>
            )}
            <span>RENDER_ENGINE: PDF.JS V{pdfLibVersion}</span>
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
        onConfirm={(name: string) => handleMfNameConfirm(name)}
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

      <style>{`
        @keyframes snapPulse {
          0%   { transform: translate(-50%,-50%) scale(0.5); opacity: 1; }
          100% { transform: translate(-50%,-50%) scale(2.5); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
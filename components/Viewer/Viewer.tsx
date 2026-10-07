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
import { ChevronLeft, ChevronRight, Check, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import pdfjsLib from '@/lib/pdf/pdfClient';
import { ToolType, TakeoffRow } from '@/types';
import { Minimap }           from '@/components/features/overlays/Minimap';
import { SnapSettingsPanel } from '@/components/features/dialogs/SnapSettingsPanel';
import { useSnapEngine }     from '@/hooks/snapEngine/useSnapEngine';
import { usePdfDocument, hasSnapGeometry } from '@/hooks/snapEngine/usePdfDocument';
import { RoomHoverOverlay } from './RoomHoverOverlay';
import { createLassoStore } from '@/lib/geometry/lassoStore';
import { useShapeActions } from '@/hooks/shapes/useShapeActions';
import { AutoCount } from '@/components/Viewer/AutoCount';
import { actionForKey } from '@/lib/shortcuts';
import { useActiveItem, kindOfTool, kindOfType } from '@/hooks/shapes/useActiveItem';
import { ActiveItemBar } from '@/components/Viewer/ActiveItemBar';
import { getNextMeasurementColor } from '@/hooks/measurements/useMeasurements';
import { setColorsInUse } from '@/hooks/measurements/useMeasurements/colors';
import { ShapeActions, type ShapeMenuState } from '@/components/Viewer/ShapeActions';
import { CentreAnchorOverlay, angleInArc, alignSweep, type Anchor, type CentreGroup } from './CentreAnchorOverlay';
import { RADIUS_SENTINEL, ARC_SENTINEL, isRadiusSentinel } from '@/hooks/measurements/useMeasurements/useMeasurementCommit';
import type { GeometryShape } from '@/types/snapTypes';
import { buildGeometryIndex } from '@/lib/geometry/geometryIndex';
import { ViewerStatusControls } from './ViewerStatusControls';
import { DEFAULT_DRAW_MODE, drawModeState, clampSides, type DrawMode } from '@/lib/geometry/pathShapes';
import { constrainToAngle, isExactSnap, ORTHO_TOOLS, orthoState } from '@/lib/geometry/ortho';
import { buildPointGrid } from '@/lib/geometry/pointGrid';
import { snapOutline as snapOutlineToDrawing } from '@/lib/geometry/snapOutline';
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
  // Angle lock (F8): next point of a line/polygon stays on 0° / 45° / 90° from the last.
  const [orthoEnabled,     setOrthoEnabled]     = useState(false);
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
    selectedId, setSelectedId, projectState, updateMeasurement, replaceMeasurements,
    setActivePage, showLabels, pendingPage, clearPendingPage,
    setDrawingPageCount, focusSeq, setNextMaterial, showGeometry, projectId: takeoffProjectId,
    setShowLabels, setShowGeometry,
  } = useTakeoffContext();
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  // More shapes selected with Shift-click (the first one picked is `selectedId`).
  const [extraSelected, setExtraSelected] = useState<string[]>([]);
  const extraSelectedRef = useRef<string[]>(extraSelected);
  extraSelectedRef.current = extraSelected;
  const [shapeMenu, setShapeMenu] = useState<ShapeMenuState | null>(null);
  // While a cut-out / split is being drawn, the drawn shape is used as the
  // cutter instead of being saved (set further down, once the actions exist).
  const consumeDrawnRef = useRef<(rows: TakeoffRow[]) => boolean>(() => false);
  // With a named item active, drawn shapes are added to it (set further down).
  const adoptRef = useRef<(rows: TakeoffRow[]) => boolean>(() => false);
  const itemActiveRef = useRef(false);
  const commitOrConsume = useCallback((m: TakeoffRow) => {
    // Ellipse mode: the drawn box becomes the ellipse that fits inside it.
    if (drawModeState.ellipse && m.type === 'Rectangle' && m.points.length >= 2) {
      const xs = m.points.map(p => p.x), ys = m.points.map(p => p.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const rx = (Math.max(...xs) - Math.min(...xs)) / 2, ry = (Math.max(...ys) - Math.min(...ys)) / 2;
      const N = 72;
      m = {
        ...m, type: 'Polygon', quantity: +(m.quantity * Math.PI / 4).toFixed(4),
        label: m.label?.replace(/Rectangle/g, 'Ellipse'), description: (m.description ?? '').replace(/Rectangle/g, 'Ellipse'),
        points: Array.from({ length: N }, (_, i) => ({ x: cx + rx * Math.cos((i / N) * 2 * Math.PI), y: cy + ry * Math.sin((i / N) * 2 * Math.PI) })),
      };
    }
    if (consumeDrawnRef.current([m]) || adoptRef.current([m])) return;
    commitMeasurement(m);
  }, [commitMeasurement]);
  const batchCommitOrConsume = useCallback((rows: TakeoffRow[]) => {
    // A run drawn with straight and curved parts arrives as a group of
    // pieces. Keep it as ONE line (curves become fine steps), so selecting it
    // selects the whole run and its length is one row.
    const head = rows.find(r => r.isGroupHeader);
    const parts = rows.filter(r => !r.isGroupHeader);
    if (activeToolRef.current === 'polyarc' && !drawModeState.area && head && head.type === 'Length' && parts.length > 1 &&
        parts.every(p => p.type === 'Length' && p.parentId === head.id)) {
      const dim = pdfDimensionsRef.current;
      const pts = tessellatePoints(getEffectivePoints(head, rows), dim?.w ?? 1, dim?.h ?? 1).map(q => ({ x: q.x, y: q.y }));
      if (pts.length >= 2) {
        const curved = parts.filter(p => p.arcRadius != null).length;
        rows = [{
          ...parts[0], id: head.id, parentId: undefined, groupId: undefined, isGroupHeader: false, childIds: [],
          label: head.label, description: head.description, points: pts, quantity: head.quantity, unit: head.unit,
          arcRadius: undefined, sweepAngle: undefined, color: head.color,
          notes: curved ? `Includes ${curved} curved part${curved === 1 ? '' : 's'}` : '',
        } as TakeoffRow];
        if (consumeDrawnRef.current(rows) || adoptRef.current(rows)) return;
        commitMeasurement(rows[0]);
        return;
      }
    }
    if (consumeDrawnRef.current(rows) || adoptRef.current(rows)) return;
    batchCommitMeasurements(rows);
  }, [batchCommitMeasurements, commitMeasurement]);
  const shapePendingRef = useRef(false);
  const magicItemIdRef = useRef<string | null>(null);
  const [showTechInfo, setShowTechInfo] = useState(false);
  const [dragOver,     setDragOver]     = useState(false);

  const undoRedoRef = useRef<UndoRedoRefValue>({ setCursorPoint: () => {} });
  // New items get a colour nothing else in the takeoff is using.
  setColorsInUse(((projectState?.measurements ?? []) as TakeoffRow[]).filter(m => m.isGroupHeader || !m.parentId).map(m => m.color));

  // Undo / redo also put the selection back: whatever the step changed or
  // brought back is selected again (so undoing a merge re-selects both areas).
  const undoDiffRef = useRef<Map<string, TakeoffRow> | null>(null);
  const noteBeforeUndo = () => {
    undoDiffRef.current = new Map(((projectState?.measurements ?? []) as TakeoffRow[]).map(m => [m.id, m]));
    setTimeout(() => { undoDiffRef.current = null; }, 80);      // nothing changed (e.g. a point was undone) → forget
  };
  const handleUndo  = useCallback(() => { noteBeforeUndo(); undo();  undoRedoRef.current.setCursorPoint(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [undo, projectState]);
  const handleRedo  = useCallback(() => { noteBeforeUndo(); redo();  undoRedoRef.current.setCursorPoint(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [redo, projectState]);
  useEffect(() => {
    const before = undoDiffRef.current;
    if (!before) return;
    undoDiffRef.current = null;
    const now = (projectState?.measurements ?? []) as TakeoffRow[];
    const alive = new Set(now.map(m => m.id));
    const changed = now.filter(m => !m.isGroupHeader && (m.points?.length ?? 0) > 0 && before.get(m.id) !== m).map(m => m.id);
    if (activeTool === 'select' && changed.length > 0 && changed.length <= 24) {
      const first = selectedId && changed.includes(selectedId) ? selectedId : changed[0];
      setSelectedId(first);
      setExtraSelected(changed.filter(id => id !== first));
    } else {
      if (selectedId && !alive.has(selectedId)) setSelectedId(null);
      setExtraSelected(prev => prev.filter(id => alive.has(id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectState?.measurements]);

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
    circles:     pdfCircles,
    arcs:        pdfArcs,
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

  // Zooming: hide the measurements until the page has been redrawn at the new
  // size (the page is only stretched in the meantime, so they wouldn't line up).
  const [zoomSettling, setZoomSettling] = useState(false);
  useEffect(() => {
    if (Math.abs(scale - committedScale) > 1e-6) { setZoomSettling(true); return; }
    // Zoom has stopped changing; the redraw that follows bumps pdfRenderCount.
    const t = setTimeout(() => setZoomSettling(false), 900);         // safety net if no redraw comes
    return () => clearTimeout(t);
  }, [scale, committedScale]);
  useEffect(() => {
    if (Math.abs(scale - committedScale) > 1e-6) return;
    const f = requestAnimationFrame(() => setZoomSettling(false));   // redrawn → show them again
    return () => cancelAnimationFrame(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfRenderCount]);


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
  // The snap engine works in PAGE UNITS (the page at 100%, the space the
  // geometry worker outputs lines/curves in, and what the pin layer expects).
  // The drawing canvas is at the committed zoom, so snapToCanvas() below
  // converts the cursor into page units and the result back.
  const pageSnapPoints = useMemo(() => {
    if (!pdfDocDims || !pdfSnapPoints.length) return [];
    const { w, h } = pdfDocDims;
    return pdfSnapPoints.map(sp => ({ ...sp, x: sp.nx * w, y: sp.ny * h }));
  }, [pdfSnapPoints, pdfDocDims]);

  // Centre anchor for the Circle / Arc tools (see "Centre anchor actions").
  const [anchor,   setAnchor]   = useState<Anchor | null>(null);
  const [arcStart, setArcStart] = useState<{ x: number; y: number } | null>(null);

  // Once a circle's centre is placed (or an arc centre is anchored), the next
  // point can be anywhere — so snapping opens up to everything on the plan:
  // ends, midpoints, crossings, points on lines and arcs.
  const lastTemp = tempPoints[tempPoints.length - 1];
  const pickingFromCentre =
    (activeTool === 'radius' && tempPoints.length > 0 && !!lastTemp && !isRadiusSentinel(lastTemp)) ||
    (activeTool === 'arc' && !!anchor);

  // ── What each tool gets to see and snap to ────────────────────────────────
  //   Circle  → circle centres (and circle edges for the 2nd click)
  //   Linear  → straight lines only
  //   Arc     → arcs and arc centres only
  //   Polyarc → lines + arcs
  //   others  → everything
  const toolShapes = useMemo<ReadonlySet<GeometryShape> | null>(() => {
    if (pickingFromCentre) return null;
    switch (activeTool) {
      case 'linear':  return new Set<GeometryShape>(['line']);
      case 'arc':     return new Set<GeometryShape>(['arc']);
      case 'polyarc': return new Set<GeometryShape>(['line', 'arc']);
      case 'radius':  return new Set<GeometryShape>(['circle']);
      default:        return null;
    }
  }, [activeTool, pickingFromCentre]);

  const toolSnapPoints = useMemo(() => {
    if (!toolShapes) return pageSnapPoints;
    return pageSnapPoints.filter(sp =>
      toolShapes.has(sp.shape ?? 'line') && (activeTool !== 'radius' || sp.type === 'centroid'));
  }, [pageSnapPoints, toolShapes, activeTool]);
  const toolLines  = useMemo(() => (toolShapes ? pdfLines.filter(l => toolShapes.has(l.shape ?? 'line')) : pdfLines), [pdfLines, toolShapes]);
  const toolCurves = useMemo(() => (toolShapes ? pdfCurves.filter(c => toolShapes.has(c.shape ?? 'arc')) : pdfCurves), [pdfCurves, toolShapes]);

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
    // Pins are drawn on the drawing canvas now (see findPinsNear) — the old
    // worker pin layer mixed coordinate spaces and is kept switched off.
    showPins: false,
    snapThreshold,
    lines:      toolLines,          // page units (100% zoom), filtered for the tool
    curves:     toolCurves,
    snapPoints: toolSnapPoints,     // page units, filtered for the tool
    activeTool,
    proximityRadius: 80,
    zoom:            scale,
    pan:             stablePan,
  });

  // In-progress Magic Fill lasso, shared with the room preview only.
  const lassoStore = useMemo(() => createLassoStore(), []);

  // ── Centre anchor (Circle / Arc tools) ────────────────────────────────────
  // Picking a centre marker anchors it; the next clicks either take one of the
  // drawn shapes around it exactly, or draw your own from that centre.
  const anchorRef = useRef<Anchor | null>(null);
  anchorRef.current = anchor;
  const arcStartRef = useRef<{ x: number; y: number } | null>(null);
  arcStartRef.current = arcStart;
  const tempCountRef = useRef(0);
  tempCountRef.current = tempPoints.length;

  // Canvas px ↔ page units for snapping.
  const snapEnabledRef = useRef(snapEnabled);
  snapEnabledRef.current = snapEnabled;
  const snapThresholdRef = useRef(snapThreshold);
  snapThresholdRef.current = snapThreshold;
  const geometryIndexRef = useRef<ReturnType<typeof buildGeometryIndex> | null>(null);
  const ownVertexGridRef = useRef<ReturnType<typeof buildPointGrid> | null>(null);
  const canvasPerPageRef = useRef(1);
  canvasPerPageRef.current = pdfDimensions && pdfDocDims?.w ? pdfDimensions.w / pdfDocDims.w : 1;
  const snapCore = useCallback((cx: number, cy: number) => {
    const k = canvasPerPageRef.current || 1;
    const qx = cx / k, qy = cy / k;
    const out = (x: number, y: number, type: string) =>
      ({ snapped: true, point: { x: x * k, y: y * k }, type } as ReturnType<typeof snapToCorner>);

    // 0. Arc tool with an anchored centre: points belong to its circle(s).
    const aa = anchorRef.current;
    if (aa?.kind === 'arc' && pdfDocDims) {
      const ax = aa.nx * pdfDocDims.w, ay = aa.ny * pdfDocDims.h;
      const tolP = 12 / k;
      const start = arcStartRef.current;
      if (!start) {
        if (snapEnabledRef.current) {
          // a drawn arc's end, then any point along a drawn arc
          for (const arc of aa.arcs) {
            for (const ang of [arc.start, arc.start + arc.sweep]) {
              const ex = ax + arc.r * Math.cos(ang), ey = ay + arc.r * Math.sin(ang);
              if (Math.hypot(qx - ex, qy - ey) < tolP) return out(ex, ey, 'endpoint');
            }
          }
          const d = Math.hypot(qx - ax, qy - ay), ang = Math.atan2(qy - ay, qx - ax);
          const on = d > 0 ? aa.arcs.find(arc => Math.abs(d - arc.r) < tolP && angleInArc(ang, arc.start, arc.sweep)) : undefined;
          if (on) return out(ax + on.r * Math.cos(ang), ay + on.r * Math.sin(ang), 'on-curve');
        }
        // otherwise fall through to normal snapping (own radius)
      } else {
        // End point: always on the circle through the start point…
        const sx = start.x * pdfDocDims.w, sy = start.y * pdfDocDims.h;
        const R = Math.hypot(sx - ax, sy - ay);
        let ang = Math.atan2(qy - ay, qx - ax);
        // …snapping to the ends of drawn arcs on that circle.
        if (snapEnabledRef.current) {
          for (const arc of aa.arcs) {
            if (Math.abs(arc.r - R) > tolP) continue;
            for (const e of [arc.start, arc.start + arc.sweep]) {
              let diff = ang - e;
              diff = Math.atan2(Math.sin(diff), Math.cos(diff));
              if (Math.abs(diff) * R < tolP) { ang = e; return out(ax + R * Math.cos(ang), ay + R * Math.sin(ang), 'endpoint'); }
            }
          }
        }
        return out(ax + R * Math.cos(ang), ay + R * Math.sin(ang), 'on-curve');
      }
    }

    // 1. Exact points win: ends, midpoints, crossings, centres — and the
    //    points of your own measurements (continue exactly from a previous end).
    const r = snapToCorner(qx, qy);
    if (snapEnabledRef.current) {
      const tol = (snapThresholdRef.current || 12) / (scaleRef.current || 1);
      const own = ownVertexGridRef.current?.near({ x: qx, y: qy }, tol, 1)[0];
      const pdfD = r.snapped && r.type !== 'line' ? Math.hypot(r.point.x - qx, r.point.y - qy) : Infinity;
      if (own && Math.hypot(own.x - qx, own.y - qy) <= pdfD) return out(own.x, own.y, 'vertex');
    }
    if (r.snapped && r.type !== 'line') return { ...r, point: { x: r.point.x * k, y: r.point.y * k } };

    // 2. Circle tool, centre placed: the drawn circles around that centre.
    const a = anchorRef.current;
    if (snapEnabledRef.current && a?.kind === 'circle' && tempCountRef.current === 1 && pdfDocDims) {
      const ax = a.nx * pdfDocDims.w, ay = a.ny * pdfDocDims.h;
      const d = Math.hypot(qx - ax, qy - ay);
      const hit = d > 0 ? a.circles.find(c => Math.abs(d - c.r) < 12 / k) : undefined;
      if (hit) return out(ax + ((qx - ax) / d) * hit.r, ay + ((qy - ay) / d) * hit.r, 'circle-edge');
    }

    // 3. Otherwise land exactly on the nearest line / arc / circle edge the
    //    current step allows.
    if (snapEnabledRef.current) {
      const tol = (snapThresholdRef.current || 12) / (scaleRef.current || 1);
      const on = geometryIndexRef.current?.nearestPoint({ x: qx, y: qy }, tol, toolShapesRef.current);
      if (on) return out(on.point.x, on.point.y, on.entity.shape === 'line' ? 'line' : 'on-curve');
    }
    return { ...r, point: { x: r.point.x * k, y: r.point.y * k } };
  }, [snapToCorner, pdfDocDims]);

  // Angle lock sits on top of snapping: an exact snap point (end, midpoint,
  // crossing, centre, own vertex) still wins, as in CAD; anything looser is
  // pulled onto the nearest 45° ray from the previous point.
  const orthoRef = useRef(orthoEnabled);
  orthoRef.current = orthoEnabled;
  orthoState.on = orthoEnabled;
  const orthoFromRef = useRef<{ x: number; y: number } | null>(null);
  const snapToCanvas = useCallback((cx: number, cy: number) => {
    const res  = snapCore(cx, cy);
    const from = orthoFromRef.current;
    if (!orthoRef.current || !from || !ORTHO_TOOLS.has(activeToolRef.current)) return res;
    if (isExactSnap((res as { type?: string }).type, res.snapped)) return res;
    const dim = pdfDimensionsRef.current;
    if (!dim) return res;
    const p = constrainToAngle({ x: from.x * dim.w, y: from.y * dim.h }, { x: cx, y: cy });
    return { ...res, snapped: false, point: { x: p.x, y: p.y } };
  }, [snapCore]);

  // ── Extracted geometry: hover highlight + optional overlay ────────────────
  const geometryIndex = useMemo(() => buildGeometryIndex(pdfLines as never, pdfCurves as never), [pdfLines, pdfCurves]);
  geometryIndexRef.current = geometryIndex;
  const HOVER_TOOLS = useMemo(() => new Set(['linear', 'polygon', 'rectangle', 'arc', 'polyarc', 'radius', 'count', 'point', 'scale']), []);
  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;
  const toolShapesRef = useRef(toolShapes);
  toolShapesRef.current = toolShapes;
  // Canvas px in → nearest PDF line/arc (as canvas-px points) out.
  const findHoverGeometry = useCallback((cx: number, cy: number) => {
    if (!HOVER_TOOLS.has(activeToolRef.current as string)) return null;
    const k = canvasPerPageRef.current || 1;
    const e = geometryIndex.nearest({ x: cx / k, y: cy / k }, 10 / k, toolShapesRef.current);
    if (!e) return null;
    const pts = e.kind === 'line' ? [e.a, e.b] : e.pts;
    return { kind: e.kind, pts: pts.map(p => ({ x: p.x * k, y: p.y * k })) };
  }, [geometryIndex, HOVER_TOOLS]);

  // GEOMETRY ON: draw every extracted line/arc faintly on the vector layer.
  // Redrawn only when the page, its geometry or the zoom level changes.
  useEffect(() => {
    const c = vectorCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!showGeometry || !pdfDimensions || !geometryIndex.entities.length) return;
    const k = canvasPerPageRef.current || 1;
    ctx.save();
    ctx.lineWidth = 1;
    // Only what the current tool uses; colour-coded by what it is.
    const COLOUR: Record<GeometryShape, string> = {
      line:   'rgba(14,165,233,0.55)',   // blue
      arc:    'rgba(217,70,239,0.65)',   // magenta
      circle: 'rgba(139,92,246,0.7)',    // purple
    };
    for (const shape of ['line', 'arc', 'circle'] as GeometryShape[]) {
      if (toolShapes && !toolShapes.has(shape)) continue;
      ctx.strokeStyle = COLOUR[shape];
      ctx.beginPath();
      for (const e of geometryIndex.entities) {
        if (e.shape !== shape) continue;
        if (e.kind === 'line') { ctx.moveTo(e.a.x * k, e.a.y * k); ctx.lineTo(e.b.x * k, e.b.y * k); }
        else e.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * k, p.y * k) : ctx.lineTo(p.x * k, p.y * k)));
      }
      ctx.stroke();
    }
    ctx.restore();
    // pdfRenderCount: the vector canvas is resized (cleared) by page renders.
  }, [showGeometry, geometryIndex, pdfDimensions, pdfRenderCount, toolShapes]);

  // ── Your own measurements' points are snappable too ───────────────────────
  // So a new line / arc can start exactly where the previous one ended.
  const ownVertexGrid = useMemo(() => {
    if (!pdfDocDims) return buildPointGrid([]);
    const pts: { x: number; y: number; type: string }[] = [];
    for (const m of measurements) {
      if (m.isVisible === false || !m.points?.length) continue;
      for (const p of m.points) pts.push({ x: p.x * pdfDocDims.w, y: p.y * pdfDocDims.h, type: 'vertex' });
    }
    return buildPointGrid(pts);
  }, [measurements, pdfDocDims]);
  ownVertexGridRef.current = ownVertexGrid;

  // ── PINS: snap points near the cursor, drawn on the drawing canvas ────────
  // Same coordinates as everything else (page units × canvas scale), so they
  // line up at every zoom. Shown with PINS ON, and automatically while you
  // pick a point from a centre (Circle / Arc tools).
  const pinGrid = useMemo(() => buildPointGrid(toolSnapPoints as never), [toolSnapPoints]);
  const pinsVisible = showPins || pickingFromCentre;
  const findPinsNear = useMemo(() => {
    if (!pinsVisible) return null;
    return (cx: number, cy: number) => {
      const k = canvasPerPageRef.current || 1;
      const q = { x: cx / k, y: cy / k };
      return [...ownVertexGrid.near(q, 80 / k, 40), ...pinGrid.near(q, 80 / k)]
        .map(p => ({ x: p.x * k, y: p.y * k, type: p.type }));
    };
  }, [pinsVisible, pinGrid, ownVertexGrid]);

  const stagedArcs = calcStagedArcCount(tempPoints);

  // ── setActiveTool — raw passthrough ───────────────────────────────────────
  const setActiveToolString = useCallback(
    (t: string) => setActiveTool(t as ToolType),
    [setActiveTool],
  );

  // ── handleSetActiveTool — with linear↔arc→polyarc upgrade ────────────────
  // ── Polyarc mode ──────────────────────────────────────────────────────────
  // The segment type the next Polyarc click creates. Switching to Linear / Arc
  // while drawing sets it directly (it used to be stored in forcedPolyarcMode,
  // which nothing read — so after an arc, "line" clicks were still recorded as
  // arc points and the line after an arc was lost).
  const [polyarcMode, setPolyarcMode] = useState<'line' | 'arc'>('line');
  const togglePolyarcMode = useCallback(() => {
    setPolyarcMode(m => m === 'line' ? 'arc' : 'line');
  }, []);

  const pendingPolyarcModeRef = useRef<'line' | 'arc' | null>(null);
  const [forcedPolyarcMode, setForcedPolyarcMode] = useState<'line' | 'arc' | null>(null);

  const handleSetActiveTool = useCallback((newTool: ToolType) => {
    const LINEAR_ARC = new Set<string>(['linear', 'arc']);

    if (activeTool === 'polyarc' && LINEAR_ARC.has(newTool)) {
      const nextMode: 'line' | 'arc' = newTool === 'linear' ? 'line' : 'arc';
      pendingPolyarcModeRef.current = nextMode;
      setForcedPolyarcMode(nextMode);
      setPolyarcMode(nextMode);
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
      setPolyarcMode(nextMode);
      retagTempPoints(pts => pts.map(p => ({ ...p, segmentType: existingSegType })));
      setActiveTool('polyarc' as ToolType);
      return;
    }

    pendingPolyarcModeRef.current = null;
    setForcedPolyarcMode(null);
    setActiveTool(newTool);
  }, [activeTool, tempPoints, retagTempPoints, setActiveTool]);

  // ── Area / Length modes ───────────────────────────────────────────────────
  // The rail's Area, Length and Count buttons are groups of the underlying
  // tools. `drawMode` says how a tool is being used (e.g. a path of lines and
  // curves closes into an area). Picking a mode from the strip abandons an
  // unfinished shape of a different tool rather than converting it.
  const [drawMode, setDrawModeState] = useState<DrawMode>(DEFAULT_DRAW_MODE);
  Object.assign(drawModeState, drawMode);
  const setToolMode = useCallback((tool: ToolType, mode?: Partial<DrawMode>) => {
    const next: DrawMode = { ...DEFAULT_DRAW_MODE, sides: drawModeState.sides, ...mode };
    next.sides = clampSides(next.sides);
    Object.assign(drawModeState, next);
    setDrawModeState(next);
    if (tool !== activeTool) {
      if (tempPoints.length > 0) clearTempPoints();
      pendingPolyarcModeRef.current = null;
      setForcedPolyarcMode(null);
      setActiveTool(tool);
    }
  }, [activeTool, tempPoints.length, clearTempPoints, setActiveTool]);

  // Each new path starts with straight edges again (finishing or cancelling a
  // shape while on "curve" shouldn't make the next one start curved).
  const prevTempCountRef = useRef(0);
  useEffect(() => {
    if (activeTool === 'polyarc' && prevTempCountRef.current > 0 && tempPoints.length === 0) {
      pendingPolyarcModeRef.current = null;
      setForcedPolyarcMode(null);
      setPolyarcMode('line');
    }
    prevTempCountRef.current = tempPoints.length;
  }, [activeTool, tempPoints.length]);

  useEffect(() => {
    if (activeTool !== 'polyarc') {
      setForcedPolyarcMode(null);
      pendingPolyarcModeRef.current = null;
      setPolyarcMode('line');           // a fresh Polyarc starts with a line
    }
  }, [activeTool]);


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
    pendingBreak,
  } = useMeasurements({
    drawingCanvasRef: drawingCanvasRef as React.RefObject<HTMLCanvasElement>,
    pdfDimensionsRef: pdfDimensionsRef as React.RefObject<NonNullable<typeof pdfDimensions>>,
    pageNumberRef:    pageNumberRef    as React.RefObject<number>,
    // Quantities convert canvas px → PDF points using the zoom the canvas was
    // laid out at (not the live, still-debouncing zoom) — see useViewerPdf.
    scaleRef:         dimsScaleRef    as React.RefObject<number>,
    activeTool, setActiveTool: setActiveToolString,
    measurements, tempPoints, pushPoint,
    commitMeasurement: commitOrConsume, batchCommitMeasurements: batchCommitOrConsume,
    appendToGroupId, onAppendComplete,
    onScalePrompt: handleScalePrompt,
    clearTempPoints, scaleFactor, onUpdateMeasurement,
    isPanning, snapToCorner: snapToCanvas as any, getScaledCorners: () => [],
    triggerSnapFlash, snapEnabled, snapThreshold,
    redrawPinCanvas, cursorPointRef, activeDrawingId,
    snapCandidates: [],
    polyarcMode,
    togglePolyarcMode,
    forcedPolyarcMode: forcedPolyarcMode ?? undefined,
    showLabels,
    selectedIdRef,
    extraSelectedRef,
    findHoverGeometry,
    findPinsNear,
  } as any);

  // Angle lock measures from the last placed point of the run being drawn.
  orthoFromRef.current =
    !pendingBreak && tempPoints.length > 0 && ORTHO_TOOLS.has(activeTool)
      ? tempPoints[tempPoints.length - 1]
      : null;

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
  // ── Magic Fill outlines hug the drawing ───────────────────────────────────
  // Traced fill outlines (mask pixels) are snapped onto the PDF's own lines
  // and arcs: corners to line ends / crossings, edges onto the nearest line
  // or arc, sharp corners rebuilt. Available once the page geometry loaded.
  const cornerGrid = useMemo(() => buildPointGrid(
    pageSnapPoints.filter(p => p.type === 'endpoint' || p.type === 'intersection') as never,
  ), [pageSnapPoints]);
  const snapFillOutline = useMemo(() => {
    if (!pdfDocDims || geometryIndex.entities.length === 0) return null;
    return (poly: [number, number][], mw: number, mh: number): [number, number][] => {
      const kx = pdfDocDims.w / mw, ky = pdfDocDims.h / mh;
      const out = snapOutlineToDrawing(poly.map(([x, y]) => [x * kx, y * ky] as [number, number]), {
        nearest: (x, y, tol) => geometryIndex.nearestPoint({ x, y }, tol) as never,
        corner:  (x, y, tol) => cornerGrid.near({ x, y }, tol, 1)[0] ?? null,
        edgeTol:   4 * kx,     // ≈ 4 mask pixels: the trace sits just inside the wall line
        cornerTol: 3 * kx,
      });
      return out.map(([x, y]) => [x / kx, y / ky] as [number, number]);
    };
  }, [pdfDocDims, geometryIndex, cornerGrid]);

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
    handleMagicFillHoles, handleMagicUndo, handleMagicRedo, mfRedoCount, mfUndoCount,
    handleMagicSubtractClick, handleMagicFillAll, mfRoomCount,
    handleMagicClear, handleMagicDelete,
    handleMagicToggleHide, handleMagicAbortSession,
    handleMagicFinish, handleMfNameConfirm, handleMfNameSkip,
    mfRooms,
  } = useMagicFillSession({
    snapOutline: snapFillOutline,
    pageSizePt:  pdfDocDims,
    regionKey:   activeDrawingId ? `${activeDrawingId}:${pageNumber}` : null,
    regionOwner: activeDrawingId && takeoffProjectId
      ? { projectId: takeoffProjectId, drawingId: activeDrawingId, page: pageNumber }
      : null,
    fillCanvasRef,
    magicFillActive: activeTool === 'magic-fill',
    pdfRenderCount,
    pdfCanvasRef,
    pdfDimensions,
    scaleFactor,
    isMagicFillActiveRef,
    activeDrawingId,
    measurements,
    propAppendToGroupId: appendToGroupId ?? magicItemIdRef.current ?? undefined,
    // Fills saved while a named item is active go into that item.
    onAddMeasurementProp: (row: TakeoffRow) => {
      if (row.parentId && row.parentId === magicItemIdRef.current && !row.isGroupHeader) { if (adoptRef.current([{ ...row, parentId: undefined }])) return; }
      onAddMeasurementProp?.(row);
    },
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

  const finishLatestRef = useRef<() => void>(() => {});
  const finishQueuedRef = useRef(false);
  finishLatestRef.current = () => finishMeasurement();

  // ── Finish + measurement name dialog ──────────────────────────────────────
  const handleFinishMeasurement = useCallback(() => {
    const minPts = activeTool === 'count' || activeTool === 'point' ? 1 : 2;
    if (tempPoints.length < minPts) { finishMeasurement(); return; }
    if (propAppendToGroupId) { finishMeasurement(); onAppendComplete?.(); return; }
    // Cut-out / split, or a named item is active: no name box. Finish on the
    // next frame, with the newest points — a double-click finishes in the same
    // instant as its last click, before that point has been stored.
    if (shapePendingRef.current || itemActiveRef.current) {
      if (finishQueuedRef.current) return;          // Enter can reach here twice for one press — finish once
      finishQueuedRef.current = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        finishLatestRef.current();
        setTimeout(() => { finishQueuedRef.current = false; }, 60);
      }));
      return;
    }
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

  // ── Centre anchor actions ─────────────────────────────────────────────────
  // Shapes created from the anchor are fed through the normal finish flow
  // (naming dialog, material, undo) by pushing the same points the tools use.
  const pendingFinishRef = useRef(false);
  useEffect(() => {
    if (!pendingFinishRef.current || tempPoints.length === 0) return;
    pendingFinishRef.current = false;
    handleFinishMeasurement();
  }, [tempPoints, handleFinishMeasurement]);

  // Anchors end with the tool, or when the circle in progress is finished/cleared.
  useEffect(() => { setAnchor(null); setArcStart(null); }, [activeTool, activeDrawingId, pageNumber]);
  useEffect(() => {
    if (anchor?.kind === 'circle' && tempPoints.length === 0 && !pendingFinishRef.current) setAnchor(null);
  }, [anchor, tempPoints.length]);

  const pickCentre = useCallback((g: CentreGroup) => {
    if (activeTool === 'radius') {
      setAnchor({ ...g, kind: 'circle' });
      pushPoint({ x: g.nx, y: g.ny, snapped: true });      // the centre — next click sets the radius
    } else if (activeTool === 'arc') {
      setAnchor({ ...g, kind: 'arc' });
      setArcStart(null);
    }
  }, [activeTool, pushPoint]);

  /** Push an arc (centre in page units, angles in radians) as the Arc tool's 3 points. */
  const pushArcFromCentre = useCallback((ax: number, ay: number, r: number, a0: number, sweep: number) => {
    if (!pdfDocDims) return;
    const P = (a: number) => ({ x: (ax + r * Math.cos(a)) / pdfDocDims.w, y: (ay + r * Math.sin(a)) / pdfDocDims.h, snapped: true });
    pushPoint(P(a0));
    pushPoint(P(a0 + sweep / 2));
    pushPoint(P(a0 + sweep));
    pushPoint({ ...ARC_SENTINEL });
    pendingFinishRef.current = true;
    setAnchor(null);
    setArcStart(null);
  }, [pushPoint, pdfDocDims]);

  // Own arc from a centre: follow the mouse round the centre (unwrapped), so
  // the arc can go past 180° — up to a full turn — in either direction.
  const arcSweepRef   = useRef(0);
  const arcLastAngRef = useRef<number | null>(null);
  const [arcSweep, setArcSweep] = useState(0);
  useEffect(() => {
    arcSweepRef.current = 0;
    setArcSweep(0);
    if (!arcStart || !anchor || !pdfDocDims) { arcLastAngRef.current = null; return; }
    const ax = anchor.nx * pdfDocDims.w, ay = anchor.ny * pdfDocDims.h;
    arcLastAngRef.current = Math.atan2(arcStart.y * pdfDocDims.h - ay, arcStart.x * pdfDocDims.w - ax);
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      const c = drawingCanvasRef.current;
      if (!c || arcLastAngRef.current === null) return;
      const rect = c.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * pdfDocDims.w;
      const py = ((e.clientY - rect.top) / rect.height) * pdfDocDims.h;
      if (Math.hypot(px - ax, py - ay) < 1) return;
      const a = Math.atan2(py - ay, px - ax);
      let d = a - arcLastAngRef.current;
      if (d > Math.PI) d -= 2 * Math.PI; else if (d <= -Math.PI) d += 2 * Math.PI;
      arcLastAngRef.current = a;
      const LIMIT = 2 * Math.PI - 0.002;
      arcSweepRef.current = Math.max(-LIMIT, Math.min(LIMIT, arcSweepRef.current + d));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setArcSweep(arcSweepRef.current));
    };
    el.addEventListener('pointermove', onMove);
    return () => { cancelAnimationFrame(raf); el.removeEventListener('pointermove', onMove); };
  }, [arcStart, anchor, pdfDocDims]);

  /** Arc tool with an anchored centre: handle the click ourselves. */
  const handleArcAnchorClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const a = anchorRef.current;
    if (!a || !pdfDocDims) return;
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const cy = (e.clientY - rect.top) * (canvas.height / rect.height);
    const k = canvasPerPageRef.current || 1;
    const ax = a.nx * pdfDocDims.w, ay = a.ny * pdfDocDims.h;

    if (!arcStart) {
      // Shift-click on a drawn arc: take the whole arc in one go.
      if (e.shiftKey) {
        const qx = cx / k, qy = cy / k;
        const d = Math.hypot(qx - ax, qy - ay), ang = Math.atan2(qy - ay, qx - ax);
        const hit = a.arcs.find(arc => Math.abs(d - arc.r) < 12 / k && angleInArc(ang, arc.start, arc.sweep));
        if (hit) { pushArcFromCentre(ax, ay, hit.r, hit.start, hit.sweep); return; }
      }
      // Start point: on a drawn arc / its end (snapped), or anywhere for your own radius.
      const s = snapToCanvas(cx, cy);
      const p = s?.point ?? { x: cx, y: cy };
      if (Math.hypot(p.x / k - ax, p.y / k - ay) < 1) return;   // too close to the centre
      setArcStart({ x: p.x / k / pdfDocDims.w, y: p.y / k / pdfDocDims.h });
      return;
    }
    // End point: on the same circle (snapToCanvas keeps it there, and snaps to
    // drawn arc ends). The sweep follows how the mouse went round the centre.
    const sx = arcStart.x * pdfDocDims.w, sy = arcStart.y * pdfDocDims.h;
    const r = Math.hypot(sx - ax, sy - ay);
    const a0 = Math.atan2(sy - ay, sx - ax);
    const endPt = snapToCanvas(cx, cy)?.point ?? { x: cx, y: cy };
    const a1 = Math.atan2(endPt.y / k - ay, endPt.x / k - ax);
    const sweep = alignSweep(arcSweepRef.current, a0, a1);
    if (Math.abs(sweep) < 0.01) return;
    pushArcFromCentre(ax, ay, r, a0, sweep);
  }, [arcStart, pdfDocDims, snapToCanvas, pushArcFromCentre]);

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
  const mfSessionUndo = activeTool === 'magic-fill' && (mfStagedCount > 0 || mfRedoCount > 0 || mfUndoCount > 0);
  const toolbarAPI = useMemo(() => ({
    tools: VIEWER_TOOLS as any,
    activeTool, setActiveTool: handleSetActiveTool, scale, setScale, scaleFactor,
    snapEnabled, setSnapEnabled, showSnapSettings, setShowSnapSettings,
    orthoEnabled, setOrthoEnabled,
    drawMode, setToolMode,
    showPins, setShowPins,
    snapThreshold, setSnapThreshold,
    confidenceFilter, setConfidenceFilter,
    analysisStatus: pdfStage === 'done' ? 'done' : pdfStage === 'error' ? 'done' : 'analyzing' as const,
    analysisPage:   null,
    currentPageCorners: resolvedSnapPoints.filter(p => p.type === 'endpoint').length,
    pdf, pageNumber,
    fitToScreen: () => fitToScreen(),
    handleManualScale,
    // While fills are waiting to be finished, the main Undo / Redo buttons
    // step through those fills.
    canUndo: mfSessionUndo ? mfUndoCount > 0 : canUndo,
    canRedo: mfSessionUndo ? mfRedoCount > 0 : canRedo,
    handleUndo: mfSessionUndo ? handleMagicUndo : handleUndo,
    handleRedo: mfSessionUndo ? handleMagicRedo : handleRedo,
    polyarcMode: safePolyarcMode, togglePolyarcMode,
    tempPointsCount: tempPoints.length,
    pageSizePt: pdfDimensions ? { w: pdfDimensions.w / (dimsScaleRef.current || 1), h: pdfDimensions.h / (dimsScaleRef.current || 1) } : null,
  }), [
    activeTool, handleSetActiveTool, scale, scaleFactor,
    snapEnabled, showSnapSettings, orthoEnabled, drawMode, setToolMode,
    showPins, setShowPins,
    snapThreshold, confidenceFilter,
    pdfStage, resolvedSnapPoints,
    pageNumber, pdf,
    fitToScreen, handleManualScale, canUndo, canRedo, handleUndo, handleRedo, mfSessionUndo, mfStagedCount, mfRedoCount, mfUndoCount, handleMagicUndo, handleMagicRedo,
    safePolyarcMode, togglePolyarcMode, tempPoints.length,
  , pdfDimensions]);

  useEffect(() => { onToolbarReady?.(toolbarAPI); }, [onToolbarReady, toolbarAPI]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Magic fill: Esc steps back one fill (or just drops the lasso in
        // progress) — it never throws the whole series away.
        if (activeTool === 'magic-fill' && lassoStore.get()) return;
        if (activeTool === 'magic-fill' && mfStagedCount > 0) { e.preventDefault(); handleMagicUndo(); return; }
        if (activeTool === 'perimeter-offset') { handleOffsetCancel(); return; }
      }
      if (activeTool === 'magic-fill' && !(e.target as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable]')) {
        const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
        if (mfUndoCount > 0 && ((mod && k === 'z' && !e.shiftKey) || (!mod && e.key === 'Backspace'))) { e.preventDefault(); handleMagicUndo(); return; }
        if (mfRedoCount > 0 && mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); handleMagicRedo(); return; }
      }
      if (e.key === 'Enter' && activeTool === 'perimeter-offset') return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target?.isContentEditable;
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
      // Enter finishes the shape in progress. (This used to live on the drawing
      // container, which can't take focus — so Enter never worked.)
      if (e.key === 'Enter' && !isTyping && !hasModifier && !showMeasurementDialog) {
        if (activeTool === 'magic-fill' && mfStagedCount > 0) { e.preventDefault(); finishMagicRef.current(); return; }
        if (tempPoints.length > 0) { e.preventDefault(); handleFinishMeasurement(); return; }
      }
      if (e.key === 'Escape' && !isTyping && anchorRef.current) {
        // Step back: own-arc start → anchor → nothing.
        if (arcStart) setArcStart(null);
        else { if (anchorRef.current.kind === 'circle') clearTempPoints(); setAnchor(null); }
        e.preventDefault(); return;
      }
      if (e.key === 'Escape' && !isTyping && tempPoints.length === 0 && activeTool !== 'select') {
        handleSetActiveTool('select' as ToolType); return;
      }
      if (!isTyping && !hasModifier) {
        // Single-key shortcuts — the user can change these (Shortcuts panel).
        const act = actionForKey(e.key);
        const plain = (tool: ToolType) => {             // a shortcut means the tool's plain form
          setDrawModeState(d => ({ ...DEFAULT_DRAW_MODE, sides: d.sides }));
          handleSetActiveTool(tool);
        };
        if (act === 'curve') { if (activeTool === 'polyarc') { e.preventDefault(); togglePolyarcMode(); } return; }
        // Mid-path, the Length key means "straight edges again" (A = curve, L = line).
        if (act === 'length' && activeTool === 'polyarc' && tempPoints.length > 0) {
          e.preventDefault(); if (safePolyarcMode === 'arc') togglePolyarcMode(); return;
        }
        if (act === 'swap') { e.preventDefault(); swapRef.current(); return; }
        if (act === 'close') {
          // Same as Enter: finish what is being drawn (nothing to finish → do nothing).
          if (showMeasurementDialog) return;
          if (activeTool === 'magic-fill' && mfStagedCount > 0) { e.preventDefault(); finishMagicRef.current(); }
          else if (tempPoints.length > 0) { e.preventDefault(); handleFinishMeasurement(); }
          return;
        }
        if (act) {
          switch (act) {
            case 'snap':      setSnapEnabled(!snapEnabled); break;
            case 'angle':     setOrthoEnabled(v => !v); break;
            case 'select':    plain('select' as ToolType); break;
            case 'area':      setToolMode('polyarc' as ToolType, { area: true }); break;
            case 'length':    setToolMode('polyarc' as ToolType); break;
            case 'rectangle': plain('rectangle' as ToolType); break;
            case 'circle':    setToolMode('radius' as ToolType, { area: true }); break;
            case 'ellipse':   setToolMode('rectangle' as ToolType, { area: true, ellipse: true }); break;
            case 'arc':       plain('arc' as ToolType); break;
            case 'count':     plain('count' as ToolType); break;
            case 'findCount': setToolMode('count' as ToolType, { auto: true }); break;
            case 'grid':      plain('grid-count' as ToolType); break;
            case 'marker':    plain('point' as ToolType); break;
            case 'magic':     plain('magic-fill' as ToolType); break;
            case 'scale':     plain('scale' as ToolType); break;
            case 'offset':    plain('perimeter-offset' as ToolType); break;
            default: return;                              // panels: handled by the page
          }
          e.preventDefault(); return;
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
    handleSetActiveTool, handleMagicAbortSession, handleOffsetCancel, handleMagicUndo, handleMagicRedo, mfRedoCount, mfUndoCount, lassoStore,
    setScale, togglePolyarcMode, tempPoints.length, snapEnabled, setSnapEnabled, setToolMode,
    arcStart, clearTempPoints, showMeasurementDialog, mfStagedCount, handleMagicFinish, handleFinishMeasurement,
  ]);

  // ── Selection ↔ table linking ─────────────────────────────────────────────
  // Repaint the selection outline when the selection changes (cheap: the
  // committed shapes come from the cached layer).
  useEffect(() => { redrawDrawingCanvas(); }, [selectedId, redrawDrawingCanvas, pinsVisible, snapEnabled]);

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
      if (!(pts.length >= 2 && hitTestMeasurement(nx, ny, pts, closed, radius))) return false;
      // Inside a cut-out is not inside the area (unless right on the cut-out's edge).
      for (const hole of m.holes ?? []) {
        if (hole.length >= 3 && hitTestMeasurement(nx, ny, hole, true, radius) && !hitTestMeasurement(nx, ny, hole, false, radius)) return false;
      }
      return true;
    });
  }, [measurements, scale, pdfDimensionsRef]);

  const handleCanvasClickWithSelect = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === 'select') {
      if (skipClickRef.current) { skipClickRef.current = false; return; }
      const r = e.currentTarget.getBoundingClientRect();
      const hit = findShapeAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      const id = hit ? (hit.parentId && !hit.points?.length ? hit.parentId : hit.id) : null;
      setShapeMenu(null);
      if ((e.shiftKey || e.ctrlKey || e.metaKey) && id) {
        // Add to / remove from the selection.
        if (!selectedId) setSelectedId(id);
        else if (id === selectedId) { setSelectedId(extraSelected[0] ?? null); setExtraSelected(extraSelected.slice(1)); }
        else setExtraSelected(extraSelected.includes(id) ? extraSelected.filter(x => x !== id) : [...extraSelected, id]);
        return;
      }
      setExtraSelected([]);
      setSelectedId(id);
      return;
    }
    if (activeTool === 'arc' && anchorRef.current?.kind === 'arc') { handleArcAnchorClick(e); return; }
    handleCanvasClick(e);
  }, [activeTool, findShapeAt, setSelectedId, handleCanvasClick, handleArcAnchorClick, selectedId, extraSelected]);

  // "Select all in the group" from the takeoff table.
  useEffect(() => {
    const onSelect = (e: Event) => {
      const here = new Set(measurements.map(m => m.id));
      const ids = (((e as CustomEvent).detail?.ids ?? []) as string[]).filter(id => here.has(id));
      if (!ids.length) return;
      if (tempPoints.length > 0) clearTempPoints();
      setActiveTool('select');
      setShapeMenu(null);
      setSelectedId(ids[0]);
      // After the tool switch has settled (it clears the extra selection).
      setTimeout(() => setExtraSelected(ids.slice(1)), 0);
    };
    window.addEventListener('foldrule:select-rows', onSelect);
    return () => window.removeEventListener('foldrule:select-rows', onSelect);
  }, [measurements, tempPoints.length, clearTempPoints, setActiveTool, setSelectedId]);

  // Right-click on a shape (Select tool) → what you can do with it.
  const handleContextMenuWithShapes = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool !== 'select') { handleContextMenu(e); return; }
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const at = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    const hit = findShapeAt(at.x, at.y);
    if (!hit) { setShapeMenu(null); return; }
    const id = hit.parentId && !hit.points?.length ? hit.parentId : hit.id;
    if (id !== selectedId && !extraSelected.includes(id)) { setExtraSelected([]); setSelectedId(id); }
    setShapeMenu({ x: e.clientX, y: e.clientY, at, tol: 9 / Math.max(0.25, scale) });
  }, [activeTool, handleContextMenu, findShapeAt, selectedId, extraSelected, setSelectedId, scale]);

  const shapeApi = useShapeActions({
    measurements, selectedId, setSelectedId, extraSelected, setExtraSelected,
    pageSizePt: pdfDocDims ?? null, scaleFactor, activeTool, tempPointCount: tempPoints.length,
    replaceMeasurements,
    startDrawing: kind => setToolMode('polyarc' as ToolType, { area: kind === 'area' }),
    backToSelect: () => { if (tempPoints.length > 0) clearTempPoints(); setActiveTool('select'); },
  });
  consumeDrawnRef.current = shapeApi.consumeDrawn;

  // ── Named item: everything drawn is added to it until it is changed ───────
  const itemApi = useActiveItem({
    measurements, activeDrawingId, replaceMeasurements,
    kind: shapeApi.pending ? null : kindOfTool(activeTool, drawMode),
  });
  adoptRef.current = itemApi.adopt;
  // "+" on a group in the takeoff: carry on adding to that group with the
  // normal tools (straight and curved edges, rectangle, magic fill…) — not the
  // old single-purpose line tool.
  useEffect(() => {
    if (!propAppendToGroupId) return;
    const header = ((projectState?.measurements ?? []) as TakeoffRow[]).find(m => m.isGroupHeader && (m.id === propAppendToGroupId || m.groupId === propAppendToGroupId));
    const k = header ? kindOfType(header.type) : null;
    if (!header || !k) return;                        // other kinds keep the old behaviour
    itemApi.useFor(k, header);
    if (k === 'count') setToolMode('count' as ToolType);
    else setToolMode('polyarc' as ToolType, { area: k === 'area' });
    onAppendComplete?.();                             // the named item does the grouping from here on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propAppendToGroupId]);
  itemActiveRef.current = !!itemApi.item;
  magicItemIdRef.current = activeTool === 'magic-fill' && itemApi.item ? itemApi.item.id : null;
  /** Finish the staged magic fills: straight into the named item, or ask for a name. */
  const finishMagic = () => {
    if (activeTool === 'magic-fill' && itemApi.item) handleMfNameConfirm(itemApi.item.name);
    else handleMagicFinish();
  };
  const finishMagicRef = useRef(finishMagic); finishMagicRef.current = finishMagic;
  // Nothing can be measured until the item is named (or naming is skipped on purpose).
  const [nameNudge, setNameNudge] = useState(0);
  useEffect(() => { if (!itemApi.needsName) setNameNudge(0); }, [itemApi.needsName]);

  // ── Space: swap between Select and the tool you were using ───────────────
  // A quick tap swaps; holding Space and dragging still pans. A shape that is
  // half drawn is put aside, and comes back when you return to the tool.
  const lastToolRef = useRef<{ tool: ToolType; mode: DrawMode } | null>(null);
  const parkedRef = useRef<{ tool: ToolType; mode: DrawMode; points: typeof tempPoints } | null>(null);
  const [parked, setParked] = useState(0);
  if (activeTool !== 'select') lastToolRef.current = { tool: activeTool as ToolType, mode: drawMode };
  // Leaving a measuring tool with Esc (or by picking Select) means "done with
  // this item": the next time the tool is picked it asks what is being measured,
  // with the item just used offered first. Space is only a pause, so it keeps the item.
  const swapLeaveRef = useRef(false);
  const borrowedToolRef = useRef(false);
  if (shapeApi.pending) borrowedToolRef.current = true;
  const prevToolKindRef = useRef<ReturnType<typeof kindOfTool>>(null);
  useEffect(() => {
    const prev = prevToolKindRef.current;
    prevToolKindRef.current = kindOfTool(activeTool, drawMode);
    if (activeTool !== 'select') { swapLeaveRef.current = false; return; }
    // (A cut-out or split borrows a drawing tool for a moment — that is not leaving the item.)
    if (prev && !swapLeaveRef.current && !parkedRef.current && !borrowedToolRef.current) itemApi.forget(prev);
    swapLeaveRef.current = false; borrowedToolRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool]);
  const swapRef = useRef<() => void>(() => {});
  swapRef.current = () => {
    if (shapeApi.pending || showMeasurementDialog) return;
    if (activeTool !== 'select' && parkedRef.current && tempPoints.length === 0) {
      // A shape is waiting and nothing is half-drawn here → straight back to it, in one press.
      const { tool, mode } = parkedRef.current;
      setDrawModeState(mode);
      Object.assign(drawModeState, mode);
      setActiveTool(tool);
      return;
    }
    if (activeTool !== 'select') {
      swapLeaveRef.current = true;                 // a pause, not "I'm done with this item"
      // Park the half-drawn shape — unless one is already parked (then this one is a side job: let it go).
      if (tempPoints.length > 0) {
        if (!parkedRef.current) { parkedRef.current = { tool: activeTool as ToolType, mode: drawMode, points: tempPoints }; setParked(tempPoints.length); }
        clearTempPoints();
      }
      setActiveTool('select');
    } else if (parkedRef.current || lastToolRef.current) {
      // A paused shape comes first: Space takes you back to it, even if you used another tool meanwhile.
      const { tool, mode } = parkedRef.current ?? lastToolRef.current!;
      setDrawModeState(mode);
      Object.assign(drawModeState, mode);
      setActiveTool(tool);
    }
  };
  // Back on the tool → the half-drawn shape returns.
  useEffect(() => {
    const p = parkedRef.current;
    if (!p) return;
    // Same tool in the same mode (a Length path is not an Area path) → the shape returns.
    // Any other tool leaves it parked, so you can draw or fix something else first.
    if (activeTool === p.tool && !!drawMode.area === !!p.mode.area && !!drawMode.ellipse === !!p.mode.ellipse && !!drawMode.auto === !!p.mode.auto) {
      const t = setTimeout(() => { retagTempPoints(() => p.points); parkedRef.current = null; setParked(0); }, 0);
      return () => clearTimeout(t);
    }
  }, [activeTool, drawMode, retagTempPoints]);
  // A new drawing or page: the paused shape no longer belongs here.
  useEffect(() => { parkedRef.current = null; setParked(0); }, [activeDrawingId, pageNumber]);
  useEffect(() => {
    let downAt = 0, used = false;
    const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable],button');
    const kd = (e: KeyboardEvent) => { if (e.code === 'Space' && !e.repeat && !typing(e.target)) { downAt = Date.now(); used = false; } };
    const pd = () => { used = true; };                 // Space + drag / click = pan or lasso, not a swap
    const ku = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !downAt) return;
      const quick = Date.now() - downAt < 350;
      downAt = 0;
      if (quick && !used && !typing(e.target)) swapRef.current();
    };
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku); window.addEventListener('pointerdown', pd, true);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('pointerdown', pd, true); };
  }, []);

  // Drag a selected shape to move it (corners are still dragged on their own).
  const moveRef = useRef<{ sx: number; sy: number; moved: boolean; pointerId: number } | null>(null);
  const [moveDelta, setMoveDelta] = useState<{ dx: number; dy: number } | null>(null);
  const skipClickRef = useRef(false);
  const shapePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>): boolean => {
    if (activeTool !== 'select' || e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || spaceHeld) return false;
    if (!shapeApi.movable.length) return false;
    const r = e.currentTarget.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
    const hit = findShapeAt(nx, ny);
    if (!hit || !shapeApi.movable.some(m => m.id === hit.id)) return false;
    e.preventDefault(); e.stopPropagation();          // not a pan
    e.currentTarget.setPointerCapture(e.pointerId);
    moveRef.current = { sx: nx, sy: ny, moved: false, pointerId: e.pointerId };
    return true;
  }, [activeTool, spaceHeld, shapeApi.movable, findShapeAt]);
  const shapePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>): boolean => {
    const mv = moveRef.current;
    if (!mv) return false;
    const r = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - mv.sx, dy = (e.clientY - r.top) / r.height - mv.sy;
    if (!mv.moved && Math.hypot(dx * r.width, dy * r.height) < 4) return true;
    mv.moved = true;
    setMoveDelta({ dx, dy });
    return true;
  }, []);
  const shapePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>): boolean => {
    const mv = moveRef.current;
    if (!mv) return false;
    moveRef.current = null;
    try { e.currentTarget.releasePointerCapture(mv.pointerId); } catch { /* already released */ }
    if (mv.moved) {
      const r = e.currentTarget.getBoundingClientRect();
      shapeApi.moveBy((e.clientX - r.left) / r.width - mv.sx, (e.clientY - r.top) / r.height - mv.sy);
      skipClickRef.current = true;                       // the click that follows a drag isn't a selection
      setTimeout(() => { skipClickRef.current = false; }, 0);
    }
    setMoveDelta(null);
    return true;
  }, [shapeApi]);
  shapePendingRef.current = !!shapeApi.pending;
  // The extra selection only makes sense with the Select tool, on this page.
  useEffect(() => { if (activeTool !== 'select') { setExtraSelected([]); setShapeMenu(null); } }, [activeTool]);
  useEffect(() => { setExtraSelected([]); setShapeMenu(null); }, [activeDrawingId, pageNumber]);
  useEffect(() => { if (!selectedId) setExtraSelected([]); }, [selectedId]);
  useEffect(() => { redrawDrawingCanvas(); }, [extraSelected, redrawDrawingCanvas]);

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
        <ActiveItemBar api={itemApi} hidden={!pdf} nudge={nameNudge} onLeave={() => setActiveTool('select')} />
        {parked > 0 && !(tempPoints.length > 0 && parkedRef.current === null) && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[72] bg-zinc-900 border border-amber-400/70 text-amber-200 text-xs px-3 py-1.5 shadow-xl pointer-events-none">
            Shape paused ({parked} point{parked === 1 ? '' : 's'}) — {activeTool === 'select' ? 'press Space to carry on drawing' : 'finish here, then press Space to carry on with it'}
            <button className="ml-3 underline text-amber-300/80 pointer-events-auto" onClick={() => { parkedRef.current = null; setParked(0); }}>discard</button>
          </div>
        )}
        <ShapeActions api={shapeApi} visible={activeTool === 'select'} menu={shapeMenu} onCloseMenu={() => setShapeMenu(null)} hasShapes={measurements.some(m => !m.isGroupHeader && (m.points?.length ?? 0) > 0)} />
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
              if (activeTool === 'magic-fill' && (mfStagedCount > 0 || lassoStore.get())) {
                /* handled by the window shortcut: step back one fill */
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
                finishMagicRef.current();
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
              handleContextMenu={handleContextMenuWithShapes}
              settling={zoomSettling}
              handleCanvasPointerMove={isOffsetTool ? handleOffsetCanvasPointerMove : (e => { if (!shapePointerMove(e)) wrappedPointerMove(e); })}
              handleCanvasPointerDown={(e => ((handleCanvasPointerDown(e) as unknown as boolean) || shapePointerDown(e))) as (e: React.PointerEvent<HTMLCanvasElement>) => boolean | undefined}
              handleCanvasPointerUp={e => { if (!shapePointerUp(e)) handleCanvasPointerUp(e); }}
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
                onSingleClick={(x, y, subtract) => (subtract ? handleMagicSubtractClick(x, y) : handleMagicSingleClick(x, y))}
                onPolygonLasso={handleMagicPolygonFill}
                onLassoChange={lassoStore.set}
                onHover={handleMagicHover}
                onHoverLeave={handleMagicHoverLeave}
              />

              {isMagicFillTool &&
                mfStagedCount > 0 &&
                !mfIsFilling &&
                !mfIsRepainting &&
                !propAppendToGroupId &&
                mfLastFillPos && (
                  <div
                    className="absolute z-[70] flex items-stretch gap-1"
                    style={{ left: mfLastFillPos.x + 15, top: mfLastFillPos.y + 15 }}
                    onPointerDown={e => e.stopPropagation()}
                  >
                  <button
                    className="flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[11px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                    onClick={e => { e.stopPropagation(); finishMagicRef.current(); }}
                    onPointerDown={e => e.stopPropagation()}
                  >
                    <Check className="w-3 h-3" />
                    Finish ({mfStagedCount} fill{mfStagedCount !== 1 ? 's' : ''})
                  </button>
                    <button
                      title="Undo the last fill (Ctrl+Z)"
                      className="flex items-center gap-1 bg-zinc-900 text-zinc-100 border border-zinc-600 font-mono text-[11px] uppercase tracking-widest px-2.5 py-1.5 shadow-lg whitespace-nowrap hover:bg-zinc-800 active:scale-95 transition-transform"
                      onClick={e => { e.stopPropagation(); handleMagicUndo(); }}
                    >
                      <Undo2 className="w-3 h-3" /> Undo
                    </button>
                  </div>
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

              {activeTool === 'magic-fill' && mfRooms && pdfDimensions && pdfDocDims && (
                <RoomHoverOverlay
                  rooms={mfRooms}
                  pdfDimensions={pdfDimensions}
                  pageWidthPt={pdfDocDims.w}
                  scaleFactor={scaleFactor}
                  calibrated={isPageCalibrated}
                  lassoStore={lassoStore}
                />
              )}

              {(activeTool === 'radius' || activeTool === 'arc') && pdfDimensions &&
                (anchor || (activeTool === 'radius' ? pdfCircles.length : pdfArcs.length) > 0) && (
                <CentreAnchorOverlay
                  mode={activeTool === 'radius' ? 'circle' : 'arc'}
                  circles={pdfCircles}
                  arcs={pdfArcs}
                  pdfDimensions={pdfDimensions}
                  scaleFactor={scaleFactor}
                  calibrated={isPageCalibrated}
                  anchor={anchor}
                  arcStart={arcStart}
                  arcSweep={arcSweep}
                  showMarkers={tempPoints.length === 0}
                  onPickCentre={pickCentre}
                  pxPerPoint={canvasPerPageRef.current}
                />
              )}
              {itemApi.needsName && pdf && (
                <div
                  className="absolute inset-0 z-[69] cursor-not-allowed"
                  style={{ pointerEvents: spaceHeld ? 'none' : 'auto' }}       /* Space + drag still pans */
                  title="Name what you are measuring first"
                  onPointerDown={e => { e.preventDefault(); e.stopPropagation(); setNameNudge(n => n + 1); }}
                  onMouseDown={e => e.preventDefault()}                          /* keep the typing cursor in the name box */
                  onClick={e => e.stopPropagation()}
                  onContextMenu={e => e.preventDefault()}
                />
              )}
              {moveDelta && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none z-[65]" viewBox="0 0 1 1" preserveAspectRatio="none">
                  {shapeApi.movable.map(m => {
                    const pts = tessellatePoints(getEffectivePoints(m, measurements), pdfDimensions?.w ?? 1, pdfDimensions?.h ?? 1)
                      .map(q => `${q.x + moveDelta.dx},${q.y + moveDelta.dy}`).join(' ');
                    const closed = m.type === 'Polygon' || m.type === 'Rectangle' || m.type === 'Area';
                    const common = { points: pts, fill: closed ? 'rgba(242,194,48,0.18)' : 'none', stroke: '#F2C230', strokeWidth: 2, strokeDasharray: '6 4', vectorEffect: 'non-scaling-stroke' as const };
                    return closed ? <polygon key={m.id} {...common} /> : <polyline key={m.id} {...common} />;
                  })}
                </svg>
              )}
              {activeTool === 'count' && drawMode.auto && pdfDimensions && (
                <AutoCount
                  pageRef={currentPdfPageRef}
                  pageKey={`${activeDrawingId}:${pageNumber}`}
                  spaceHeld={spaceHeld}
                  areas={measurements
                    .filter(m => !m.isGroupHeader && (m.type === 'Polygon' || m.type === 'Rectangle' || m.type === 'Area') && (m.points?.length ?? 0) >= 3)
                    .map(m => ({
                      id: m.id, name: m.label || m.description || 'Area',
                      outer: tessellatePoints(getEffectivePoints(m, measurements), pdfDimensions.w, pdfDimensions.h),
                      holes: m.holes ?? [],
                    }))}
                  onClose={() => setActiveTool('select')}
                  onCommit={(pts, name) => {
                    if (itemApi.item) {
                      // A named count item is active → the matches go into it.
                      itemApi.adopt(pts.map(p => ({
                        id: crypto.randomUUID(), drawingId: activeDrawingId || '', description: '', label: '',
                        type: 'Count', quantity: 1, unit: 'EA', unitRate: 0, notes: 'Found automatically', points: [{ x: p.x, y: p.y }],
                        isOverridden: false, color: itemApi.item!.color, isVisible: true, childIds: [],
                      } as TakeoffRow)));
                      return;
                    }
                    const groupId = crypto.randomUUID();
                    const color = getNextMeasurementColor();
                    const kids = pts.map((p, i) => ({
                      id: crypto.randomUUID(), drawingId: activeDrawingId || '',
                      description: `${name} ${i + 1}`, label: name,
                      type: 'Count', quantity: 1, unit: 'EA', unitRate: 0, notes: '',
                      points: [{ x: p.x, y: p.y }],
                      isOverridden: false, color, isVisible: true, parentId: groupId, childIds: [],
                    } as TakeoffRow));
                    batchCommitMeasurements([{
                      id: groupId, drawingId: activeDrawingId || '',
                      description: name, label: name, type: 'Count',
                      quantity: pts.length, unit: 'EA', unitRate: 0, notes: 'Found automatically — checked by eye', points: [],
                      isOverridden: false, color, isVisible: true, isGroupHeader: true, childIds: kids.map(k => k.id),
                    } as TakeoffRow, ...kids]);
                  }}
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
        <div className="h-10 flex-shrink-0 bg-industrial-panel border-t border-industrial-border px-3 flex items-center justify-between gap-4 z-20 font-mono relative shadow-sm">
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setPageNumber(Math.max(1, pageNumber - 1))}
              disabled={pageNumber <= 1}
              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-tighter whitespace-nowrap tabular-nums" title={`Page ${pageNumber} of ${pdf.numPages}`}>
              {pageNumber} / {pdf.numPages}
            </span>
            <button
              onClick={() => setPageNumber(Math.min(pdf.numPages, pageNumber + 1))}
              disabled={pageNumber >= pdf.numPages}
              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <span className="w-px h-4 bg-industrial-border" aria-hidden />
            <ViewerStatusControls
              snapEnabled={snapEnabled}   setSnapEnabled={setSnapEnabled}
              orthoEnabled={orthoEnabled} setOrthoEnabled={setOrthoEnabled}
              showPins={showPins}         setShowPins={setShowPins}
              showLabels={showLabels}     setShowLabels={setShowLabels}
              showGeometry={showGeometry} setShowGeometry={setShowGeometry}
              scale={scale}
              zoomIn={() => setScale(s => Math.min(MAX_ZOOM, s + ZOOM_SENSITIVITY))}
              zoomOut={() => setScale(s => Math.max(MIN_ZOOM, s - ZOOM_SENSITIVITY))}
              fitToScreen={() => fitToScreen()}
            />
          </div>

          <div className="hidden md:flex flex-1 min-w-0 items-center justify-end gap-3 text-[10px] text-zinc-500 uppercase tracking-widest whitespace-nowrap [&>span]:min-w-0 [&>span]:truncate [&>button]:shrink-0">
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
                {mfRoomCount > 0 && (
                  <button
                    onClick={handleMagicFillAll}
                    title="Fill every room found on this page. Alt-click the ones you don't want, then Finish."
                    className="border border-amber-400/60 text-amber-300 hover:bg-amber-400 hover:text-black px-2 py-0.5 font-mono font-bold"
                  >
                    Fill all {mfRoomCount} rooms
                  </button>
                )}
                <div className="w-px h-3 bg-industrial-border" />
                {mfStagedCount > 0
                  ? <span className="text-amber-400">Enter to finish · Ctrl+Z or Esc to undo the last fill</span>
                  : <span>Click a room to fill it · Alt-click takes a room back out · Space + clicks fills several together</span>
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
                {drawMode.area ? 'Area' : 'Length'} path
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
              className="w-4 h-4 inline-flex items-center justify-center border border-zinc-700 text-[10px] text-zinc-500 hover:text-zinc-200 hover:border-zinc-500"
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
          className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 border border-amber-400/60 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200 backdrop-blur"
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
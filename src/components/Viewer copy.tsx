'use client';

// ─── components/Viewer/Viewer.tsx ─────────────────────────────────────────────

import React, {
  useRef, useEffect, useState, useCallback, useMemo,
} from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import { ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType, TakeoffRow } from '@/types';
import type { PdfDimensions } from '@/types/viewerTypes';

import { Minimap }           from './Minimap';
import { SnapSettingsPanel } from './SnapSettingsPanel';
import { useSnapEngine }     from '@/hooks/useSnapEngine';
import { useMeasurements }   from '@/hooks/useMeasurements';
import { useTakeoffContext }  from '@/context/TakeoffContext';

import { ViewerToolbar }  from './Viewer/ViewerToolbar';
import { ViewerCanvas }   from './Viewer/ViewerCanvas';
import {
  CalibrationDialog, AppendGroupBanner,
  SnapCandidateWired, MeasurementDetailsWired, PresetDrawerWired,
} from './Viewer/ViewerDialogs';
import {
  CANVAS_PADDING, ZOOM_SENSITIVITY, MIN_ZOOM, MAX_ZOOM, VIEWER_TOOLS,
} from './Viewer/ViewerConstants';

// ── Magic Fill imports ────────────────────────────────────────────────────────
import { useMagicFill }    from '@/hooks/useMagicFill';
import type { MagicFill }  from '@/hooks/useMagicFill';
import {
  MagicFillCanvas,
  getNextFillColor,
  resetFillColorIdx,
} from '@/components/Viewer/MagicFillCanvas';
import {
  MagicFillProgressOverlay,
  MagicFillHoverTooltip,
  MagicFillGroupPanel,
  MagicFillSelectedPanel,
  fmtArea,
  fmtPerim,
} from '@/components/Viewer/MagicFillUI';

export type { ViewerProps, ViewerToolbarAPI } from './Viewer/ViewerConstants';

export function Viewer({
  activeTool, setActiveTool,
  measurements,
  onAddMeasurement: onAddMeasurementProp,
  onUpdateMeasurement: onUpdateMeasurementProp,
  onDeleteMeasurement: onDeleteMeasurementProp,
  scaleFactor, onScaleSet, activeDrawing, onDrawingAdded,
  showPresetDrawer, onClosePresetDrawer, onSelectPreset,
  hideToolbar = false,
  appendToGroupId: propAppendToGroupId,
  onAppendComplete,
  onToolbarReady,
}: import('./Viewer/ViewerConstants').ViewerProps) {

  // ── Canvas refs ────────────────────────────────────────────────────────────
  const pdfCanvasRef     = useRef<HTMLCanvasElement>(null);
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null);
  const pinCanvasRef     = useRef<HTMLCanvasElement>(null);
  const vectorCanvasRef  = useRef<HTMLCanvasElement>(null);
  const fillCanvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef     = useRef<HTMLDivElement>(null);
  const currentPdfPageRef = useRef<PDFPageProxy | null>(null);

  // ── Magic Fill hook ────────────────────────────────────────────────────────
  const magicFill = useMagicFill();

  const yieldFrame = useCallback(
    () => new Promise<void>(r => requestAnimationFrame(() => r())),
    [],
  );

  // ── Magic Fill committed state ─────────────────────────────────────────────
  const [magicFills,         setMagicFills]         = useState<MagicFill[]>([]);
  const [mfHiddenIds,        setMfHiddenIds]        = useState<Set<number>>(new Set());
  const [mfSelectedId,       setMfSelectedId]       = useState<number | null>(null);
  const [mfSelectedGroup,    setMfSelectedGroup]    = useState<number | null>(null);
  const [mfHoveredId,        setMfHoveredId]        = useState<number | null>(null);
  const [mfHoverPos,         setMfHoverPos]         = useState({ x: 0, y: 0 });
  const [mfHolesClosed,      setMfHolesClosed]      = useState<Set<number>>(new Set());
  const [mfIsFilling,        setMfIsFilling]        = useState(false);
  const [mfFillMsg,          setMfFillMsg]          = useState('');
  const [mfFillSub,          setMfFillSub]          = useState<string | undefined>(undefined);
  const [mfFillProgress,     setMfFillProgress]     = useState<{ done: number; total: number } | null>(null);
  const [mfMetersPerPixel,   setMfMetersPerPixel]   = useState<number | null>(null);

  // ── NEW: separate flag for background repaint (visibility / color changes) ─
  const [mfIsRepainting,     setMfIsRepainting]     = useState(false);

  // ── Magic Fill session state ───────────────────────────────────────────────
  const mfStagedFills        = useRef<MagicFill[]>([]);
  const mfSessionColor       = useRef<string | null>(null);
  const mfSessionHasSnapshot = useRef(false);
  const [mfStagedCount,      setMfStagedCount]      = useState(0);

  const [mfLastFillPos, setMfLastFillPos] = useState<{ x: number; y: number } | null>(null);

  const mfGroupCounter = useRef(0);
  const mfFillCounter  = useRef(0);

  const mfIdToRowId    = useRef<Record<number, string>>({});
  const mfFillOrigins  = useRef<Record<number, { x: number; y: number; color: string; label: string }>>({});

  useEffect(() => {
    setMfMetersPerPixel(scaleFactor > 0 ? scaleFactor : null);
  }, [scaleFactor]);

  const magicFillsRef = useRef<MagicFill[]>([]);
  useEffect(() => { magicFillsRef.current = magicFills; }, [magicFills]);

  // ── Dialog state for Magic Fill name prompt ────────────────────────────────
  const [showMfNameDialog,   setShowMfNameDialog]   = useState(false);
  const mfPendingCommitRef   = useRef<MagicFill[] | null>(null);

  // ── Core state ─────────────────────────────────────────────────────────────
  const [pdf, setPdf]               = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [loading, setLoading]       = useState(false);
  const [isPanning, setIsPanning]   = useState(false);
  const [spaceHeld, setSpaceHeld]   = useState(false);
  const spaceHeldRef                = useRef(false);

  const [scale, setScale]                   = useState(1.5);
  const [committedScale, setCommittedScale] = useState(1.5);
  const readyToDrawRef = useRef(false);

  useEffect(() => {
    readyToDrawRef.current = false;
    const t = setTimeout(() => setCommittedScale(scale), 150);
    return () => clearTimeout(t);
  }, [scale]);

  // ── Dimensions ─────────────────────────────────────────────────────────────
  const [pdfDimensions, setPdfDimensions] = useState<PdfDimensions | null>(null);
  const [pdfRenderCount, setPdfRenderCount] = useState(0);

  // ── Stable refs ────────────────────────────────────────────────────────────
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

  const activeDrawingId      = activeDrawing?.id     ?? null;
  const activeDrawingUrl     = activeDrawing?.fileUrl ?? null;
  const activeDrawingFileRef = useRef<File | undefined>(activeDrawing?.file);
  useEffect(() => { activeDrawingFileRef.current = activeDrawing?.file; }, [activeDrawing?.file]);

  const startExtractionRef = useRef<((...args: any[]) => void) | null>(null);

  // ── Settings ───────────────────────────────────────────────────────────────
  const [snapEnabled,      setSnapEnabled]      = useState(true);
  const [showPins,         setShowPins]         = useState(true);
  const [snapThreshold,    setSnapThreshold]    = useState(14);
  const [confidenceFilter, setConfidenceFilter] = useState(0.1);
  const [showSnapSettings, setShowSnapSettings] = useState(false);

  // ── Dialog state ───────────────────────────────────────────────────────────
  const [showCalibrationDialog,  setShowCalibrationDialog]  = useState(false);
  const [pendingPtLen,           setPendingPtLen]           = useState(0);
  const [calibrationInput,       setCalibrationInput]       = useState('');
  const [showMeasurementDialog,  setShowMeasurementDialog]  = useState(false);
  const [pendingMeasurementData, setPendingMeasurementData] = useState<
    { id: string; type: string; description: string } | null>(null);

  const onUpdateMeasurement = useCallback(
    (id: string, updates: Partial<TakeoffRow>) => onUpdateMeasurementProp?.(id, updates),
    [onUpdateMeasurementProp],
  );

  // ── Context ────────────────────────────────────────────────────────────────
  const {
    tempPoints, pushPoint, commitMeasurement, batchCommitMeasurements,
    clearTempPoints, undo, redo, canUndo, canRedo,
  } = useTakeoffContext();

  const undoRedoRef = useRef<{ setCursorPoint: (p: any) => void }>({ setCursorPoint: () => {} });
  const handleUndo  = useCallback(() => { undo();  undoRedoRef.current.setCursorPoint(null); }, [undo]);
  const handleRedo  = useCallback(() => { redo();  undoRedoRef.current.setCursorPoint(null); }, [redo]);

  // ── Snap engine ────────────────────────────────────────────────────────────
  const {
    pageData, analysisStatus, analysisPage, snapFlashes,
    startExtraction, getScaledCorners,
    snapToCorner, triggerSnapFlash, redrawPinCanvas, cursorPointRef,
  } = useSnapEngine({
    pinCanvasRef:     pinCanvasRef     as React.RefObject<HTMLCanvasElement>,
    pdfDimensionsRef: pdfDimensionsRef as React.RefObject<PdfDimensions>,
    pageNumberRef:    pageNumberRef    as React.RefObject<number>,
    snapEnabled, showPins, snapThreshold, confidenceFilter,
  });

  useEffect(() => { startExtractionRef.current = startExtraction; }, [startExtraction]);

  const setActiveToolString = useCallback(
    (t: string) => setActiveTool(t as ToolType),
    [setActiveTool],
  );

  // ── Calibration ────────────────────────────────────────────────────────────
  const handleScalePrompt = useCallback((ptLen: number) => {
    setPendingPtLen(ptLen); setCalibrationInput(''); setShowCalibrationDialog(true);
  }, []);

  const handleCalibrationConfirm = useCallback(() => {
    const r = parseFloat(calibrationInput);
    if (!isNaN(r) && r > 0 && pendingPtLen > 0) onScaleSetRef.current(r / pendingPtLen);
    setShowCalibrationDialog(false);
  }, [calibrationInput, pendingPtLen]);

  // ── Measurements engine ────────────────────────────────────────────────────
  const {
    pendingSnapCandidates, setPendingSnapCandidates,
    finishMeasurement, handleCanvasClick, handleContextMenu,
    handleCanvasPointerMove, handleCanvasPointerDown,
    handleCanvasPointerUp, toCanvas, setCursorPoint,
  } = useMeasurements({
    drawingCanvasRef: drawingCanvasRef as React.RefObject<HTMLCanvasElement>,
    pdfDimensionsRef: pdfDimensionsRef as React.RefObject<PdfDimensions>,
    pageNumberRef:    pageNumberRef    as React.RefObject<number>,
    scaleRef:         scaleRef        as React.RefObject<number>,
    activeTool, setActiveTool: setActiveToolString,
    measurements, tempPoints, pushPoint,
    commitMeasurement, batchCommitMeasurements,
    appendToGroupId: propAppendToGroupId, onAppendComplete,
    onScalePrompt: handleScalePrompt,
    clearTempPoints, scaleFactor, onUpdateMeasurement,
    isPanning, snapToCorner, getScaledCorners,
    triggerSnapFlash, snapEnabled, snapThreshold,
    redrawPinCanvas, cursorPointRef, activeDrawingId,
  });

  useEffect(() => { undoRedoRef.current.setCursorPoint = setCursorPoint; }, [setCursorPoint]);

  // ── Magic Fill: rebuild mask when PDF renders ──────────────────────────────
  useEffect(() => {
    const canvas = pdfCanvasRef.current;
    if (!canvas || !pdfDimensions) return;
    magicFill.buildMask(canvas);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfRenderCount, pdfDimensions]);

  // ── Magic Fill: full reset when drawing changes ────────────────────────────
  useEffect(() => {
    const fc = fillCanvasRef.current;
    if (!fc) return;
    magicFill.clearAll(fc);
    setMagicFills([]);
    setMfHiddenIds(new Set());
    setMfSelectedId(null);
    setMfSelectedGroup(null);
    setMfHoveredId(null);
    setMfHolesClosed(new Set());
    mfFillCounter.current      = 0;
    mfGroupCounter.current     = 0;
    mfIdToRowId.current        = {};
    mfFillOrigins.current      = {};
    mfStagedFills.current      = [];
    mfSessionColor.current     = null;
    mfSessionHasSnapshot.current = false;
    setMfStagedCount(0);
    setMfLastFillPos(null);
    resetFillColorIdx();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDrawingId]);

  // ── Magic Fill: abort current session ─────────────────────────────────────
  const handleMagicAbortSession = useCallback(() => {
    const fc = fillCanvasRef.current;
    if (mfStagedFills.current.length === 0) return;

    mfStagedFills.current.forEach(f => magicFill.unregisterFill(f.id));

    if (mfSessionHasSnapshot.current && fc) {
      magicFill.undo(fc);
    }

    mfStagedFills.current        = [];
    mfSessionColor.current       = null;
    mfSessionHasSnapshot.current = false;
    setMfStagedCount(0);
    setMfLastFillPos(null);
    setMfSelectedId(null);
    setMfSelectedGroup(null);
  }, [magicFill]);

  // ── Magic Fill: abort session on tool switch ───────────────────────────────
  const prevToolRef = useRef(activeTool);
  useEffect(() => {
    const prev = prevToolRef.current;
    prevToolRef.current = activeTool;
    if (prev === 'magic-fill' && activeTool !== 'magic-fill') {
      handleMagicAbortSession();
    }
  }, [activeTool, handleMagicAbortSession]);

  // ── Magic Fill: convert fill → TakeoffRow ─────────────────────────────────
  const magicFillToRow = useCallback((
    fill: MagicFill,
    opts: { drawingId: string; parentId?: string; groupId?: string; id?: string },
  ): TakeoffRow => {
    const qty = mfMetersPerPixel
      ? +(fill.areaPx * mfMetersPerPixel * mfMetersPerPixel).toFixed(4)
      : fill.areaPx;
    const unit = mfMetersPerPixel ? 'm²' : 'px²';
    const perimStr = mfMetersPerPixel
      ? `${(fill.perimPx * mfMetersPerPixel).toFixed(2)}m perimeter`
      : `${fill.perimPx.toLocaleString()}px perimeter`;

    return {
      id:           opts.id ?? `mf-${fill.id}-${Date.now()}`,
      drawingId:    opts.drawingId,
      label:        fill.label,
      description:  fill.label,
      type:         'Area',
      quantity:     qty,
      unit,
      unitRate:     0,
      notes:        `Magic Fill · ${fill.polygon.length} boundary pts · ${perimStr} · ${fill.areaPx.toLocaleString()}px²`,
      points:       [],
      isOverridden: true,
      childIds:     [],
      color:        fill.color,
      isVisible:    true,
      icon:         '⊕',
      parentId:     opts.parentId,
      groupId:      opts.groupId,
    } as TakeoffRow;
  }, [mfMetersPerPixel]);

  // ── Magic Fill: sync quantities when scale changes ─────────────────────────
  useEffect(() => {
    if (!mfMetersPerPixel || magicFillsRef.current.length === 0) return;
    magicFillsRef.current.forEach(f => {
      const rowId = mfIdToRowId.current[f.id];
      if (!rowId) return;
      const qty = +(f.areaPx * mfMetersPerPixel * mfMetersPerPixel).toFixed(4);
      const perimStr = `${(f.perimPx * mfMetersPerPixel).toFixed(2)}m perimeter`;
      onUpdateMeasurementProp?.(rowId, {
        quantity: qty,
        unit:     'm²',
        notes:    `Magic Fill · ${f.polygon.length} boundary pts · ${perimStr} · ${f.areaPx.toLocaleString()}px²`,
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mfMetersPerPixel]);

  // ── Hidden-ids ref (always fresh for the sync effect) ─────────────────────
  const mfHiddenIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => { mfHiddenIdsRef.current = mfHiddenIds; }, [mfHiddenIds]);

  // ── Magic Fill: unified sync — deletion + visibility + color ──────────────
  //
  //  Shows the loading overlay immediately so the browser paint isn't blocked,
  //  then re-floods visible fills one per animation frame to stay responsive.
  //
  useEffect(() => {
    if (magicFillsRef.current.length === 0) return;

    const currentRowIds = new Set(measurements.map(m => m.id));
    const rowById       = new Map(measurements.map(m => [m.id, m]));

    const hiddenGroupIds = new Set<string>();
    measurements.forEach(m => {
      if (m.isGroupHeader && m.isVisible === false && m.groupId) {
        hiddenGroupIds.add(m.groupId);
      }
    });

    // 1. Deleted fills
    const deletedFillIds: number[] = [];
    Object.entries(mfIdToRowId.current).forEach(([fillIdStr, rowId]) => {
      if (!currentRowIds.has(rowId)) deletedFillIds.push(Number(fillIdStr));
    });

    deletedFillIds.forEach(fillId => {
      magicFill.unregisterFill(fillId);
      delete mfIdToRowId.current[fillId];
      delete mfFillOrigins.current[fillId];
    });

    const survivingFills = magicFillsRef.current.filter(
      f => !deletedFillIds.includes(f.id),
    );

    // 2. New hidden set + color changes
    const newHidden = new Set<number>();
    const colorChanges: Array<{ fill: MagicFill; newColor: string }> = [];

    survivingFills.forEach(f => {
      const rowId = mfIdToRowId.current[f.id];
      if (!rowId) return;
      const row = rowById.get(rowId);
      if (!row) return;

      if (
        row.isVisible === false ||
        (row.groupId != null && hiddenGroupIds.has(row.groupId))
      ) {
        newHidden.add(f.id);
      }

      const origin = mfFillOrigins.current[f.id];
      if (origin && row.color && row.color !== origin.color) {
        colorChanges.push({ fill: f, newColor: row.color });
      }
    });

    // 3. Decide what work is needed
    const prevHidden = mfHiddenIdsRef.current;
    const visibilityChanged =
      newHidden.size !== prevHidden.size ||
      [...newHidden].some(id => !prevHidden.has(id)) ||
      [...prevHidden].some(id => !newHidden.has(id));

    const needsFullRepaint  = deletedFillIds.length > 0 || visibilityChanged;
    const needsColorRepaint = colorChanges.length > 0;

    if (!needsFullRepaint && !needsColorRepaint) return;

    // Apply color changes to origin map immediately (before any async work)
    colorChanges.forEach(({ fill, newColor }) => {
      const origin = mfFillOrigins.current[fill.id];
      if (origin) mfFillOrigins.current[fill.id] = { ...origin, color: newColor };
    });

    // Update hidden ref synchronously so the overlay knows the new state
    mfHiddenIdsRef.current = newHidden;
    setMfHiddenIds(newHidden);

    const fc = fillCanvasRef.current;
    if (!fc) return;

    if (needsFullRepaint) {
      // ── Full repaint path (visibility toggle / deletion) ─────────────────
      //
      //  1. Show the overlay immediately — setMfIsRepainting(true) is batched
      //     with setMfHiddenIds above so React flushes them together.
      //  2. Double-rAF ensures the overlay is actually painted to screen before
      //     the heavy canvas loop begins.
      //  3. Yield one frame between each fillAt so the browser can process
      //     input events and the overlay progress remains visible.
      //
      setMfIsRepainting(true);

      // Unregister every surviving fill — registry must match the blank canvas
      survivingFills.forEach(f => magicFill.unregisterFill(f.id));

      // Clear canvas synchronously
      const ctx = fc.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, fc.width, fc.height);

      (async () => {
        // Double rAF: first frame commits the React state (overlay visible),
        // second frame lets the browser actually paint it before heavy work.
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

        for (const f of survivingFills) {
          if (newHidden.has(f.id)) continue;
          const origin = mfFillOrigins.current[f.id];
          if (!origin) continue;
          await magicFill.fillAt(origin.x, origin.y, fc, origin.color, 40, origin.label);
          // Yield one frame between fills so the browser stays interactive
          await new Promise<void>(r => requestAnimationFrame(() => r()));
        }

        setMfIsRepainting(false);

        if (deletedFillIds.length > 0 || needsColorRepaint) {
          setMagicFills(
            survivingFills.map(f => {
              const origin = mfFillOrigins.current[f.id];
              if (origin && origin.color !== f.color) return { ...f, color: origin.color };
              return f;
            }),
          );
        }
      })();

    } else if (needsColorRepaint) {
      // ── Color-only repaint path ───────────────────────────────────────────
      //
      //  repaintFillColor is synchronous but cheap (pixel-map walk, no CCL/flood).
      //  We still show the overlay briefly and defer via double-rAF so the
      //  color picker interaction frame isn't blocked.
      //
      setMfIsRepainting(true);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const visibleIds = new Set(
            survivingFills.filter(f => !newHidden.has(f.id)).map(f => f.id),
          );

          colorChanges.forEach(({ fill, newColor }) => {
            magicFill.repaintFillColor(fill.id, newColor, visibleIds, fc);
          });

          setMagicFills(prev =>
            prev.map(f => {
              const change = colorChanges.find(c => c.fill.id === f.id);
              return change ? { ...f, color: change.newColor } : f;
            }),
          );

          setMfIsRepainting(false);
        });
      });
    }
  }, [measurements]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Magic Fill: commit staged fills ───────────────────────────────────────
  const handleMagicCommitSession = useCallback((name: string) => {
    const staged = mfPendingCommitRef.current;
    if (!staged || staged.length === 0 || !activeDrawingId) return;

    const sessionColor = mfSessionColor.current ?? staged[0].color;

    mfGroupCounter.current += 1;
    const groupId  = mfGroupCounter.current;
    const headerId = `mf-group-${groupId}-${Date.now()}`;

    const childRows = staged.map(f => {
      const row = magicFillToRow(f, {
        drawingId: activeDrawingId,
        parentId:  headerId,
        groupId:   String(groupId),
        id:        `mf-${f.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      });
      mfIdToRowId.current[f.id] = row.id;
      return row;
    });

    const totalQty = childRows.reduce((s, r) => s + r.quantity, 0);

    const headerRow: TakeoffRow = {
      id:            headerId,
      drawingId:     activeDrawingId,
      label:         name,
      description:   name,
      groupName:     name,
      type:          'Area',
      groupType:     'magic-fill',
      quantity:      +totalQty.toFixed(4),
      unit:          mfMetersPerPixel ? 'm²' : 'px²',
      unitRate:      0,
      notes:         `${staged.length} region${staged.length !== 1 ? 's' : ''} from Magic Fill`,
      points:        [],
      isOverridden:  true,
      isGroupHeader: true,
      isExpanded:    true,
      childIds:      childRows.map(r => r.id),
      groupId:       String(groupId),
      color:         sessionColor,
      isVisible:     true,
      icon:          '⊕',
    } as TakeoffRow;

    batchCommitMeasurements([headerRow, ...childRows]);

    setMagicFills(prev => [...prev, ...staged]);
    setMfSelectedId(null);
    setMfSelectedGroup(groupId);

    mfStagedFills.current        = [];
    mfSessionColor.current       = null;
    mfSessionHasSnapshot.current = false;
    mfPendingCommitRef.current   = null;
    setMfStagedCount(0);
    setMfLastFillPos(null);
  }, [activeDrawingId, magicFillToRow, mfMetersPerPixel, batchCommitMeasurements]);

  // ── Magic Fill: open name dialog ───────────────────────────────────────────
  const handleMagicFinish = useCallback(() => {
    if (mfStagedFills.current.length === 0) return;
    mfPendingCommitRef.current = [...mfStagedFills.current];
    setPendingMeasurementData({
      id:          'mf-session',
      type:        'Area',
      description: `Magic Fill Group ${mfGroupCounter.current + 1}`,
    });
    setShowMfNameDialog(true);
  }, []);

  const handleMfNameConfirm = useCallback((name: string) => {
    setShowMfNameDialog(false);
    handleMagicCommitSession(
      name.trim() || `Magic Fill Group ${mfGroupCounter.current + 1}`,
    );
  }, [handleMagicCommitSession]);

  const handleMfNameSkip = useCallback(() => {
    setShowMfNameDialog(false);
    handleMagicCommitSession(`Magic Fill Group ${mfGroupCounter.current + 1}`);
  }, [handleMagicCommitSession]);

  // ── Magic Fill: ensure session start ──────────────────────────────────────
  const mfEnsureSessionStart = useCallback((fc: HTMLCanvasElement): string => {
    if (!mfSessionHasSnapshot.current) {
      magicFill.pushSnapshot(fc);
      mfSessionHasSnapshot.current = true;
    }
    if (!mfSessionColor.current) {
      mfSessionColor.current = getNextFillColor();
    }
    return mfSessionColor.current;
  }, [magicFill]);

  // ── Magic Fill: single click ───────────────────────────────────────────────
  const handleMagicSingleClick = useCallback(async (canvasX: number, canvasY: number) => {
    const fc = fillCanvasRef.current;
    if (!fc || mfIsFilling) return;

    setMfIsFilling(true);
    setMfFillMsg('Computing fill');
    setMfFillSub(undefined);
    setMfFillProgress(null);
    await yieldFrame();

    if (propAppendToGroupId && !mfSessionColor.current) {
      const existingHeader = measurements.find(
        m => m.isGroupHeader && (m.id === propAppendToGroupId || m.groupId === propAppendToGroupId),
      );
      if (existingHeader?.color) {
        mfSessionColor.current = existingHeader.color;
      }
    }

    const color = mfEnsureSessionStart(fc);

    setMfFillMsg('Flood filling region');
    await yieldFrame();

    mfFillCounter.current += 1;
    const label = `Fill ${mfFillCounter.current}`;

    setMfFillMsg('Growing fill');
    await yieldFrame();

    const result = await magicFill.fillAt(canvasX, canvasY, fc, color, 40, label);

    if (!result) {
      mfFillCounter.current -= 1;
      if (mfStagedFills.current.length === 0 && mfSessionHasSnapshot.current) {
        magicFill.undo(fc);
        mfSessionHasSnapshot.current = false;
        mfSessionColor.current = null;
      }
      setMfIsFilling(false);
      setMfFillMsg('');
      return;
    }

    setMfFillMsg('Measuring');
    await yieldFrame();

    // ── Append mode ───────────────────────────────────────────────────────────
    if (propAppendToGroupId && activeDrawingId) {
      const existingHeader = measurements.find(
        m => m.isGroupHeader && (m.id === propAppendToGroupId || m.groupId === propAppendToGroupId),
      );
      const existingGroupId = existingHeader?.groupId ?? propAppendToGroupId;
      const existingColor   = existingHeader?.color   ?? color;

      const namedResult = { ...result, color: existingColor };
      const row = magicFillToRow(namedResult, {
        drawingId: activeDrawingId,
        parentId:  propAppendToGroupId,
        groupId:   existingGroupId,
      });
      mfIdToRowId.current[result.id]    = row.id;
      mfFillOrigins.current[result.id]  = { x: canvasX, y: canvasY, color: existingColor, label: namedResult.label };
      onAddMeasurementProp?.(row);

      if (existingHeader) {
        const newQty = +(existingHeader.quantity + row.quantity).toFixed(4);
        onUpdateMeasurementProp?.(existingHeader.id, {
          quantity: newQty,
          childIds: [...(existingHeader.childIds ?? []), row.id],
        });
      }

      setMagicFills(prev => [...prev, namedResult]);
      setMfSelectedId(result.id);
      onAppendComplete?.();

      setMfIsFilling(false);
      setMfFillMsg('');
      return;
    }

    // ── Normal mode ───────────────────────────────────────────────────────────
    mfStagedFills.current = [...mfStagedFills.current, result];
    setMfStagedCount(mfStagedFills.current.length);
    setMfSelectedId(result.id);
    setMfSelectedGroup(null);

    mfFillOrigins.current[result.id] = { x: canvasX, y: canvasY, color, label: result.label };

    if (result.polygon.length > 0 && mfStagedFills.current.length === 1) {
      const cx = result.polygon.reduce((s, p) => s + p[0], 0) / result.polygon.length;
      const cy = result.polygon.reduce((s, p) => s + p[1], 0) / result.polygon.length;
      setMfLastFillPos({ x: cx, y: cy });
    }

    setMfIsFilling(false);
    setMfFillMsg('');
  }, [
    mfIsFilling, magicFill, yieldFrame, mfEnsureSessionStart,
    propAppendToGroupId, activeDrawingId, measurements,
    magicFillToRow, onAddMeasurementProp, onUpdateMeasurementProp, onAppendComplete,
  ]);

  // ── Magic Fill: batch rect ─────────────────────────────────────────────────
  const handleMagicBatchRect = useCallback(async (
    x1: number, y1: number, x2: number, y2: number,
  ) => {
    const fc = fillCanvasRef.current;
    if (!fc || mfIsFilling) return;
    if (Math.abs(x2 - x1) < 5 || Math.abs(y2 - y1) < 5) return;

    setMfIsFilling(true);
    setMfFillMsg('Detecting regions');
    setMfFillSub('Scanning selection…');
    setMfFillProgress(null);
    await yieldFrame();

    if (propAppendToGroupId && !mfSessionColor.current) {
      const existingHeader = measurements.find(
        m => m.isGroupHeader && (m.id === propAppendToGroupId || m.groupId === propAppendToGroupId),
      );
      if (existingHeader?.color) {
        mfSessionColor.current = existingHeader.color;
      }
    }

    const color = mfEnsureSessionStart(fc);

    const results = await magicFill.fillRect(
      x1, y1, x2, y2, fc, color, 40, 'Fill', 0,
      (done, total) => {
        setMfFillProgress({ done, total });
        setMfFillMsg(`Filling region ${done + 1} / ${total}`);
        setMfFillSub(`Found ${total} region${total > 1 ? 's' : ''}`);
      },
    );

    if (results.length === 0) {
      if (mfStagedFills.current.length === 0 && mfSessionHasSnapshot.current) {
        magicFill.undo(fc);
        mfSessionHasSnapshot.current = false;
        mfSessionColor.current = null;
      }
      setMfIsFilling(false);
      setMfFillMsg('');
      setMfFillProgress(null);
      return;
    }

    setMfFillMsg('Finalising');
    setMfFillSub(undefined);
    await yieldFrame();

    const startIdx = mfFillCounter.current;
    const numbered = results.map((r, i) => ({
      ...r,
      label: `Fill ${startIdx + i + 1}`,
    }));
    mfFillCounter.current += results.length;

    // ── Append mode ───────────────────────────────────────────────────────────
    if (propAppendToGroupId && activeDrawingId) {
      const existingHeader = measurements.find(
        m => m.isGroupHeader && (m.id === propAppendToGroupId || m.groupId === propAppendToGroupId),
      );
      const existingGroupId = existingHeader?.groupId ?? propAppendToGroupId;
      const existingColor   = existingHeader?.color   ?? color;

      const coloredResults = numbered.map(r => ({ ...r, color: existingColor }));
      const childRows = coloredResults.map(f => {
        const row = magicFillToRow(f, {
          drawingId: activeDrawingId,
          parentId:  propAppendToGroupId,
          groupId:   existingGroupId,
          id:        `mf-${f.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        });
        mfIdToRowId.current[f.id] = row.id;
        if (f.polygon.length > 0) {
          const cx = f.polygon.reduce((s, p) => s + p[0], 0) / f.polygon.length;
          const cy = f.polygon.reduce((s, p) => s + p[1], 0) / f.polygon.length;
          mfFillOrigins.current[f.id] = { x: cx, y: cy, color: existingColor, label: f.label };
        }
        return row;
      });

      const addedQty = childRows.reduce((s, r) => s + r.quantity, 0);
      batchCommitMeasurements(childRows);

      if (existingHeader) {
        const newQty = +(existingHeader.quantity + addedQty).toFixed(4);
        onUpdateMeasurementProp?.(existingHeader.id, {
          quantity: newQty,
          childIds: [...(existingHeader.childIds ?? []), ...childRows.map(r => r.id)],
        });
      }

      setMagicFills(prev => [...prev, ...coloredResults]);
      setMfSelectedId(null);
      onAppendComplete?.();

      setMfIsFilling(false);
      setMfFillMsg('');
      setMfFillProgress(null);
      return;
    }

    // ── Normal mode ───────────────────────────────────────────────────────────
    mfStagedFills.current = [...mfStagedFills.current, ...numbered];
    setMfStagedCount(mfStagedFills.current.length);
    setMfSelectedId(null);
    setMfSelectedGroup(null);

    numbered.forEach(f => {
      if (f.polygon.length > 0) {
        const cx = f.polygon.reduce((s, p) => s + p[0], 0) / f.polygon.length;
        const cy = f.polygon.reduce((s, p) => s + p[1], 0) / f.polygon.length;
        mfFillOrigins.current[f.id] = { x: cx, y: cy, color, label: f.label };
      }
    });

    if (mfStagedFills.current.length === numbered.length) {
      setMfLastFillPos({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 });
    }

    setMfIsFilling(false);
    setMfFillMsg('');
    setMfFillProgress(null);
  }, [
    mfIsFilling, magicFill, yieldFrame, mfEnsureSessionStart,
    propAppendToGroupId, activeDrawingId, measurements,
    magicFillToRow, batchCommitMeasurements, onUpdateMeasurementProp, onAppendComplete,
  ]);

  // ── Magic Fill: hover ──────────────────────────────────────────────────────
  const handleMagicHover = useCallback((canvasX: number, canvasY: number) => {
    const fc = fillCanvasRef.current;
    if (!fc) return;
    const id = magicFill.getPixelAt(canvasX, canvasY, fc);
    setMfHoveredId(id > 0 ? id : null);
    setMfHoverPos({ x: canvasX, y: canvasY });
  }, [magicFill]);

  const handleMagicHoverLeave = useCallback(() => setMfHoveredId(null), []);

  // ── Magic Fill: fill holes ─────────────────────────────────────────────────
  const handleMagicFillHoles = useCallback(async (id: number) => {
    const fc = fillCanvasRef.current;
    if (!fc) return;
    const fill =
      magicFillsRef.current.find(f => f.id === id) ??
      mfStagedFills.current.find(f => f.id === id);
    if (!fill) return;

    setMfIsFilling(true);
    setMfFillMsg('Closing holes');
    setMfFillSub(undefined);
    setMfFillProgress(null);
    await yieldFrame();

    setMfFillMsg('Patching interior gaps');
    await yieldFrame();

    const result = magicFill.fillHoles(id, fill, fc);
    if (!result) {
      setMfIsFilling(false);
      setMfFillMsg('');
      return;
    }

    setMfFillMsg('Measuring');
    await yieldFrame();

    const isStaged = mfStagedFills.current.some(f => f.id === id);
    if (isStaged) {
      mfStagedFills.current = mfStagedFills.current.map(
        f => f.id === id ? { ...f, ...result } : f,
      );
    } else {
      setMagicFills(prev => prev.map(f => f.id === id ? { ...f, ...result } : f));

      const rowId = mfIdToRowId.current[id];
      if (rowId && activeDrawingId) {
        const qty = mfMetersPerPixel
          ? +(result.areaPx * mfMetersPerPixel * mfMetersPerPixel).toFixed(4)
          : result.areaPx;
        const unit = mfMetersPerPixel ? 'm²' : 'px²';
        const perimStr = mfMetersPerPixel
          ? `${(result.perimPx * mfMetersPerPixel).toFixed(2)}m perimeter`
          : `${result.perimPx.toLocaleString()}px perimeter`;
        onUpdateMeasurementProp?.(rowId, {
          quantity: qty, unit,
          notes: `Magic Fill (holes closed) · ${result.polygon.length} boundary pts · ${perimStr} · ${result.areaPx.toLocaleString()}px²`,
        });
      }
    }

    setMfHolesClosed(prev => new Set(prev).add(id));
    setMfIsFilling(false);
    setMfFillMsg('');
  }, [magicFill, yieldFrame, activeDrawingId, mfMetersPerPixel, onUpdateMeasurementProp]);

  // ── Magic Fill: undo ───────────────────────────────────────────────────────
  const handleMagicUndo = useCallback(() => {
    const fc = fillCanvasRef.current;
    if (!fc) return;

    if (mfStagedFills.current.length > 0) {
      const last = mfStagedFills.current[mfStagedFills.current.length - 1];

      mfStagedFills.current = mfStagedFills.current.slice(0, -1);
      magicFill.unregisterFill(last.id);
      setMfStagedCount(mfStagedFills.current.length);

      if (mfStagedFills.current.length === 0 && mfSessionHasSnapshot.current) {
        magicFill.undo(fc);
        mfSessionHasSnapshot.current = false;
        mfSessionColor.current = null;
      } else if (mfSessionHasSnapshot.current && mfStagedFills.current.length > 0) {
        mfStagedFills.current.forEach(f => magicFill.unregisterFill(f.id));
        magicFill.undo(fc);
        mfSessionHasSnapshot.current = false;
        mfSessionColor.current = null;
        mfStagedFills.current = [];
        setMfStagedCount(0);
        mfFillCounter.current = Math.max(0, mfFillCounter.current - 1);
      }

      setMfSelectedId(null);
      setMfSelectedGroup(null);
      return;
    }

    const ok = magicFill.undo(fc);
    if (!ok) return;

    setMagicFills(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.groupId != null) {
        const gid = last.groupId;
        prev.filter(f => f.groupId === gid).forEach(f => {
          magicFill.unregisterFill(f.id);
          const rowId = mfIdToRowId.current[f.id];
          if (rowId) { onDeleteMeasurementProp?.(rowId); delete mfIdToRowId.current[f.id]; }
        });
        return prev.filter(f => f.groupId !== gid);
      }
      magicFill.unregisterFill(last.id);
      const rowId = mfIdToRowId.current[last.id];
      if (rowId) { onDeleteMeasurementProp?.(rowId); delete mfIdToRowId.current[last.id]; }
      return prev.slice(0, -1);
    });
    setMfSelectedId(null);
    setMfSelectedGroup(null);
  }, [magicFill, onDeleteMeasurementProp]);

  // ── Magic Fill: clear all ──────────────────────────────────────────────────
  const handleMagicClear = useCallback(() => {
    const fc = fillCanvasRef.current;
    if (!fc) return;
    handleMagicAbortSession();
    magicFill.clearAll(fc);
    Object.values(mfIdToRowId.current).forEach(rowId => onDeleteMeasurementProp?.(rowId));
    mfIdToRowId.current   = {};
    mfFillOrigins.current = {};
    setMagicFills([]);
    setMfHiddenIds(new Set());
    setMfSelectedId(null);
    setMfSelectedGroup(null);
    setMfHoveredId(null);
    setMfHolesClosed(new Set());
    mfFillCounter.current  = 0;
    mfGroupCounter.current = 0;
    resetFillColorIdx();
  }, [magicFill, handleMagicAbortSession, onDeleteMeasurementProp]);

  // ── Magic Fill: delete single committed fill ───────────────────────────────
  const handleMagicDelete = useCallback((id: number) => {
    magicFill.unregisterFill(id);
    setMagicFills(prev => prev.filter(f => f.id !== id));
    if (mfSelectedId === id) setMfSelectedId(null);
    if (mfHoveredId  === id) setMfHoveredId(null);
    const rowId = mfIdToRowId.current[id];
    if (rowId) {
      onDeleteMeasurementProp?.(rowId);
      delete mfIdToRowId.current[id];
      delete mfFillOrigins.current[id];
    }
  }, [magicFill, mfSelectedId, mfHoveredId, onDeleteMeasurementProp]);

  // ── Magic Fill: toggle visibility ──────────────────────────────────────────
  const handleMagicToggleHide = useCallback((id: number) => {
    setMfHiddenIds(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  }, []);

  // ── Viewport helpers ───────────────────────────────────────────────────────
  const centerDocumentInViewport = useCallback(() => {
    const c = containerRef.current; if (!c) return;
    requestAnimationFrame(() => {
      c.scrollLeft = Math.round((c.scrollWidth  - c.clientWidth)  / 2);
      c.scrollTop  = Math.round((c.scrollHeight - c.clientHeight) / 2);
    });
  }, []);

  const fitToScreen = useCallback(async (
    pdfDoc?: pdfjsLib.PDFDocumentProxy, pageNum?: number,
  ) => {
    const doc  = pdfDoc ?? pdfRef.current;
    const page = pageNum ?? pageNumberRef.current;
    if (!doc || !containerRef.current) return;
    try {
      const p  = await doc.getPage(page);
      const vp = p.getViewport({ scale: 1 });
      const vW = containerRef.current.clientWidth  - CANVAS_PADDING * 2;
      const vH = containerRef.current.clientHeight - CANVAS_PADDING * 2;
      setScale(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
        Math.min(vW / vp.width, vH / vp.height) * 0.97)));
      setTimeout(() => centerDocumentInViewport(), 150);
    } catch (err) { console.error('Fit error', err); }
  }, [centerDocumentInViewport]);

  const handleManualScale = useCallback(() => {
    const s = window.prompt('Enter scale ratio (e.g. 1:100) or pixels per unit (e.g. 0.05):');
    if (!s) return;
    if (s.includes(':')) {
      const [paper, real] = s.split(':').map(parseFloat);
      if (!isNaN(paper) && !isNaN(real) && real > 0) onScaleSetRef.current(real / paper);
    } else {
      const f = parseFloat(s); if (!isNaN(f) && f > 0) onScaleSetRef.current(f);
    }
  }, []);

  // ── Finish + dialog flow ───────────────────────────────────────────────────
  const handleFinishMeasurement = useCallback(() => {
    const minPts = activeTool === 'count' || activeTool === 'point' ? 1 : 2;
    if (tempPoints.length < minPts) { finishMeasurement(); return; }
    if (propAppendToGroupId) { finishMeasurement(); onAppendComplete?.(); return; }
    const type = activeTool === 'polygon' || activeTool === 'rectangle'
      ? 'Polygon' : activeTool === 'linear'  ? 'Length'
      : activeTool === 'count' ? 'Count' : 'Point';
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
    setShowMeasurementDialog(false); finishMeasurement();
  }, [finishMeasurement]);

  // ── Toolbar API ────────────────────────────────────────────────────────────
  const toolbarAPI = useMemo(() => ({
    tools: [...VIEWER_TOOLS] as any,
    activeTool, setActiveTool, scale, setScale, scaleFactor,
    snapEnabled, setSnapEnabled, showSnapSettings, setShowSnapSettings,
    showPins, setShowPins, snapThreshold, setSnapThreshold,
    confidenceFilter, setConfidenceFilter, analysisStatus,
    analysisPage: analysisPage ?? null,
    currentPageCorners: pageData.get(pageNumber - 1)?.corners.length ?? 0,
    pdf, pageNumber,
    fitToScreen: () => fitToScreen(), handleManualScale,
    canUndo, canRedo, handleUndo, handleRedo,
  }), [
    activeTool, setActiveTool, scale, scaleFactor,
    snapEnabled, showSnapSettings, showPins, snapThreshold, confidenceFilter,
    analysisStatus, analysisPage, pageData, pageNumber, pdf,
    fitToScreen, handleManualScale, canUndo, canRedo, handleUndo, handleRedo,
  ]);

  useEffect(() => { onToolbarReady?.(toolbarAPI); }, [onToolbarReady, toolbarAPI]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) =>
    Array.from(e.target.files ?? []).forEach(f =>
      onDrawingAdded(f.name, URL.createObjectURL(f), f));

  // ── PDF load ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    if (!activeDrawingUrl) {
      setPdf(null); setPdfDimensions(null);
      currentPdfPageRef.current = null;
      return;
    }
    setLoading(true);

    const onLoad = async (doc: pdfjsLib.PDFDocumentProxy) => {
      if (!mounted) return;
      const page = await doc.getPage(1);
      const vp   = page.getViewport({ scale: 1 });
      let fit    = 1.5;
      if (containerRef.current) {
        const vW = (containerRef.current.clientWidth  || containerRef.current.offsetWidth)  - CANVAS_PADDING * 2;
        const vH = (containerRef.current.clientHeight || containerRef.current.offsetHeight) - CANVAS_PADDING * 2;
        if (vW > 0 && vH > 0)
          fit = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
            Math.min(vW / vp.width, vH / vp.height) * 0.97));
      }
      setPdf(doc); setPageNumber(1); setScale(fit); setCommittedScale(fit);
      setTimeout(() => {
        if (!mounted) return;
        startExtractionRef.current?.(doc, activeDrawingFileRef.current);
        setTimeout(() => { if (mounted) { centerDocumentInViewport(); setLoading(false); } }, 150);
      }, 50);
    };

    const file  = activeDrawingFileRef.current;
    const onErr = (err: any) => { console.error(err); if (mounted) setLoading(false); };

    if (file) {
      const r = new FileReader();
      r.onload = () => {
        if (!mounted) return;
        pdfjsLib.getDocument({ data: new Uint8Array(r.result as ArrayBuffer) })
          .promise.then(onLoad).catch(onErr);
      };
      r.readAsArrayBuffer(file);
    } else {
      pdfjsLib.getDocument(activeDrawingUrl!).promise.then(onLoad).catch(onErr);
    }
    return () => { mounted = false; };
  }, [activeDrawingId, activeDrawingUrl, centerDocumentInViewport]);

  // ── PDF render ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!pdf) return;
    let active = true; let task: any = null;

    (async () => {
      try {
        const page = await pdf.getPage(pageNumber); if (!active) return;
        currentPdfPageRef.current = page;

        const rawDpr  = window.devicePixelRatio || 1;
        const logVP   = page.getViewport({ scale: committedScale });
        const safeDpr = Math.sqrt(16_000_000 / (logVP.width * logVP.height));
        const dpr     = Math.min(rawDpr, safeDpr, 3);
        const physVP  = page.getViewport({ scale: committedScale * dpr });

        const canvas = pdfCanvasRef.current; if (!canvas) return;
        const ctx    = canvas.getContext('2d');  if (!ctx)    return;

        if (canvas.width !== physVP.width || canvas.height !== physVP.height) {
          canvas.width  = physVP.width;
          canvas.height = physVP.height;
        }
        canvas.style.width  = `${logVP.width}px`;
        canvas.style.height = `${logVP.height}px`;

        for (const ref of [drawingCanvasRef, pinCanvasRef, vectorCanvasRef, fillCanvasRef]) {
          const c = ref.current; if (!c) continue;
          if (c.width !== logVP.width || c.height !== logVP.height) {
            if (ref === fillCanvasRef && (c.width > 0 && c.height > 0)) {
              const tmp = document.createElement('canvas');
              tmp.width = c.width; tmp.height = c.height;
              tmp.getContext('2d')!.drawImage(c, 0, 0);
              c.width  = logVP.width;
              c.height = logVP.height;
              c.getContext('2d')!.drawImage(tmp, 0, 0, logVP.width, logVP.height);
            } else {
              c.width  = logVP.width;
              c.height = logVP.height;
            }
          }
          c.style.width  = `${logVP.width}px`;
          c.style.height = `${logVP.height}px`;
        }

        setPdfDimensions(prev =>
          prev?.w === logVP.width && prev?.h === logVP.height
            ? prev
            : { w: logVP.width, h: logVP.height },
        );

        task = page.render({ canvasContext: ctx, viewport: physVP, canvas: canvas as any } as any);
        await task.promise;

        if (active) {
          readyToDrawRef.current = true;
          setPdfRenderCount(c => c + 1);
        }

      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') console.error(err);
      }
    })();

    return () => { active = false; task?.cancel(); };
  }, [pdf, pageNumber, committedScale]);

  // ── CSS-only scale during live zoom ───────────────────────────────────────
  useEffect(() => {
    if (scale === committedScale) return;
    if (!pdfDimensions) return;
    const ratio = scale / committedScale;
    const newW  = pdfDimensions.w * ratio;
    const newH  = pdfDimensions.h * ratio;
    for (const ref of [drawingCanvasRef, pinCanvasRef, vectorCanvasRef, fillCanvasRef]) {
      const c = ref.current; if (!c) continue;
      c.style.width  = `${newW}px`;
      c.style.height = `${newH}px`;
    }
  }, [scale, committedScale, pdfDimensions]);

  // ── Center on page change ──────────────────────────────────────────────────
  useEffect(() => {
    if (pdf && pdfDimensions) centerDocumentInViewport();
  }, [pageNumber, pdfDimensions, centerDocumentInViewport, pdf]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === 'Escape') {
        if (activeTool === 'magic-fill' && mfStagedFills.current.length > 0) {
          handleMagicAbortSession(); return;
        }
      }
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
        const map: Record<string, ToolType> = {
          v: 'select', l: 'linear', r: 'rectangle',
          p: 'polygon', n: 'count', t: 'point',
        };
        if (map[e.key.toLowerCase()]) { e.preventDefault(); setActiveTool(map[e.key.toLowerCase()]); return; }
      }
      const cm = e.ctrlKey || e.metaKey;
      if (cm && (e.key === '+' || e.key === '=')) { e.preventDefault(); setScale(s => Math.min(MAX_ZOOM, s + ZOOM_SENSITIVITY)); return; }
      if (cm && e.key === '-')                     { e.preventDefault(); setScale(s => Math.max(MIN_ZOOM, s - ZOOM_SENSITIVITY)); return; }
      if (cm && e.key === '0')                     { e.preventDefault(); fitToScreen(); return; }
      if (cm && e.key === 'z' && !e.shiftKey)      { e.preventDefault(); handleUndo(); return; }
      if (cm && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); handleRedo(); return; }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTool, fitToScreen, handleUndo, handleRedo, setActiveTool, handleMagicAbortSession]);

  // ── Wheel zoom ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const delta = (e.deltaY > 0 ? -1 : 1) *
        ZOOM_SENSITIVITY * (1 + Math.min(Math.abs(e.deltaY) / 100, 1) * 0.5);
      const rect = el.getBoundingClientRect();
      const cx   = e.clientX - rect.left + el.scrollLeft;
      const cy   = e.clientY - rect.top  + el.scrollTop;
      setScale(prev => {
        const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev + delta));
        if (next === prev) return prev;
        const ratio = next / prev;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const c = containerRef.current; if (!c) return;
          c.scrollLeft = cx * ratio - (e.clientX - rect.left);
          c.scrollTop  = cy * ratio - (e.clientY - rect.top);
        }));
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── Spacebar pan ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement).tagName === 'INPUT') return;
      e.preventDefault();
      if (!e.repeat) { spaceHeldRef.current = true; setSpaceHeld(true); }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceHeldRef.current = false; setSpaceHeld(false); setIsPanning(false);
      if (containerRef.current) containerRef.current.style.cursor = '';
    };
    window.addEventListener('keydown', onDown, { capture: true });
    window.addEventListener('keyup',   onUp,   { capture: true });
    return () => {
      window.removeEventListener('keydown', onDown, { capture: true });
      window.removeEventListener('keyup',   onUp,   { capture: true });
    };
  }, []);

  // ── Pan helpers ────────────────────────────────────────────────────────────
  const startPan = useCallback((e: React.PointerEvent, target: HTMLElement) => {
    if (!pdfRef.current) return;
    e.preventDefault(); target.setPointerCapture(e.pointerId);
    setIsPanning(true);
    if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 ||
        (e.button === 0 && spaceHeldRef.current) ||
        (e.button === 0 && activeTool === 'select'))
      startPan(e, e.currentTarget as HTMLElement);
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
  const handleDrawingCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.button === 1 || (e.button === 0 && spaceHeldRef.current)) {
        e.stopPropagation();
        if (containerRef.current) startPan(e, containerRef.current);
      }
    },
    [startPan],
  );

  // ── Wrap style ─────────────────────────────────────────────────────────────
  const wrapStyle = useMemo(() => {
    if (!pdf || !pdfDimensions) return undefined;
    const el = containerRef.current;
    const vw = el ? (el.clientWidth  || el.offsetWidth  || window.innerWidth)  : window.innerWidth;
    const vh = el ? (el.clientHeight || el.offsetHeight || window.innerHeight) : window.innerHeight;
    return {
      width:  Math.max(pdfDimensions.w + CANVAS_PADDING * 2, vw  * 3),
      height: Math.max(pdfDimensions.h + CANVAS_PADDING * 2, vh * 3),
    } as React.CSSProperties;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pdfDimensions]);

  // ── Derived magic-fill state ───────────────────────────────────────────────
  const isMagicFillTool = activeTool === 'magic-fill';

  const allVisibleFills = useMemo(
    () => [...magicFills, ...mfStagedFills.current],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [magicFills, mfStagedCount],
  );

  const mfHoveredFill  = allVisibleFills.find(f => f.id === mfHoveredId)  ?? null;
  const mfSelectedFill = allVisibleFills.find(f => f.id === mfSelectedId) ?? null;
  const mfGroupFills   = mfSelectedGroup != null
    ? magicFills.filter(f => f.groupId === mfSelectedGroup)
    : [];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 relative bg-industrial-black blueprint-grid flex flex-col overflow-hidden h-full">

      {!hideToolbar && (
        <ViewerToolbar
          activeTool={activeTool} setActiveTool={setActiveTool}
          canUndo={canUndo} canRedo={canRedo} handleUndo={handleUndo} handleRedo={handleRedo}
          tempPointsCount={tempPoints.length}
          snapEnabled={snapEnabled} setSnapEnabled={setSnapEnabled}
          showSnapSettings={showSnapSettings} setShowSnapSettings={setShowSnapSettings}
          scaleFactor={scaleFactor} handleManualScale={handleManualScale}
          analysisStatus={analysisStatus} analysisPage={analysisPage ?? null}
          currentPageCorners={pageData.get(pageNumber - 1)?.corners.length ?? 0}
          scale={scale} setScale={setScale} fitToScreen={() => fitToScreen()}
          MIN_ZOOM={MIN_ZOOM} MAX_ZOOM={MAX_ZOOM} ZOOM_SENSITIVITY={ZOOM_SENSITIVITY}
        />
      )}

      {showSnapSettings && (
        <SnapSettingsPanel
          showPins={showPins}                  onShowPinsChange={setShowPins}
          snapThreshold={snapThreshold}        onSnapThresholdChange={setSnapThreshold}
          confidenceFilter={confidenceFilter}  onConfidenceFilterChange={setConfidenceFilter}
          snapEnabled={snapEnabled}            onSnapEnabledChange={setSnapEnabled}
        />
      )}

      <div className="flex flex-1 overflow-hidden min-h-0 relative">

        {/* Overlay shown for both active filling AND background repaint */}
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
              if (activeTool === 'magic-fill' && mfStagedFills.current.length > 0) {
                handleMagicAbortSession();
              } else if (tempPoints.length > 0) {
                handleFinishMeasurement();
              } else {
                setActiveTool('select');
              }
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              if (activeTool === 'magic-fill' && mfStagedFills.current.length > 0) {
                handleMagicFinish();
              } else if (tempPoints.length > 0) {
                handleFinishMeasurement();
              }
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
              snapFlashes={snapFlashes} toCanvas={toCanvas}
              readyToDraw={readyToDrawRef.current}
              handleCanvasClick={handleCanvasClick} handleContextMenu={handleContextMenu}
              handleCanvasPointerMove={handleCanvasPointerMove}
              handleCanvasPointerDown={handleCanvasPointerDown as (e: React.PointerEvent<HTMLCanvasElement>) => boolean | undefined}
              handleCanvasPointerUp={handleCanvasPointerUp}
              handleDrawingCanvasPointerDown={handleDrawingCanvasPointerDown}
              setCursorPoint={setCursorPoint} cursorPointRef={cursorPointRef}
              redrawPinCanvas={redrawPinCanvas}
              handleFinishMeasurement={handleFinishMeasurement}
              handleFileUpload={handleFileUpload}
              containerRef={containerRef} CANVAS_PADDING={CANVAS_PADDING}
            >
              <MagicFillCanvas
                pdfDimensions={pdfDimensions}
                active={isMagicFillTool}
                isFilling={mfIsFilling || mfIsRepainting}
                fills={allVisibleFills}
                hiddenIds={mfHiddenIds}
                selectedId={mfSelectedId}
                selectedGroup={mfSelectedGroup}
                onSingleClick={handleMagicSingleClick}
                onBatchRect={handleMagicBatchRect}
                onHover={handleMagicHover}
                onHoverLeave={handleMagicHoverLeave}
              />

              {/* Floating Finish button */}
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
              onClick={() => setPageNumber(p => Math.max(1, p - 1))}
              disabled={pageNumber <= 1}
              className="p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-50"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-tighter">
              PAGE {pageNumber} OF {pdf.numPages}
            </span>
            <button
              onClick={() => setPageNumber(p => Math.min(pdf.numPages, p + 1))}
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
                    <span>
                      Total: {fmtArea(magicFills.reduce((s, f) => s + f.areaPx, 0), mfMetersPerPixel)}
                    </span>
                  </>
                )}
                <div className="w-px h-3 bg-industrial-border" />
                {mfStagedCount > 0 ? (
                  <span className="text-amber-400">Click Finish or press Enter to commit · Esc to discard</span>
                ) : (
                  <span>Click: fill · Drag: batch fill</span>
                )}
              </>
            ) : (
              <span>
                Double-click or right-click to finish · ESC to cancel · Enter to finish
              </span>
            )}
            <span>RENDER_ENGINE: PDF.JS V{pdfjsLib.version}</span>
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
        show={showMfNameDialog} pendingMeasurementData={pendingMeasurementData}
        onConfirm={(name, desc, icon) => handleMfNameConfirm(name)}
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
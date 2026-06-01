'use client';

// ─── hooks/useMagicFillSession.ts ─────────────────────────────────────────────
//
//  FIX: Committed magic-fill regions were being repainted onto fillCanvasRef
//  whenever `measurements` changed — including after scale calibration, tool
//  switches, and any other state update that touched the measurements array.
//  This caused the green cross artifact to appear on the canvas even when the
//  magic-fill tool was not active.
//
//  ROOT CAUSE:
//  The "measurements sync" effect watched `measurements` and called
//  magicFill.fillAt() / magicFill.repaintFillColor() unconditionally. It had
//  no awareness of whether the magic-fill tool was actually active.
//
//  FIX:
//  Added `isMagicFillActiveRef: React.RefObject<boolean>` to the hook options.
//  Every code path that writes to fillCanvasRef now checks this ref first and
//  bails out if the tool is not active. Specifically:
//    1. measurements sync effect — skips the full repaint and color repaint
//       branches when not active.
//    2. scale-change sync effect (quantity update) — already only calls
//       onUpdateMeasurementProp (no canvas write), so no guard needed there.
//    3. pdfRenderCount effect (mask rebuild) — reads pdfCanvasRef only, no
//       fillCanvasRef write, so no guard needed there.
//    4. handleMagicSingleClick / handleMagicBatchRect / handleMagicFillHoles —
//       these are only reachable while the tool is active (MagicFillCanvas
//       passes events only when active=true), so no guard needed there.
//
//  The ref is updated synchronously on every render of Viewer.tsx so it is
//  always current by the time any async effect callback reads it.

import {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import type { TakeoffRow } from '@/types';
import { useMagicFill } from '@/hooks/useMagicFill';
import type { MagicFill } from '@/hooks/useMagicFill';
import {
  getNextFillColor,
  resetFillColorIdx,
} from '@/components/Viewer/MagicFillCanvas';

// ── Public interface ───────────────────────────────────────────────────────────

export interface UseMagicFillSessionOptions {
  fillCanvasRef:          React.RefObject<HTMLCanvasElement>;
  pdfRenderCount:         number;
  pdfCanvasRef:           React.RefObject<HTMLCanvasElement>;
  /** logical canvas dimensions — used only to re-trigger mask build */
  pdfDimensions:          { w: number; h: number } | null;
  scaleFactor:            number;
  activeDrawingId:        string | null;
  measurements:           TakeoffRow[];
  propAppendToGroupId?:   string;
  onAddMeasurementProp?:  (row: TakeoffRow) => void;
  onUpdateMeasurementProp?: (id: string, updates: Partial<TakeoffRow>) => void;
  onDeleteMeasurementProp?: (id: string) => void;
  onAppendComplete?:      () => void;
  batchCommitMeasurements: (rows: TakeoffRow[]) => void;
  /**
   * Ref that is `true` only while activeTool === 'magic-fill'.
   * All canvas-write paths check this before painting so committed fills
   * are never repainted when the tool is inactive (e.g. after calibration,
   * while using grid-count, etc.).
   *
   * Pass `isMagicFillActiveRef` from Viewer.tsx.
   */
  isMagicFillActiveRef:   React.RefObject<boolean>;
}

export interface UseMagicFillSessionReturn {
  allVisibleFills:    MagicFill[];
  magicFills:         MagicFill[];
  mfStagedCount:      number;
  mfSelectedId:       number | null;
  setMfSelectedId:    (id: number | null) => void;
  mfSelectedGroup:    number | null;
  setMfSelectedGroup: (g: number | null) => void;
  mfHoveredId:        number | null;
  mfHoverPos:         { x: number; y: number };
  mfHolesClosed:      Set<number>;
  mfHiddenIds:        Set<number>;
  mfIsFilling:        boolean;
  mfIsRepainting:     boolean;
  mfFillMsg:          string;
  mfFillSub:          string | undefined;
  mfFillProgress:     { done: number; total: number } | null;
  mfMetersPerPixel:   number | null;
  mfLastFillPos:      { x: number; y: number } | null;
  showMfNameDialog:   boolean;
  pendingMfData:      { id: string; type: string; description: string } | null;
  handleMagicSingleClick:  (canvasX: number, canvasY: number) => Promise<void>;
  handleMagicBatchRect:    (x1: number, y1: number, x2: number, y2: number) => Promise<void>;
  handleMagicHover:        (canvasX: number, canvasY: number) => void;
  handleMagicHoverLeave:   () => void;
  handleMagicFillHoles:    (id: number) => Promise<void>;
  handleMagicUndo:         () => void;
  handleMagicClear:        () => void;
  handleMagicDelete:       (id: number) => void;
  handleMagicToggleHide:   (id: number) => void;
  handleMagicAbortSession: () => void;
  handleMagicFinish:       () => void;
  handleMfNameConfirm:     (name: string) => void;
  handleMfNameSkip:        () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMagicFillSession({
  fillCanvasRef,
  pdfRenderCount,
  pdfCanvasRef,
  pdfDimensions,
  scaleFactor,
  activeDrawingId,
  measurements,
  propAppendToGroupId,
  onAddMeasurementProp,
  onUpdateMeasurementProp,
  onDeleteMeasurementProp,
  onAppendComplete,
  batchCommitMeasurements,
  isMagicFillActiveRef,
}: UseMagicFillSessionOptions): UseMagicFillSessionReturn {

  const magicFill = useMagicFill();

  const yieldFrame = useCallback(
    () => new Promise<void>(r => requestAnimationFrame(() => r())),
    [],
  );

  // ── Committed state ────────────────────────────────────────────────────────
  const [magicFills,       setMagicFills]       = useState<MagicFill[]>([]);
  const [mfHiddenIds,      setMfHiddenIds]      = useState<Set<number>>(new Set());
  const [mfSelectedId,     setMfSelectedId]     = useState<number | null>(null);
  const [mfSelectedGroup,  setMfSelectedGroup]  = useState<number | null>(null);
  const [mfHoveredId,      setMfHoveredId]      = useState<number | null>(null);
  const [mfHoverPos,       setMfHoverPos]       = useState({ x: 0, y: 0 });
  const [mfHolesClosed,    setMfHolesClosed]    = useState<Set<number>>(new Set());
  const [mfIsFilling,      setMfIsFilling]      = useState(false);
  const [mfFillMsg,        setMfFillMsg]        = useState('');
  const [mfFillSub,        setMfFillSub]        = useState<string | undefined>(undefined);
  const [mfFillProgress,   setMfFillProgress]   = useState<{ done: number; total: number } | null>(null);
  const [mfMetersPerPixel, setMfMetersPerPixel] = useState<number | null>(null);
  const [mfIsRepainting,   setMfIsRepainting]   = useState(false);

  // ── Session state ──────────────────────────────────────────────────────────
  const mfStagedFills        = useRef<MagicFill[]>([]);
  const mfSessionColor       = useRef<string | null>(null);
  const mfSessionHasSnapshot = useRef(false);
  const [mfStagedCount,      setMfStagedCount]  = useState(0);
  const [mfLastFillPos,      setMfLastFillPos]  = useState<{ x: number; y: number } | null>(null);

  const mfGroupCounter = useRef(0);
  const mfFillCounter  = useRef(0);

  const mfIdToRowId    = useRef<Record<number, string>>({});
  const mfFillOrigins  = useRef<Record<number, { x: number; y: number; color: string; label: string }>>({});

  // ── Name dialog ────────────────────────────────────────────────────────────
  const [showMfNameDialog, setShowMfNameDialog] = useState(false);
  const [pendingMfData,    setPendingMfData]    = useState<{ id: string; type: string; description: string } | null>(null);
  const mfPendingCommitRef = useRef<MagicFill[] | null>(null);

  // ── Stable refs ────────────────────────────────────────────────────────────
  const magicFillsRef  = useRef<MagicFill[]>([]);
  useEffect(() => { magicFillsRef.current = magicFills; }, [magicFills]);

  const mfHiddenIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => { mfHiddenIdsRef.current = mfHiddenIds; }, [mfHiddenIds]);

  // ── Scale sync ─────────────────────────────────────────────────────────────
  useEffect(() => {
    setMfMetersPerPixel(scaleFactor > 0 ? scaleFactor : null);
  }, [scaleFactor]);

  // ── Rebuild mask when PDF renders ──────────────────────────────────────────
  // No fillCanvasRef write here — safe to run regardless of active tool.
  useEffect(() => {
    const canvas = pdfCanvasRef.current;
    if (!canvas || !pdfDimensions) return;
    magicFill.buildMask(canvas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfRenderCount, pdfDimensions]);

  // ── Full reset when drawing changes ───────────────────────────────────────
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
    mfFillCounter.current        = 0;
    mfGroupCounter.current       = 0;
    mfIdToRowId.current          = {};
    mfFillOrigins.current        = {};
    mfStagedFills.current        = [];
    mfSessionColor.current       = null;
    mfSessionHasSnapshot.current = false;
    setMfStagedCount(0);
    setMfLastFillPos(null);
    resetFillColorIdx();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDrawingId]);

  // ── Quantity sync when scale changes ──────────────────────────────────────
  // Only calls onUpdateMeasurementProp — no canvas writes. No guard needed.
  useEffect(() => {
    if (!mfMetersPerPixel || magicFillsRef.current.length === 0) return;
    magicFillsRef.current.forEach(f => {
      const rowId = mfIdToRowId.current[f.id];
      if (!rowId) return;
      const qty      = +(f.areaPx * mfMetersPerPixel * mfMetersPerPixel).toFixed(4);
      const perimStr = `${(f.perimPx * mfMetersPerPixel).toFixed(2)}m perimeter`;
      onUpdateMeasurementProp?.(rowId, {
        quantity: qty,
        unit:     'm²',
        notes:    `Magic Fill · ${f.polygon.length} boundary pts · ${perimStr} · ${f.areaPx.toLocaleString()}px²`,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mfMetersPerPixel]);

  // ── Measurements sync (deletion + visibility + color) ─────────────────────
  //
  //  FIX: This effect fires whenever `measurements` changes — including after
  //  calibration, undo/redo, and any tool switch that adds a measurement.
  //  Previously it unconditionally painted onto fillCanvasRef, causing the
  //  green cross to appear even when magic-fill was not the active tool.
  //
  //  Guard: bail out of any fillCanvasRef write when isMagicFillActiveRef is
  //  false. State-only updates (setMfHiddenIds, setMagicFills) are still
  //  applied so the data stays consistent for when the tool is re-activated.
  useEffect(() => {
    if (magicFillsRef.current.length === 0) return;

    const currentRowIds  = new Set(measurements.map(m => m.id));
    const rowById        = new Map(measurements.map(m => [m.id, m]));

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
    const newHidden    = new Set<number>();
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

    // Always update color origin map and hidden state — these are pure data,
    // no canvas involvement. Safe to do regardless of active tool.
    colorChanges.forEach(({ fill, newColor }) => {
      const origin = mfFillOrigins.current[fill.id];
      if (origin) mfFillOrigins.current[fill.id] = { ...origin, color: newColor };
    });

    mfHiddenIdsRef.current = newHidden;
    setMfHiddenIds(newHidden);

    // FIX: guard all canvas-write paths. If magic-fill is not the active tool,
    // skip the repaint entirely. The state updates above keep the data correct
    // so when the user returns to magic-fill the repaint will trigger again
    // via the measurements effect (measurements will still be the same, but
    // the component re-mounts or the user can re-enter the tool which calls
    // a fresh render cycle). If fills were deleted we still update magicFills
    // state so the data model stays accurate without touching the canvas.
    if (!isMagicFillActiveRef.current) {
      if (deletedFillIds.length > 0) {
        setMagicFills(survivingFills);
      }
      if (needsColorRepaint) {
        setMagicFills(prev =>
          prev.map(f => {
            const change = colorChanges.find(c => c.fill.id === f.id);
            return change ? { ...f, color: change.newColor } : f;
          }),
        );
      }
      return;
    }

    // ── Tool is active — proceed with canvas repaints ─────────────────────
    const fc = fillCanvasRef.current;
    if (!fc) return;

    if (needsFullRepaint) {
      setMfIsRepainting(true);
      survivingFills.forEach(f => magicFill.unregisterFill(f.id));
      const ctx = fc.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, fc.width, fc.height);

      (async () => {
        await new Promise<void>(r =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())));

        // Re-check: user may have switched tool while the rAF was pending.
        if (!isMagicFillActiveRef.current) {
          setMfIsRepainting(false);
          return;
        }

        for (const f of survivingFills) {
          if (newHidden.has(f.id)) continue;
          const origin = mfFillOrigins.current[f.id];
          if (!origin) continue;
          // Check again inside the loop — each fillAt is async.
          if (!isMagicFillActiveRef.current) break;
          await magicFill.fillAt(origin.x, origin.y, fc, origin.color, 40, origin.label);
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
      setMfIsRepainting(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Re-check after the double-rAF.
          if (!isMagicFillActiveRef.current) {
            setMfIsRepainting(false);
            // Still update state so color is correct when tool re-activates.
            setMagicFills(prev =>
              prev.map(f => {
                const change = colorChanges.find(c => c.fill.id === f.id);
                return change ? { ...f, color: change.newColor } : f;
              }),
            );
            return;
          }

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

  // ── fill → TakeoffRow helper ───────────────────────────────────────────────
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

  // ── Abort session ──────────────────────────────────────────────────────────
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
  }, [magicFill, fillCanvasRef]);

  // ── Ensure session start ───────────────────────────────────────────────────
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

  // ── Single click ───────────────────────────────────────────────────────────
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
        mfSessionColor.current       = null;
      }
      setMfIsFilling(false);
      setMfFillMsg('');
      return;
    }

    setMfFillMsg('Measuring');
    await yieldFrame();

    // Append mode
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
      mfIdToRowId.current[result.id]   = row.id;
      mfFillOrigins.current[result.id] = { x: canvasX, y: canvasY, color: existingColor, label: namedResult.label };
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

    // Normal mode
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
    fillCanvasRef, mfIsFilling, magicFill, yieldFrame, mfEnsureSessionStart,
    propAppendToGroupId, activeDrawingId, measurements,
    magicFillToRow, onAddMeasurementProp, onUpdateMeasurementProp, onAppendComplete,
  ]);

  // ── Batch rect ─────────────────────────────────────────────────────────────
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
      if (existingHeader?.color) mfSessionColor.current = existingHeader.color;
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
        mfSessionColor.current       = null;
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
    const numbered = results.map((r, i) => ({ ...r, label: `Fill ${startIdx + i + 1}` }));
    mfFillCounter.current += results.length;

    // Append mode
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

    // Normal mode
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
    fillCanvasRef, mfIsFilling, magicFill, yieldFrame, mfEnsureSessionStart,
    propAppendToGroupId, activeDrawingId, measurements,
    magicFillToRow, batchCommitMeasurements, onUpdateMeasurementProp, onAppendComplete,
  ]);

  // ── Hover ──────────────────────────────────────────────────────────────────
  const handleMagicHover = useCallback((canvasX: number, canvasY: number) => {
    const fc = fillCanvasRef.current;
    if (!fc) return;
    const id = magicFill.getPixelAt(canvasX, canvasY, fc);
    setMfHoveredId(id > 0 ? id : null);
    setMfHoverPos({ x: canvasX, y: canvasY });
  }, [magicFill, fillCanvasRef]);

  const handleMagicHoverLeave = useCallback(() => setMfHoveredId(null), []);

  // ── Fill holes ─────────────────────────────────────────────────────────────
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
    if (!result) { setMfIsFilling(false); setMfFillMsg(''); return; }

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
  }, [magicFill, fillCanvasRef, yieldFrame, activeDrawingId, mfMetersPerPixel, onUpdateMeasurementProp]);

  // ── Undo ───────────────────────────────────────────────────────────────────
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
        mfSessionColor.current       = null;
      } else if (mfSessionHasSnapshot.current && mfStagedFills.current.length > 0) {
        mfStagedFills.current.forEach(f => magicFill.unregisterFill(f.id));
        magicFill.undo(fc);
        mfSessionHasSnapshot.current = false;
        mfSessionColor.current       = null;
        mfStagedFills.current        = [];
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
  }, [magicFill, fillCanvasRef, onDeleteMeasurementProp]);

  // ── Clear all ──────────────────────────────────────────────────────────────
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
  }, [magicFill, fillCanvasRef, handleMagicAbortSession, onDeleteMeasurementProp]);

  // ── Delete single committed fill ───────────────────────────────────────────
  const handleMagicDelete = useCallback((id: number) => {
    magicFill.unregisterFill(id);
    setMagicFills(prev => prev.filter(f => f.id !== id));
    setMfSelectedId(prev => prev === id ? null : prev);
    setMfHoveredId(prev  => prev === id ? null : prev);
    const rowId = mfIdToRowId.current[id];
    if (rowId) {
      onDeleteMeasurementProp?.(rowId);
      delete mfIdToRowId.current[id];
      delete mfFillOrigins.current[id];
    }
  }, [magicFill, onDeleteMeasurementProp]);

  // ── Toggle visibility ──────────────────────────────────────────────────────
  const handleMagicToggleHide = useCallback((id: number) => {
    setMfHiddenIds(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  }, []);

  // ── Commit staged fills ────────────────────────────────────────────────────
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

  // ── Open name dialog ───────────────────────────────────────────────────────
  const handleMagicFinish = useCallback(() => {
    if (mfStagedFills.current.length === 0) return;
    mfPendingCommitRef.current = [...mfStagedFills.current];
    setPendingMfData({
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

  // ── allVisibleFills (merged for rendering) ─────────────────────────────────
  const allVisibleFills = useMemo(
    () => [...magicFills, ...mfStagedFills.current],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [magicFills, mfStagedCount],
  );

  return {
    allVisibleFills,
    magicFills,
    mfStagedCount,
    mfSelectedId,       setMfSelectedId,
    mfSelectedGroup,    setMfSelectedGroup,
    mfHoveredId,
    mfHoverPos,
    mfHolesClosed,
    mfHiddenIds,
    mfIsFilling,
    mfIsRepainting,
    mfFillMsg,
    mfFillSub,
    mfFillProgress,
    mfMetersPerPixel,
    mfLastFillPos,
    showMfNameDialog,
    pendingMfData,
    handleMagicSingleClick,
    handleMagicBatchRect,
    handleMagicHover,
    handleMagicHoverLeave,
    handleMagicFillHoles,
    handleMagicUndo,
    handleMagicClear,
    handleMagicDelete,
    handleMagicToggleHide,
    handleMagicAbortSession,
    handleMagicFinish,
    handleMfNameConfirm,
    handleMfNameSkip,
  };
}
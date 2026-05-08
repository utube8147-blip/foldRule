// ─── hooks/useMeasurements/useMeasurementCommit.ts ───────────────────────────
//
//  Extracted from useMeasurements.ts — #2 / #5 hook split.
//  Owns: finishMeasurement (all tool types + append), handleCanvasClick,
//        handleContextMenu, checkSnapCandidates, groupPointsBySegment.
//
//  Fix preserved from original:
//    #12 — single resolved appendToGroupId source of truth
//
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useCallback } from 'react';
import React from 'react';
import { TakeoffRow } from '@/types';
import { PdfDimensions, PendingSnapCandidate } from '@/types/viewerTypes';
import { getNextMeasurementColor } from './colors';
import { toCanvas as toCanvasUtil, toNorm as toNormUtil } from './utils';
import type { InProgressPoint } from '@/context/TakeoffContext';

interface UseMeasurementCommitParams {
  pdfDimensionsRef:        React.MutableRefObject<PdfDimensions | null>;
  pageNumberRef:           React.MutableRefObject<number>;
  scaleRef:                React.MutableRefObject<number>;
  activeTool:              string;
  setActiveTool:           (tool: string) => void;
  measurements:            TakeoffRow[];
  tempPoints:              InProgressPoint[];
  pushPoint:               (p: InProgressPoint) => void;
  commitMeasurement:       (m: TakeoffRow) => void;
  batchCommitMeasurements: (ms: TakeoffRow[]) => void;
  clearTempPoints:         () => void;
  scaleFactor:             number;
  onUpdateMeasurement?:    (id: string, updates: Partial<TakeoffRow>) => void;
  snapToCorner:            (x: number, y: number) => { point: { x: number; y: number }; snapped: boolean };
  triggerSnapFlash:        (x: number, y: number) => void;
  snapEnabledRef:          React.MutableRefObject<boolean>;
  snapThresholdRef:        React.MutableRefObject<number>;
  getScaledCorners:        (pageIdx: number) => Array<{ x: number; y: number; confidence: number }>;
  activeDrawingId:         string | null;
  drawingCanvasRef:        React.RefObject<HTMLCanvasElement>;
  cursorPointRef:          React.MutableRefObject<{ x: number; y: number } | null>;
  appendToGroupId?:        string | null;
  onAppendComplete?:       () => void;
  onScalePrompt:           (ptLen: number) => void;
  pendingBreak:            boolean;
  setPendingBreak:         (v: boolean) => void;
  nextSegmentIdRef:        React.MutableRefObject<string | null>;
  setCursorPoint:          (p: { x: number; y: number } | null) => void;
  setPendingSnapCandidates:(c: PendingSnapCandidate[] | null) => void;
  resetBreakState:         () => void;
}

// ── Helper: group InProgressPoints by segmentId ───────────────────────────────
export function groupPointsBySegment(points: InProgressPoint[]) {
  const segs: { segmentId: string; points: InProgressPoint[] }[] = [];
  let cur: InProgressPoint[] = [];
  let curId: string | undefined;
  for (const pt of points) {
    const id = pt.segmentId || 'default';
    if (curId !== id) {
      if (cur.length) segs.push({ segmentId: curId!, points: cur });
      cur = [pt]; curId = id;
    } else {
      cur.push(pt);
    }
  }
  if (cur.length) segs.push({ segmentId: curId!, points: cur });
  return segs;
}

export function useMeasurementCommit({
  pdfDimensionsRef,
  pageNumberRef,
  scaleRef,
  activeTool,
  setActiveTool,
  measurements,
  tempPoints,
  pushPoint,
  commitMeasurement,
  batchCommitMeasurements,
  clearTempPoints,
  scaleFactor,
  onUpdateMeasurement,
  snapToCorner,
  triggerSnapFlash,
  snapEnabledRef,
  snapThresholdRef,
  getScaledCorners,
  activeDrawingId,
  drawingCanvasRef,
  cursorPointRef,
  appendToGroupId,
  onAppendComplete,
  onScalePrompt,
  pendingBreak,
  setPendingBreak,
  nextSegmentIdRef,
  setCursorPoint,
  setPendingSnapCandidates,
  resetBreakState,
}: UseMeasurementCommitParams) {

  const toCanvas = useCallback((normX: number, normY: number) => {
    return toCanvasUtil(normX, normY, pdfDimensionsRef.current);
  }, [pdfDimensionsRef]);

  const toNorm = useCallback((canvasX: number, canvasY: number) => {
    return toNormUtil(canvasX, canvasY, pdfDimensionsRef.current);
  }, [pdfDimensionsRef]);

  // ── Post-commit snap candidate check ────────────────────────────────────────
  const checkSnapCandidates = useCallback((pts: InProgressPoint[], measurementId: string) => {
    if (!snapEnabledRef.current || !pdfDimensionsRef.current) return;
    const free = pts.map((p, i) => ({ ...p, index: i })).filter(p => !p.snapped);
    if (free.length === 0) return;
    const corners = getScaledCorners(pageNumberRef.current);
    const cands: PendingSnapCandidate[] = [];
    for (const fp of free) {
      const fc = toCanvas(fp.x, fp.y);
      let best = snapThresholdRef.current * 2;
      let tgt: { x: number; y: number } | null = null;
      for (const c of corners) {
        const d = Math.hypot(fc.x - c.x, fc.y - c.y);
        if (d < best) { best = d; tgt = { x: c.x, y: c.y }; }
      }
      if (tgt) cands.push({ pointIndex: fp.index, measurementId, snapTarget: toNorm(tgt.x, tgt.y) });
    }
    if (cands.length) setPendingSnapCandidates(cands);
  }, [getScaledCorners, toCanvas, toNorm, pdfDimensionsRef, pageNumberRef, snapEnabledRef, snapThresholdRef, setPendingSnapCandidates]);

  // ── FIX #12: single resolved appendToGroupId source of truth ─────────────
  const finishMeasurement = useCallback((
    currentTempPoints?: InProgressPoint[],
    meta?: { label?: string; icon?: string; appendToGroupId?: string },
  ) => {
    const pts = currentTempPoints ?? tempPoints;
    resetBreakState();

    const resolvedAppendTarget = appendToGroupId ?? meta?.appendToGroupId ?? null;

    if (resolvedAppendTarget) {
      const targetGroup = measurements.find(m => m.id === resolvedAppendTarget);
      if (!targetGroup) { clearTempPoints(); return; }

      const activeType = activeTool === 'linear' ? 'Length'
        : activeTool === 'polygon' ? 'Polygon'
        : activeTool === 'rectangle' ? 'Rectangle'
        : activeTool === 'count' ? 'Count'
        : activeTool === 'point' ? 'Point'
        : null;

      if (activeType !== targetGroup.type) {
        console.warn(`Cannot append ${activeType} to ${targetGroup.type} group`);
        clearTempPoints();
        return;
      }

      // ─── POINT ────────────────────────────────────────────────────────────
      if (activeTool === 'point') {
        if (pts.length < 1) { clearTempPoints(); return; }
        const newChildId = crypto.randomUUID();
        const childNumber = (targetGroup.childIds?.length ?? 0) + 1;
        commitMeasurement({
          id: newChildId, drawingId: activeDrawingId || '',
          description: `${targetGroup.label || targetGroup.description} ${childNumber}`,
          label: targetGroup.label || targetGroup.description,
          type: 'Point', quantity: 1, unit: 'PT', unitRate: 0, notes: '',
          points: [{ x: pts[0].x, y: pts[0].y }],
          isOverridden: false, color: targetGroup.color, isVisible: true,
          parentId: targetGroup.id, childIds: [],
        });
        onUpdateMeasurement?.(targetGroup.id, {
          childIds: [...(targetGroup.childIds ?? []), newChildId],
          quantity: (targetGroup.quantity ?? 0) + 1,
        });
        clearTempPoints(); setCursorPoint(null); onAppendComplete?.(); return;
      }

      // ─── COUNT ────────────────────────────────────────────────────────────
      if (activeTool === 'count') {
        if (pts.length < 1) { clearTempPoints(); return; }
        const newChildId = crypto.randomUUID();
        const childNumber = (targetGroup.childIds?.length ?? 0) + 1;
        commitMeasurement({
          id: newChildId, drawingId: activeDrawingId || '',
          description: `${targetGroup.label || targetGroup.description} ${childNumber}`,
          label: targetGroup.label || targetGroup.description,
          type: 'Count', quantity: 1, unit: 'EA', unitRate: 0, notes: '',
          points: [{ x: pts[0].x, y: pts[0].y }],
          isOverridden: false, color: targetGroup.color, isVisible: true,
          parentId: targetGroup.id, childIds: [],
        });
        onUpdateMeasurement?.(targetGroup.id, {
          childIds: [...(targetGroup.childIds ?? []), newChildId],
          quantity: (targetGroup.quantity ?? 0) + 1,
        });
        clearTempPoints(); setCursorPoint(null); onAppendComplete?.(); return;
      }

      // ─── LINEAR ───────────────────────────────────────────────────────────
      if (activeTool === 'linear') {
        const segCanvas = pts.map(p => toCanvas(p.x, p.y));
        let len = 0;
        for (let i = 1; i < segCanvas.length; i++)
          len += Math.hypot(segCanvas[i].x - segCanvas[i-1].x, segCanvas[i].y - segCanvas[i-1].y);
        const quantity = len / scaleRef.current * scaleFactor;
        const newChildId = crypto.randomUUID();
        commitMeasurement({
          id: newChildId, drawingId: activeDrawingId || '',
          description: `Section ${(targetGroup.childIds?.length ?? 0) + 1}`,
          label: `Section ${(targetGroup.childIds?.length ?? 0) + 1}`,
          type: 'Length', quantity, unit: 'm', unitRate: 0, notes: '',
          points: pts.map(p => ({ x: p.x, y: p.y })),
          isOverridden: false, color: targetGroup.color, isVisible: true,
          parentId: targetGroup.id, childIds: [],
        });
        onUpdateMeasurement?.(targetGroup.id, {
          childIds: [...(targetGroup.childIds ?? []), newChildId],
          quantity: (targetGroup.quantity ?? 0) + quantity,
        });
        clearTempPoints(); setCursorPoint(null); onAppendComplete?.(); return;
      }

      // ─── POLYGON ──────────────────────────────────────────────────────────
      if (activeTool === 'polygon') {
        const allSegs = groupPointsBySegment(pts);
        const validSegs = allSegs.filter(s => s.points.length >= 3);
        if (validSegs.length === 0) { clearTempPoints(); return; }
        const zoom = scaleRef.current;
        const calcArea = (points: { x: number; y: number }[]) => {
          let a = 0;
          for (let i = 0; i < points.length; i++) {
            const j = (i + 1) % points.length;
            a += points[i].x * points[j].y - points[j].x * points[i].y;
          }
          return Math.abs(a) / 2 / (zoom * zoom) * scaleFactor * scaleFactor;
        };
        const newPoints = validSegs[0].points.map(p => ({ x: p.x, y: p.y }));
        const newQuantity = calcArea(newPoints.map(p => toCanvas(p.x, p.y)));
        const newChildId = crypto.randomUUID();
        commitMeasurement({
          id: newChildId, drawingId: activeDrawingId || '',
          description: `Shape ${(targetGroup.childIds?.length ?? 0) + 1}`,
          label: targetGroup.label || targetGroup.description,
          type: 'Polygon', quantity: newQuantity, unit: 'sq m', unitRate: 0, notes: '',
          points: newPoints, isOverridden: false, color: targetGroup.color,
          isVisible: true, parentId: targetGroup.id, childIds: [],
        });
        onUpdateMeasurement?.(targetGroup.id, {
          childIds: [...(targetGroup.childIds ?? []), newChildId],
          quantity: (targetGroup.quantity ?? 0) + newQuantity,
        });
        clearTempPoints(); setCursorPoint(null); onAppendComplete?.(); return;
      }

      // ─── RECTANGLE ────────────────────────────────────────────────────────
      if (activeTool === 'rectangle') {
        const allSegs = groupPointsBySegment(pts);
        const validSegs = allSegs.filter(s => s.points.length === 2);
        if (validSegs.length === 0) { clearTempPoints(); return; }
        const zoom = scaleRef.current;
        const rectFromTwo = (p1n: { x: number; y: number }, p2n: { x: number; y: number }) => {
          const p1 = toCanvas(p1n.x, p1n.y);
          const p2 = toCanvas(p2n.x, p2n.y);
          const r4 = [
            { x: p1.x, y: p1.y }, { x: p2.x, y: p1.y },
            { x: p2.x, y: p2.y }, { x: p1.x, y: p2.y },
          ];
          let a = 0;
          for (let i = 0; i < 4; i++) {
            const j = (i + 1) % 4;
            a += r4[i].x * r4[j].y - r4[j].x * r4[i].y;
          }
          return { normPoints: r4.map(p => toNorm(p.x, p.y)), area: Math.abs(a) / 2 / (zoom * zoom) * scaleFactor * scaleFactor };
        };
        const { normPoints, area } = rectFromTwo(validSegs[0].points[0], validSegs[0].points[1]);
        const newChildId = crypto.randomUUID();
        commitMeasurement({
          id: newChildId, drawingId: activeDrawingId || '',
          description: `Rectangle ${(targetGroup.childIds?.length ?? 0) + 1}`,
          label: targetGroup.label || targetGroup.description,
          type: 'Rectangle', quantity: area, unit: 'sq m', unitRate: 0, notes: '',
          points: normPoints, isOverridden: false, color: targetGroup.color,
          isVisible: true, parentId: targetGroup.id, childIds: [],
        });
        onUpdateMeasurement?.(targetGroup.id, {
          childIds: [...(targetGroup.childIds ?? []), newChildId],
          quantity: (targetGroup.quantity ?? 0) + area,
        });
        clearTempPoints(); setCursorPoint(null); onAppendComplete?.(); return;
      }
    }

    // ─── REGULAR FINISH (NO APPEND) ──────────────────────────────────────────

    if (activeTool === 'point') {
      if (pts.length < 1) { clearTempPoints(); setCursorPoint(null); return; }
      const label = meta?.label || 'Point Marker';
      commitMeasurement({
        id: crypto.randomUUID(), drawingId: activeDrawingId || '',
        description: label, label, type: 'Point',
        quantity: 1, unit: 'PT', unitRate: 0, notes: '',
        points: [{ x: pts[0].x, y: pts[0].y }],
        isOverridden: false, color: getNextMeasurementColor(), isVisible: true, childIds: [],
      });
      clearTempPoints(); setCursorPoint(null); return;
    }

    if (activeTool === 'count') {
      if (pts.length < 1) { clearTempPoints(); setCursorPoint(null); return; }
      const groupId    = crypto.randomUUID();
      const groupColor = getNextMeasurementColor();
      const groupLabel = meta?.label || 'New Count Group';
      const groupIcon  = meta?.icon;
      const childIds: string[] = [];
      const children: TakeoffRow[] = [];
      for (let i = 0; i < pts.length; i++) {
        const cid = crypto.randomUUID();
        childIds.push(cid);
        children.push({
          id: cid, drawingId: activeDrawingId || '',
          description: `${groupLabel} ${i + 1}`,
          label: groupLabel, icon: groupIcon, type: 'Count',
          quantity: 1, unit: 'EA', unitRate: 0, notes: '',
          points: [{ x: pts[i].x, y: pts[i].y }],
          isOverridden: false, color: groupColor, isVisible: true,
          parentId: groupId, childIds: [],
        });
      }
      const parent: TakeoffRow = {
        id: groupId, drawingId: activeDrawingId || '',
        description: groupLabel, label: groupLabel, icon: groupIcon, type: 'Count',
        quantity: pts.length, unit: 'EA', unitRate: 0, notes: '', points: [],
        isOverridden: false, color: groupColor, isVisible: true,
        isGroupHeader: true, childIds,
      };
      batchCommitMeasurements([parent, ...children]);
      clearTempPoints(); setCursorPoint(null); return;
    }

    if (activeTool === 'scale') {
      if (tempPoints.length === 0) {
        clearTempPoints(); setCursorPoint(null); return;
      } else {
        const p0 = toCanvas(tempPoints[0].x, tempPoints[0].y);
        const p1 = toCanvas(pts[pts.length - 1].x, pts[pts.length - 1].y);
        const ptLen = Math.hypot(p1.x - p0.x, p1.y - p0.y) / scaleRef.current;
        clearTempPoints();
        setCursorPoint(null);
        cursorPointRef.current = null;
        resetBreakState();
        setActiveTool('select');
        onScalePrompt(ptLen);
      }
      return;
    }

    if (pts.length < 2) { clearTempPoints(); setCursorPoint(null); return; }

    const zoom       = scaleRef.current;
    const newId      = crypto.randomUUID();
    const groupColor = getNextMeasurementColor();

    // ── Linear ────────────────────────────────────────────────────────────────
    if (activeTool === 'linear') {
      const allSegs   = groupPointsBySegment(pts);
      const validSegs = allSegs.filter(s => s.points.length >= 2);
      if (validSegs.length === 0) { clearTempPoints(); setCursorPoint(null); return; }
      const groupLabel = meta?.label || 'New Length';
      const segLength = (seg: typeof validSegs[0]) => {
        const sc = seg.points.map(p => toCanvas(p.x, p.y));
        let len = 0;
        for (let i = 1; i < sc.length; i++)
          len += Math.hypot(sc[i].x - sc[i-1].x, sc[i].y - sc[i-1].y);
        return len / zoom * scaleFactor;
      };
      const totalQty = validSegs.reduce((sum, seg) => sum + segLength(seg), 0);
      if (validSegs.length === 1) {
        commitMeasurement({
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Length', quantity: totalQty, unit: 'm', unitRate: 0, notes: '',
          points: validSegs[0].points.map(p => ({ x: p.x, y: p.y })),
          isOverridden: false, color: groupColor, isVisible: true, childIds: [],
        });
      } else {
        const childIds: string[] = [];
        const children: TakeoffRow[] = [];
        validSegs.forEach((seg, idx) => {
          const cid = crypto.randomUUID();
          childIds.push(cid);
          children.push({
            id: cid, drawingId: activeDrawingId || '',
            description: `Section ${idx + 1}`, label: `Section ${idx + 1}`,
            type: 'Length', quantity: segLength(seg), unit: 'm', unitRate: 0, notes: '',
            points: seg.points.map(p => ({ x: p.x, y: p.y })),
            isOverridden: false, color: groupColor, isVisible: true, parentId: newId, childIds: [],
          });
        });
        batchCommitMeasurements([{
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Length', quantity: totalQty, unit: 'm', unitRate: 0, notes: '', points: [],
          isOverridden: false, color: groupColor, isVisible: true, isGroupHeader: true, childIds,
        }, ...children]);
      }
      clearTempPoints(); setCursorPoint(null);
      checkSnapCandidates(pts, newId); return;
    }

    // ── Polygon ───────────────────────────────────────────────────────────────
    if (activeTool === 'polygon') {
      const allSegs   = groupPointsBySegment(pts);
      const validSegs = allSegs.filter(s => s.points.length >= 3);
      if (validSegs.length === 0) { clearTempPoints(); setCursorPoint(null); return; }
      const groupLabel = meta?.label || 'New Polygon';
      const calcPolyArea = (points: { x: number; y: number }[]) => {
        let a = 0;
        for (let i = 0; i < points.length; i++) {
          const j = (i + 1) % points.length;
          a += points[i].x * points[j].y - points[j].x * points[i].y;
        }
        return Math.abs(a) / 2 / (zoom * zoom) * scaleFactor * scaleFactor;
      };
      const segArea = (seg: typeof validSegs[0]) =>
        calcPolyArea(seg.points.map(p => toCanvas(p.x, p.y)));
      const totalArea = validSegs.reduce((sum, seg) => sum + segArea(seg), 0);
      if (validSegs.length === 1) {
        commitMeasurement({
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Polygon', quantity: totalArea, unit: 'sq m', unitRate: 0, notes: '',
          points: validSegs[0].points.map(p => ({ x: p.x, y: p.y })),
          isOverridden: false, color: groupColor, isVisible: true, childIds: [],
        });
      } else {
        const childIds: string[] = [];
        const children: TakeoffRow[] = [];
        validSegs.forEach((seg, idx) => {
          const cid = crypto.randomUUID();
          childIds.push(cid);
          children.push({
            id: cid, drawingId: activeDrawingId || '',
            description: `Shape ${idx + 1}`, label: `Shape ${idx + 1}`,
            type: 'Polygon', quantity: segArea(seg), unit: 'sq m', unitRate: 0, notes: '',
            points: seg.points.map(p => ({ x: p.x, y: p.y })),
            isOverridden: false, color: groupColor, isVisible: true, parentId: newId, childIds: [],
          });
        });
        batchCommitMeasurements([{
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Polygon', quantity: totalArea, unit: 'sq m', unitRate: 0, notes: '', points: [],
          isOverridden: false, color: groupColor, isVisible: true, isGroupHeader: true, childIds,
        }, ...children]);
      }
      clearTempPoints(); setCursorPoint(null);
      checkSnapCandidates(pts, newId); return;
    }

    // ── Rectangle ─────────────────────────────────────────────────────────────
    if (activeTool === 'rectangle') {
      const allSegs   = groupPointsBySegment(pts);
      const validSegs = allSegs.filter(s => s.points.length === 2);
      if (validSegs.length === 0) { clearTempPoints(); setCursorPoint(null); return; }
      const groupLabel = meta?.label || 'New Rectangle';
      const rectFromTwo = (p1n: { x: number; y: number }, p2n: { x: number; y: number }) => {
        const p1 = toCanvas(p1n.x, p1n.y);
        const p2 = toCanvas(p2n.x, p2n.y);
        const r4 = [
          { x: p1.x, y: p1.y }, { x: p2.x, y: p1.y },
          { x: p2.x, y: p2.y }, { x: p1.x, y: p2.y },
        ];
        let a = 0;
        for (let i = 0; i < 4; i++) {
          const j = (i + 1) % 4;
          a += r4[i].x * r4[j].y - r4[j].x * r4[i].y;
        }
        return { normPoints: r4.map(p => toNorm(p.x, p.y)), area: Math.abs(a) / 2 / (zoom * zoom) * scaleFactor * scaleFactor };
      };
      const totalArea = validSegs.reduce((s, seg) => s + rectFromTwo(seg.points[0], seg.points[1]).area, 0);
      if (validSegs.length === 1) {
        const { normPoints, area } = rectFromTwo(validSegs[0].points[0], validSegs[0].points[1]);
        commitMeasurement({
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Rectangle', quantity: area, unit: 'sq m', unitRate: 0, notes: '',
          points: normPoints, isOverridden: false, color: groupColor, isVisible: true, childIds: [],
        });
      } else {
        const childIds: string[] = [];
        const children: TakeoffRow[] = [];
        validSegs.forEach((seg, idx) => {
          const cid = crypto.randomUUID();
          childIds.push(cid);
          const { normPoints, area } = rectFromTwo(seg.points[0], seg.points[1]);
          children.push({
            id: cid, drawingId: activeDrawingId || '',
            description: `Rectangle ${idx + 1}`, label: `Rectangle ${idx + 1}`,
            type: 'Rectangle', quantity: area, unit: 'sq m', unitRate: 0, notes: '',
            points: normPoints, isOverridden: false, color: groupColor, isVisible: true, parentId: newId, childIds: [],
          });
        });
        batchCommitMeasurements([{
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Rectangle', quantity: totalArea, unit: 'sq m', unitRate: 0, notes: '', points: [],
          isOverridden: false, color: groupColor, isVisible: true, isGroupHeader: true, childIds,
        }, ...children]);
      }
      clearTempPoints(); setCursorPoint(null);
      checkSnapCandidates(pts, newId); return;
    }
  }, [
    tempPoints, activeTool, scaleFactor, commitMeasurement, batchCommitMeasurements,
    clearTempPoints, setActiveTool, checkSnapCandidates, toCanvas, toNorm,
    activeDrawingId, scaleRef, resetBreakState, onUpdateMeasurement, measurements,
    onScalePrompt, cursorPointRef, onAppendComplete, appendToGroupId, setCursorPoint,
  ]);

  // ── handleCanvasClick ─────────────────────────────────────────────────────
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === 'select') return;
    if (e.button !== 0) return;

    const canvas = drawingCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const rawX = (e.clientX - rect.left) * (canvas.width / rect.width);
    const rawY = (e.clientY - rect.top)  * (canvas.height / rect.height);

    const snap = snapToCorner(rawX, rawY);
    if (snap.snapped) triggerSnapFlash(snap.point.x, snap.point.y);
    const norm = toNorm(snap.point.x, snap.point.y);

    if (activeTool === 'point') {
      commitMeasurement({
        id: crypto.randomUUID(), drawingId: activeDrawingId || '',
        description: 'Point Marker', type: 'Point',
        quantity: 1, unit: 'PT', unitRate: 0, notes: '',
        points: [norm], isOverridden: false, color: getNextMeasurementColor(),
        isVisible: true, label: '', childIds: [],
      });
      return;
    }

    if (activeTool === 'count') {
      pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped });
      return;
    }

    if (activeTool === 'linear') {
      let segmentId: string;
      if (tempPoints.length === 0) {
        segmentId = crypto.randomUUID();
      } else if (pendingBreak) {
        segmentId = nextSegmentIdRef.current ?? crypto.randomUUID();
        nextSegmentIdRef.current = null;
        setPendingBreak(false);
      } else {
        segmentId = tempPoints[tempPoints.length - 1].segmentId!;
      }
      pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped, segmentId });
      return;
    }

    if (activeTool === 'polygon') {
      let segmentId: string;
      if (tempPoints.length === 0) {
        segmentId = crypto.randomUUID();
      } else if (pendingBreak) {
        segmentId = nextSegmentIdRef.current ?? crypto.randomUUID();
        nextSegmentIdRef.current = null;
        setPendingBreak(false);
      } else {
        segmentId = tempPoints[tempPoints.length - 1].segmentId!;
      }
      pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped, segmentId });
      return;
    }

    if (activeTool === 'rectangle') {
      let segmentId: string;
      if (tempPoints.length === 0) {
        segmentId = crypto.randomUUID();
      } else if (pendingBreak) {
        segmentId = nextSegmentIdRef.current ?? crypto.randomUUID();
        nextSegmentIdRef.current = null;
        setPendingBreak(false);
      } else {
        const segs = groupPointsBySegment(tempPoints);
        const lastSeg = segs[segs.length - 1];
        segmentId = lastSeg.points.length >= 2
          ? crypto.randomUUID()
          : tempPoints[tempPoints.length - 1].segmentId!;
      }
      pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped, segmentId });
      return;
    }

    if (activeTool === 'scale') {
      if (tempPoints.length === 0) {
        pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped });
      } else {
        const p0 = toCanvas(tempPoints[0].x, tempPoints[0].y);
        const p1 = { x: snap.point.x, y: snap.point.y };
        const ptLen = Math.hypot(p1.x - p0.x, p1.y - p0.y) / scaleRef.current;
        clearTempPoints();
        setCursorPoint(null);
        cursorPointRef.current = null;
        resetBreakState();
        setActiveTool('select');
        onScalePrompt(ptLen);
      }
      return;
    }

    pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped });
  }, [
    activeTool, snapToCorner, triggerSnapFlash, toNorm, toCanvas,
    commitMeasurement, pushPoint, clearTempPoints, drawingCanvasRef, activeDrawingId,
    tempPoints, pendingBreak, scaleRef, resetBreakState,
    setActiveTool, cursorPointRef, onScalePrompt, nextSegmentIdRef, setPendingBreak, setCursorPoint,
  ]);

  // ── handleContextMenu ─────────────────────────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (activeTool === 'select') return;

    if (activeTool === 'count' || activeTool === 'point') {
      finishMeasurement();
      return;
    }

    if (activeTool === 'linear' || activeTool === 'polygon') {
      if (tempPoints.length === 0) return;
      if (appendToGroupId && tempPoints.length >= (activeTool === 'linear' ? 2 : 3)) {
        finishMeasurement();
        return;
      }
      nextSegmentIdRef.current = crypto.randomUUID();
      setPendingBreak(true);
      return;
    }

    if (activeTool === 'rectangle') {
      if (tempPoints.length === 0) return;
      if (appendToGroupId && tempPoints.length >= 2) {
        finishMeasurement();
        return;
      }
      nextSegmentIdRef.current = crypto.randomUUID();
      setPendingBreak(true);
      return;
    }
  }, [activeTool, tempPoints, finishMeasurement, appendToGroupId, nextSegmentIdRef, setPendingBreak]);

  return {
    finishMeasurement,
    handleCanvasClick,
    handleContextMenu,
    checkSnapCandidates,
  };
}
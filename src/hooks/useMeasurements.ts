// ─── useMeasurements.ts ───────────────────────────────────────────────────────
//
//  BEHAVIOUR for linear / polygon / rectangle:
//    • Left-click      → add a point to the current segment
//    • Right-click     → break continuity; sets pendingBreak = true and
//                        pre-generates a new segmentId stored in nextSegmentIdRef.
//                        No point is pushed at right-click time.
//                        The NEXT left-click consumes pendingBreak, uses the
//                        pre-generated segmentId, and pushes the first point of
//                        the new segment — writing a real boundary into
//                        tempPoints so groupPointsBySegment splits correctly.
//                        Count / point: finishes immediately on right-click.
//    • Finish button   → commit all segments as ONE named group. Each segment
//                        (≥2 pts for linear/polygon, exactly 2 for rectangle)
//                        becomes its own child row in the takeoff table.
//    • ESC             → cancel
//
//  FIX 1: React onClick never fires for right-clicks (button 2).
//         All right-click logic lives in handleContextMenu only.
//
//  FIX 2: Each broken segment is saved as a separate child row under the group.
//         Segments with fewer points than the minimum are discarded before commit.
//         The parent group row shows the summed quantity; each child shows its own.
//
//  FIX 3: Right-click pre-generates nextSegmentIdRef and sets pendingBreak=true.
//         Next left-click writes that new segmentId into tempPoints, creating a
//         real data boundary that survives until finishMeasurement is called.
//         This fixed the bug where Finish ignored breaks and treated all points
//         as one segment.
//
//  FIX 4: Batch commit all parent + children at once to eliminate race condition.
//         Uses batchCommitMeasurements from context for atomic updates.
//
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useEffect, useCallback, useState } from 'react';
import { TakeoffRow, MeasurementType } from '../types';
import { SnapResult, PendingSnapCandidate, PdfDimensions } from '../types/viewerTypes';
import type { InProgressPoint } from '@/context/TakeoffContext';

// ─── Color palette ────────────────────────────────────────────────────────────
const MEASUREMENT_COLORS = [
  '#EF9F27', '#3B82F6', '#10B981', '#F43F5E', '#8B5CF6',
  '#06B6D4', '#F97316', '#EC4899', '#14B8A6', '#6366F1',
  '#84CC16', '#A855F7',
];
let colorIndex = 0;
export function getNextMeasurementColor(): string {
  return MEASUREMENT_COLORS[colorIndex++ % MEASUREMENT_COLORS.length];
}
export function resetColorIndex(): void { colorIndex = 0; }

// ─── Hook params ──────────────────────────────────────────────────────────────

export interface UseMeasurementsParams {
  drawingCanvasRef:     React.RefObject<HTMLCanvasElement>;
  pdfDimensionsRef:     React.MutableRefObject<PdfDimensions | null>;
  pageNumberRef:        React.MutableRefObject<number>;
  scaleRef:             React.MutableRefObject<number>;
  activeTool:           string;
  setActiveTool:        (tool: string) => void;
  measurements:         TakeoffRow[];
  tempPoints:           InProgressPoint[];
  pushPoint:            (point: InProgressPoint) => void;
  commitMeasurement:    (m: TakeoffRow) => void;
  batchCommitMeasurements: (measurements: TakeoffRow[]) => void; // ADDED for batch commits
  clearTempPoints:      () => void;
  scaleFactor:          number;
  onUpdateMeasurement?: (id: string, updates: Partial<TakeoffRow>) => void;
  isPanning:            boolean;
  snapToCorner:         (rawX: number, rawY: number) => SnapResult;
  getScaledCorners:     (pageIdx: number) => Array<{ x: number; y: number; confidence: number }>;
  triggerSnapFlash:     (x: number, y: number) => void;
  snapEnabled:          boolean;
  snapThreshold:        number;
  redrawPinCanvas:      () => void;
  cursorPointRef:       React.MutableRefObject<{ x: number; y: number } | null>;
  activeDrawingId:      string | null;
}

// ─── Hook return ──────────────────────────────────────────────────────────────

export interface UseMeasurementsReturn {
  cursorPoint:              { x: number; y: number } | null;
  setCursorPoint:           React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  pendingSnapCandidates:    PendingSnapCandidate[] | null;
  setPendingSnapCandidates: React.Dispatch<React.SetStateAction<PendingSnapCandidate[] | null>>;
  finishMeasurement:        (pts?: InProgressPoint[], meta?: { label?: string; icon?: string }) => void;
  handleCanvasClick:        (e: React.MouseEvent<HTMLCanvasElement>) => void;
  handleContextMenu:        (e: React.MouseEvent<HTMLCanvasElement>) => void;
  handleCanvasPointerMove:  (e: React.PointerEvent<HTMLCanvasElement>) => void;
  toCanvas:                 (normX: number, normY: number) => { x: number; y: number };
  toNorm:                   (canvasX: number, canvasY: number) => { x: number; y: number };
  pendingBreak:             boolean;
}

// ─── useMeasurements ─────────────────────────────────────────────────────────

export function useMeasurements({
  drawingCanvasRef, pdfDimensionsRef, pageNumberRef, scaleRef,
  activeTool, setActiveTool, measurements, tempPoints,
  pushPoint, commitMeasurement, batchCommitMeasurements, clearTempPoints, scaleFactor,
  onUpdateMeasurement, isPanning, snapToCorner, getScaledCorners,
  triggerSnapFlash, snapEnabled, snapThreshold, redrawPinCanvas,
  cursorPointRef, activeDrawingId,
}: UseMeasurementsParams): UseMeasurementsReturn {

  const [cursorPoint, setCursorPoint] = useState<{ x: number; y: number } | null>(null);
  const [pendingSnapCandidates, setPendingSnapCandidates] = useState<PendingSnapCandidate[] | null>(null);

  // ── Break state ───────────────────────────────────────────────────────────
  const [pendingBreak, setPendingBreak] = useState(false);
  const nextSegmentIdRef = useRef<string | null>(null);

  const snapEnabledRef   = useRef(snapEnabled);
  const snapThresholdRef = useRef(snapThreshold);
  useEffect(() => { snapEnabledRef.current   = snapEnabled;   }, [snapEnabled]);
  useEffect(() => { snapThresholdRef.current = snapThreshold; }, [snapThreshold]);

  // ── Coordinate helpers ────────────────────────────────────────────────────

  const toNorm = useCallback((canvasX: number, canvasY: number) => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return { x: canvasX, y: canvasY };
    return { x: canvasX / dims.w, y: canvasY / dims.h };
  }, [pdfDimensionsRef]);

  const toCanvas = useCallback((normX: number, normY: number) => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return { x: normX, y: normY };
    return { x: normX * dims.w, y: normY * dims.h };
  }, [pdfDimensionsRef]);

  // ── resetBreakState ───────────────────────────────────────────────────────
  const resetBreakState = useCallback(() => {
    setPendingBreak(false);
    nextSegmentIdRef.current = null;
  }, []);

  // ── Clear on tool switch ──────────────────────────────────────────────────
  useEffect(() => {
    clearTempPoints();
    setCursorPoint(null);
    cursorPointRef.current = null;
    resetBreakState();
  }, [activeTool, clearTempPoints, cursorPointRef, resetBreakState]);

  // ─────────────────────────────────────────────────────────────────────────
  // ── Main drawing effect ───────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);

    rafIdRef.current = requestAnimationFrame(() => {
      const canvas = drawingCanvasRef.current;
      const dims   = pdfDimensionsRef.current;
      if (!canvas || !dims) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // ──────────────────────────────────────────────────────────────────
      // 1.  COMMITTED MEASUREMENTS
      // ──────────────────────────────────────────────────────────────────
      measurements.forEach(m => {
        // Do not draw the overarching parent group! (It connects the breaks)
        if (m.isGroupHeader && m.childIds && m.childIds.length > 0) return;

        if (!m.isVisible || m.points.length === 0) return;
        const pts = m.points.map(p => toCanvas(p.x, p.y));

        if (m.type === 'Count' || m.type === 'Point') {
          pts.forEach(p => {
            ctx.save();
            ctx.beginPath();
            ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
            ctx.fillStyle = m.color + '18';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            ctx.fillStyle = m.color;
            ctx.fill();
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.6)';
            ctx.lineWidth = 1.2;
            ctx.stroke();
            ctx.restore();
          });
        } else {
          ctx.strokeStyle = m.color;
          ctx.fillStyle   = m.color + '55';
          ctx.lineWidth   = 2.5;
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
          if (m.type === 'Polygon' || m.type === 'Rectangle') {
            ctx.closePath();
            ctx.fill();
          }
          ctx.stroke();
          pts.forEach(p => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            ctx.fillStyle   = m.color + '88';
            ctx.fill();
            ctx.strokeStyle = m.color;
            ctx.stroke();
          });
        }
      });

      // ──────────────────────────────────────────────────────────────────
      // 2.  IN-PROGRESS TEMP POINTS
      // ──────────────────────────────────────────────────────────────────
      const tempPx = tempPoints.map(p => ({
        ...toCanvas(p.x, p.y),
        snapped:   p.snapped,
        segmentId: p.segmentId,
      }));

      const hasTemp   = tempPx.length > 0;
      const hasCursor = !!cursorPoint && activeTool !== 'select';
      if (!hasTemp && !hasCursor) return;

      const strokeColor = '#F59E0B';

      // ── COUNT ─────────────────────────────────────────────────────────
      if (activeTool === 'count') {
        const DOT_R = 5;
        tempPx.forEach((p, idx) => {
          ctx.save();
          ctx.beginPath();
          ctx.arc(p.x, p.y, DOT_R * 1.8, 0, Math.PI * 2);
          ctx.fillStyle = (p.snapped ? '#22C55E' : strokeColor) + '22';
          ctx.fill();
          if (!p.snapped) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, DOT_R + 4, 0, Math.PI * 2);
            ctx.strokeStyle = strokeColor + '60';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
          ctx.beginPath();
          ctx.arc(p.x, p.y, DOT_R, 0, Math.PI * 2);
          ctx.fillStyle = p.snapped ? '#22C55E' : strokeColor;
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.7)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
          const bx = p.x + DOT_R + 2;
          const by = p.y - DOT_R - 2;
          ctx.beginPath();
          ctx.arc(bx, by, 6, 0, Math.PI * 2);
          ctx.fillStyle = p.snapped ? '#22C55E' : strokeColor;
          ctx.fill();
          ctx.fillStyle    = 'black';
          ctx.font         = 'bold 8px monospace';
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText((idx + 1).toString(), bx, by);
          ctx.restore();
        });
        if (cursorPoint) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(cursorPoint.x, cursorPoint.y, DOT_R, 0, Math.PI * 2);
          ctx.strokeStyle = strokeColor + '70';
          ctx.lineWidth   = 1.5;
          ctx.setLineDash([3, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }
        if (cursorPoint && tempPx.length > 0) {
          const text = `${tempPx.length} placed — click Finish to commit`;
          ctx.save();
          ctx.font         = 'bold 11px monospace';
          ctx.textAlign    = 'left';
          ctx.textBaseline = 'alphabetic';
          const tw = ctx.measureText(text).width;
          ctx.fillStyle = strokeColor;
          ctx.fillRect(cursorPoint.x + DOT_R + 8, cursorPoint.y - 20, tw + 10, 19);
          ctx.fillStyle = 'black';
          ctx.fillText(text, cursorPoint.x + DOT_R + 13, cursorPoint.y - 5);
          ctx.restore();
        }
        return;
      }

      // ── LINEAR / POLYGON / RECTANGLE / SCALE ─────────────────────────
      ctx.strokeStyle = strokeColor;
      ctx.setLineDash([5, 5]);
      ctx.lineWidth   = 2;

      const segGroups: { id: string | undefined; pts: typeof tempPx }[] = [];
      for (const p of tempPx) {
        const last = segGroups[segGroups.length - 1];
        if (!last || last.id !== p.segmentId) {
          segGroups.push({ id: p.segmentId, pts: [p] });
        } else {
          last.pts.push(p);
        }
      }

      if (activeTool === 'linear' || activeTool === 'polygon' || activeTool === 'rectangle') {
        for (const seg of segGroups) {
          if (seg.pts.length === 0) continue;
          const isLastSeg = seg === segGroups[segGroups.length - 1];
          const showRubberBand = isLastSeg && !!cursorPoint && !pendingBreak;

          if (activeTool === 'rectangle') {
            if (seg.pts.length === 2) {
              const [p1, p2] = seg.pts;
              ctx.strokeStyle = strokeColor;
              ctx.setLineDash([5, 5]);
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p1.y);
              ctx.lineTo(p2.x, p2.y); ctx.lineTo(p1.x, p2.y);
              ctx.closePath();
              ctx.fillStyle = strokeColor + '30';
              ctx.fill();
              ctx.stroke();
            } else if (seg.pts.length === 1 && showRubberBand) {
              const p1 = seg.pts[0];
              const p2 = cursorPoint!;
              ctx.strokeStyle = strokeColor + '80';
              ctx.setLineDash([3, 3]);
              ctx.lineWidth   = 2;
              ctx.beginPath();
              ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p1.y);
              ctx.lineTo(p2.x, p2.y); ctx.lineTo(p1.x, p2.y);
              ctx.closePath();
              ctx.fillStyle = strokeColor + '15';
              ctx.fill();
              ctx.stroke();
              ctx.strokeStyle = strokeColor;
              ctx.setLineDash([5, 5]);
              ctx.lineWidth   = 2;
            }
          } else if (activeTool === 'polygon') {
            ctx.beginPath();
            ctx.moveTo(seg.pts[0].x, seg.pts[0].y);
            for (let i = 1; i < seg.pts.length; i++) ctx.lineTo(seg.pts[i].x, seg.pts[i].y);
            if (showRubberBand) ctx.lineTo(cursorPoint!.x, cursorPoint!.y);
            if (seg.pts.length >= 2) {
              ctx.lineTo(seg.pts[0].x, seg.pts[0].y);
              ctx.fillStyle = strokeColor + '30';
              ctx.fill();
            }
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.moveTo(seg.pts[0].x, seg.pts[0].y);
            for (let i = 1; i < seg.pts.length; i++) ctx.lineTo(seg.pts[i].x, seg.pts[i].y);
            if (showRubberBand) ctx.lineTo(cursorPoint!.x, cursorPoint!.y);
            ctx.stroke();
          }
        }
        ctx.setLineDash([]);
      } else {
        const allPts = [...tempPx.map(p => ({ x: p.x, y: p.y }))];
        if (cursorPoint && hasTemp) allPts.push(cursorPoint);
        if (allPts.length > 1) {
          ctx.beginPath();
          ctx.moveTo(allPts[0].x, allPts[0].y);
          allPts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      tempPx.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.snapped ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = p.snapped ? '#22C55E' : strokeColor;
        ctx.fill();
        if (p.snapped) {
          ctx.strokeStyle = '#22C55E';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      });

      if (cursorPoint) {
        ctx.beginPath();
        ctx.arc(cursorPoint.x, cursorPoint.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = pendingBreak ? '#60A5FA' : strokeColor;
        ctx.fill();
      }

      const allPtsForLabel = [...tempPx.map(p => ({ x: p.x, y: p.y }))];
      if (cursorPoint && hasTemp && !pendingBreak) allPtsForLabel.push(cursorPoint);

      if (allPtsForLabel.length > 1 && cursorPoint) {
        const zoom = scaleRef.current;
        let text = '';

        if (activeTool === 'rectangle') {
          const lastSeg = segGroups[segGroups.length - 1];
          if (lastSeg?.pts.length === 1 && !pendingBreak) {
            const w = Math.abs(cursorPoint.x - lastSeg.pts[0].x);
            const h = Math.abs(cursorPoint.y - lastSeg.pts[0].y);
            text = `${(w * h / (zoom * zoom) * scaleFactor * scaleFactor).toFixed(2)} sq m`;
          }
        } else if (activeTool === 'polygon' && allPtsForLabel.length > 2) {
          let a = 0;
          for (let i = 0; i < allPtsForLabel.length; i++) {
            const j = (i + 1) % allPtsForLabel.length;
            a += allPtsForLabel[i].x * allPtsForLabel[j].y - allPtsForLabel[j].x * allPtsForLabel[i].y;
          }
          text = `${(Math.abs(a) / 2 / (zoom * zoom) * scaleFactor * scaleFactor).toFixed(2)} sq m`;
        } else if (activeTool === 'linear' || activeTool === 'scale') {
          let len = 0;
          if (activeTool === 'linear' && tempPx.length > 0) {
            for (const seg of segGroups) {
              for (let i = 1; i < seg.pts.length; i++) {
                len += Math.hypot(seg.pts[i].x - seg.pts[i-1].x, seg.pts[i].y - seg.pts[i-1].y);
              }
            }
            if (!pendingBreak) {
              const lastSeg = segGroups[segGroups.length - 1];
              if (lastSeg && lastSeg.pts.length > 0) {
                const last = lastSeg.pts[lastSeg.pts.length - 1];
                len += Math.hypot(cursorPoint.x - last.x, cursorPoint.y - last.y);
              }
            }
          } else {
            for (let i = 1; i < allPtsForLabel.length; i++) {
              len += Math.hypot(
                allPtsForLabel[i].x - allPtsForLabel[i-1].x,
                allPtsForLabel[i].y - allPtsForLabel[i-1].y,
              );
            }
          }
          text = activeTool === 'scale'
            ? `${(len / zoom).toFixed(2)} pts`
            : `${(len / zoom * scaleFactor).toFixed(2)} m`;
        }

        if (text) {
          ctx.font         = 'bold 12px monospace';
          ctx.textAlign    = 'left';
          ctx.textBaseline = 'alphabetic';
          const tw = ctx.measureText(text).width;
          ctx.fillStyle = strokeColor;
          ctx.fillRect(cursorPoint.x + 10, cursorPoint.y - 22, tw + 10, 20);
          ctx.fillStyle = 'black';
          ctx.fillText(text, cursorPoint.x + 15, cursorPoint.y - 7);
        }
      }
    });

    return () => { if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current); };
  }, [
    measurements, tempPoints, cursorPoint, activeTool, scaleFactor,
    toCanvas, pdfDimensionsRef, scaleRef, drawingCanvasRef, pendingBreak,
  ]);

  // ── onScaleSet ref ────────────────────────────────────────────────────────
  const onScaleSetRef = useRef<((f: number) => void) | null>(null);
  (useMeasurements as any)._onScaleSetRef = onScaleSetRef;

  // ── Group points by segmentId ─────────────────────────────────────────────
  const groupPointsBySegment = (points: InProgressPoint[]) => {
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
  };

  // ── Post-commit snap candidate check ─────────────────────────────────────
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
  }, [getScaledCorners, toCanvas, toNorm, pdfDimensionsRef, pageNumberRef]);

  // ── finishMeasurement ─────────────────────────────────────────────────────
  const finishMeasurement = useCallback((
    currentTempPoints?: InProgressPoint[],
    meta?: { label?: string; icon?: string },
  ) => {
    const pts = currentTempPoints ?? tempPoints;

    // Always clear break state when finishing
    resetBreakState();

    // ── Point ──────────────────────────────────────────────────────────────
    if (activeTool === 'point') {
      if (pts.length < 1) { clearTempPoints(); setCursorPoint(null); return; }
      const label = meta?.label || 'Point Marker';
      commitMeasurement({
        id: crypto.randomUUID(), drawingId: activeDrawingId || '',
        description: label, label, type: 'Point',
        quantity: 1, unit: 'PT', unitRate: 0, notes: '',
        points: [{ x: pts[0].x, y: pts[0].y }],
        isOverridden: false, color: getNextMeasurementColor(), isVisible: true,
      });
      clearTempPoints(); setCursorPoint(null); return;
    }

    // ── Count ──────────────────────────────────────────────────────────────
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
          isOverridden: false, color: groupColor, isVisible: true, parentId: groupId,
        });
      }
      
      const parent: TakeoffRow = {
        id: groupId, drawingId: activeDrawingId || '',
        description: groupLabel, label: groupLabel, icon: groupIcon, type: 'Count',
        quantity: pts.length, unit: 'EA', unitRate: 0, notes: '',
        points: [], // FIX 1: Empty points array
        isOverridden: false, color: groupColor, isVisible: true,
        isGroupHeader: true, childIds,
      };
      
      // BATCH COMMIT - parent + all children at once, NO race condition!
      batchCommitMeasurements([parent, ...children]);
      
      clearTempPoints(); setCursorPoint(null); 
      return;
    }

    if (pts.length < 2) { clearTempPoints(); setCursorPoint(null); return; }

    // ── Scale ──────────────────────────────────────────────────────────────
    if (activeTool === 'scale') {
      const p0 = toCanvas(pts[0].x, pts[0].y);
      const p1 = toCanvas(pts[1].x, pts[1].y);
      const ptLen = Math.hypot(p1.x - p0.x, p1.y - p0.y) / scaleRef.current;
      const realStr = window.prompt('Enter real world length in meters (e.g. 5):', '5');
      if (realStr) {
        const r = parseFloat(realStr);
        if (!isNaN(r) && r > 0) onScaleSetRef.current?.(r / ptLen);
      }
      clearTempPoints(); setCursorPoint(null); setActiveTool('select'); return;
    }

    const zoom       = scaleRef.current;
    const newId      = crypto.randomUUID();
    const groupColor = getNextMeasurementColor();

    // ── Linear ─────────────────────────────────────────────────────────────
    if (activeTool === 'linear') {
      const allSegs   = groupPointsBySegment(pts);
      const validSegs = allSegs.filter(s => s.points.length >= 2);

      if (validSegs.length === 0) { clearTempPoints(); setCursorPoint(null); return; }

      const groupLabel = meta?.label || 'New Length';

      const segLength = (seg: typeof validSegs[0]) => {
        const sc = seg.points.map(p => toCanvas(p.x, p.y));
        let len = 0;
        for (let i = 1; i < sc.length; i++) {
          len += Math.hypot(sc[i].x - sc[i-1].x, sc[i].y - sc[i-1].y);
        }
        return len / zoom * scaleFactor;
      };

      const totalQty = validSegs.reduce((sum, seg) => sum + segLength(seg), 0);

      if (validSegs.length === 1) {
        // Single segment - simple commit
        commitMeasurement({
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Length', quantity: totalQty, unit: 'm', unitRate: 0, notes: '',
          points: validSegs[0].points.map(p => ({ x: p.x, y: p.y })),
          isOverridden: false, color: groupColor, isVisible: true,
        });
      } else {
        // Multiple segments - batch commit ALL at once
        const childIds: string[] = [];
        const children: TakeoffRow[] = [];

        validSegs.forEach((seg, idx) => {
          const cid = crypto.randomUUID();
          childIds.push(cid);
          children.push({
            id: cid, drawingId: activeDrawingId || '',
            description: `Section ${idx + 1}`,
            label: `Section ${idx + 1}`,
            type: 'Length',
            quantity: segLength(seg),
            unit: 'm', unitRate: 0, notes: '',
            points: seg.points.map(p => ({ x: p.x, y: p.y })),
            isOverridden: false, color: groupColor, isVisible: true, parentId: newId,
          });
        });

        const parent: TakeoffRow = {
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Length', quantity: totalQty, unit: 'm', unitRate: 0, notes: '',
          points: [], // FIX 1: Empty points array - no connecting line
          isOverridden: false, color: groupColor, isVisible: true,
          isGroupHeader: true, childIds,
        };
        
        // BATCH COMMIT - parent + all children at once
        batchCommitMeasurements([parent, ...children]);
      }

      clearTempPoints(); setCursorPoint(null);
      checkSnapCandidates(pts, newId);
      return;
    }

    // ── Polygon ────────────────────────────────────────────────────────────
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
          isOverridden: false, color: groupColor, isVisible: true,
        });
      } else {
        const childIds: string[] = [];
        const children: TakeoffRow[] = [];

        validSegs.forEach((seg, idx) => {
          const cid = crypto.randomUUID();
          childIds.push(cid);
          children.push({
            id: cid, drawingId: activeDrawingId || '',
            description: `Shape ${idx + 1}`,
            label: `Shape ${idx + 1}`,
            type: 'Polygon',
            quantity: segArea(seg),
            unit: 'sq m', unitRate: 0, notes: '',
            points: seg.points.map(p => ({ x: p.x, y: p.y })),
            isOverridden: false, color: groupColor, isVisible: true, parentId: newId,
          });
        });

        const parent: TakeoffRow = {
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Polygon', quantity: totalArea, unit: 'sq m', unitRate: 0, notes: '',
          points: [], // FIX 1: Empty points array - no connecting line
          isOverridden: false, color: groupColor, isVisible: true,
          isGroupHeader: true, childIds,
        };
        
        // BATCH COMMIT - parent + all children at once
        batchCommitMeasurements([parent, ...children]);
      }

      clearTempPoints(); setCursorPoint(null);
      checkSnapCandidates(pts, newId);
      return;
    }

    // ── Rectangle ──────────────────────────────────────────────────────────
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
        return {
          normPoints: r4.map(p => toNorm(p.x, p.y)),
          area: Math.abs(a) / 2 / (zoom * zoom) * scaleFactor * scaleFactor,
        };
      };

      const totalArea = validSegs.reduce(
        (s, seg) => s + rectFromTwo(seg.points[0], seg.points[1]).area, 0
      );

      if (validSegs.length === 1) {
        const { normPoints, area } = rectFromTwo(validSegs[0].points[0], validSegs[0].points[1]);
        commitMeasurement({
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Rectangle', quantity: area, unit: 'sq m', unitRate: 0, notes: '',
          points: normPoints,
          isOverridden: false, color: groupColor, isVisible: true,
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
            description: `Rectangle ${idx + 1}`,
            label: `Rectangle ${idx + 1}`,
            type: 'Rectangle',
            quantity: area,
            unit: 'sq m', unitRate: 0, notes: '',
            points: normPoints,
            isOverridden: false, color: groupColor, isVisible: true, parentId: newId,
          });
        });

        const parent: TakeoffRow = {
          id: newId, drawingId: activeDrawingId || '',
          description: groupLabel, label: groupLabel,
          type: 'Rectangle', quantity: totalArea, unit: 'sq m', unitRate: 0, notes: '',
          points: [], // FIX 1: Empty points array - no connecting line
          isOverridden: false, color: groupColor, isVisible: true,
          isGroupHeader: true, childIds,
        };
        
        // BATCH COMMIT - parent + all children at once
        batchCommitMeasurements([parent, ...children]);
      }

      clearTempPoints(); setCursorPoint(null);
      checkSnapCandidates(pts, newId);
      return;
    }
  }, [
    tempPoints, activeTool, scaleFactor, commitMeasurement, batchCommitMeasurements,
    clearTempPoints, setActiveTool, checkSnapCandidates, toCanvas, toNorm,
    activeDrawingId, scaleRef, resetBreakState,
  ]);

  // ── handleCanvasClick (LEFT-CLICK ONLY) ───────────────────────────────────
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === 'select') return;
    if (e.button !== 0) return;

    const rect = drawingCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rawX = (e.clientX - rect.left) * (drawingCanvasRef.current!.width / rect.width);
    const rawY = (e.clientY - rect.top)  * (drawingCanvasRef.current!.height / rect.height);

    const snap = snapToCorner(rawX, rawY);
    if (snap.snapped) triggerSnapFlash(snap.point.x, snap.point.y);
    const norm = toNorm(snap.point.x, snap.point.y);

    if (activeTool === 'point') {
      commitMeasurement({
        id: crypto.randomUUID(), drawingId: activeDrawingId || '',
        description: 'Point Marker', type: 'Point',
        quantity: 1, unit: 'PT', unitRate: 0, notes: '',
        points: [norm], isOverridden: false, color: getNextMeasurementColor(), isVisible: true,
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

    pushPoint({ x: norm.x, y: norm.y, snapped: snap.snapped });
  }, [
    activeTool, snapToCorner, triggerSnapFlash, toNorm,
    commitMeasurement, pushPoint, drawingCanvasRef, activeDrawingId,
    tempPoints, pendingBreak,
  ]);

  // ── handleContextMenu (RIGHT-CLICK) ───────────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (activeTool === 'select') return;

    if (activeTool === 'count' || activeTool === 'point') {
      finishMeasurement();
      return;
    }

    if (activeTool === 'linear' || activeTool === 'polygon') {
      if (tempPoints.length === 0) return;
      nextSegmentIdRef.current = crypto.randomUUID();
      setPendingBreak(true);
      return;
    }

    if (activeTool === 'rectangle') {
      if (tempPoints.length === 0) return;
      const segs = groupPointsBySegment(tempPoints);
      const lastSeg = segs[segs.length - 1];
      if (lastSeg && lastSeg.points.length === 2) {
        nextSegmentIdRef.current = crypto.randomUUID();
        setPendingBreak(true);
      }
      return;
    }
  }, [activeTool, tempPoints, finishMeasurement]);

  // ── handleCanvasPointerMove ───────────────────────────────────────────────
  const handleCanvasPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeTool === 'select' || isPanning) return;
    const rect = drawingCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rawX = (e.clientX - rect.left) * (drawingCanvasRef.current!.width / rect.width);
    const rawY = (e.clientY - rect.top)  * (drawingCanvasRef.current!.height / rect.height);
    cursorPointRef.current = { x: rawX, y: rawY };
    redrawPinCanvas();
    const snap = snapToCorner(rawX, rawY);
    setCursorPoint(snap.point);
    cursorPointRef.current = snap.point;
  }, [activeTool, isPanning, snapToCorner, redrawPinCanvas, cursorPointRef, drawingCanvasRef]);

  return {
    cursorPoint, setCursorPoint,
    pendingSnapCandidates, setPendingSnapCandidates,
    finishMeasurement,
    handleCanvasClick, handleContextMenu, handleCanvasPointerMove,
    toCanvas, toNorm,
    pendingBreak,
  };
}
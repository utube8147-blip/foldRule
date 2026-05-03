// ─── useMeasurements.ts ───────────────────────────────────────────────────────
// Encapsulates:
//   • Drawing measurements + temp-point preview onto drawingCanvasRef
//   • finishMeasurement() with zoom-independent quantity calculation
//   • handleCanvasClick / handleCanvasPointerMove / handleContextMenu
//   • Post-draw snap correction (pendingSnapCandidates)

import { useRef, useState, useEffect, useCallback } from 'react';
import { TakeoffRow, MeasurementType } from '../types';
import { SnapResult, PendingSnapCandidate, PdfDimensions } from '../types/viewerTypes';

// ─── Hook params ──────────────────────────────────────────────────────────────

export interface UseMeasurementsParams {
  drawingCanvasRef: React.RefObject<HTMLCanvasElement>;
  pdfDimensionsRef: React.MutableRefObject<PdfDimensions | null>;
  pageNumberRef: React.MutableRefObject<number>;
  scaleRef: React.MutableRefObject<number>;
  activeTool: string;
  setActiveTool: (tool: string) => void;
  measurements: TakeoffRow[];
  scaleFactor: number;
  onAddMeasurement: (m: Omit<TakeoffRow, 'id' | 'color' | 'isVisible' | 'drawingId'>) => void;
  onUpdateMeasurement?: (id: string, updates: Partial<TakeoffRow>) => void;
  isPanning: boolean;
  snapToCorner: (rawX: number, rawY: number) => SnapResult;
  getScaledCorners: (pageIdx: number) => Array<{ x: number; y: number; confidence: number }>;
  triggerSnapFlash: (x: number, y: number) => void;
  snapEnabled: boolean;
  snapThreshold: number;
  redrawPinCanvas: () => void;
  cursorPointRef: React.MutableRefObject<{ x: number; y: number } | null>;
}

// ─── Hook return ──────────────────────────────────────────────────────────────

export interface UseMeasurementsReturn {
  tempPoints: Array<{ x: number; y: number; snapped: boolean }>;
  cursorPoint: { x: number; y: number } | null;
  setCursorPoint: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  pendingSnapCandidates: PendingSnapCandidate[] | null;
  setPendingSnapCandidates: React.Dispatch<React.SetStateAction<PendingSnapCandidate[] | null>>;
  finishMeasurement: (pts?: Array<{ x: number; y: number; snapped: boolean }>) => void;
  handleCanvasClick: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  handleContextMenu: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  handleCanvasPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  // Coordinate helpers exposed so Viewer can use them for the Finish button position
  toCanvas: (normX: number, normY: number) => { x: number; y: number };
  toNorm: (canvasX: number, canvasY: number) => { x: number; y: number };
}

// ─── useMeasurements ─────────────────────────────────────────────────────────

export function useMeasurements({
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
}: UseMeasurementsParams): UseMeasurementsReturn {

  // tempPoints stored in NORMALIZED [0,1] coordinates — zoom-independent
  const [tempPoints, setTempPoints] = useState<Array<{ x: number; y: number; snapped: boolean }>>([]);
  // cursorPoint in CANVAS PIXEL space — only used for live rubber-band preview
  const [cursorPoint, setCursorPoint] = useState<{ x: number; y: number } | null>(null);
  const [pendingSnapCandidates, setPendingSnapCandidates] = useState<PendingSnapCandidate[] | null>(null);

  const snapEnabledRef   = useRef(snapEnabled);
  const snapThresholdRef = useRef(snapThreshold);
  useEffect(() => { snapEnabledRef.current   = snapEnabled;   }, [snapEnabled]);
  useEffect(() => { snapThresholdRef.current = snapThreshold; }, [snapThreshold]);

  // ── Coordinate helpers ───────────────────────────────────────────────────────

  // canvas pixels → normalized [0,1]  (used when STORING a clicked point)
  const toNorm = useCallback((canvasX: number, canvasY: number) => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return { x: canvasX, y: canvasY };
    return { x: canvasX / dims.w, y: canvasY / dims.h };
  }, [pdfDimensionsRef]);

  // normalized [0,1] → canvas pixels  (used when RENDERING a stored point)
  const toCanvas = useCallback((normX: number, normY: number) => {
    const dims = pdfDimensionsRef.current;
    if (!dims) return { x: normX, y: normY };
    return { x: normX * dims.w, y: normY * dims.h };
  }, [pdfDimensionsRef]);

  // ── Clear temp points on tool switch ────────────────────────────────────────
  useEffect(() => {
    setTempPoints([]);
    setCursorPoint(null);
    cursorPointRef.current = null;
  }, [activeTool, cursorPointRef]);

  // ── Drawing effect ───────────────────────────────────────────────────────────
  // measurements[].points are normalized [0,1]; we call toCanvas() before drawing.
  // Live labels: canvas pixels / zoom scale → PDF points → × scaleFactor → real units
  useEffect(() => {
    const canvas = drawingCanvasRef.current;
    const dims   = pdfDimensionsRef.current;
    if (!canvas || !dims) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // ── Committed measurements ──────────────────────────────────────────────
    measurements.forEach(m => {
      if (!m.isVisible || m.points.length === 0) return;
      const pts = m.points.map(p => toCanvas(p.x, p.y));

      ctx.strokeStyle = m.color;
      ctx.fillStyle   = m.color + '60';
      ctx.lineWidth   = 3;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      if (m.type === 'Area') ctx.closePath();
      ctx.stroke();
      if (m.type === 'Area') ctx.fill();

      pts.forEach((p, idx) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        if (m.type === 'Count') {
          ctx.fillStyle = 'white';
          ctx.font = '12px monospace';
          ctx.fillText((idx + 1).toString(), p.x + 8, p.y - 8);
          ctx.fillStyle = m.color + '60';
        }
      });
    });

    // ── Temp point preview ──────────────────────────────────────────────────
    const tempPx = tempPoints.map(p => ({ ...toCanvas(p.x, p.y), snapped: p.snapped }));

    if (tempPx.length > 0 || (cursorPoint && activeTool !== 'select')) {
      ctx.strokeStyle = '#F59E0B';
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 2;

      const allPts = [...tempPx.map(p => ({ x: p.x, y: p.y }))];
      if (cursorPoint && tempPx.length > 0) allPts.push(cursorPoint);

      if (allPts.length > 0) {
        ctx.beginPath();
        ctx.moveTo(allPts[0].x, allPts[0].y);
        allPts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        if (activeTool === 'area' && allPts.length > 2) {
          ctx.lineTo(allPts[0].x, allPts[0].y);
          ctx.fillStyle = '#F59E0B40';
          ctx.fill();
        }
        ctx.stroke();
        ctx.setLineDash([]);

        tempPx.forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.snapped ? 6 : 4, 0, Math.PI * 2);
          ctx.fillStyle = p.snapped ? '#22C55E' : '#F59E0B';
          ctx.fill();
          if (p.snapped) {
            ctx.strokeStyle = '#22C55E';
            ctx.lineWidth   = 1.5;
            ctx.stroke();
          }
        });

        if (cursorPoint) {
          ctx.beginPath();
          ctx.arc(cursorPoint.x, cursorPoint.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#F59E0B';
          ctx.fill();
        }

        // ── Live quantity label ───────────────────────────────────────────
        if (allPts.length > 1 && cursorPoint) {
          const zoom = scaleRef.current;
          let text = '';

          if (activeTool === 'area' && allPts.length > 2) {
            let areaPx = 0;
            for (let i = 0; i < allPts.length; i++) {
              const j = (i + 1) % allPts.length;
              areaPx += allPts[i].x * allPts[j].y - allPts[j].x * allPts[i].y;
            }
            const areaPts = Math.abs(areaPx) / 2 / (zoom * zoom);
            text = `${(areaPts * scaleFactor * scaleFactor).toFixed(2)} sq m`;

          } else if (activeTool === 'linear' || activeTool === 'scale') {
            let lenPx = 0;
            for (let i = 1; i < allPts.length; i++) {
              lenPx += Math.hypot(allPts[i].x - allPts[i - 1].x, allPts[i].y - allPts[i - 1].y);
            }
            const lenPts = lenPx / zoom;
            text = activeTool === 'scale'
              ? `${lenPts.toFixed(2)} pts`
              : `${(lenPts * scaleFactor).toFixed(2)} m`;
          }

          if (text) {
            ctx.font = 'bold 12px monospace';
            const tw = ctx.measureText(text).width;
            ctx.fillStyle = '#F59E0B';
            ctx.fillRect(cursorPoint.x + 10, cursorPoint.y - 22, tw + 10, 20);
            ctx.fillStyle = 'black';
            ctx.fillText(text, cursorPoint.x + 15, cursorPoint.y - 7);
          }
        }
      }
    }
  }, [measurements, tempPoints, cursorPoint, activeTool, scaleFactor, toCanvas, pdfDimensionsRef, scaleRef, drawingCanvasRef]);

  // ── finishMeasurement ────────────────────────────────────────────────────────
  // scaleFactor = real-units per PDF-point (zoom-independent)
  // canvas pixels / zoom = PDF points
  const finishMeasurement = useCallback((
    currentTempPoints?: Array<{ x: number; y: number; snapped: boolean }>
  ) => {
    const pts = currentTempPoints ?? tempPoints;
    if (pts.length < 2) { setTempPoints([]); setCursorPoint(null); return; }

    if (activeTool === 'scale') {
      const p0    = toCanvas(pts[0].x, pts[0].y);
      const p1    = toCanvas(pts[1].x, pts[1].y);
      const pxLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const ptLen = pxLen / scaleRef.current; // PDF points, zoom-independent
      const realStr = window.prompt('Enter real world length in meters (e.g. 5):', '5');
      if (realStr) {
        const realLen = parseFloat(realStr);
        // onScaleSet receives real-units-per-PDF-point
        // We call it via a tiny closure trick since we don't want to import it here —
        // it's passed via the setActiveTool side-channel; callers handle it in Viewer.
        // Instead we store it to a module-level ref set by Viewer. See note in Viewer.
        if (!isNaN(realLen) && realLen > 0) {
          onScaleSetRef.current?.(realLen / ptLen);
        }
      }
      setTempPoints([]); setCursorPoint(null);
      setActiveTool('select');
      return;
    }

    const normPoints = pts.map(p => ({ x: p.x, y: p.y }));
    const canvasPts  = pts.map(p => toCanvas(p.x, p.y));
    const zoom       = scaleRef.current;

    let type: MeasurementType = 'Length';
    let qty = 0;
    let unit = 'm';

    if (activeTool === 'area') {
      type = 'Area';
      let areaPx = 0;
      for (let i = 0; i < canvasPts.length; i++) {
        const j = (i + 1) % canvasPts.length;
        areaPx += canvasPts[i].x * canvasPts[j].y - canvasPts[j].x * canvasPts[i].y;
      }
      qty  = (Math.abs(areaPx) / 2 / (zoom * zoom)) * scaleFactor * scaleFactor;
      unit = 'sq m';

    } else if (activeTool === 'linear') {
      type = 'Length';
      let lenPx = 0;
      for (let i = 1; i < canvasPts.length; i++) {
        lenPx += Math.hypot(canvasPts[i].x - canvasPts[i - 1].x, canvasPts[i].y - canvasPts[i - 1].y);
      }
      qty  = (lenPx / zoom) * scaleFactor;
      unit = 'm';
    }

    const newMeasurementId = crypto.randomUUID();

    onAddMeasurement({
      description: `New ${type}`,
      type, quantity: qty, unit, unitRate: 0, notes: '',
      points: normPoints,
      isOverridden: false,
    });

    // Post-draw correction — find unsnapped points near corners
    if (snapEnabledRef.current && pdfDimensionsRef.current) {
      const freePoints = pts.map((p, i) => ({ ...p, index: i })).filter(p => !p.snapped);
      if (freePoints.length > 0) {
        const pageCorners = getScaledCorners(pageNumberRef.current);
        const candidates: PendingSnapCandidate[] = [];
        for (const fp of freePoints) {
          const fpCanvas  = toCanvas(fp.x, fp.y);
          let bestDist    = snapThresholdRef.current * 2;
          let bestTarget: { x: number; y: number } | null = null;
          for (const c of pageCorners) {
            const dist = Math.hypot(fpCanvas.x - c.x, fpCanvas.y - c.y);
            if (dist < bestDist) { bestDist = dist; bestTarget = { x: c.x, y: c.y }; }
          }
          if (bestTarget) {
            candidates.push({
              pointIndex: fp.index,
              measurementId: newMeasurementId,
              snapTarget: toNorm(bestTarget.x, bestTarget.y),
            });
          }
        }
        if (candidates.length > 0) setPendingSnapCandidates(candidates);
      }
    }

    setTempPoints([]); setCursorPoint(null);
  }, [
    tempPoints, activeTool, scaleFactor, onAddMeasurement, setActiveTool,
    getScaledCorners, toCanvas, toNorm, pdfDimensionsRef, pageNumberRef, scaleRef,
  ]);

  // ── onScaleSet ref — Viewer injects this so finishMeasurement can call it ───
  // (avoids prop-drilling through the hook boundary)
  const onScaleSetRef = useRef<((f: number) => void) | null>(null);
  // Viewer calls: engine.onScaleSetRef.current = onScaleSet  (see Viewer)
  // We expose it so Viewer can inject it after mount.
  (useMeasurements as any)._onScaleSetRef = onScaleSetRef;

  // ── Auto-finish scale after 2 points ────────────────────────────────────────
  useEffect(() => {
    if (activeTool === 'scale' && tempPoints.length === 2) {
      finishMeasurement(tempPoints);
    }
  }, [tempPoints, activeTool, finishMeasurement]);

  // ── handleCanvasClick ────────────────────────────────────────────────────────
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === 'select') return;
    if (e.button === 2) { finishMeasurement(); return; }

    const rect = drawingCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rawX = (e.clientX - rect.left) * (drawingCanvasRef.current!.width / rect.width);
    const rawY = (e.clientY - rect.top)  * (drawingCanvasRef.current!.height / rect.height);

    const snapResult    = snapToCorner(rawX, rawY);
    const finalPt       = snapResult.point;
    if (snapResult.snapped) triggerSnapFlash(finalPt.x, finalPt.y);
    const norm = toNorm(finalPt.x, finalPt.y);

    if (activeTool === 'count') {
      onAddMeasurement({
        description: 'New Count', type: 'Count',
        quantity: measurements.filter(m => m.type === 'Count').length + 1,
        unit: 'EA', unitRate: 0, notes: '',
        points: [norm],
        isOverridden: false,
      });
      return;
    }

    if (activeTool === 'point') {
      onAddMeasurement({
        description: 'Point Marker', type: 'Point',
        quantity: 1, unit: 'PT', unitRate: 0, notes: '',
        points: [norm],
        isOverridden: false,
      });
      return;
    }

    setTempPoints(prev => [...prev, { x: norm.x, y: norm.y, snapped: snapResult.snapped }]);
  }, [activeTool, finishMeasurement, snapToCorner, triggerSnapFlash, toNorm, onAddMeasurement, measurements, drawingCanvasRef]);

  // ── handleContextMenu ────────────────────────────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (activeTool !== 'select') finishMeasurement();
  }, [activeTool, finishMeasurement]);

  // ── handleCanvasPointerMove ──────────────────────────────────────────────────
  const handleCanvasPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeTool === 'select' || isPanning) return;

    const rect = drawingCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rawX = (e.clientX - rect.left) * (drawingCanvasRef.current!.width / rect.width);
    const rawY = (e.clientY - rect.top)  * (drawingCanvasRef.current!.height / rect.height);

    cursorPointRef.current = { x: rawX, y: rawY };
    redrawPinCanvas();

    const snapResult = snapToCorner(rawX, rawY);
    setCursorPoint(snapResult.point);
    cursorPointRef.current = snapResult.point;
  }, [activeTool, isPanning, snapToCorner, redrawPinCanvas, cursorPointRef, drawingCanvasRef]);

  return {
    tempPoints,
    cursorPoint,
    setCursorPoint,
    pendingSnapCandidates,
    setPendingSnapCandidates,
    finishMeasurement,
    handleCanvasClick,
    handleContextMenu,
    handleCanvasPointerMove,
    toCanvas,
    toNorm,
  };
}
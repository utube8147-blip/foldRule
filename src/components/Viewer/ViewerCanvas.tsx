'use client';

// ─── ViewerCanvas.tsx ─────────────────────────────────────────────────────────
//
// CHANGES vs previous version:
//   • ADDED: Room label overlay layer (roomLabelCanvasRef)
//   • ADDED: drawRoomLabelsCanvas - renders room names + sq ft inside rooms
//   • UPDATED: SVG_SNAP_COLOURS imported from useSvgSnapPoints (includes arc-center cyan)
//   • UPDATED: drawSvgSnapDebugCanvas renders arc-center as cyan crosshair ⊕
//              all other types remain small circle + dot
//   • KEPT: svgAreaCanvasRef layer for door/polygon area rendering
//   • KEPT: drawSvgAreaCanvas (doors=green, named=orange, generic=purple)
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { FolderOpen, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType, TakeoffRow } from '@/types';
import type { PdfDimensions } from '@/types/viewerTypes';
import type { InProgressPoint } from '@/context/TakeoffContext';
import type { DetectedRoom } from '@/hooks/useSnapEngine/detectRooms';
import { CountPinOverlay } from '../CountPinOverlay';
import { SVG_SNAP_COLOURS } from '@/hooks/useSvgSnapPoints';
import type { SvgSnapPoint } from '@/hooks/useSvgSnapPoints';
import type { SvgArea } from '@/hooks/useSvgInteraction';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pointInPolygon(
  x: number, y: number,
  poly: Array<{ x: number; y: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SnapFlash {
  id: string;
  x: number;
  y: number;
}

interface ViewerCanvasProps {
  // Refs
  pdfCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  drawingCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  pinCanvasRef:     React.RefObject<HTMLCanvasElement | null>;
  roomCanvasRef:    React.RefObject<HTMLCanvasElement | null>;
  wallCanvasRef:    React.RefObject<HTMLCanvasElement | null>;
  vectorCanvasRef:  React.RefObject<HTMLCanvasElement | null>;
  svgAreaCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  roomLabelCanvasRef?: React.RefObject<HTMLCanvasElement | null>; // NEW: for room labels

  // State
  pdf:             any;
  loading:         boolean;
  pdfDimensions:   PdfDimensions | null;
  activeTool:      ToolType;
  showPins:        boolean;
  isPanning:       boolean;
  spaceHeld:       boolean;
  tempPoints:      InProgressPoint[];
  measurements:    TakeoffRow[];
  activeDrawingId: string | null;
  snapFlashes:     SnapFlash[];

  // Vector overlay
  showVectors:      boolean;
  vectorPathCount:  number;

  // Wall overlay
  showWalls:        boolean;
  wallSegmentCount: number;

  // Room detection
  showRooms:       boolean;
  rooms:           DetectedRoom[];
  hoveredRoomId:   string | null;
  setHoveredRoomId:(id: string | null) => void;
  onRoomClick:     (room: DetectedRoom) => void;

  // SVG overlay — content injected by Viewer (same source used for snapping)
  svgContent?:       string | null;
  showSvgOverlay?:   boolean;

  // SVG areas (doors, polygons) — injected by Viewer
  svgAreas?:         SvgArea[];

  // SVG snap points (debug pins)
  svgSnapPoints?:    SvgSnapPoint[];
  showSvgSnapDebug?: boolean;

  // Geometry helper
  toCanvas: (x: number, y: number) => { x: number; y: number };

  // Canvas event handlers
  handleCanvasClick:              (e: React.MouseEvent<HTMLCanvasElement>)   => void;
  handleContextMenu:              (e: React.MouseEvent<HTMLCanvasElement>)   => void;
  handleCanvasPointerMove:        (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handleCanvasPointerDown:        (e: React.PointerEvent<HTMLCanvasElement>) => boolean | undefined;
  handleCanvasPointerUp:          (e: React.PointerEvent<HTMLCanvasElement>) => void;
  handleDrawingCanvasPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  setCursorPoint:                 (p: any) => void;
  cursorPointRef:                 React.RefObject<any>;
  redrawPinCanvas:                () => void;

  // Finish action
  handleFinishMeasurement: () => void;

  // File upload
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;

  // Layout
  containerRef:   React.RefObject<HTMLDivElement | null>;
  CANVAS_PADDING: number;
}

// ─── SVG snap point debug overlay ────────────────────────────────────────────
//
// arc-center  → cyan crosshair ⊕ (circle + perpendicular arms + centre dot)
// endpoint    → amber circle + dot
// midpoint    → emerald circle + dot
// centroid    → violet circle + dot
// intersection→ red circle + dot

function drawSvgSnapDebugCanvas(
  canvas: HTMLCanvasElement,
  points: SvgSnapPoint[],
  pdfDimensions: PdfDimensions,
) {
  const { w, h } = pdfDimensions;
  canvas.width        = w;
  canvas.height       = h;
  canvas.style.width  = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  for (const pt of points) {
    const px     = pt.nx * w;
    const py     = pt.ny * h;
    const colour = SVG_SNAP_COLOURS[pt.type] ?? 'rgba(255,255,255,0.7)';

    if (pt.type === 'arc-center') {
      // ── Cyan crosshair ⊕ — circle with perpendicular arms ────────────────
      const R = 7;
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.lineWidth   = 1.5;

      // Outer circle
      ctx.beginPath();
      ctx.arc(px, py, R, 0, Math.PI * 2);
      ctx.stroke();

      // Horizontal arm
      ctx.beginPath();
      ctx.moveTo(px - R - 4, py);
      ctx.lineTo(px + R + 4, py);
      ctx.stroke();

      // Vertical arm
      ctx.beginPath();
      ctx.moveTo(px, py - R - 4);
      ctx.lineTo(px, py + R + 4);
      ctx.stroke();

      // Centre fill dot
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();

      ctx.restore();

    } else {
      // ── Default: small circle + centre dot ───────────────────────────────
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.strokeStyle = colour;
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
    }
  }
}

// ─── SVG area canvas (doors, polygons) ───────────────────────────────────────
function drawSvgAreaCanvas(
  canvas: HTMLCanvasElement,
  areas: SvgArea[],
  pdfDimensions: PdfDimensions,
) {
  const { w, h } = pdfDimensions;
  canvas.width        = w;
  canvas.height       = h;
  canvas.style.width  = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  for (const area of areas) {
    if (area.points.length < 3) continue;

    if (area.label === 'door' && area.points.length >= 3) {
      const pivot    = area.points[0];
      const arcStart = area.points[1];
      const arcEnd   = area.points[area.points.length - 1];
      const radius   = Math.hypot(arcStart.x - pivot.x, arcStart.y - pivot.y);
      const startAngle = Math.atan2(arcStart.y - pivot.y, arcStart.x - pivot.x);
      const endAngle   = Math.atan2(arcEnd.y   - pivot.y, arcEnd.x   - pivot.x);

      // ── Filled pie-slice overlay ──────────────────────────────────────────
      ctx.beginPath();
      ctx.moveTo(pivot.x, pivot.y);
      ctx.arc(pivot.x, pivot.y, radius, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle   = 'rgba(34, 197, 94, 0.18)';
      ctx.fill();

      // ── Door leaf ─────────────────────────────────────────────────────────
      ctx.beginPath();
      ctx.moveTo(pivot.x, pivot.y);
      ctx.lineTo(arcStart.x, arcStart.y);
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.9)';
      ctx.lineWidth   = 2;
      ctx.setLineDash([]);
      ctx.stroke();

      // ── Swing arc (dashed) ────────────────────────────────────────────────
      ctx.beginPath();
      ctx.arc(pivot.x, pivot.y, radius, startAngle, endAngle);
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.7)';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.stroke();
      ctx.setLineDash([]);

      // ── Badge ─────────────────────────────────────────────────────────────
      const midAngle = (startAngle + endAngle) / 2;
      const midX = pivot.x + Math.cos(midAngle) * (radius * 0.55);
      const midY = pivot.y + Math.sin(midAngle) * (radius * 0.55);
      ctx.beginPath();
      ctx.arc(midX, midY, 10, 0, Math.PI * 2);
      ctx.fillStyle   = 'rgba(34, 197, 94, 0.75)';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
      ctx.fillStyle       = 'white';
      ctx.font            = 'bold 12px monospace';
      ctx.textAlign       = 'center';
      ctx.textBaseline    = 'middle';
      ctx.fillText('🚪', midX, midY);

    } else {
      // ── Shared polygon fill path ──────────────────────────────────────────
      ctx.beginPath();
      ctx.moveTo(area.points[0].x, area.points[0].y);
      for (let i = 1; i < area.points.length; i++) {
        ctx.lineTo(area.points[i].x, area.points[i].y);
      }
      ctx.closePath();

      if (area.label) {
        // Named area — orange
        ctx.fillStyle   = 'rgba(251, 146, 60, 0.20)';
        ctx.strokeStyle = 'rgba(251, 146, 60, 0.70)';
      } else {
        // Generic area — purple
        ctx.fillStyle   = 'rgba(168, 85, 247, 0.15)';
        ctx.strokeStyle = 'rgba(168, 85, 247, 0.50)';
      }

      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // ── Label at centroid (named areas only) ──────────────────────────────
      if (area.label) {
        const cx = area.points.reduce((s, p) => s + p.x, 0) / area.points.length;
        const cy = area.points.reduce((s, p) => s + p.y, 0) / area.points.length;

        // Pill background behind text
        const text    = area.label;
        ctx.font      = 'italic 10px monospace';
        const metrics = ctx.measureText(text);
        const tw      = metrics.width;
        const th      = 12;
        const pad     = 4;

        ctx.fillStyle = 'rgba(251, 146, 60, 0.75)';
        ctx.beginPath();
        ctx.roundRect(cx - tw / 2 - pad, cy - th / 2 - pad + 1, tw + pad * 2, th + pad * 2 - 2, 4);
        ctx.fill();

        ctx.fillStyle    = 'white';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, cx, cy);
      }
    }
  }
}

// ─── ROOM LABELS CANVAS (NEW) ────────────────────────────────────────────────
// Draws room labels (name + square footage) inside each detected room
function drawRoomLabelsCanvas(
  canvas: HTMLCanvasElement,
  rooms: DetectedRoom[],
  pdfDimensions: PdfDimensions,
  showRooms: boolean,
) {
  const { w, h } = pdfDimensions;
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  if (!showRooms || rooms.length === 0) return;

  for (const room of rooms) {
    // Calculate centroid of the room polygon
    let centroidX = 0;
    let centroidY = 0;
    
    for (const point of room.polygon) {
      centroidX += point.nx * w;
      centroidY += point.ny * h;
    }
    centroidX /= room.polygon.length;
    centroidY /= room.polygon.length;

    // Generate display name
    const roomName = room.label || `ROOM ${room.id.slice(0, 4).toUpperCase()}`;
    
    // Draw pill background
    ctx.font = 'bold 11px monospace';
    const metrics = ctx.measureText(roomName);
    const tw = metrics.width;
    const th = 14;
    const pad = 8;
    const pillHeight = th + pad * 2;
    const pillWidth = tw + pad * 2;

    // Drop shadow for better readability
    ctx.shadowBlur = 8;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    
    // Background pill
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.beginPath();
    ctx.roundRect(
      centroidX - pillWidth / 2,
      centroidY - pillHeight / 2,
      pillWidth,
      pillHeight,
      8
    );
    ctx.fill();

    // Border accent
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(
      centroidX - pillWidth / 2,
      centroidY - pillHeight / 2,
      pillWidth,
      pillHeight,
      8
    );
    ctx.stroke();

    // Room name text
    ctx.fillStyle = '#fbbf24'; // amber-400
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(roomName, centroidX, centroidY - 2);
    
    // Optional: Add square footage if available
    if (room.squareFootage && room.squareFootage > 0) {
      ctx.font = '9px monospace';
      ctx.fillStyle = '#9ca3af'; // gray-400
      ctx.fillText(
        `${Math.round(room.squareFootage)} sq ft`,
        centroidX,
        centroidY + 10
      );
    }
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ViewerCanvas({
  pdfCanvasRef, drawingCanvasRef, pinCanvasRef, roomCanvasRef,
  wallCanvasRef, vectorCanvasRef, svgAreaCanvasRef,
  roomLabelCanvasRef, // NEW
  pdf, loading, pdfDimensions,
  activeTool, showPins, isPanning, spaceHeld,
  tempPoints, measurements, activeDrawingId,
  snapFlashes, toCanvas,
  showVectors, vectorPathCount,
  showWalls, wallSegmentCount,
  showRooms, rooms, hoveredRoomId, setHoveredRoomId, onRoomClick,
  svgContent       = null,
  showSvgOverlay   = true,
  svgAreas         = [],
  svgSnapPoints    = [],
  showSvgSnapDebug = false,
  handleCanvasClick, handleContextMenu,
  handleCanvasPointerMove, handleCanvasPointerDown,
  handleCanvasPointerUp, handleDrawingCanvasPointerDown,
  setCursorPoint, cursorPointRef, redrawPinCanvas,
  handleFinishMeasurement,
  handleFileUpload,
  containerRef, CANVAS_PADDING,
}: ViewerCanvasProps) {

  const svgCanvasRef      = React.useRef<HTMLCanvasElement | null>(null);
  const svgDebugCanvasRef = React.useRef<HTMLCanvasElement | null>(null);

  // ── Render SVG content to canvas ──────────────────────────────────────────
  React.useEffect(() => {
    const canvas = svgCanvasRef.current;
    if (!canvas) return;

    if (!svgContent || !pdfDimensions || !showSvgOverlay) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const { w, h } = pdfDimensions;
    canvas.width        = w;
    canvas.height       = h;
    canvas.style.width  = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const img  = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      console.error('[ViewerCanvas] Failed to render SVG to canvas');
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }, [svgContent, pdfDimensions, showSvgOverlay]);

  // ── Draw SVG area canvas (doors, polygons) ────────────────────────────────
  React.useEffect(() => {
    const canvas = svgAreaCanvasRef.current;
    if (!canvas || !pdfDimensions) return;
    if (!showSvgOverlay || svgAreas.length === 0) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    drawSvgAreaCanvas(canvas, svgAreas, pdfDimensions);
  }, [svgAreas, showSvgOverlay, pdfDimensions, svgAreaCanvasRef]);

  // ── Draw SVG snap debug pins ──────────────────────────────────────────────
  React.useEffect(() => {
    const canvas = svgDebugCanvasRef.current;
    if (!canvas || !pdfDimensions) return;
    if (!showSvgSnapDebug || svgSnapPoints.length === 0) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    drawSvgSnapDebugCanvas(canvas, svgSnapPoints, pdfDimensions);
  }, [svgSnapPoints, showSvgSnapDebug, pdfDimensions]);

  // ── Draw room labels (NEW) ────────────────────────────────────────────────
  React.useEffect(() => {
    const canvas = roomLabelCanvasRef?.current;
    if (!canvas || !pdfDimensions) return;
    drawRoomLabelsCanvas(canvas, rooms, pdfDimensions, showRooms);
  }, [rooms, showRooms, pdfDimensions, roomLabelCanvasRef]);

  const drawingCanvasCursor = spaceHeld
    ? isPanning ? 'cursor-grabbing' : 'cursor-grab'
    : activeTool !== 'select' && !isPanning
    ? 'cursor-crosshair'
    : isPanning
    ? 'cursor-grabbing'
    : 'cursor-grab';

  const handleRoomPointerMove = React.useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!showRooms || !pdfDimensions || !rooms.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;
    const hit  = rooms.find(r => {
      const pts = r.polygon.map(p => ({
        x: p.nx * pdfDimensions.w,
        y: p.ny * pdfDimensions.h,
      }));
      return pointInPolygon(mx, my, pts);
    });
    setHoveredRoomId(hit?.id ?? null);
  }, [showRooms, pdfDimensions, rooms, setHoveredRoomId]);

  const handleRoomClick = React.useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!showRooms || !hoveredRoomId) return;
    const room = rooms.find(r => r.id === hoveredRoomId);
    if (room) { e.stopPropagation(); onRoomClick(room); }
  }, [showRooms, hoveredRoomId, rooms, onRoomClick]);

  return (
    <>
      {/* ── Empty state ── */}
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

      {/* ── Loading spinner ── */}
      {loading && (
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-zinc-800 border-t-amber-400 rounded-full animate-spin" />
          <span className="text-[10px] font-mono font-bold text-amber-400 tracking-[0.2em] uppercase animate-pulse">
            Processing Vector Data...
          </span>
        </div>
      )}

      {/* ── Canvas stack ── */}
      {pdf && (
        <div
          className="relative shadow-2xl border border-industrial-border bg-white"
          style={pdfDimensions ? (() => {
            const vw    = containerRef.current?.clientWidth  ?? 0;
            const vh    = containerRef.current?.clientHeight ?? 0;
            const wrapW = Math.max(pdfDimensions.w + CANVAS_PADDING * 2, vw  * 3);
            const wrapH = Math.max(pdfDimensions.h + CANVAS_PADDING * 2, vh * 3);
            const left  = Math.round((wrapW - pdfDimensions.w) / 2);
            const top   = Math.round((wrapH - pdfDimensions.h) / 2);
            return { position: 'absolute' as const, left, top, width: pdfDimensions.w, height: pdfDimensions.h };
          })() : {}}
        >

          {/* ── Layer 0: PDF raster ────────────────────────────────────────── */}
          <canvas ref={pdfCanvasRef} className="absolute inset-0 z-0 pointer-events-none" />

          {/* ── Layer 1: Full vector overlay ───────────────────────────────── */}
          <canvas
            ref={vectorCanvasRef}
            className="absolute inset-0 z-10 pointer-events-none"
            style={{ opacity: showVectors && vectorPathCount > 0 ? 1 : 0, transition: 'opacity 0.2s' }}
          />

          {/* ── Layer 1.5: SVG overlay (same svgContent used for snapping) ─── */}
          {svgContent && (
            <canvas
              ref={svgCanvasRef}
              className="absolute inset-0 z-[15] pointer-events-none"
              style={{
                opacity:    showSvgOverlay ? 1 : 0,
                transition: 'opacity 0.2s',
                width:      pdfDimensions?.w,
                height:     pdfDimensions?.h,
              }}
            />
          )}

          {/* ── Layer 1.6: SVG area canvas (doors=green, named=orange, generic=purple) */}
          <canvas
            ref={svgAreaCanvasRef}
            className="absolute inset-0 z-[16] pointer-events-none"
            style={{
              opacity:    showSvgOverlay && svgAreas.length > 0 ? 1 : 0,
              transition: 'opacity 0.2s',
              width:      pdfDimensions?.w,
              height:     pdfDimensions?.h,
            }}
          />

          {/* ── Layer 1.7: SVG snap debug overlay ─────────────────────────── */}
          {/*   amber=endpoint  emerald=midpoint  violet=centroid              */}
          {/*   red=intersection  CYAN ⊕ =arc-center                          */}
          <canvas
            ref={svgDebugCanvasRef}
            className="absolute inset-0 z-[17] pointer-events-none"
            style={{
              opacity:    showSvgSnapDebug && svgSnapPoints.length > 0 ? 1 : 0,
              transition: 'opacity 0.2s',
              width:      pdfDimensions?.w,
              height:     pdfDimensions?.h,
            }}
          />

          {/* ── Layer 2: Room labels overlay (NEW) ────────────────────────── */}
          <canvas
            ref={roomLabelCanvasRef}
            className="absolute inset-0 z-[18] pointer-events-none"
            style={{
              opacity:    showRooms && rooms.length > 0 ? 1 : 0,
              transition: 'opacity 0.2s',
            }}
          />

          {/* ── Layer 4: Drawing / measurement canvas ─────────────────────── */}
          <canvas
            ref={drawingCanvasRef}
            onClick={handleCanvasClick}
            onContextMenu={handleContextMenu}
            onPointerMove={handleCanvasPointerMove}
            onPointerDown={(e) => {
              const handled = handleCanvasPointerDown(e) ?? false;
              if (!handled) handleDrawingCanvasPointerDown(e);
            }}
            onPointerUp={handleCanvasPointerUp}
            onPointerLeave={() => {
              setCursorPoint(null);
              cursorPointRef.current = null;
              redrawPinCanvas();
            }}
            className={cn('absolute inset-0 z-40 w-full h-full mix-blend-multiply', drawingCanvasCursor)}
          />

          {/* ── Layer 5: Snap pin canvas ───────────────────────────────────── */}
          <canvas
            ref={pinCanvasRef}
            className="absolute inset-0 z-50 w-full h-full pointer-events-none"
            style={{ opacity: showPins && activeTool !== 'select' ? 1 : 0, transition: 'opacity 0.2s' }}
          />

          {/* ── Layer 6: Count pin overlay (DOM) ──────────────────────────── */}
          <CountPinOverlay
            measurements={measurements}
            pdfDimensions={pdfDimensions}
            toCanvas={toCanvas}
            activeDrawingId={activeDrawingId}
            activeTool={activeTool}
          />

          {/* ── Layer 7: Snap flash animations ────────────────────────────── */}
          {snapFlashes.map(flash => (
            <div
              key={flash.id}
              className="absolute pointer-events-none z-[60]"
              style={{ left: flash.x, top: flash.y, transform: 'translate(-50%,-50%)' }}
            >
              <div
                className="w-8 h-8 rounded-full border-2 border-green-400"
                style={{ animation: 'snapPulse 0.6s ease-out forwards' }}
              />
            </div>
          ))}

          {/* ── Layer 8: Finish button — Count tool ───────────────────────── */}
          {tempPoints.length > 0 && activeTool === 'count' && (() => {
            const last = toCanvas(
              tempPoints[tempPoints.length - 1].x,
              tempPoints[tempPoints.length - 1].y,
            );
            return (
              <button
                className="absolute z-[70] flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                style={{ left: last.x + 15, top: last.y + 15 }}
                onClick={e => { e.stopPropagation(); handleFinishMeasurement(); }}
                onPointerDown={e => e.stopPropagation()}
              >
                <Check className="w-3 h-3" />
                Finish ({tempPoints.length} counts)
              </button>
            );
          })()}

          {/* ── Layer 8: Finish button — Polygon / Rectangle / Linear ─────── */}
          {tempPoints.length > 1 &&
            (activeTool === 'polygon' || activeTool === 'rectangle' || activeTool === 'linear') &&
            (() => {
              const last = toCanvas(
                tempPoints[tempPoints.length - 1].x,
                tempPoints[tempPoints.length - 1].y,
              );
              return (
                <button
                  className="absolute z-[70] flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
                  style={{ left: last.x + 15, top: last.y + 15 }}
                  onClick={e => { e.stopPropagation(); handleFinishMeasurement(); }}
                  onPointerDown={e => e.stopPropagation()}
                >
                  <Check className="w-3 h-3" />
                  Finish ({tempPoints.filter(p => p.snapped).length}/{tempPoints.length} snapped)
                </button>
              );
            })()}

        </div>
      )}
    </>
  );
}
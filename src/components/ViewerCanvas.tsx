import React from 'react';
import { Check, Target } from 'lucide-react';
import { cn } from '../lib/utils';
import { ToolType } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SnapFlash {
  x: number; y: number; id: number;
}

export interface PendingSnapCandidate {
  pointIndex: number;
  measurementId: string;
  /** normalized [0,1] space */
  snapTarget: { x: number; y: number };
}

export interface ViewerCanvasProps {
  // Refs — owned by the parent so all canvas logic stays in Viewer.tsx
  pdfCanvasRef: React.RefObject<HTMLCanvasElement>;
  drawingCanvasRef: React.RefObject<HTMLCanvasElement>;
  pinCanvasRef: React.RefObject<HTMLCanvasElement>;

  // Layout
  pdfDimensions: { w: number; h: number } | null;

  // Tool / interaction state
  activeTool: ToolType;
  isPanning: boolean;
  showPins: boolean;

  // Temp points (normalized [0,1]) — used only for the Finish button position
  tempPoints: Array<{ x: number; y: number; snapped: boolean }>;
  /** Convert normalized → canvas pixels (provided by Viewer) */
  toCanvas: (nx: number, ny: number) => { x: number; y: number };

  // Events forwarded to Viewer
  onCanvasClick: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerLeave: () => void;
  onFinish: () => void;

  // Snap flashes
  snapFlashes: SnapFlash[];

  // Post-draw correction dialog
  pendingSnapCandidates: PendingSnapCandidate[] | null;
  onSnapCandidateAccept: () => void;
  onSnapCandidateDismiss: () => void;
}

// ─── Snap Candidate Dialog ────────────────────────────────────────────────────

function SnapCandidateDialog({
  count, onAccept, onDismiss,
}: { count: number; onAccept: () => void; onDismiss: () => void }) {
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

// ─── Component ────────────────────────────────────────────────────────────────

export function ViewerCanvas({
  pdfCanvasRef, drawingCanvasRef, pinCanvasRef,
  pdfDimensions,
  activeTool, isPanning, showPins,
  tempPoints, toCanvas,
  onCanvasClick, onContextMenu, onPointerMove, onPointerLeave, onFinish,
  snapFlashes,
  pendingSnapCandidates, onSnapCandidateAccept, onSnapCandidateDismiss,
}: ViewerCanvasProps) {
  // Finish button position: last temp point converted to canvas pixels
  const finishButtonPos = (() => {
    if (tempPoints.length < 2) return null;
    if (activeTool !== 'area' && activeTool !== 'linear') return null;
    const last = tempPoints[tempPoints.length - 1];
    return toCanvas(last.x, last.y);
  })();

  const snappedCount = tempPoints.filter(p => p.snapped).length;

  return (
    <div
      className="relative shadow-2xl border border-industrial-border bg-white transition-all flex-shrink-0 m-auto"
      style={pdfDimensions ? { width: pdfDimensions.w, height: pdfDimensions.h } : {}}
    >
      {/* ── Layer 0: PDF render ── */}
      <canvas
        ref={pdfCanvasRef}
        className="absolute inset-0 z-0 pointer-events-none"
      />

      {/* ── Layer 1: Measurement drawings ── */}
      <canvas
        ref={drawingCanvasRef}
        onClick={onCanvasClick}
        onContextMenu={onContextMenu}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        className={cn(
          'absolute inset-0 z-10 w-full h-full mix-blend-multiply',
          activeTool !== 'select' && !isPanning
            ? 'cursor-crosshair'
            : isPanning
              ? 'cursor-grabbing'
              : 'cursor-grab',
        )}
      />

      {/* ── Layer 2: Corner pin overlay ── */}
      <canvas
        ref={pinCanvasRef}
        className="absolute inset-0 z-20 w-full h-full pointer-events-none"
        style={{
          opacity: showPins && activeTool !== 'select' ? 1 : 0,
          transition: 'opacity 0.2s',
        }}
      />

      {/* ── Snap flash rings ── */}
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

      {/* ── Finish button ── */}
      {finishButtonPos && (
        <button
          className="absolute z-30 flex items-center justify-center gap-1.5 bg-amber-400 text-black font-bold font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 shadow-lg whitespace-nowrap hover:bg-amber-300 active:scale-95 transition-transform"
          style={{ left: finishButtonPos.x + 15, top: finishButtonPos.y + 15 }}
          onClick={e => { e.stopPropagation(); onFinish(); }}
          onPointerDown={e => e.stopPropagation()}
        >
          <Check className="w-3 h-3" />
          Finish ({snappedCount}/{tempPoints.length} snapped)
        </button>
      )}

      {/* ── Post-draw snap correction dialog ── */}
      {pendingSnapCandidates && pendingSnapCandidates.length > 0 && (
        <SnapCandidateDialog
          count={pendingSnapCandidates.length}
          onAccept={onSnapCandidateAccept}
          onDismiss={onSnapCandidateDismiss}
        />
      )}
    </div>
  );
}
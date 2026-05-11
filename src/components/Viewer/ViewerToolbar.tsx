'use client';

// ─── ViewerToolbar.tsx ────────────────────────────────────────────────────────
//
//  Renders the top toolbar bar: tool buttons, undo/redo, snap controls,
//  scale display, zoom controls, and fit-to-screen.
//
//  ADDED: unit conversion dropdown (m / cm / mm / ft / in) next to scale.
//         Reads/writes displayUnit from TakeoffContext — no prop needed.
//
//  ADDED: room detection toggle button
//
//  All state lives in Viewer.tsx — this is purely presentational.
//
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import {
  ZoomIn, ZoomOut, Maximize,
  Undo2, Redo2, Target, Settings2,
  Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType } from '@/types';
import { VIEWER_TOOLS } from './ViewerConstants';
import { useTakeoffContext } from '@/context/TakeoffContext';
import { UNIT_OPTIONS } from '@/hooks/useMeasurements/unitConversion';
import type { DisplayUnit } from '@/hooks/useMeasurements/unitConversion';

// ─── Props ────────────────────────────────────────────────────────────────────

interface ViewerToolbarProps {
  activeTool:      ToolType;
  setActiveTool:   (tool: ToolType) => void;

  canUndo:         boolean;
  canRedo:         boolean;
  handleUndo:      () => void;
  handleRedo:      () => void;
  tempPointsCount: number;

  snapEnabled:          boolean;
  setSnapEnabled:       (v: boolean) => void;
  showSnapSettings:     boolean;
  setShowSnapSettings:  (v: boolean) => void;

  scaleFactor:       number;
  handleManualScale: () => void;

  analysisStatus: string;
  analysisPage:   { current: number; total: number } | null;
  currentPageCorners: number;

  scale:       number;
  setScale:    React.Dispatch<React.SetStateAction<number>>;
  fitToScreen: () => void;

  MIN_ZOOM:         number;
  MAX_ZOOM:         number;
  ZOOM_SENSITIVITY: number;

  // ── Room detection props ─────────────────────────────────────────────────
  showRooms:       boolean;
  setShowRooms:    (v: boolean) => void;
  detectingRooms:  boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ViewerToolbar({
  activeTool, setActiveTool,
  canUndo, canRedo, handleUndo, handleRedo, tempPointsCount,
  snapEnabled, setSnapEnabled,
  showSnapSettings, setShowSnapSettings,
  scaleFactor, handleManualScale,
  analysisStatus, analysisPage, currentPageCorners,
  scale, setScale, fitToScreen,
  MIN_ZOOM, MAX_ZOOM, ZOOM_SENSITIVITY,
  showRooms, setShowRooms, detectingRooms,
}: ViewerToolbarProps) {
  const isAnalyzing = analysisStatus === 'analyzing';
  const isAnalysisDone = analysisStatus === 'done';

  // ── pull displayUnit from context ────────────────────────────────────────
  const { displayUnit, setDisplayUnit } = useTakeoffContext();

  return (
    <div className="h-12 bg-industrial-panel border-b border-industrial-border flex flex-shrink-0 items-center justify-between px-4 z-20 shadow-sm relative">

      {/* ── Left: Tool buttons + Undo/Redo ── */}
      <div className="flex gap-1">
        {VIEWER_TOOLS.map(tool => (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id as ToolType)}
            className={cn(
              'w-9 h-9 flex items-center justify-center transition-all relative group border',
              activeTool === tool.id
                ? 'bg-zinc-800 border-amber-400 text-amber-400'
                : 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200',
            )}
            title={`${tool.label} (${tool.shortcut})`}
          >
            <tool.icon className="w-4 h-4" />
            <div className="absolute top-10 transform -translate-x-1/2 left-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[9px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-50">
              {tool.label} [{tool.shortcut}]
            </div>
          </button>
        ))}

        <div className="w-px h-5 bg-zinc-700/60 self-center mx-0.5" />

        {/* Undo */}
        <button
          onClick={handleUndo}
          disabled={!canUndo}
          className={cn(
            'w-9 h-9 flex items-center justify-center transition-all relative group border',
            canUndo
              ? 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200 hover:border-zinc-700'
              : 'bg-transparent border-transparent text-zinc-700 cursor-not-allowed',
          )}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 className="w-4 h-4" />
          {canUndo && (
            <div className="absolute top-10 transform -translate-x-1/2 left-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[9px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-50">
              Undo [Ctrl+Z]
              {tempPointsCount > 0 && (
                <span className="text-amber-400 ml-1">· pop point</span>
              )}
            </div>
          )}
        </button>

        {/* Redo */}
        <button
          onClick={handleRedo}
          disabled={!canRedo}
          className={cn(
            'w-9 h-9 flex items-center justify-center transition-all relative group border',
            canRedo
              ? 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200 hover:border-zinc-700'
              : 'bg-transparent border-transparent text-zinc-700 cursor-not-allowed',
          )}
          title="Redo (Ctrl+Y)"
        >
          <Redo2 className="w-4 h-4" />
          {canRedo && (
            <div className="absolute top-10 transform -translate-x-1/2 left-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[9px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-50">
              Redo [Ctrl+Y]
            </div>
          )}
        </button>
      </div>

      {/* ── Centre: Status + Snap + Scale ── */}
      <div className="flex flex-row items-center gap-2 flex-1 justify-center">

        {/* Only show analysis when snap is ON */}
        {snapEnabled && isAnalyzing && analysisPage && (
          <div className="flex items-center gap-1.5 border border-blue-500/40 bg-blue-500/10 px-2 py-1">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[9px] font-mono text-blue-400 uppercase tracking-widest">
              Analyzing plan… {analysisPage.current}/{analysisPage.total}
            </span>
          </div>
        )}

        {/* Main Snap toggle - always visible */}
        <button
          onClick={() => setSnapEnabled(!snapEnabled)}
          className={cn(
            'flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-widest px-3 py-1 border transition-all',
            snapEnabled
              ? 'bg-green-500/10 border-green-500/50 text-green-400 hover:bg-green-500/20'
              : 'bg-amber-500/10 border-amber-500/50 text-amber-400 hover:bg-amber-500/20',
          )}
          title={snapEnabled ? "Snap is ON - Click to disable" : "Snap is OFF - Click to enable analysis"}
        >
          <Target className="w-3 h-3" />
          {snapEnabled ? 'SNAP ACTIVE' : 'SNAP INACTIVE'}
        </button>

        {/* Snap Settings - only when snap is ON AND analysis is done */}
        {snapEnabled && isAnalysisDone && (
          <button
            onClick={() => setShowSnapSettings(!showSnapSettings)}
            className={cn(
              'flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-widest px-2 py-1 border transition-all',
              showSnapSettings
                ? 'bg-zinc-800 border-zinc-500 text-zinc-200'
                : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
            )}
            title="Snap settings"
          >
            <Settings2 className="w-3 h-3" />
            SNAP SETTINGS
          </button>
        )}

        {/* Room detection toggle - available when analysis is done, regardless of snap state */}
        {/* {isAnalysisDone && (
          <button
            onClick={() => setShowRooms(!showRooms)}
            className={cn(
              'flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-widest px-2 py-1 border transition-all',
              showRooms
                ? 'bg-blue-500/10 border-blue-500/50 text-blue-400 hover:bg-blue-500/20'
                : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
            )}
            title="Toggle room detection overlay"
          >
            <Layers className="w-3 h-3" />
            {detectingRooms ? 'DETECTING...' : showRooms ? 'ROOMS ON' : 'ROOMS OFF'}
          </button>
        )} */}

        {/* Separator */}
        <div className="w-px h-4 bg-zinc-700/60 mx-0.5" />

        {/* Scale display */}
        <div className="flex items-center gap-1 border border-industrial-border bg-stone-900 px-2 py-1">
          <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-tighter">Scale:</span>
          <span className="text-[10px] font-mono font-bold text-amber-400 tracking-tighter whitespace-nowrap">
            {scaleFactor === 1 ? 'NOT CALIBRATED' : `1pt = ${scaleFactor.toFixed(4)}m`}
          </span>
        </div>

        {/* Unit conversion dropdown */}
        <div className="flex items-center gap-1 border border-industrial-border bg-stone-900 px-1 py-0.5" title="Display unit">
          <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-tighter pl-1">Unit:</span>
          <select
            value={displayUnit}
            onChange={e => setDisplayUnit(e.target.value as DisplayUnit)}
            className="h-6 px-1 text-[10px] font-mono font-bold bg-transparent border-none text-amber-400 focus:outline-none cursor-pointer"
          >
            {UNIT_OPTIONS.map(u => (
              <option key={u.value} value={u.value} className="bg-zinc-900 text-zinc-200">
                {u.label}
              </option>
            ))}
          </select>
        </div>

        {/* Draw Calibration button */}
        <button
          onClick={() => setActiveTool('scale')}
          className={cn(
            'text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 transition-all border',
            activeTool === 'scale'
              ? 'bg-amber-400 text-black border-amber-400'
              : 'text-amber-400 border-amber-400 hover:bg-amber-400 hover:text-black',
          )}
        >
          DRAW CALIBRATION
        </button>
      </div>

      {/* ── Right: Zoom Controls ── */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => setScale(s => Math.max(MIN_ZOOM, s - ZOOM_SENSITIVITY))}
          className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
          title="Zoom Out (Ctrl/Cmd + -)"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="text-[10px] font-mono text-zinc-400 w-12 text-center font-bold">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => setScale(s => Math.min(MAX_ZOOM, s + ZOOM_SENSITIVITY))}
          className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
          title="Zoom In (Ctrl/Cmd + +)"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-industrial-border mx-1" />
        <button
          onClick={fitToScreen}
          className="p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
          title="Fit to Screen (Ctrl/Cmd + 0)"
        >
          <Maximize className="w-4 h-4" />
        </button>
      </div>

    </div>
  );
}
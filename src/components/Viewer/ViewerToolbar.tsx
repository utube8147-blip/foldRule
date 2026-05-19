'use client';

// ─── components/Viewer/ViewerToolbar.tsx ──────────────────────────────────────

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  ZoomIn, ZoomOut, Maximize,
  Undo2, Redo2, Target, Settings2,
  ChevronDown, Circle, Grid3x3, Ruler,
  Box, Spline, ScanSearch,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType } from '@/types';
import { VIEWER_TOOLS } from './ViewerConstants';
import { useTakeoffContext } from '@/context/TakeoffContext';
import { UNIT_OPTIONS } from '@/hooks/useMeasurements/unitConversion';
import type { DisplayUnit } from '@/hooks/useMeasurements/unitConversion';

interface ViewerToolbarProps {
  activeTool:      ToolType;
  setActiveTool:   (tool: ToolType) => void;
  canUndo:         boolean;
  canRedo:         boolean;
  handleUndo:      () => void;
  handleRedo:      () => void;
  tempPointsCount: number;
  snapEnabled:         boolean;
  setSnapEnabled:      (v: boolean) => void;
  showSnapSettings:    boolean;
  setShowSnapSettings: (v: boolean) => void;
  scaleFactor:       number;
  handleManualScale: () => void;
  analysisStatus:     string;
  analysisPage:       { current: number; total: number } | null;
  currentPageCorners: number;
  scale:       number;
  setScale:    React.Dispatch<React.SetStateAction<number>>;
  fitToScreen: () => void;
  MIN_ZOOM:         number;
  MAX_ZOOM:         number;
  ZOOM_SENSITIVITY: number;
  onApplyPitchFactor?: (factor: number) => void;
  onGridCountCommit?: (count: number, spacingMm: number, cols: number, rows: number) => void;
}

const ADVANCED_CANVAS_TOOLS: Array<{
  id: ToolType;
  label: string;
  sub: string;
  icon: React.ElementType;
  shortcut: string;
  badge?: string;
}> = [
  {
    id:       'radius',
    label:    'Radius / circle',
    sub:      'Click centre then any edge point',
    icon:     Circle,
    shortcut: 'R2',
  },
  {
    id:       'grid-count',
    label:    'Grid count',
    sub:      'Draw polygon area, grid auto-counts tiles',
    icon:     Grid3x3,
    shortcut: 'G',
  },
  {
    id:       'volume',
    label:    'Volume',
    sub:      'Draw boundary then enter depth for cubic m³',
    icon:     Box,
    shortcut: 'V2',
    badge:    'Soon',
  },
  {
    id:       'perimeter-offset',
    label:    'Perimeter offset',
    sub:      'Auto-generate offset line from any polygon',
    icon:     Spline,
    shortcut: 'O',
    badge:    'Soon',
  },
  {
    id:       'symbol-detect',
    label:    'Symbol detect',
    sub:      'Click one symbol — AI finds all matches',
    icon:     ScanSearch,
    shortcut: 'D',
    badge:    'Soon',
  },
];

interface AdvancedDropdownProps {
  activeTool:          ToolType;
  setActiveTool:       (t: ToolType) => void;
  onApplyPitchFactor?: (factor: number) => void;
}

function AdvancedToolsDropdown({
  activeTool,
  setActiveTool,
  onApplyPitchFactor,
}: AdvancedDropdownProps) {
  const [open, setOpen] = useState(false);
  const [rise, setRise] = useState('6');
  const [run,  setRun]  = useState('12');
  const ref             = useRef<HTMLDivElement>(null);

  const runNum  = parseFloat(run)  || 12;
  const riseNum = parseFloat(rise) || 6;
  const ratio   = Math.sqrt(1 + (riseNum / runNum) ** 2);

  const isAdvancedActive = ADVANCED_CANVAS_TOOLS.some(t => t.id === activeTool);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleApplyPitch = useCallback(() => {
    onApplyPitchFactor?.(ratio);
    setOpen(false);
  }, [ratio, onApplyPitchFactor]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          'h-9 flex items-center gap-1 px-2 border transition-all relative group',
          isAdvancedActive || open
            ? 'bg-zinc-800 border-amber-400 text-amber-400'
            : 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200',
        )}
        title="Advanced tools"
      >
        <Ruler className="w-4 h-4" />
        <span className="hidden xl:inline text-[9px] font-mono font-bold uppercase tracking-widest">
          Advanced
        </span>
        <ChevronDown
          className={cn('w-3 h-3 transition-transform duration-150', open && 'rotate-180')}
        />
        <div className="absolute top-10 transform -translate-x-1/2 left-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[9px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-50 xl:hidden">
          Advanced tools
        </div>
      </button>

      {open && (
        <div className="absolute top-10 left-0 z-[80] bg-industrial-panel border border-industrial-border shadow-2xl min-w-[260px]">

          {/* Pitch / slope factor */}
          <div className="px-3 py-2.5 border-b border-industrial-border">
            <div className="flex items-center gap-1.5 mb-2">
              <Ruler className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-zinc-300">
                Pitch / slope factor
              </span>
            </div>

            <div className="flex items-center gap-2 mb-1.5">
              <div className="flex flex-col gap-0.5">
                <span className="text-[8px] font-mono text-zinc-600 uppercase">Rise</span>
                <input
                  type="number"
                  min="0" max="24" step="1"
                  value={rise}
                  onChange={e => setRise(e.target.value)}
                  className="w-12 bg-zinc-900 border border-zinc-700 text-zinc-200 text-[10px] font-mono text-center px-1 py-1 focus:outline-none focus:border-amber-400"
                />
              </div>
              <span className="text-zinc-600 text-[10px] font-mono mt-4">:</span>
              <div className="flex flex-col gap-0.5">
                <span className="text-[8px] font-mono text-zinc-600 uppercase">Run</span>
                <input
                  type="number"
                  min="1" max="24" step="1"
                  value={run}
                  onChange={e => setRun(e.target.value)}
                  className="w-12 bg-zinc-900 border border-zinc-700 text-zinc-200 text-[10px] font-mono text-center px-1 py-1 focus:outline-none focus:border-amber-400"
                />
              </div>
              <div className="flex flex-col items-start mt-3 ml-1">
                <span className="text-[8px] font-mono text-zinc-600 uppercase">Factor</span>
                <span className="text-[11px] font-mono font-bold text-amber-400">
                  ×{ratio.toFixed(4)}
                </span>
              </div>
            </div>

            <button
              onClick={handleApplyPitch}
              disabled={!onApplyPitchFactor}
              className={cn(
                'w-full text-[9px] font-mono font-bold uppercase tracking-widest px-2 py-1.5 border transition-all',
                onApplyPitchFactor
                  ? 'border-amber-400/70 text-amber-400 hover:bg-amber-400 hover:text-black'
                  : 'border-zinc-700 text-zinc-600 cursor-not-allowed',
              )}
            >
              Apply to selected row
            </button>
            <p className="text-[8px] text-zinc-600 font-mono mt-1">
              Select a length row in table first
            </p>
          </div>

          {/* Canvas tools */}
          {ADVANCED_CANVAS_TOOLS.map(tool => {
            const isSoon = !!tool.badge;
            return (
              <button
                key={tool.id}
                onClick={() => {
                  if (isSoon) return;
                  setActiveTool(tool.id);
                  setOpen(false);
                }}
                disabled={isSoon}
                className={cn(
                  'w-full flex items-start gap-3 px-3 py-2.5 transition-colors text-left border-b border-industrial-border last:border-b-0',
                  isSoon
                    ? 'opacity-50 cursor-not-allowed'
                    : 'hover:bg-zinc-800',
                  activeTool === tool.id && !isSoon && 'bg-zinc-800',
                )}
              >
                <tool.icon
                  className={cn(
                    'w-4 h-4 mt-0.5 flex-shrink-0',
                    activeTool === tool.id && !isSoon ? 'text-amber-400' : 'text-zinc-500',
                  )}
                />
                <div className="flex-1 min-w-0">
                  <div className={cn(
                    'text-[10px] font-mono font-bold uppercase tracking-widest flex items-center gap-2',
                    activeTool === tool.id && !isSoon ? 'text-amber-400' : 'text-zinc-300',
                  )}>
                    {tool.label}
                    <span className="text-zinc-600">[{tool.shortcut}]</span>
                    {tool.badge && (
                      <span className="ml-auto text-[8px] font-mono font-bold uppercase tracking-widest px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 text-zinc-500">
                        {tool.badge}
                      </span>
                    )}
                  </div>
                  <div className="text-[9px] text-zinc-500 mt-0.5 font-mono">
                    {tool.sub}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ViewerToolbar({
  activeTool, setActiveTool,
  canUndo, canRedo, handleUndo, handleRedo, tempPointsCount,
  snapEnabled, setSnapEnabled,
  showSnapSettings, setShowSnapSettings,
  scaleFactor, handleManualScale,
  analysisStatus, analysisPage, currentPageCorners,
  scale, setScale, fitToScreen,
  MIN_ZOOM, MAX_ZOOM, ZOOM_SENSITIVITY,
  onApplyPitchFactor,
}: ViewerToolbarProps) {
  const isAnalyzing    = analysisStatus === 'analyzing';
  const isAnalysisDone = analysisStatus === 'done';

  const { displayUnit, setDisplayUnit } = useTakeoffContext();

  return (
    <div className="h-12 bg-industrial-panel border-b border-industrial-border flex flex-shrink-0 items-center justify-between px-4 z-30 shadow-sm relative">

      <div className="flex gap-1 items-center">

        {VIEWER_TOOLS.map(tool => (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id as ToolType)}
            className={cn(
              'w-9 h-9 flex items-center justify-center transition-all relative group border',
              activeTool === tool.id
                ? tool.id === 'magic-fill'
                  ? 'bg-zinc-800 border-violet-400 text-violet-400'
                  : tool.id === 'arc'
                  ? 'bg-zinc-800 border-teal-400 text-teal-400'
                  : 'bg-zinc-800 border-amber-400 text-amber-400'
                : 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200',
            )}
            title={`${tool.label} (${tool.shortcut})`}
          >
            <tool.icon className="w-4 h-4" />

            {tool.id === 'arc' && activeTool === 'arc' && (
              <span className="absolute inset-0 rounded-sm animate-pulse bg-teal-400/10 pointer-events-none" />
            )}
            {tool.id === 'magic-fill' && activeTool === 'magic-fill' && (
              <span className="absolute inset-0 rounded-sm animate-pulse bg-violet-400/10 pointer-events-none" />
            )}

            <div className="absolute top-10 transform -translate-x-1/2 left-1/2 px-2 py-1 bg-zinc-900 border border-industrial-border text-[9px] text-zinc-400 invisible group-hover:visible whitespace-nowrap pointer-events-none uppercase tracking-widest font-mono z-50">
              {tool.label} [{tool.shortcut}]
              {tool.id === 'arc' && (
                <span className="block text-teal-400 mt-0.5">
                  Click 3 points — start, mid, end
                </span>
              )}
              {tool.id === 'magic-fill' && (
                <span className="block text-violet-400 mt-0.5">
                  Click or drag to fill rooms
                </span>
              )}
            </div>
          </button>
        ))}

        <div className="w-px h-5 bg-zinc-700/60 self-center mx-0.5" />

        <AdvancedToolsDropdown
          activeTool={activeTool}
          setActiveTool={setActiveTool}
          onApplyPitchFactor={onApplyPitchFactor}
        />

        <div className="w-px h-5 bg-zinc-700/60 self-center mx-0.5" />

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

      <div className="flex flex-row items-center gap-2 flex-1 justify-center">

        {snapEnabled && isAnalyzing && analysisPage && (
          <div className="flex items-center gap-1.5 border border-blue-500/40 bg-blue-500/10 px-2 py-1">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[9px] font-mono text-blue-400 uppercase tracking-widest">
              Analyzing plan… {analysisPage.current}/{analysisPage.total}
            </span>
          </div>
        )}

        <button
          onClick={() => setSnapEnabled(!snapEnabled)}
          className={cn(
            'flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-widest px-3 py-1 border transition-all',
            snapEnabled
              ? 'bg-green-500/10 border-green-500/50 text-green-400 hover:bg-green-500/20'
              : 'bg-amber-500/10 border-amber-500/50 text-amber-400 hover:bg-amber-500/20',
          )}
          title={snapEnabled ? 'Snap is ON' : 'Snap is OFF'}
        >
          <Target className="w-3 h-3" />
          {snapEnabled ? 'SNAP ACTIVE' : 'SNAP INACTIVE'}
        </button>

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

        <div className="w-px h-4 bg-zinc-700/60 mx-0.5" />

        <div className="flex items-center gap-1 border border-industrial-border bg-stone-900 px-2 py-1">
          <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-tighter">Scale:</span>
          <span className="text-[10px] font-mono font-bold text-amber-400 tracking-tighter whitespace-nowrap">
            {scaleFactor === 1 ? 'NOT CALIBRATED' : `1pt = ${scaleFactor.toFixed(4)}m`}
          </span>
        </div>

        <div
          className="flex items-center gap-1 border border-industrial-border bg-stone-900 px-1 py-0.5"
          title="Display unit"
        >
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
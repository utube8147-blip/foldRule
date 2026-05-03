import React from 'react';
import {
  ZoomIn, ZoomOut, Maximize,
  MousePointer2, CircleDot, Ruler, Square, Hash,
  Scaling, Target, Settings2,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { ToolType } from '../types';
import { SnapSettingsPanel } from './SnapSettingsPanel';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AnalysisPage {
  current: number;
  total: number;
}

export interface ViewerToolbarProps {
  // Tool
  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;

  // Zoom
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToScreen: () => void;

  // Scale calibration
  scaleFactor: number;
  onDrawCalibration: () => void;
  onManualScale: () => void;

  // Snap
  snapEnabled: boolean;
  onSnapEnabledChange: (v: boolean) => void;
  showSnapSettings: boolean;
  onShowSnapSettingsChange: (v: boolean) => void;

  // Snap settings panel props (forwarded when panel is open)
  showPins: boolean;
  onShowPinsChange: (v: boolean) => void;
  snapThreshold: number;
  onSnapThresholdChange: (v: number) => void;
  confidenceFilter: number;
  onConfidenceFilterChange: (v: number) => void;

  // Analysis status
  analysisStatus: 'idle' | 'analyzing' | 'done';
  analysisPage: AnalysisPage | null;
  detectedCornerCount: number;
}

// ─── Tool definitions (stable, outside component) ─────────────────────────────

const TOOLS = [
  { id: 'select', icon: MousePointer2, label: 'Select (Pan)', shortcut: 'V' },
  { id: 'point',  icon: CircleDot,     label: 'Point',        shortcut: 'P' },
  { id: 'linear', icon: Ruler,         label: 'Linear',       shortcut: 'L' },
  { id: 'area',   icon: Square,        label: 'Area',         shortcut: 'A' },
  { id: 'count',  icon: Hash,          label: 'Count',        shortcut: 'C' },
  { id: 'scale',  icon: Scaling,       label: 'Calibrate',    shortcut: 'S' },
] as const;

// ─── Component ────────────────────────────────────────────────────────────────

export function ViewerToolbar({
  activeTool, setActiveTool,
  scale, onZoomIn, onZoomOut, onFitToScreen,
  scaleFactor, onDrawCalibration, onManualScale,
  snapEnabled, onSnapEnabledChange,
  showSnapSettings, onShowSnapSettingsChange,
  showPins, onShowPinsChange,
  snapThreshold, onSnapThresholdChange,
  confidenceFilter, onConfidenceFilterChange,
  analysisStatus, analysisPage, detectedCornerCount,
}: ViewerToolbarProps) {
  return (
    <>
      {/* ── Main toolbar row ── */}
      <div className="h-12 bg-industrial-panel border-b border-industrial-border flex flex-shrink-0 items-center justify-between px-4 z-20 shadow-sm relative">

        {/* Left — drawing tools */}
        <div className="flex gap-1">
          {TOOLS.map(tool => (
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
        </div>

        {/* Centre — analysis status, snap controls, scale */}
        <div className="flex flex-col md:flex-row items-center gap-2">

          {/* Analysis progress */}
          {analysisStatus === 'analyzing' && analysisPage && (
            <div className="flex items-center gap-1.5 border border-blue-500/40 bg-blue-500/10 px-2 py-1">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              <span className="text-[9px] font-mono text-blue-400 uppercase tracking-widest">
                Analyzing plan… {analysisPage.current}/{analysisPage.total}
              </span>
            </div>
          )}

          {/* Analysis done */}
          {analysisStatus === 'done' && (
            <div className="flex items-center gap-1.5 border border-green-500/40 bg-green-500/10 px-2 py-1">
              <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
              <span className="text-[9px] font-mono text-green-400 uppercase tracking-widest">
                {detectedCornerCount} corners detected
              </span>
            </div>
          )}

          {/* Snap toggle */}
          <button
            onClick={() => onSnapEnabledChange(!snapEnabled)}
            className={cn(
              'flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-widest px-2 py-1 border transition-all',
              snapEnabled
                ? 'bg-green-500/10 border-green-500/50 text-green-400 hover:bg-green-500/20'
                : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
            )}
            title="Toggle corner snapping"
          >
            <Target className="w-3 h-3" />
            {snapEnabled ? 'SNAP ON' : 'SNAP OFF'}
          </button>

          {/* Snap settings toggle */}
          <button
            onClick={() => onShowSnapSettingsChange(!showSnapSettings)}
            className={cn(
              'flex items-center gap-1 text-[9px] font-mono font-bold uppercase tracking-widest px-2 py-1 border transition-all',
              showSnapSettings
                ? 'bg-zinc-800 border-zinc-500 text-zinc-200'
                : 'bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500',
            )}
            title="Snap settings"
          >
            <Settings2 className="w-3 h-3" />
            SNAP
          </button>

          {/* Scale display */}
          <div className="flex items-center gap-1 border border-industrial-border bg-stone-900 px-2 py-1">
            <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-tighter">Scale:</span>
            <span className="text-[10px] font-mono font-bold text-amber-400 tracking-tighter whitespace-nowrap">
              {scaleFactor === 1 ? 'NOT CALIBRATED' : `1px = ${scaleFactor.toFixed(4)}u`}
            </span>
          </div>

          {/* Draw calibration */}
          <button
            onClick={onDrawCalibration}
            className={cn(
              'text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 transition-all border',
              activeTool === 'scale'
                ? 'bg-amber-400 text-black border-amber-400'
                : 'text-amber-400 border-amber-400 hover:bg-amber-400 hover:text-black',
            )}
          >
            DRAW CALIBRATION
          </button>

          {/* Manual scale */}
          <button
            onClick={onManualScale}
            className="text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1 transition-all border text-amber-400 border-amber-400 hover:bg-amber-400 hover:text-black"
          >
            MANUAL SCALE
          </button>
        </div>

        {/* Right — zoom controls */}
        <div className="flex items-center gap-2">
          <button onClick={onZoomOut} className="p-1.5 text-zinc-500 hover:text-zinc-200">
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-[10px] font-mono text-zinc-400 w-12 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button onClick={onZoomIn} className="p-1.5 text-zinc-500 hover:text-zinc-200">
            <ZoomIn className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-industrial-border mx-1" />
          <button onClick={onFitToScreen} className="p-1.5 text-zinc-500 hover:text-zinc-200">
            <Maximize className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Snap settings panel (rendered below toolbar when open) ── */}
      {showSnapSettings && (
        <SnapSettingsPanel
          showPins={showPins}
          onShowPinsChange={onShowPinsChange}
          snapThreshold={snapThreshold}
          onSnapThresholdChange={onSnapThresholdChange}
          confidenceFilter={confidenceFilter}
          onConfidenceFilterChange={onConfidenceFilterChange}
          snapEnabled={snapEnabled}
          onSnapEnabledChange={onSnapEnabledChange}
        />
      )}
    </>
  );
}
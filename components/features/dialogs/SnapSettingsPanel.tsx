// SnapSettingsPanel.tsx
import React from 'react';
import { Target, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SnapSettingsPanelProps {
  showPins: boolean;
  onShowPinsChange: (v: boolean) => void;
  snapThreshold: number;
  onSnapThresholdChange: (v: number) => void;
  confidenceFilter: number;
  onConfidenceFilterChange: (v: number) => void;
  snapEnabled: boolean;
  onSnapEnabledChange: (v: boolean) => void;
}

export function SnapSettingsPanel({
  showPins, onShowPinsChange,
  snapThreshold, onSnapThresholdChange,
  confidenceFilter, onConfidenceFilterChange,
  snapEnabled, onSnapEnabledChange,
}: SnapSettingsPanelProps) {
  return (
    <div className="absolute top-14 right-2 z-50 bg-zinc-900 border border-zinc-700 shadow-2xl shadow-black/50 p-3 w-64 font-mono">
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-zinc-800">
        <Target className="w-3.5 h-3.5 text-amber-400" />
        <span className="text-[10px] font-bold text-zinc-200 uppercase tracking-widest">Snap Settings</span>
      </div>

      {/* Snap Enable Toggle
          FIX Bug #7: replaced custom `bg-amber-accent` / `border-amber-accent`
          tokens (which may not be defined in tailwind.config) with the standard
          Tailwind `bg-amber-400` / `border-amber-400` utilities. */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-zinc-400 uppercase tracking-wider">Corner Snap</span>
        <button
          onClick={() => onSnapEnabledChange(!snapEnabled)}
          className={cn(
            "text-[9px] font-bold px-2 py-0.5 border transition-all uppercase tracking-widest",
            snapEnabled
              ? "bg-amber-400 text-black border-amber-400"
              : "bg-transparent text-zinc-500 border-zinc-700 hover:border-zinc-500"
          )}
        >
          {snapEnabled ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* Show Pins Toggle */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-zinc-400 uppercase tracking-wider">Show Pins</span>
        <button
          onClick={() => onShowPinsChange(!showPins)}
          className={cn(
            "flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 border transition-all uppercase tracking-widest",
            showPins
              ? "text-blue-400 border-blue-400/50 hover:bg-blue-400/10"
              : "text-zinc-500 border-zinc-700 hover:border-zinc-500"
          )}
        >
          {showPins ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          {showPins ? 'VISIBLE' : 'HIDDEN'}
        </button>
      </div>

      {/* Snap Threshold */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-zinc-400 uppercase tracking-wider">Snap Radius</span>
          {/* FIX Bug #7: replaced text-amber-accent with text-amber-400 */}
          <span className="text-[10px] font-bold text-amber-400">{snapThreshold}px</span>
        </div>
        <input
          type="range"
          min={8}
          max={30}
          value={snapThreshold}
          onChange={e => onSnapThresholdChange(parseInt(e.target.value))}
          className="w-full h-1 accent-amber-400 cursor-pointer"
        />
        <div className="flex justify-between text-[8px] text-zinc-600 mt-0.5">
          <span>8px precise</span>
          <span>30px loose</span>
        </div>
      </div>

      {/* Confidence Filter */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-zinc-400 uppercase tracking-wider">Corner Density</span>
          <span className="text-[10px] font-bold text-blue-400">
            {confidenceFilter < 0.15 ? 'ALL' : confidenceFilter < 0.5 ? 'MAJOR' : 'KEY ONLY'}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(confidenceFilter * 100)}
          onChange={e => onConfidenceFilterChange(parseInt(e.target.value) / 100)}
          className="w-full h-1 accent-blue-400 cursor-pointer"
        />
        <div className="flex justify-between text-[8px] text-zinc-600 mt-0.5">
          <span>All corners</span>
          <span>Key only</span>
        </div>
      </div>
    </div>
  );
}

// components/Viewer/AdvancedToolsDropdown.tsx
'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  ChevronDown, Ruler, Circle, Grid3x3, Check, AlertTriangle,
  Box, Spline, ScanSearch,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolType } from '@/types';
import { useTakeoffContext } from '@/context/TakeoffContext';

interface Props {
  activeTool:    ToolType;
  setActiveTool: (t: ToolType) => void;
}

const ADVANCED_TOOLS: Array<{
  id:       ToolType;
  label:    string;
  sub:      string;
  icon:     React.ElementType;
  shortcut: string;
  badge?:   string;
}> = [
  {
    id:       'arc',
    label:    'Arc',
    sub:      'Click start · mid · end points',
    icon:     Circle,
    shortcut: 'B',
  },
  {
    id:       'radius',
    label:    'Radius / circle',
    sub:      'Click centre then edge',
    icon:     Circle,
    shortcut: 'R2',
  },
  {
    id:       'grid-count',
    label:    'Grid count',
    sub:      'Draw polygon area, grid auto-counts tiles',
    icon:     Grid3x3,
    shortcut: 'Soon',
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

export function AdvancedToolsDropdown({ activeTool, setActiveTool }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const isAdvancedActive = ADVANCED_TOOLS.some(t => t.id === activeTool);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          'h-9 flex items-center gap-1 px-2 border transition-all text-[9px] font-mono font-bold uppercase tracking-widest',
          isAdvancedActive || open
            ? 'bg-zinc-800 border-amber-400 text-amber-400'
            : 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-200',
        )}
        title="Advanced tools"
      >
        <Ruler className="w-4 h-4" />
        <span className="hidden xl:inline">Advanced</span>
        <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute top-10 left-0 z-[80] bg-industrial-panel border border-industrial-border shadow-xl min-w-[260px]">

          {/* Pitch factor row */}
          <PitchFactorRow />

          <div className="h-px bg-industrial-border" />

          {/* Canvas tools */}
          {ADVANCED_TOOLS.map(tool => {
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
                <tool.icon className={cn(
                  'w-4 h-4 mt-0.5 flex-shrink-0',
                  activeTool === tool.id && !isSoon ? 'text-amber-400' : 'text-zinc-500',
                )} />
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
                  <div className="text-[9px] text-zinc-500 mt-0.5">{tool.sub}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Pitch factor inline row ────────────────────────────────────────────────

function PitchFactorRow() {
  const [rise, setRise] = useState('6');
  const [run,  setRun]  = useState('12');
  const [feedback, setFeedback] = useState<'idle' | 'applied' | 'error'>('idle');

  const { selectedId, projectState, updateMeasurement } = useTakeoffContext();

  const riseNum = parseFloat(rise) || 0;
  const runNum  = parseFloat(run)  || 1;
  const ratio   = runNum > 0 ? Math.sqrt(1 + (riseNum / runNum) ** 2) : 1;

  const selectedMeasurement = selectedId
    ? projectState.measurements.find(m => m.id === selectedId)
    : null;

  const canApply =
    !!selectedMeasurement &&
    !selectedMeasurement.isGroupHeader &&
    selectedMeasurement.type === 'Length';

  const handleApply = () => {
    if (!canApply || !selectedMeasurement) {
      setFeedback('error');
      setTimeout(() => setFeedback('idle'), 2000);
      return;
    }

    const newQty = +(selectedMeasurement.quantity * ratio).toFixed(4);

    updateMeasurement(selectedMeasurement.id, {
      quantity:    newQty,
      isOverridden: true,
      notes: [
        selectedMeasurement.notes,
        `Pitch ${rise}:${run} (×${ratio.toFixed(4)}) applied`,
      ].filter(Boolean).join(' | '),
    });

    setFeedback('applied');
    setTimeout(() => setFeedback('idle'), 1800);
  };

  return (
    <div className="px-3 py-2.5">
      <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-zinc-300 mb-2 flex items-center gap-1.5">
        <Ruler className="w-3.5 h-3.5 text-zinc-500" />
        Pitch / slope factor
      </div>

      <div className="flex items-center gap-2 mb-2">
        <div className="flex flex-col items-center">
          <span className="text-[8px] text-zinc-600 font-mono mb-0.5">RISE</span>
          <input
            type="number" min="0" max="24" step="1"
            value={rise}
            onChange={e => { setRise(e.target.value); setFeedback('idle'); }}
            className="w-12 bg-zinc-900 border border-zinc-700 text-zinc-200 text-[10px] font-mono text-center px-1 py-1 focus:outline-none focus:border-amber-400"
          />
        </div>
        <span className="text-zinc-500 text-[9px] font-mono mt-3">:</span>
        <div className="flex flex-col items-center">
          <span className="text-[8px] text-zinc-600 font-mono mb-0.5">RUN</span>
          <input
            type="number" min="1" max="24" step="1"
            value={run}
            onChange={e => { setRun(e.target.value); setFeedback('idle'); }}
            className="w-12 bg-zinc-900 border border-zinc-700 text-zinc-200 text-[10px] font-mono text-center px-1 py-1 focus:outline-none focus:border-amber-400"
          />
        </div>
        <span className="text-[9px] font-mono text-zinc-500 mt-3">→</span>
        <div className="flex flex-col items-center mt-3">
          <span className="text-[10px] font-mono font-bold text-amber-400">
            ×{ratio.toFixed(4)}
          </span>
        </div>
      </div>

      <div className="mb-2 min-h-[28px]">
        {selectedMeasurement && canApply ? (
          <div className="text-[9px] font-mono text-zinc-400 bg-zinc-900 border border-zinc-700 px-2 py-1">
            <span className="text-zinc-500">Selected: </span>
            <span className="text-zinc-200 truncate">
              {selectedMeasurement.label || selectedMeasurement.description}
            </span>
            <span className="text-zinc-500 ml-1">
              {selectedMeasurement.quantity.toFixed(3)}m
            </span>
            <span className="text-amber-400 ml-1">
              → {(selectedMeasurement.quantity * ratio).toFixed(3)}m
            </span>
          </div>
        ) : selectedMeasurement && !canApply ? (
          <div className="text-[9px] font-mono text-zinc-500 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3 text-amber-600" />
            Select a Length row to apply pitch
          </div>
        ) : (
          <div className="text-[9px] text-zinc-600 font-mono">
            Select a length row in the takeoff table
          </div>
        )}
      </div>

      <button
        onClick={handleApply}
        disabled={!canApply}
        className={cn(
          'w-full flex items-center justify-center gap-1.5 py-1.5 font-mono font-bold text-[9px] uppercase tracking-widest transition-all',
          feedback === 'applied'
            ? 'bg-green-600 text-white border border-green-500'
            : feedback === 'error'
            ? 'bg-red-900/60 text-red-400 border border-red-700'
            : canApply
            ? 'bg-amber-400 text-black hover:bg-amber-300 active:scale-95 border border-amber-400'
            : 'bg-zinc-800 text-zinc-600 border border-zinc-700 cursor-not-allowed',
        )}
      >
        {feedback === 'applied' ? (
          <><Check className="w-3 h-3" /> Applied</>
        ) : feedback === 'error' ? (
          <><AlertTriangle className="w-3 h-3" /> No length row selected</>
        ) : (
          <>Apply to selected row</>
        )}
      </button>
    </div>
  );
}
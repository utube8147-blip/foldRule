'use client';

// ─── WallChainCommitDialog.tsx ────────────────────────────────────────────────
//
//  Shown when the user right-clicks or presses Enter to commit a wall chain.
//  Lets them:
//    • Name the measurement
//    • Choose type: Linear / Area / Polygon
//  Then calls onCommit(type, label).
//
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useRef } from 'react';
import { Link2, Square, Activity, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  isOpen:        boolean;
  segmentCount:  number;
  totalLengthM:  number;
  scaleFactor:   number;
  onCommit:      (type: 'Length' | 'Area' | 'Polygon', label: string) => void;
  onCancel:      () => void;
}

type MeasureType = 'Length' | 'Area' | 'Polygon';

const TYPES: { id: MeasureType; icon: React.ElementType; label: string; unit: string; desc: string }[] = [
  { id: 'Length',  icon: Link2,     label: 'Linear',  unit: 'm',  desc: 'Sum of segment lengths' },
  { id: 'Area',    icon: Square,    label: 'Area',    unit: 'm²', desc: 'Enclosed area (auto-close)' },
  { id: 'Polygon', icon: Activity,  label: 'Polygon', unit: 'm²', desc: 'Custom polygon shape' },
];

export function WallChainCommitDialog({
  isOpen,
  segmentCount,
  totalLengthM,
  scaleFactor,
  onCommit,
  onCancel,
}: Props) {
  const [selected, setSelected] = useState<MeasureType>('Length');
  const [label,    setLabel]    = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setSelected('Length');
      setLabel('');
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleConfirm = () => {
    onCommit(selected, label.trim() || `Wall Chain ${segmentCount} seg`);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-amber-400/40 shadow-2xl shadow-amber-400/10 w-96 font-mono">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-bold text-amber-400 uppercase tracking-widest">
              Commit Wall Chain
            </span>
          </div>
          <button onClick={onCancel} className="text-zinc-600 hover:text-zinc-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Stats */}
        <div className="px-4 py-3 border-b border-zinc-800 flex gap-4">
          <div className="flex flex-col">
            <span className="text-[10px] text-zinc-500 uppercase tracking-widest">Segments</span>
            <span className="text-sm font-bold text-zinc-200">{segmentCount}</span>
          </div>
          <div className="w-px bg-zinc-800" />
          <div className="flex flex-col">
            <span className="text-[10px] text-zinc-500 uppercase tracking-widest">Total Length</span>
            <span className="text-sm font-bold text-amber-400">
              {scaleFactor > 0 ? `${totalLengthM.toFixed(3)} m` : 'Not calibrated'}
            </span>
          </div>
          {scaleFactor <= 0 && (
            <p className="text-[10px] text-red-400 uppercase tracking-wider self-center">
              Calibrate scale first
            </p>
          )}
        </div>

        {/* Type picker */}
        <div className="px-4 py-3 border-b border-zinc-800">
          <p className="text-[10px] text-zinc-500 uppercase tracking-widest mb-2">Measurement Type</p>
          <div className="flex gap-2">
            {TYPES.map(t => (
              <button
                key={t.id}
                onClick={() => setSelected(t.id)}
                className={cn(
                  'flex-1 flex flex-col items-center gap-1 py-2 px-1 border transition-all text-center',
                  selected === t.id
                    ? 'border-amber-400 bg-amber-400/10 text-amber-400'
                    : 'border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300',
                )}
              >
                <t.icon className="w-4 h-4" />
                <span className="text-[10px] font-bold uppercase tracking-widest">{t.label}</span>
                <span className="text-[10px] text-zinc-600">{t.unit}</span>
              </button>
            ))}
          </div>
          <p className="text-[10px] text-zinc-600 mt-1.5">
            {TYPES.find(t => t.id === selected)?.desc}
          </p>
        </div>

        {/* Label input */}
        <div className="px-4 py-3 border-b border-zinc-800">
          <p className="text-[10px] text-zinc-500 uppercase tracking-widest mb-2">Label (optional)</p>
          <input
            ref={inputRef}
            type="text"
            placeholder={`Wall Chain ${segmentCount} seg`}
            value={label}
            onChange={e => setLabel(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleConfirm();
              if (e.key === 'Escape') onCancel();
            }}
            className="w-full bg-zinc-800 border border-zinc-600 focus:border-amber-400 text-zinc-100 text-sm font-mono px-3 py-2 outline-none transition-colors"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-2 px-4 py-3">
          <button
            onClick={handleConfirm}
            className="flex-1 bg-amber-400 hover:bg-amber-300 text-black font-bold text-[11px] uppercase tracking-widest py-2 transition-all active:scale-95"
          >
            Add to Takeoff
          </button>
          <button
            onClick={onCancel}
            className="flex-1 border border-zinc-700 hover:border-zinc-500 text-zinc-400 font-bold text-[11px] uppercase tracking-widest py-2 transition-all"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
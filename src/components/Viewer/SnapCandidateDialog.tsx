import React from 'react';
import { Target } from 'lucide-react';

export interface SnapCandidateDialogProps {
  count: number;
  onAccept: () => void;
  onDismiss: () => void;
}

export function SnapCandidateDialog({ count, onAccept, onDismiss }: SnapCandidateDialogProps) {
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

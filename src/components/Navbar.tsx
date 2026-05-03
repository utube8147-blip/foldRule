import React from 'react';
import { Download, HardHat, Cloud, Grid3X3 } from 'lucide-react';
import { cn } from '../lib/utils';

interface NavbarProps {
  projectName: string;
  onProjectNameChange: (name: string) => void;
  onExport: () => void;
  onOpenPresets?: () => void;
}

export function Navbar({ projectName, onProjectNameChange, onExport, onOpenPresets }: NavbarProps) {
  return (
    <header className="h-14 bg-industrial-panel border-b border-industrial-border flex items-center justify-between px-6 z-50 fixed top-0 w-full">
      <div className="flex items-center gap-6 h-full">
        <div className="flex items-center gap-2 border-r border-industrial-border pr-6 h-8">
          <HardHat className="w-6 h-6 text-amber-accent" />
          <span className="text-xl font-black tracking-tighter text-amber-accent font-mono">QUANTITY SAVIOR</span>
        </div>
        
        <div className="flex flex-col">
          <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest leading-none mb-1">ACTIVE PROJECT</span>
          <input
            type="text"
            value={projectName}
            onChange={(e) => onProjectNameChange(e.target.value)}
            className="bg-transparent border-none p-0 m-0 text-sm font-mono font-bold text-zinc-200 focus:ring-0 focus:text-amber-accent transition-colors w-64"
          />
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 px-3 py-1 bg-stone-900 border border-industrial-border">
          <Cloud className="w-3.5 h-3.5 text-emerald-500 animate-pulse" />
          <span className="text-[10px] font-mono font-bold text-zinc-400">SYNCED</span>
        </div>
        
        {onOpenPresets && (
          <button
            onClick={onOpenPresets}
            className="bg-slate-700 hover:bg-slate-600 text-amber-400 font-mono font-bold text-xs px-4 py-2 flex items-center gap-2 transition-all active:scale-95 border border-amber-500"
          >
            <Grid3X3 className="w-4 h-4" />
            PRESETS
          </button>
        )}
        
        <button
          onClick={onExport}
          className="bg-amber-accent hover:bg-amber-400 text-black font-mono font-bold text-xs px-4 py-2 flex items-center gap-2 transition-all active:scale-95 shadow-lg shadow-amber-accent/10"
        >
          <Download className="w-4 h-4" />
          EXPORT TO EXCEL
        </button>
      </div>
    </header>
  );
}

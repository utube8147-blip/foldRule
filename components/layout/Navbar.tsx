'use client';

import React from 'react';
import Link from 'next/link';
import { Download, HardHat } from 'lucide-react';
import { SaveIndicator } from '@/components/layout/SaveIndicator';

interface NavbarProps {
  projectName: string;
  onProjectNameChange: (name: string) => void;
  onExport: () => void;
  onOpenPresets?: () => void;
}

function NavbarImpl({ projectName, onProjectNameChange, onExport, onOpenPresets }: NavbarProps) {
  return (
    <header className="h-14 bg-industrial-panel border-b border-industrial-border flex items-center justify-between px-6 z-50 fixed top-0 w-full">
      <div className="flex items-center gap-6 h-full">
        <Link
          href="/dashboard"
          title="All projects"
          className="flex items-center gap-2 border-r border-industrial-border pr-6 h-8 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
        >
          <HardHat className="w-6 h-6 text-amber-accent" />
          <span className="text-xl font-black tracking-tighter text-amber-accent font-mono">QUANTITY SAVIOR</span>
        </Link>
        
        <div className="flex flex-col">
          <label htmlFor="project-name" className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest leading-none mb-1">Project</label>
          <input
            id="project-name"
            maxLength={120}
            type="text"
            value={projectName}
            onChange={(e) => onProjectNameChange(e.target.value)}
            className="bg-transparent border-none p-0 m-0 text-sm font-mono font-bold text-zinc-200 focus:ring-0 focus:text-amber-accent transition-colors w-64"
          />
        </div>
      </div>

      <div className="flex items-center gap-4">
        <SaveIndicator />

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

/** Memoized: skips re-rendering when its props are unchanged. */
export const Navbar = React.memo(NavbarImpl);

'use client';

import React from 'react';
import Link from 'next/link';
import { Download } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { SaveIndicator } from '@/components/layout/SaveIndicator';

interface NavbarProps {
  projectName: string;
  onProjectNameChange: (name: string) => void;
  onExport: () => void;
  onOpenPresets?: () => void;
  /** Project-level controls shown in the middle of the header (undo/redo, scale). */
  center?: React.ReactNode;
}

function NavbarImpl({ projectName, onProjectNameChange, onExport, onOpenPresets, center }: NavbarProps) {
  return (
    <header className="h-14 bg-industrial-panel border-b border-industrial-border flex items-center justify-between gap-6 px-6 z-50 fixed top-0 w-full">
      <div className="flex items-center gap-6 h-full min-w-0">
        <Link
          href="/dashboard"
          title="All projects"
          aria-label="Foldrule — all projects"
          className="flex items-center gap-2 border-r border-industrial-border pr-6 h-8 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
        >
          <Logo size={20} />
        </Link>
        
        <div className="flex flex-col">
          <label htmlFor="project-name" className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest leading-none mb-1">Project</label>
          <input
            id="project-name"
            maxLength={120}
            type="text"
            value={projectName}
            onChange={(e) => onProjectNameChange(e.target.value)}
            className="bg-transparent border-none p-0 m-0 text-sm font-mono font-bold text-zinc-200 focus:ring-0 focus:text-amber-accent transition-colors w-40 xl:w-64"
          />
        </div>
      </div>

      {center && (
        <div className="flex flex-1 items-center justify-center gap-3 min-w-0">
          {center}
        </div>
      )}

      <div className="flex items-center gap-4 flex-shrink-0">
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

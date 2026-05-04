import React, { useState } from 'react';
import { FileText, FolderOpen, Filter, Search, Settings2, Plus, Trash2, Database, Info, Layers } from 'lucide-react';
import { cn } from '../lib/utils';
import { ProjectState, MaterialSpec } from '../types';

interface SidebarProps {
  isCollapsed: boolean;
  projectState: ProjectState;
  onUpdateMaterials: (materials: MaterialSpec[]) => void;
  onOpenMaterialLibrary?: () => void;
  onDrawingAdded: (name: string, fileUrl: string, file?: File) => void;
  onSelectDrawing: (id: string) => void;
  onProjectNameChange: (name: string) => void;
  onProjectNumberChange: (num: string) => void;
}

export function Sidebar({ 
  isCollapsed, 
  projectState, 
  onUpdateMaterials, 
  onOpenMaterialLibrary,
  onDrawingAdded,
  onSelectDrawing,
  onProjectNameChange,
  onProjectNumberChange
}: SidebarProps) {
  const [activeTab, setActiveTab] = useState<'drawings' | 'specs'>('drawings');

  return (
    <aside 
      className={cn(
        "bg-industrial-panel border-r border-industrial-border flex flex-col h-full transition-all duration-300 ease-in-out font-mono",
        isCollapsed ? "w-0 overflow-hidden border-none" : "w-72 shrink-0"
      )}
    >
      <div className="p-3 border-b border-industrial-border bg-stone-900/50 flex justify-between items-center shrink-0">
        <span className="text-[10px] font-bold text-zinc-500 my-1 tracking-widest uppercase">Project Explorer</span>
        <div className="flex gap-2">
          <button className="text-zinc-600 hover:text-zinc-300 transition-colors">
            <Filter className="w-3.5 h-3.5" />
          </button>
          <button className="text-zinc-600 hover:text-zinc-300 transition-colors">
            <Search className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex border-b border-industrial-border shrink-0">
        <button 
          onClick={() => setActiveTab('drawings')}
          className={cn(
            "flex-1 py-3 text-[10px] font-bold tracking-widest uppercase transition-colors flex items-center justify-center gap-2",
            activeTab === 'drawings' ? "text-amber-accent border-b-2 border-amber-accent bg-zinc-800/20" : "text-zinc-600 hover:text-zinc-400"
          )}
        >
          <FolderOpen className="w-3.5 h-3.5" />
          Drawings
        </button>
        <button 
          onClick={() => setActiveTab('specs')}
          className={cn(
            "flex-1 py-3 text-[10px] font-bold tracking-widest uppercase transition-colors flex items-center justify-center gap-2",
            activeTab === 'specs' ? "text-amber-accent border-b-2 border-amber-accent bg-zinc-800/20" : "text-zinc-600 hover:text-zinc-400"
          )}
        >
          <Settings2 className="w-3.5 h-3.5" />
          Scope / Specs
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-0">
        {activeTab === 'drawings' ? (
          <div className="space-y-px flex flex-col h-full">
            <div className="flex-1 overflow-y-auto">
              {projectState.drawings.length === 0 && (
                <div className="text-center py-10 px-4 flex flex-col items-center">
                  <FileText className="w-8 h-8 text-zinc-700 mb-3" />
                  <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">No Drawings</p>
                  <p className="text-[9px] text-zinc-600 mt-2 uppercase tracking-widest">Select files in the main view or below</p>
                </div>
              )}
              {projectState.drawings.map((file) => (
                <button
                  key={file.id}
                  onClick={() => onSelectDrawing(file.id)}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-3 text-left transition-all border-l-2",
                    file.id === projectState.activeDrawingId 
                      ? "bg-zinc-800/50 border-amber-accent text-amber-accent" 
                      : "border-transparent text-zinc-400 hover:bg-zinc-800/30 hover:text-zinc-200"
                  )}
                >
                  <FileText className="w-4 h-4 shrink-0" />
                  <span className="text-[11px] truncate font-medium uppercase tracking-tight">{file.name}</span>
                </button>
              ))}
            </div>
            {projectState.drawings.length > 0 && (
              <div className="p-4 border-t border-industrial-border mt-auto shrink-0 bg-industrial-black/50">
                <label className="w-full bg-stone-800 hover:bg-stone-700 text-zinc-300 font-bold uppercase tracking-widest text-[10px] py-2.5 transition-colors flex items-center justify-center gap-2 cursor-pointer border border-zinc-700">
                  <Plus className="w-3.5 h-3.5" /> Upload Drawing
                  <input 
                    type="file" 
                    multiple 
                    className="hidden" 
                    accept=".pdf,.png,.jpg,.jpeg,.dwg" 
                    onChange={(e) => {
                      const files = e.target.files;
                      if (!files) return;
                      Array.from(files).forEach((file: File) => {
                        onDrawingAdded(file.name, URL.createObjectURL(file), file);
                      });
                    }} 
                  />
                </label>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 flex flex-col gap-6">
            <div>
              <h3 className="text-[10px] font-bold text-amber-accent uppercase tracking-widest mb-3 flex items-center gap-2">
                <Info className="w-3.5 h-3.5" /> Project Scope
              </h3>
              <div className="space-y-4">
                <div>
                  <label className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold block mb-1">Project Name</label>
                  <input 
                    type="text" 
                    value={projectState.projectName}
                    onChange={(e) => onProjectNameChange(e.target.value)}
                    className="w-full bg-[#0D0D0D] border border-zinc-800 p-2 text-[11px] font-bold text-zinc-200 outline-none focus:border-amber-accent transition-colors uppercase"
                  />
                </div>
                <div>
                  <label className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold block mb-1">Project Number</label>
                  <input 
                    type="text"
                    value={projectState.projectNumber || ''}
                    onChange={(e) => onProjectNumberChange(e.target.value)}
                    className="w-full bg-[#0D0D0D] border border-zinc-800 p-2 text-[11px] font-bold text-zinc-200 outline-none focus:border-amber-accent transition-colors uppercase"
                  />
                </div>
              </div>
            </div>

            <div className="h-px bg-zinc-800/50 w-full" />

            <div>
              <h3 className="text-[10px] font-bold text-amber-accent uppercase tracking-widest mb-3 flex items-center gap-2">
                <Layers className="w-3.5 h-3.5" /> Master Specifications
              </h3>
              <p className="text-[10px] text-zinc-400 uppercase tracking-widest leading-relaxed mb-4">
                Access the centralized material library to manage unit costs, labor rates, and equipment expenses globally.
              </p>
              <button 
                onClick={() => onOpenMaterialLibrary?.()}
                className="w-full bg-amber-accent hover:bg-amber-400 text-black font-bold uppercase tracking-widest text-[10px] py-3.5 transition-colors flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(245,158,11,0.15)] hover:shadow-[0_0_20px_rgba(245,158,11,0.25)] active:scale-95"
              >
                <Database className="w-3.5 h-3.5" /> Open Master Library
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="p-4 bg-industrial-black border-t border-industrial-border shrink-0">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">Workspace Industrial V2.4</span>
        </div>
        <div className="text-[10px] font-bold text-zinc-600 uppercase tracking-tighter flex justify-between">
          <span>MEM LOAD: 4.2GB</span>
          <span className="text-emerald-500/50">STABLE</span>
        </div>
      </div>
    </aside>
  );
}

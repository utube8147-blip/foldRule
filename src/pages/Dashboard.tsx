import React from 'react';
import { useLocation } from 'wouter';
import { HardHat, FolderOpen, Plus, Search, Filter, BoxSelect, LogOut } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';

const MOCK_PROJECTS = [
  { id: 1, name: 'LOGISTICS_HUB_P2', date: 'Oct 24, 2023', items: 1542, status: 'Active', updated: '2 hrs ago' },
  { id: 2, name: 'STEEL_MILL_RENOVATION', date: 'Sep 12, 2023', items: 340, status: 'Review', updated: '1 day ago' },
  { id: 3, name: 'WAREHOUSE_EXPANSION_A', date: 'Aug 05, 2023', items: 890, status: 'Active', updated: '3 days ago' },
  { id: 4, name: 'FACTORY_FLOOR_B3', date: 'Jul 18, 2023', items: 210, status: 'Archived', updated: '1 month ago' },
];

export function Dashboard() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-industrial-black flex flex-col font-mono text-zinc-200">
      <header className="h-16 border-b border-industrial-border bg-industrial-panel px-6 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-6 h-full">
          <div className="flex items-center gap-3 border-r border-industrial-border pr-6">
            <HardHat className="w-7 h-7 text-amber-accent" />
            <span className="text-2xl font-black tracking-tighter text-amber-accent font-mono uppercase">Quantity Savior</span>
          </div>
          
          <nav className="flex items-center gap-1 h-full">
            {['Dashboard', 'Projects', 'Archives'].map((item, i) => (
              <button 
                key={item} 
                className={cn(
                  "px-4 h-full text-xs font-bold uppercase tracking-widest flex items-center border-b-2 transition-all",
                  i === 0 
                    ? "border-amber-accent text-amber-accent bg-zinc-800/30" 
                    : "border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/10"
                )}
              >
                {item}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input 
              type="text" 
              placeholder="Search projects..." 
              className="bg-stone-900 border border-industrial-border pl-9 pr-4 py-1.5 text-xs focus:border-amber-accent outline-none w-48 transition-all focus:w-64"
            />
          </div>
          
          <div className="w-px h-6 bg-industrial-border mx-2" />
          
          <div className="flex items-center gap-3">
            <div className="text-right flex flex-col">
              <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest leading-none">John Doe</span>
              <span className="text-[9px] text-zinc-500 uppercase tracking-widest">Lead Estimator</span>
            </div>
            <div className="w-8 h-8 bg-zinc-800 border border-industrial-border flex items-center justify-center font-bold text-amber-accent">
              JD
            </div>
            <button 
              onClick={() => setLocation('/')}
              className="p-1.5 text-zinc-600 hover:text-red-400 transition-colors ml-2"
              title="Logout"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-8 max-w-screen-2xl mx-auto w-full">
        <div className="flex justify-between items-end mb-8">
          <div>
            <h1 className="text-3xl font-black tracking-tight uppercase mb-2">Active Projects</h1>
            <p className="text-[11px] text-zinc-500 tracking-widest uppercase">System holds {MOCK_PROJECTS.length} records</p>
          </div>
          <div className="flex items-center gap-3">
            <button className="flex items-center gap-2 text-[10px] font-bold border border-industrial-border px-3 py-2 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-all uppercase tracking-widest">
              <Filter className="w-3.5 h-3.5" />
              Filter
            </button>
            <button 
              onClick={() => setLocation('/workspace')}
              className="flex items-center gap-2 text-[10px] font-bold bg-amber-accent hover:bg-amber-400 text-black px-4 py-2 uppercase tracking-widest transition-all shadow-[0_0_15px_rgba(245,158,11,0.15)] active:scale-95"
            >
              <Plus className="w-3.5 h-3.5" />
              New Project
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {MOCK_PROJECTS.map((project, i) => (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              key={project.id}
              onClick={() => setLocation('/workspace')}
              className="group bg-industrial-panel border border-industrial-border hover:border-amber-accent/50 cursor-pointer transition-all hover:shadow-2xl hover:shadow-amber-accent/5 flex flex-col"
            >
              <div className="h-32 bg-stone-900 border-b border-industrial-border relative overflow-hidden flex items-center justify-center">
                <div className="absolute inset-0 blueprint-grid opacity-30 group-hover:opacity-50 transition-opacity" />
                <FolderOpen className="w-10 h-10 text-zinc-700 group-hover:text-amber-accent/50 transition-colors z-10" />
                
                {project.status === 'Active' && (
                  <div className="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/30 text-[9px] font-bold text-emerald-500 uppercase tracking-widest z-10">
                    <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                    Active
                  </div>
                )}
              </div>
              
              <div className="p-4 flex-1 flex flex-col justify-between">
                <div>
                  <h3 className="font-bold text-sm tracking-tight text-zinc-100 uppercase group-hover:text-amber-accent transition-colors max-w-full truncate" title={project.name}>
                    {project.name}
                  </h3>
                  <div className="flex items-center gap-2 mt-2 text-[10px] text-zinc-500 tracking-widest uppercase">
                    <span>Created: {project.date}</span>
                  </div>
                </div>
                
                <div className="mt-6 pt-4 border-t border-industrial-border/50 flex justify-between items-center text-[10px] uppercase font-bold tracking-widest">
                  <span className="text-zinc-600 flex items-center gap-1.5">
                    <BoxSelect className="w-3.5 h-3.5" />
                    {project.items} Quantities
                  </span>
                  <span className="text-amber-accent/70">{project.updated}</span>
                </div>
              </div>
            </motion.div>
          ))}
          
          <button 
            onClick={() => setLocation('/workspace')}
            className="border-2 border-dashed border-industrial-border hover:border-amber-accent/40 bg-industrial-panel/30 hover:bg-amber-accent/5 flex flex-col items-center justify-center p-8 text-zinc-500 hover:text-amber-accent transition-all min-h-[280px]"
          >
            <Plus className="w-8 h-8 mb-4 border border-current rounded-none" />
            <span className="text-sm font-bold uppercase tracking-widest">Initialize Blank Project</span>
          </button>
        </div>
      </main>
    </div>
  );
}

'use client';

import React from 'react';
import { motion } from 'motion/react';
import {
  HardHat,
  Search,
  Settings,
  Bell,
  Plus,
  Copy,
  LayoutTemplate,
  Layers,
  Boxes,
  Wrench,
  HelpCircle,
  ChevronRight,
  Filter,
  Lock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ELEMENT_PRESETS, PresetTemplate, PresetForm } from './PresetTemplates';

interface PresetGalleryProps {
  onSelectPreset: (data: Record<string, any>, template: PresetTemplate) => void;
  /** FIX: which top-nav tab should appear active when the gallery is opened.
   *  Pass 'Library' when opened from the Takeoff / Viewer context.
   *  Defaults to 'Library'. */
  activeTopNav?: string;
}

/* ══════════════════════════════════════════
   CORNER BRACKETS
══════════════════════════════════════════ */
function BlueprintBrackets({ amber = false }: { amber?: boolean }) {
  const color = amber ? 'border-amber-500' : 'border-zinc-800 group-hover:border-amber-500/40';
  return (
    <>
      <div className={cn('absolute top-0 left-0 w-2 h-2 border-t border-l transition-colors', color)} />
      <div className={cn('absolute top-0 right-0 w-2 h-2 border-t border-r transition-colors', color)} />
      <div className={cn('absolute bottom-0 left-0 w-2 h-2 border-b border-l transition-colors', color)} />
      <div className={cn('absolute bottom-0 right-0 w-2 h-2 border-b border-r transition-colors', color)} />
    </>
  );
}

/* ══════════════════════════════════════════
   UNSPLASH IMAGE MAP — grayscale thumbnails
══════════════════════════════════════════ */
const CATEGORY_IMAGES: Record<string, string> = {
  STRUCTURE: 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=120&h=120&fit=crop&auto=format',
  WALLS:     'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=120&h=120&fit=crop&auto=format',
  ENVELOPE:  'https://images.unsplash.com/photo-1487958449943-2429e8be8625?w=120&h=120&fit=crop&auto=format',
  OPENINGS:  'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=120&h=120&fit=crop&auto=format',
  INTERIOR:  'https://images.unsplash.com/photo-1618219944342-824e40a13285?w=120&h=120&fit=crop&auto=format',
  FINISHES:  'https://images.unsplash.com/photo-1562259949-e8e7689d7828?w=120&h=120&fit=crop&auto=format',
  SERVICES:  'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=120&h=120&fit=crop&auto=format',
  DEFAULT:   'https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=120&h=120&fit=crop&auto=format',
};

function getCategoryImage(category: string): string {
  const key = category?.toUpperCase().split('/')[0].trim();
  return CATEGORY_IMAGES[key] ?? CATEGORY_IMAGES.DEFAULT;
}

/* ══════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════ */
export function PresetGallery({ onSelectPreset, activeTopNav = 'Library' }: PresetGalleryProps) {
  const [selectedTemplate, setSelectedTemplate] = React.useState<PresetTemplate | null>(null);
  const [searchTerm, setSearchTerm]             = React.useState('');
  const [activeCategory, setActiveCategory]     = React.useState<string | null>(null);
  const [activeNav, setActiveNav]               = React.useState('Templates');
  const [activePhase, setActivePhase]           = React.useState<string>('Phase 2: Openings');
  const [currentPage, setCurrentPage]           = React.useState(1);

  const categories = Array.from(new Set(ELEMENT_PRESETS.map(p => p.category)));

  const filteredPresets = ELEMENT_PRESETS.filter(preset => {
    const matchesSearch =
      preset.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      preset.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = !activeCategory || preset.category === activeCategory;
    return matchesSearch && matchesCategory;
  });

  const handlePresetSelect = (data: Record<string, any>, template: PresetTemplate) => {
    onSelectPreset(data, template);
    setSelectedTemplate(null);
  };

  const sideNavItems = [
    { icon: LayoutTemplate, label: 'Templates' },
    { icon: Layers,         label: 'Assemblies' },
    { icon: Boxes,          label: 'Materials' },
    { icon: HardHat,        label: 'Labor' },
    { icon: Wrench,         label: 'Equipment' },
  ];

  const phases = [
    { label: 'Phase 1: Structure', amber: false },
    { label: 'Phase 2: Openings',  amber: true  },
    { label: 'Phase 3: Finishes',  amber: false },
  ];

  /* FIX: activeTopNav is now driven by the prop so the correct tab is highlighted
     whether the gallery was opened from the Library page or from the Takeoff/Viewer. */
  const topNavLinks = ['Library', 'Estimates', 'Workflows', 'Analytics'];
  const breadcrumb  = ['Library', 'Smart Templates', activeCategory ?? 'Openings & Walls'];

  return (
    <>
      {/* FIX: unified .qs-scrollbar class — same 3px thumb, amber hover, used everywhere */}
      <style>{`
        .blueprint-grid {
          background-image:
            linear-gradient(to right, #1c1c1c 1px, transparent 1px),
            linear-gradient(to bottom, #1c1c1c 1px, transparent 1px);
          background-size: 28px 28px;
        }
        .qs-scrollbar::-webkit-scrollbar        { width: 4px; }
        .qs-scrollbar::-webkit-scrollbar-track  { background: #111; }
        .qs-scrollbar::-webkit-scrollbar-thumb  { background: #333; border-radius: 2px; }
        .qs-scrollbar::-webkit-scrollbar-thumb:hover { background: #F59E0B; }
        .card-thumb {
          filter: grayscale(100%) brightness(0.7);
          transition: filter 0.25s ease;
        }
        .group:hover .card-thumb {
          filter: grayscale(80%) brightness(0.85);
        }
      `}</style>

      <div className="flex h-screen w-full bg-[#111] font-mono text-zinc-300 antialiased">

        {/* ════════ SIDEBAR ════════ */}
        <aside className="w-[242px] shrink-0 flex flex-col bg-[#111] border-r border-[#1e1e1e] h-screen sticky top-0 z-40">

          {/* Logo */}
          <div className="h-14 flex items-center gap-2.5 px-5 border-b border-[#1e1e1e] shrink-0">
            <HardHat className="w-5 h-5 text-amber-500 shrink-0" />
            <span className="text-sm font-black tracking-tight text-amber-500 uppercase">QUANTITY SAVIOR</span>
          </div>

          {/* Brand */}
          <div className="px-5 pt-4 pb-3 shrink-0">
            <p className="text-amber-500 font-black text-[11px] tracking-widest uppercase">ESTIMATOR PRO</p>
            <p className="text-[9px] text-zinc-700 mt-0.5 uppercase tracking-wide">Industrial v4.2 // Division Mgr</p>
          </div>

          {/* Nav */}
          <nav className="flex-1 overflow-y-auto qs-scrollbar pt-1">
            {sideNavItems.map(({ icon: Icon, label }) => {
              const isActive = activeNav === label;
              return (
                <button
                  key={label}
                  onClick={() => setActiveNav(label)}
                  className={cn(
                    'w-full flex items-center gap-3 px-5 py-3 text-[11px] font-bold uppercase tracking-widest transition-all text-left border-l-[3px]',
                    isActive
                      ? 'border-amber-500 text-amber-500 bg-[#1a1a1a]'
                      : 'border-transparent text-zinc-600 hover:text-zinc-300 hover:bg-[#181818]'
                  )}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {label}
                </button>
              );
            })}

            {/* Phase filter */}
            <div className="mt-5 pt-4 border-t border-[#1e1e1e] px-5 pb-2">
              <p className="text-[9px] text-zinc-700 font-bold tracking-widest uppercase mb-3">Filter by Phase</p>
              {phases.map(phase => (
                <button
                  key={phase.label}
                  onClick={() => setActivePhase(phase.label)}
                  className={cn(
                    'w-full text-left py-1.5 text-[10px] flex items-center gap-2.5 uppercase tracking-tight font-bold transition-colors',
                    activePhase === phase.label ? 'text-zinc-200' : 'text-zinc-700 hover:text-zinc-400'
                  )}
                >
                  <span className={cn(
                    'w-2 h-2 rounded-sm shrink-0',
                    phase.label === activePhase && phase.amber ? 'bg-amber-500'
                    : phase.amber ? 'bg-amber-900/60'
                    : 'bg-zinc-700'
                  )} />
                  {phase.label}
                </button>
              ))}
            </div>
          </nav>

          {/* Bottom */}
          <div className="border-t border-[#1e1e1e] pb-2 shrink-0">
            <button className="w-full flex items-center gap-3 px-5 py-3 text-zinc-600 hover:text-zinc-300 transition-colors text-[11px] font-bold uppercase tracking-widest">
              <HelpCircle className="w-4 h-4 shrink-0" />
              Support
            </button>
            <button className="w-full flex items-center gap-3 px-5 py-2.5 text-zinc-600 hover:text-zinc-300 transition-colors text-[11px] font-bold uppercase tracking-widest">
              <div className="w-7 h-7 rounded-full bg-zinc-800 border border-[#2a2a2a] flex items-center justify-center text-[10px] font-black text-amber-500 shrink-0">N</div>
              Account
            </button>
          </div>
        </aside>

        {/* ════════ RIGHT COLUMN ════════ */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">

          {/* Top Nav — FIX: uses activeTopNav prop to highlight correct tab */}
          <header className="sticky top-0 z-50 h-14 shrink-0 flex items-center justify-between px-6 bg-[#111] border-b border-[#1e1e1e]">
            <nav className="flex items-center h-full">
              {topNavLinks.map(link => (
                <button
                  key={link}
                  className={cn(
                    'px-4 h-full text-[11px] font-bold uppercase tracking-widest flex items-center border-b-2 transition-all',
                    link === activeTopNav
                      ? 'border-amber-500 text-amber-500'
                      : 'border-transparent text-zinc-600 hover:text-zinc-300'
                  )}
                >
                  {link}
                </button>
              ))}
            </nav>

            <div className="flex items-center gap-2.5">
              <div className="relative hidden lg:flex items-center">
                <Search className="w-3.5 h-3.5 absolute left-3 text-zinc-600" />
                <input
                  type="text"
                  placeholder="Search Templates"
                  value={searchTerm}
                  onChange={e => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                  className="bg-[#1a1a1a] border border-[#2a2a2a] pl-9 pr-4 py-1.5 text-[11px] focus:border-amber-500 outline-none w-52 uppercase tracking-widest placeholder-zinc-700 transition-colors"
                />
              </div>
              <button className="flex items-center gap-2 text-[11px] font-black bg-amber-500 hover:bg-amber-400 text-black px-4 py-2 uppercase tracking-widest transition-all active:scale-95">
                <Plus className="w-3.5 h-3.5" />
                New Template
              </button>
              <button className="w-8 h-8 flex items-center justify-center text-zinc-600 hover:text-zinc-300 transition-colors">
                <Settings className="w-4 h-4" />
              </button>
              <button className="w-8 h-8 flex items-center justify-center text-zinc-600 hover:text-zinc-300 transition-colors">
                <Bell className="w-4 h-4" />
              </button>
            </div>
          </header>

          {/* Main */}
          <main className="flex-1 overflow-y-auto qs-scrollbar relative">
            <div className="blueprint-grid absolute inset-0 pointer-events-none z-0 opacity-50" />

            <div className="relative z-10 px-8 py-5">

              {/* Breadcrumb */}
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-700 mb-2">
                {breadcrumb.map((crumb, i) => (
                  <React.Fragment key={crumb}>
                    <button
                      onClick={() => i === 0 && setActiveCategory(null)}
                      className={cn(
                        'transition-colors',
                        i === breadcrumb.length - 1
                          ? 'text-amber-500 cursor-default'
                          : 'hover:text-zinc-400 cursor-pointer'
                      )}
                    >
                      {crumb}
                    </button>
                    {i < breadcrumb.length - 1 && <ChevronRight className="w-3 h-3 text-zinc-700" />}
                  </React.Fragment>
                ))}
              </div>

              {/* Page header + stats */}
              <div className="flex flex-col md:flex-row md:items-center justify-between mb-5 gap-4">
                <h1 className="text-xl font-black tracking-tight uppercase text-zinc-100 leading-none">
                  Element Template Library
                </h1>
                <div className="flex items-stretch border border-[#2a2a2a] bg-[#161616] shrink-0">
                  <div className="flex flex-col justify-center px-5 py-2.5">
                    <span className="text-[8px] text-zinc-600 uppercase font-bold tracking-widest mb-1.5">Library Density</span>
                    <div className="flex gap-1">
                      {[1,2,3,4].map(i => (
                        <div key={i} className={cn('w-5 h-1.5', i <= 2 ? 'bg-amber-500' : 'bg-zinc-700')} />
                      ))}
                    </div>
                  </div>
                  <div className="w-px bg-[#2a2a2a]" />
                  <div className="flex flex-col justify-center px-5 py-2.5">
                    <span className="text-[8px] text-zinc-600 uppercase font-bold tracking-widest mb-0.5">Active Elements</span>
                    <span className="text-2xl font-black leading-none text-zinc-100">{filteredPresets.length}</span>
                  </div>
                </div>
              </div>

              {/* Category pills */}
              <div className="flex flex-wrap items-center gap-2 mb-5">
                <button className="flex items-center gap-1.5 text-[9px] font-bold border border-[#2a2a2a] px-2.5 py-1.5 text-zinc-500 hover:text-zinc-200 transition-all uppercase tracking-widest">
                  <Filter className="w-3 h-3" />
                  Filter
                </button>
                {[null, ...categories].map(cat => {
                  const isActive = activeCategory === cat;
                  return (
                    <button
                      key={cat ?? '__all__'}
                      onClick={() => { setActiveCategory(cat); setCurrentPage(1); }}
                      className={cn(
                        'px-3 py-1 text-[9px] font-bold uppercase tracking-widest transition-all border',
                        isActive
                          ? 'bg-amber-500 text-black border-amber-500'
                          : 'bg-transparent text-zinc-600 border-[#2a2a2a] hover:border-zinc-600 hover:text-zinc-300'
                      )}
                    >
                      {cat ?? 'ALL'}
                    </button>
                  );
                })}
              </div>

              {/* Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredPresets.map((preset, i) => (
                  <motion.div
                    key={preset.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03, duration: 0.15 }}
                  >
                    <PresetCard preset={preset} onEdit={() => setSelectedTemplate(preset)} />
                  </motion.div>
                ))}

                {filteredPresets.length === 0 && (
                  <div className="col-span-full py-16 text-center text-zinc-700 text-[11px] uppercase tracking-widest font-bold">
                    No templates found
                  </div>
                )}

                {/* Enterprise locked */}
                <div className="border border-[#222] bg-[#141414] relative flex flex-col items-center justify-center min-h-[260px] cursor-not-allowed">
                  <BlueprintBrackets />
                  <Lock className="w-7 h-7 text-zinc-700 mb-3" />
                  <p className="text-[10px] font-black uppercase tracking-widest text-zinc-600 text-center px-6 leading-relaxed">
                    Structural Steel Truss
                  </p>
                  <p className="text-[8px] font-bold uppercase tracking-widest text-zinc-800 mt-1.5">
                    Available in Enterprise
                  </p>
                </div>

                {/* Add new */}
                <button className="border border-dashed border-[#272727] hover:border-amber-500/30 bg-transparent hover:bg-amber-500/[0.03] flex flex-col items-center justify-center min-h-[260px] text-zinc-700 hover:text-amber-500/70 transition-all group">
                  <div className="w-11 h-11 rounded-full border border-current flex items-center justify-center mb-3 transition-colors">
                    <Plus className="w-5 h-5" />
                  </div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-center px-6 leading-relaxed">
                    Add New Master Template
                  </p>
                  <p className="text-[8px] font-bold uppercase tracking-widest text-zinc-800 group-hover:text-amber-900/60 mt-1 transition-colors">
                    Define Custom Logic & Variables
                  </p>
                </button>
              </div>

              {/* Footer */}
              <div className="mt-8 border-t border-[#1e1e1e] pt-4 flex justify-between items-center text-[9px] uppercase tracking-widest text-zinc-700 font-bold">
                <div className="flex gap-5">
                  {['Last Sync: 14:02:59 UTC', 'Database: master_v4.r22'].map(label => (
                    <div key={label} className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 bg-zinc-700 inline-block" />
                      <span>{label}</span>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3">
                  <span>Displaying {filteredPresets.length} / {ELEMENT_PRESETS.length} Templates</span>
                  <div className="flex gap-1">
                    <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} className="w-6 h-6 flex items-center justify-center border border-[#2a2a2a] hover:bg-zinc-800 transition-colors">
                      <ChevronRight className="w-3 h-3 rotate-180" />
                    </button>
                    {[1, 2].map(p => (
                      <button
                        key={p}
                        onClick={() => setCurrentPage(p)}
                        className={cn('w-6 h-6 flex items-center justify-center border text-[10px] font-bold transition-colors',
                          currentPage === p ? 'bg-amber-500 text-black border-amber-500' : 'border-[#2a2a2a] hover:bg-zinc-800'
                        )}
                      >{p}</button>
                    ))}
                    <button onClick={() => setCurrentPage(p => p + 1)} className="w-6 h-6 flex items-center justify-center border border-[#2a2a2a] hover:bg-zinc-800 transition-colors">
                      <ChevronRight className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>

            </div>
          </main>
        </div>
      </div>

      {/* FIX: PresetForm now mounts as a slide-over, not a fullscreen replace.
              The gallery grid stays visible behind the dim backdrop.
              Pass activeTopNav so the form header shows the correct active tab. */}
      {selectedTemplate && (
        <PresetForm
          template={selectedTemplate}
          onSubmit={data => handlePresetSelect(data, selectedTemplate)}
          onClose={() => setSelectedTemplate(null)}
        />
      )}
    </>
  );
}

/* ════════════════════════════════════════
   PRESET CARD
════════════════════════════════════════ */
function PresetCard({ preset, onEdit }: { preset: PresetTemplate; onEdit: () => void }) {
  const specRows = preset.fields.slice(0, 3);
  const isDraft  = false;
  const thumbSrc = getCategoryImage(preset.category);

  return (
    <div className="group bg-[#161616] border border-[#242424] relative flex flex-col transition-all duration-150 hover:border-[#333] min-h-[260px]">
      <BlueprintBrackets />

      {/* Top: thumbnail + badge */}
      <div className="flex items-start justify-between px-4 pt-4 pb-2 gap-3">
        <div className="w-[60px] h-[60px] bg-[#0d0d0d] border border-[#222] overflow-hidden shrink-0">
          <img
            src={thumbSrc}
            alt={preset.category}
            className="card-thumb w-full h-full object-cover"
            loading="lazy"
          />
        </div>
        <span className={cn(
          'text-[8px] font-black uppercase tracking-widest px-2 py-0.5 border mt-1 shrink-0',
          isDraft
            ? 'border-zinc-700 bg-zinc-800/30 text-zinc-500'
            : 'border-amber-600/40 bg-amber-500/[0.08] text-amber-500'
        )}>
          {isDraft ? 'Draft' : 'Active'}
        </span>
      </div>

      {/* Content */}
      <div className="px-4 pb-4 flex flex-col flex-1">
        <h3 className="text-[13px] font-black tracking-tight text-zinc-200 uppercase group-hover:text-amber-500 transition-colors leading-tight mb-0.5">
          {preset.name}
        </h3>
        <p className="text-[9px] text-zinc-700 uppercase tracking-widest font-bold mb-3">
          {preset.category}
        </p>

        {/* Spec rows */}
        <div className="flex-1 space-y-1.5 border-t border-[#1e1e1e] pt-3 mb-3">
          {specRows.length > 0 ? specRows.map(field => {
            const val = field.defaultValue !== undefined && String(field.defaultValue).trim() !== ''
              ? String(field.defaultValue).toUpperCase()
              : null;
            return (
              <div key={field.name} className="flex justify-between items-center gap-2">
                <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold truncate">
                  {field.label ?? field.name}
                </span>
                {val
                  ? <span className="text-[10px] text-zinc-200 font-black tracking-wide shrink-0">{val}</span>
                  : <span className="text-[10px] text-zinc-700 font-bold shrink-0">—</span>
                }
              </div>
            );
          }) : (
            <p className="text-[9px] text-zinc-600 leading-relaxed">{preset.description}</p>
          )}
        </div>

        {/* Buttons */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onEdit}
            className="flex-1 h-8 border border-[#2a2a2a] hover:bg-[#1e1e1e] hover:border-zinc-600 text-[9px] font-black uppercase tracking-widest text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            Edit Parameters
          </button>
          <button
            onClick={onEdit}
            className="w-8 h-8 flex items-center justify-center border border-[#2a2a2a] hover:border-amber-500/40 text-zinc-600 hover:text-amber-500 transition-colors shrink-0"
          >
            <Copy className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
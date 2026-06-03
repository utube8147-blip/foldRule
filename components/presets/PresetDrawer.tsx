'use client';

import React, { useState, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useRouter } from 'next/navigation';
import {
  ChevronDown, ChevronRight, ChevronUp, X, Check, Search,
  Ruler, Square, Hash, CircleDot, Layers, RotateCcw,
  Copy, Lock, Sparkles, ExternalLink,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ELEMENT_PRESETS,
  PRESET_FORM_MAP,
  PresetTemplate,
  PresetFormComponentProps,
} from './PresetTemplates';
import { usePresetContext } from '@/context/PresetContext';
import { useTakeoffContext } from '@/context/TakeoffContext';
import { TakeoffRow, Drawing } from '@/types';
import { usePresetTakeoff } from '@/hooks/presets/usePresetTakeoff';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PresetDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectPreset?: (data: Record<string, any>, template: PresetTemplate) => void;
}

// ─── Measurement type → icon ──────────────────────────────────────────────────

const TYPE_ICONS: Record<string, React.ElementType> = {
  linear:  Ruler,
  area:    Square,
  count:   Hash,
  point:   CircleDot,
  default: Layers,
};

// ─── Corner Brackets ──────────────────────────────────────────────────────────

function BlueprintBrackets({ amber = false }: { amber?: boolean }) {
  const color = amber
    ? 'border-amber-500'
    : 'border-zinc-800 group-hover:border-amber-500/40';
  return (
    <>
      <div className={cn('absolute top-0 left-0 w-2 h-2 border-t border-l transition-colors', color)} />
      <div className={cn('absolute top-0 right-0 w-2 h-2 border-t border-r transition-colors', color)} />
      <div className={cn('absolute bottom-0 left-0 w-2 h-2 border-b border-l transition-colors', color)} />
      <div className={cn('absolute bottom-0 right-0 w-2 h-2 border-b border-r transition-colors', color)} />
    </>
  );
}

// ─── Category thumbnail map ───────────────────────────────────────────────────

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

// ─── Enterprise Upgrade Modal ─────────────────────────────────────────────────

function EnterpriseUpgradeModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[#161616] border border-amber-500/40 max-w-md w-full mx-4 p-6 relative"
        onClick={e => e.stopPropagation()}
      >
        <BlueprintBrackets amber />
        <div className="flex flex-col items-center text-center gap-4">
          <div className="w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
            <Sparkles className="w-8 h-8 text-amber-500" />
          </div>
          <h3 className="text-lg font-black uppercase tracking-tight text-zinc-100">
            Enterprise Feature
          </h3>
          <p className="text-[11px] font-mono text-zinc-400 leading-relaxed">
            This template is part of our Enterprise library. Upgrade to access
            advanced structural templates, custom formulas, and team collaboration.
          </p>
          <div className="flex items-center gap-3 mt-2 w-full">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-[#2a2a2a] text-[10px] font-black uppercase tracking-widest text-zinc-400 hover:border-zinc-500 transition-all"
            >
              Cancel
            </button>
            <button
              onClick={() => { window.open('https://example.com/enterprise', '_blank'); onClose(); }}
              className="flex-1 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-black uppercase tracking-widest transition-all active:scale-95"
            >
              Upgrade Now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Template Card ────────────────────────────────────────────────────────────

function TemplateCard({
  template, isSelected, isLocked = false, onClick, onUpgradeClick,
}: {
  template: PresetTemplate;
  isSelected: boolean;
  isLocked?: boolean;
  onClick: () => void;
  onUpgradeClick?: () => void;
}) {
  const Icon     = TYPE_ICONS[template.measurementType] ?? TYPE_ICONS.default;
  const thumbSrc = getCategoryImage(template.category);

  return (
    <button
      onClick={isLocked ? onUpgradeClick : onClick}
      disabled={isLocked}
      className={cn(
        'group bg-[#161616] border relative flex flex-col text-left transition-all duration-150',
        isLocked
          ? 'border-[#2a2a2a] opacity-60 cursor-not-allowed'
          : isSelected
          ? 'border-amber-500/60 bg-amber-500/[0.03]'
          : 'border-[#242424] hover:border-[#333]',
      )}
    >
      <BlueprintBrackets amber={isSelected && !isLocked} />

      {isLocked && (
        <div className="absolute inset-0 bg-black/50 z-10 flex items-center justify-center backdrop-blur-[1px]">
          <Lock className="w-6 h-6 text-amber-500/60" />
        </div>
      )}

      <div className="flex items-start justify-between px-4 pt-4 pb-2 gap-3">
        <div className="w-[60px] h-[60px] bg-[#0d0d0d] border border-[#222] overflow-hidden shrink-0">
          <img
            src={thumbSrc}
            alt={template.category}
            className="w-full h-full object-cover filter grayscale brightness-75 group-hover:grayscale-[80%] group-hover:brightness-85 transition-all duration-250"
            loading="lazy"
          />
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <span className={cn(
            'text-[8px] font-black uppercase tracking-widest px-2 py-0.5 border',
            isLocked
              ? 'border-zinc-700 bg-zinc-800/30 text-zinc-500'
              : isSelected
              ? 'border-amber-500/60 bg-amber-500/[0.08] text-amber-500'
              : 'border-amber-600/40 bg-amber-500/[0.08] text-amber-500',
          )}>
            {isLocked ? 'Enterprise' : template.category}
          </span>
          <Icon className={cn(
            'w-4 h-4',
            isSelected && !isLocked ? 'text-amber-500' : 'text-zinc-600 group-hover:text-zinc-400',
          )} />
        </div>
      </div>

      <div className="px-4 pb-4 flex flex-col flex-1">
        <h3 className={cn(
          'text-[13px] font-black tracking-tight uppercase leading-tight mb-0.5 transition-colors',
          isSelected && !isLocked ? 'text-amber-500' : 'text-zinc-200 group-hover:text-amber-500',
        )}>
          {template.name}
        </h3>
        <p className="text-[9px] text-zinc-700 uppercase tracking-widest font-bold mb-3">
          {template.measurementType}
        </p>
        <div className="flex-1 border-t border-[#1e1e1e] pt-3 mb-3">
          <p className="text-[9px] text-zinc-600 leading-relaxed line-clamp-2">
            {template.description}
          </p>
        </div>
        <div className="flex items-center gap-1 text-[8px] text-zinc-700 uppercase tracking-widest font-bold mt-auto">
          {isLocked
            ? <><Lock className="w-2.5 h-2.5" /><span>Enterprise only</span></>
            : <><Copy className="w-2.5 h-2.5" /><span>Click to configure</span></>
          }
        </div>
      </div>
    </button>
  );
}

// ─── Preset Drawer ────────────────────────────────────────────────────────────

export function PresetDrawer({ isOpen, onClose, onSelectPreset }: PresetDrawerProps) {
  const router = useRouter();

  const { projectState: ps, addMeasurement, batchCommitMeasurements } = useTakeoffContext();
  const activeDrawing = ps.drawings.find((d: Drawing) => d.id === ps.activeDrawingId) ?? null;

  // USE SHARED PRESET CONTEXT (same as preset page)
  const {
    selectedTemplate,
    setSelectedTemplate,
    getFormData,
    setFormField,
    resetForm,
    searchTerm,
    setSearchTerm,
    activeCategory,
    setActiveCategory,
    showEnterpriseModal,
    setShowEnterpriseModal,
  } = usePresetContext();

  const [drawerHeight, setDrawerHeight] = useState<'collapsed' | 'half' | 'full'>('half');
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const LOCKED_COUNT = 3;
  const categories = Array.from(new Set(ELEMENT_PRESETS.map(p => p.category)));

  // Get current form data from context
  const currentFormData = selectedTemplate ? getFormData(selectedTemplate.id) : {};

  const filteredTemplates = ELEMENT_PRESETS.filter(t => {
    const matchSearch =
      searchTerm === '' ||
      t.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchCat = !activeCategory || t.category === activeCategory;
    return matchSearch && matchCat;
  });

  useEffect(() => {
    if (isOpen) {
      setDrawerHeight('half');
      setToastMsg(null);
    }
  }, [isOpen]);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  };

  const handleChange = (key: string, value: any) => {
    if (!selectedTemplate) return;
    setFormField(selectedTemplate.id, key, value);
  };

  const handleReset = () => {
    if (!selectedTemplate) return;
    resetForm(selectedTemplate.id);
  };

  // ─── USE THE EXTRACTED HOOK ────────────────────────────────────────────────
  const { handleConfirm: handleTakeoffConfirm } = usePresetTakeoff({
    activeDrawing,
    addMeasurement,
    batchCommitMeasurements,
    showToast,
  });

  // Wrap the hook's handleConfirm to also call onSelectPreset if needed
  const handleConfirm = () => {
    if (!selectedTemplate) {
      showToast('⚠ SELECT A TEMPLATE FIRST');
      return;
    }
    
    handleTakeoffConfirm(selectedTemplate, currentFormData, () => {
      // Optional callback after successful addition
      onSelectPreset?.(currentFormData, selectedTemplate);
    });
  };

  const handleOpenFullPage = () => {
    onClose();
    router.push('/presets');
  };

  const cycleHeight = () =>
    setDrawerHeight(h => h === 'half' ? 'full' : h === 'full' ? 'collapsed' : 'half');

  const heightClass = { collapsed: 'h-12', half: 'h-[420px]', full: 'h-[80vh]' }[drawerHeight];

  const FormComponent = selectedTemplate
    ? (PRESET_FORM_MAP[selectedTemplate.id] ?? null)
    : null;

  return (
    <>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 340, damping: 34 }}
            className={cn(
              'absolute bottom-0 left-0 right-0 z-50 bg-[#111] border-t border-[#1e1e1e]',
              'flex flex-col overflow-hidden shadow-2xl transition-[height] duration-300 ease-in-out',
              heightClass,
            )}
          >
            {/* Header */}
            <div className="h-12 flex-shrink-0 flex items-center justify-between px-4 border-b border-[#1e1e1e] bg-[#0d0d0d]">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-2 h-2 bg-amber-500 shrink-0" />
                <button
                  onClick={() => setSelectedTemplate(null)}
                  className="text-[10px] font-mono font-black uppercase tracking-widest text-zinc-300 hover:text-amber-400 transition-colors shrink-0"
                >
                  PRESET TEMPLATES
                </button>

                {selectedTemplate ? (
                  <>
                    <ChevronRight className="w-3 h-3 text-zinc-600 shrink-0" />
                    <span className="text-[10px] font-mono font-black uppercase tracking-widest text-amber-500 truncate">
                      {selectedTemplate.name}
                    </span>
                  </>
                ) : (
                  <span className="text-[9px] font-mono text-zinc-600 border border-[#1e1e1e] px-1.5 py-0.5 shrink-0">
                    {filteredTemplates.length} templates · {LOCKED_COUNT} locked
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {selectedTemplate && !activeDrawing && (
                  <span className="text-[8px] font-mono font-black uppercase tracking-widest text-amber-500/80 border border-amber-500/30 px-2 py-0.5 bg-amber-500/5">
                    ⚠ No drawing
                  </span>
                )}

                <button
                  onClick={handleOpenFullPage}
                  className={cn(
                    'flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest',
                    'px-2.5 py-1 border border-amber-500/40 text-amber-500',
                    'hover:bg-amber-500 hover:text-black transition-all',
                  )}
                >
                  <ExternalLink className="w-3 h-3" />
                  Full Library
                </button>

                {!selectedTemplate && (
                  <div className="relative flex items-center">
                    <Search className="w-3 h-3 absolute left-2 text-zinc-600 pointer-events-none" />
                    <input
                      type="text"
                      placeholder="Search…"
                      value={searchTerm}
                      onChange={e => setSearchTerm(e.target.value)}
                      className="bg-[#1a1a1a] border border-[#2a2a2a] pl-7 pr-2 py-1 text-[10px]
                                 focus:border-amber-500 outline-none w-36 uppercase tracking-widest
                                 placeholder-zinc-700 transition-colors font-mono"
                    />
                  </div>
                )}

                <button onClick={cycleHeight} className="p-1.5 text-zinc-600 hover:text-zinc-300 transition-colors">
                  {drawerHeight === 'full' ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                </button>

                <button onClick={onClose} className="p-1.5 text-zinc-600 hover:text-red-500 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Toast */}
            <AnimatePresence>
              {toastMsg && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex-shrink-0 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-[9px] font-mono font-black uppercase tracking-widest text-amber-400"
                >
                  {toastMsg}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Body */}
            {drawerHeight !== 'collapsed' && (
              <div className="flex flex-1 overflow-hidden">
                {!selectedTemplate ? (
                  <div className="flex flex-col flex-1 overflow-hidden">
                    {/* Category pills */}
                    <div className="flex-shrink-0 flex items-center gap-1.5 px-4 py-2 border-b border-[#1e1e1e] overflow-x-auto">
                      <button
                        onClick={() => setActiveCategory(null)}
                        className={cn(
                          'px-2.5 py-1 text-[9px] font-black uppercase tracking-widest border flex-shrink-0 transition-all',
                          !activeCategory ? 'bg-amber-500 text-black border-amber-500' : 'bg-transparent text-zinc-600 border-[#2a2a2a] hover:border-zinc-600 hover:text-zinc-300',
                        )}
                      >
                        ALL
                      </button>
                      {categories.map(cat => (
                        <button
                          key={cat}
                          onClick={() => setActiveCategory(cat)}
                          className={cn(
                            'px-2.5 py-1 text-[9px] font-black uppercase tracking-widest border flex-shrink-0 transition-all',
                            activeCategory === cat ? 'bg-amber-500 text-black border-amber-500' : 'bg-transparent text-zinc-600 border-[#2a2a2a] hover:border-zinc-600 hover:text-zinc-300',
                          )}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>

                    {/* Grid */}
                    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4" style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
                      {filteredTemplates.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                          <Lock className="w-8 h-8 text-zinc-700" />
                          <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">No templates match your filters</span>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                          {filteredTemplates.map(template => {
                            const originalIndex = ELEMENT_PRESETS.findIndex(t => t.id === template.id);
                            const isLocked = originalIndex >= ELEMENT_PRESETS.length - LOCKED_COUNT;
                            return (
                              <TemplateCard
                                key={template.id}
                                template={template}
                                isSelected={(selectedTemplate as any)?.id === template.id}
                                isLocked={isLocked}
                                onUpgradeClick={() => setShowEnterpriseModal(true)}
                                onClick={() => setSelectedTemplate(template)}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Footer */}
                    <div className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-t border-[#1e1e1e] bg-[#0d0d0d]">
                      <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">Want more space to configure?</span>
                      <button onClick={handleOpenFullPage} className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-amber-500 hover:text-amber-400 transition-colors">
                        <ExternalLink className="w-3 h-3" />
                        Open Full Preset Library
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
                    <div className="flex flex-col h-full">
                      {/* Form header */}
                      <div className="flex items-start justify-between px-5 py-4 border-b border-[#1e1e1e] shrink-0">
                        <div>
                          <h3 className="text-[14px] font-mono font-black uppercase tracking-widest text-amber-500">
                            {selectedTemplate.name}
                          </h3>
                          {selectedTemplate.description && (
                            <p className="text-[10px] font-mono text-zinc-500 mt-1 leading-relaxed">{selectedTemplate.description}</p>
                          )}
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest border border-[#2a2a2a] px-1.5 py-0.5">{selectedTemplate.category}</span>
                            <span className="text-[8px] font-mono text-zinc-600 uppercase tracking-widest border border-[#2a2a2a] px-1.5 py-0.5">{selectedTemplate.measurementType}</span>
                          </div>
                        </div>
                        <button onClick={handleReset} className="flex items-center gap-1.5 text-[9px] font-mono font-black uppercase tracking-widest px-3 py-1.5 border border-[#2a2a2a] text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 transition-all shrink-0">
                          <RotateCcw className="w-2.5 h-2.5" />
                          Reset
                        </button>
                      </div>

                      {/* Form body - withViz HOC handles 3D visualization */}
                      <div className="flex-1 px-5 py-5">
                        {FormComponent ? (
                          <FormComponent 
                            formData={currentFormData} 
                            onChange={handleChange} 
                            template={selectedTemplate} 
                          />
                        ) : (
                          <div className="flex items-center justify-center h-full border border-dashed border-[#2a2a2a]">
                            <p className="text-[10px] font-mono text-zinc-600 italic">No form configured for "{selectedTemplate.id}".</p>
                          </div>
                        )}
                      </div>

                      {/* Action bar */}
                      <div className="flex items-center gap-3 px-5 py-4 border-t border-[#1e1e1e] shrink-0 bg-[#0d0d0d]">
                        <button
                          onClick={handleConfirm}
                          disabled={!activeDrawing}
                          className={cn(
                            'flex items-center gap-2 font-mono font-black text-[10px] uppercase tracking-widest px-5 py-2.5 transition-all active:scale-95',
                            activeDrawing
                              ? 'bg-amber-500 hover:bg-amber-400 text-black'
                              : 'bg-zinc-800 text-zinc-600 cursor-not-allowed',
                          )}
                        >
                          <Check className="w-3 h-3" />
                          ADD MEASUREMENT
                        </button>

                        <button
                          onClick={() => setSelectedTemplate(null)}
                          className="text-[10px] font-mono font-black uppercase tracking-widest px-4 py-2.5 border border-[#2a2a2a] text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 transition-all"
                        >
                          ← BACK TO GALLERY
                        </button>

                        <button
                          onClick={handleOpenFullPage}
                          className="flex items-center gap-1.5 text-[9px] font-mono font-black uppercase tracking-widest text-amber-500/70 hover:text-amber-400 transition-colors ml-auto border border-amber-500/20 px-2.5 py-1.5 hover:border-amber-500/50"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Continue in Full Page
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {showEnterpriseModal && (
        <EnterpriseUpgradeModal onClose={() => setShowEnterpriseModal(false)} />
      )}
    </>
  );
}
'use client';

import React, { useState, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronDown, ChevronRight, ChevronUp, X, Check, Search, Filter,
  Ruler, Square, Hash, CircleDot, Layers, RotateCcw,
  HardHat, Boxes, Wrench, Copy, Plus, Lock, Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ELEMENT_PRESETS, PresetTemplate, PresetForm } from './PresetTemplates';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PresetDrawerProps {
  /** Whether the drawer is open */
  isOpen: boolean;
  /** Called when user closes the drawer */
  onClose: () => void;
  /** Called when user confirms a preset with data */
  onSelectPreset: (data: Record<string, any>, template: PresetTemplate) => void;
}

// ─── Template icon map ────────────────────────────────────────────────────────

const TYPE_ICONS: Record<string, React.ElementType> = {
  linear:  Ruler,
  area:    Square,
  count:   Hash,
  point:   CircleDot,
  default: Layers,
};

// ─── Corner Brackets ──────────────────────────────────────────────────────────

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

// ─── Category Image Map ───────────────────────────────────────────────────────

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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose}>
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
              onClick={() => {
                window.open('https://example.com/enterprise', '_blank');
                onClose();
              }}
              className="flex-1 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-black uppercase tracking-widest transition-all active:scale-95"
            >
              Upgrade Now
            </button>
          </div>
          
          <p className="text-[8px] font-mono text-zinc-600 uppercase tracking-wider mt-2">
            Contact sales for custom enterprise pricing
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Field Input ──────────────────────────────────────────────────────────────

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: PresetTemplate['fields'][number];
  value: any;
  onChange: (v: any) => void;
}) {
  const base =
    'w-full bg-[#1a1a1a] border border-[#2a2a2a] text-zinc-200 text-[11px] font-mono px-2 py-1.5 focus:outline-none focus:border-amber-500 transition-colors';

  if (field.type === 'select' && field.options) {
    return (
      <select value={value ?? ''} onChange={e => onChange(e.target.value)} className={base}>
        <option value="">— select —</option>
        {field.options.map(o => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }

  if (field.type === 'number') {
    return (
      <input
        type="number"
        value={value ?? ''}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className={base}
        placeholder={field.placeholder ?? '0'}
      />
    );
  }

  if (field.type === 'boolean') {
    return (
      <button
        onClick={() => onChange(!value)}
        className={cn(
          'flex items-center gap-2 text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-1.5 border transition-all',
          value
            ? 'bg-amber-500/10 border-amber-500 text-amber-500'
            : 'bg-transparent border-[#2a2a2a] text-zinc-500 hover:border-zinc-500',
        )}
      >
        <div className={cn('w-3 h-3 border', value ? 'bg-amber-500 border-amber-500' : 'border-zinc-600')} />
        {value ? 'Yes' : 'No'}
      </button>
    );
  }

  // default: text
  return (
    <input
      type="text"
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      className={base}
      placeholder={field.placeholder ?? field.label}
    />
  );
}

// ─── Template Card (Gallery style) ────────────────────────────────────────────

function TemplateCard({
  template,
  isSelected,
  onClick,
  isLocked = false,
  onUpgradeClick,
}: {
  template: PresetTemplate;
  isSelected: boolean;
  onClick: () => void;
  isLocked?: boolean;
  onUpgradeClick?: () => void;
}) {
  const Icon = TYPE_ICONS[template.measurementType] ?? TYPE_ICONS.default;
  const thumbSrc = getCategoryImage(template.category);
  const specRows = template.fields?.slice(0, 3) ?? [];

  const handleClick = () => {
    if (isLocked && onUpgradeClick) {
      onUpgradeClick();
    } else {
      onClick();
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={isLocked}
      className={cn(
        'group bg-[#161616] border relative flex flex-col text-left transition-all duration-150',
        isLocked
          ? 'border-[#2a2a2a] opacity-60 cursor-not-allowed'
          : isSelected
          ? 'border-amber-500/60 bg-amber-500/[0.03] hover:border-[#333]'
          : 'border-[#242424] hover:border-[#333]',
      )}
    >
      <BlueprintBrackets amber={isSelected && !isLocked} />

      {/* Lock overlay for locked templates */}
      {isLocked && (
        <div className="absolute inset-0 bg-black/50 z-10 flex items-center justify-center backdrop-blur-[1px]">
          <Lock className="w-6 h-6 text-amber-500/60" />
        </div>
      )}

      {/* Top: thumbnail + type icon */}
      <div className="flex items-start justify-between px-4 pt-4 pb-2 gap-3">
        <div className="w-[60px] h-[60px] bg-[#0d0d0d] border border-[#222] overflow-hidden shrink-0">
          <img
            src={thumbSrc}
            alt={template.category}
            className="w-full h-full object-cover filter grayscale-[100%] brightness-75 group-hover:grayscale-[80%] group-hover:brightness-85 transition-all duration-250"
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
              : 'border-amber-600/40 bg-amber-500/[0.08] text-amber-500'
          )}>
            {isLocked ? 'Enterprise' : 'Active'}
          </span>
          <Icon className={cn('w-4 h-4', isSelected && !isLocked ? 'text-amber-500' : 'text-zinc-600 group-hover:text-zinc-400')} />
        </div>
      </div>

      {/* Content */}
      <div className="px-4 pb-4 flex flex-col flex-1">
        <h3 className={cn(
          'text-[13px] font-black tracking-tight uppercase leading-tight mb-0.5 transition-colors',
          isSelected && !isLocked ? 'text-amber-500' : 'text-zinc-200 group-hover:text-amber-500'
        )}>
          {template.name}
        </h3>
        <p className="text-[9px] text-zinc-700 uppercase tracking-widest font-bold mb-3">
          {template.category}
        </p>

        {/* Spec rows */}
        <div className="flex-1 space-y-1.5 border-t border-[#1e1e1e] pt-3 mb-3">
          {specRows.length > 0 ? specRows.map(field => {
            const val = field.default !== undefined && String(field.default).trim() !== ''
              ? (field.type === 'number' ? field.default : String(field.default).toUpperCase())
              : null;
            return (
              <div key={field.key} className="flex justify-between items-center gap-2">
                <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold truncate">
                  {field.label ?? field.key}
                </span>
                {val !== null
                  ? <span className="text-[10px] text-zinc-200 font-black tracking-wide shrink-0">{val}</span>
                  : <span className="text-[10px] text-zinc-700 font-bold shrink-0">—</span>
                }
              </div>
            );
          }) : (
            <p className="text-[9px] text-zinc-600 leading-relaxed line-clamp-2">{template.description}</p>
          )}
        </div>

        {/* Edit hint */}
        <div className="flex items-center gap-1 text-[8px] text-zinc-700 uppercase tracking-widest font-bold mt-auto">
          {isLocked ? (
            <>
              <Lock className="w-2.5 h-2.5" />
              <span>Enterprise only</span>
            </>
          ) : (
            <>
              <Copy className="w-2.5 h-2.5" />
              <span>Click to configure</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── Preset Drawer (Bottom Slide-up) ──────────────────────────────────────────

export function PresetDrawer({ isOpen, onClose, onSelectPreset }: PresetDrawerProps) {
  const [selectedTemplate, setSelectedTemplate] = useState<PresetTemplate | null>(null);
  const [fieldValues, setFieldValues]           = useState<Record<string, any>>({});
  const [drawerHeight, setDrawerHeight]         = useState<'collapsed' | 'half' | 'full'>('half');
  const [searchTerm, setSearchTerm]             = useState('');
  const [activeCategory, setActiveCategory]     = useState<string | null>(null);
  const [showEnterpriseModal, setShowEnterpriseModal] = useState(false);
  const [lockedTemplateName, setLockedTemplateName] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);

  // Number of templates to lock at the end
  const LOCKED_COUNT = 3;

  // Get all unique categories from templates
  const categories = Array.from(new Set(ELEMENT_PRESETS.map(p => p.category)));

  // Mark which templates are locked (last LOCKED_COUNT templates by index)
  const getLockedStatus = (index: number, total: number) => {
    return index >= total - LOCKED_COUNT;
  };

  // Filter templates based on search and category
  const filteredTemplates = ELEMENT_PRESETS.filter(template => {
    const matchesSearch = searchTerm === '' || 
      template.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      template.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = !activeCategory || template.category === activeCategory;
    return matchesSearch && matchesCategory;
  });

  // Reset when opened
  useEffect(() => {
    if (isOpen) {
      setSelectedTemplate(null);
      setFieldValues({});
      setDrawerHeight('half');
      setSearchTerm('');
      setActiveCategory(null);
      setShowEnterpriseModal(false);
    }
  }, [isOpen]);

  // Pre-fill defaults when template is selected
  useEffect(() => {
    if (!selectedTemplate) return;
    const defaults: Record<string, any> = {};
    selectedTemplate.fields?.forEach(f => {
      defaults[f.key] = f.default ?? (f.type === 'boolean' ? false : f.type === 'number' ? 0 : '');
    });
    setFieldValues(defaults);
  }, [selectedTemplate]);

  const handleConfirm = () => {
    if (!selectedTemplate) return;
    onSelectPreset(fieldValues, selectedTemplate);
    setSelectedTemplate(null);
    onClose();
  };

  const handleReset = () => {
    if (!selectedTemplate) return;
    const defaults: Record<string, any> = {};
    selectedTemplate.fields?.forEach(f => {
      defaults[f.key] = f.default ?? (f.type === 'boolean' ? false : f.type === 'number' ? 0 : '');
    });
    setFieldValues(defaults);
  };

  const handleLockedTemplateClick = (templateName: string) => {
    setLockedTemplateName(templateName);
    setShowEnterpriseModal(true);
  };

  const heightClass = {
    collapsed: 'h-12',
    half:      'h-96',
    full:      'h-[80vh]',
  }[drawerHeight];

  const cycleHeight = () => {
    setDrawerHeight(h => h === 'half' ? 'full' : h === 'full' ? 'collapsed' : 'half');
  };

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
              'absolute bottom-0 left-0 right-0 z-50 bg-[#111] border-t border-[#1e1e1e] flex flex-col overflow-hidden shadow-2xl',
              heightClass,
            )}
          >
            {/* ── Header bar ────────────────────────────────────────────── */}
            <div className="h-12 flex-shrink-0 flex items-center justify-between px-4 border-b border-[#1e1e1e] bg-[#0d0d0d]">
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 bg-amber-500" />
                <span className="text-[10px] font-mono font-black uppercase tracking-widest text-zinc-300">
                  PRESET TEMPLATES
                </span>
                {selectedTemplate && (
                  <>
                    <ChevronRight className="w-3 h-3 text-zinc-600" />
                    <span className="text-[10px] font-mono font-black uppercase tracking-widest text-amber-500">
                      {selectedTemplate.name}
                    </span>
                  </>
                )}
                {!selectedTemplate && filteredTemplates.length > 0 && (
                  <span className="text-[9px] font-mono text-zinc-600 border border-[#1e1e1e] px-1.5 py-0.5">
                    {filteredTemplates.length} templates
                  </span>
                )}
                {!selectedTemplate && (
                  <span className="text-[8px] font-mono text-amber-500/60 border border-amber-500/20 px-1.5 py-0.5">
                    {LOCKED_COUNT} locked
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {/* Search - only show in gallery view */}
                {!selectedTemplate && (
                  <div className="relative flex items-center">
                    <Search className="w-3 h-3 absolute left-2 text-zinc-600" />
                    <input
                      type="text"
                      placeholder="Search..."
                      value={searchTerm}
                      onChange={e => setSearchTerm(e.target.value)}
                      className="bg-[#1a1a1a] border border-[#2a2a2a] pl-7 pr-2 py-1 text-[10px] focus:border-amber-500 outline-none w-36 uppercase tracking-widest placeholder-zinc-700 transition-colors"
                    />
                  </div>
                )}
                <button
                  onClick={cycleHeight}
                  className="p-1.5 text-zinc-600 hover:text-zinc-300 transition-colors"
                  title={drawerHeight === 'full' ? 'Shrink' : 'Expand'}
                >
                  {drawerHeight === 'full' ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                </button>
                <button
                  onClick={onClose}
                  className="p-1.5 text-zinc-600 hover:text-red-500 transition-colors"
                  title="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* ── Body (hidden when collapsed) ──────────────────────────── */}
            {drawerHeight !== 'collapsed' && (
              <div className="flex flex-1 overflow-hidden">

                {/* Gallery view */}
                {!selectedTemplate ? (
                  <div className="flex flex-col flex-1 overflow-hidden">
                    {/* Category pills */}
                    <div className="flex-shrink-0 flex items-center gap-1.5 px-4 py-2 border-b border-[#1e1e1e] overflow-x-auto">
                      <button
                        onClick={() => setActiveCategory(null)}
                        className={cn(
                          'px-2.5 py-1 text-[9px] font-black uppercase tracking-widest transition-all border flex-shrink-0',
                          !activeCategory
                            ? 'bg-amber-500 text-black border-amber-500'
                            : 'bg-transparent text-zinc-600 border-[#2a2a2a] hover:border-zinc-600 hover:text-zinc-300'
                        )}
                      >
                        ALL
                      </button>
                      {categories.map(cat => (
                        <button
                          key={cat}
                          onClick={() => setActiveCategory(cat)}
                          className={cn(
                            'px-2.5 py-1 text-[9px] font-black uppercase tracking-widest transition-all border flex-shrink-0',
                            activeCategory === cat
                              ? 'bg-amber-500 text-black border-amber-500'
                              : 'bg-transparent text-zinc-600 border-[#2a2a2a] hover:border-zinc-600 hover:text-zinc-300'
                          )}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>

                    {/* Template grid */}
                    <div
                      ref={scrollRef}
                      className="flex-1 overflow-y-auto p-4"
                      style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}
                    >
                      {filteredTemplates.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                          <Lock className="w-8 h-8 text-zinc-700" />
                          <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
                            No templates match your filters
                          </span>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                          {filteredTemplates.map((template, idx) => {
                            const originalIndex = ELEMENT_PRESETS.findIndex(t => t.id === template.id);
                            const isLocked = getLockedStatus(originalIndex, ELEMENT_PRESETS.length);
                            
                            return (
                              <TemplateCard
                                key={template.id}
                                template={template}
                                isSelected={false}
                                isLocked={isLocked}
                                onUpgradeClick={() => handleLockedTemplateClick(template.name)}
                                onClick={() => setSelectedTemplate(template)}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  /* Form view */
                  <div className="flex-1 overflow-y-auto p-5" style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}>
                    <div className="flex flex-col gap-5 max-w-xl mx-auto">
                      {/* Template header */}
                      <div className="flex items-start justify-between pb-3 border-b border-[#1e1e1e]">
                        <div>
                          <h3 className="text-[14px] font-mono font-black uppercase tracking-widest text-amber-500">
                            {selectedTemplate.name}
                          </h3>
                          {selectedTemplate.description && (
                            <p className="text-[10px] font-mono text-zinc-500 mt-1 leading-relaxed">
                              {selectedTemplate.description}
                            </p>
                          )}
                          <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-wider mt-1.5">
                            Category: {selectedTemplate.category}
                          </p>
                        </div>
                        <button
                          onClick={handleReset}
                          className="flex items-center gap-1.5 text-[9px] font-mono font-black uppercase tracking-widest px-3 py-1.5 border border-[#2a2a2a] text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 transition-all"
                        >
                          <RotateCcw className="w-2.5 h-2.5" />
                          Reset
                        </button>
                      </div>

                      {/* Fields grid */}
                      {selectedTemplate.fields && selectedTemplate.fields.length > 0 ? (
                        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                          {selectedTemplate.fields.map(field => (
                            <div key={field.key} className={cn('flex flex-col gap-1.5', field.fullWidth && 'col-span-2')}>
                              <label className="text-[9px] font-mono font-black uppercase tracking-widest text-zinc-500">
                                {field.label}
                                {field.required && <span className="text-amber-500 ml-0.5">*</span>}
                                {field.unit && <span className="text-zinc-600 ml-1">({field.unit})</span>}
                              </label>
                              <FieldInput
                                field={field}
                                value={fieldValues[field.key]}
                                onChange={v => setFieldValues(prev => ({ ...prev, [field.key]: v }))}
                              />
                              {field.hint && (
                                <span className="text-[8px] font-mono text-zinc-600 uppercase tracking-wider">{field.hint}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-[10px] font-mono text-zinc-600 italic py-4 text-center border border-dashed border-[#2a2a2a]">
                          No configuration fields for this template.
                        </div>
                      )}

                      {/* Action buttons */}
                      <div className="flex items-center gap-3 pt-4 border-t border-[#1e1e1e] mt-2">
                        <button
                          onClick={handleConfirm}
                          className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-black font-mono font-black text-[10px] uppercase tracking-widest px-5 py-2.5 transition-all active:scale-95"
                        >
                          <Check className="w-3 h-3" />
                          ADD MEASUREMENT
                        </button>
                        <button
                          onClick={() => setSelectedTemplate(null)}
                          className="text-[10px] font-mono font-black uppercase tracking-widest px-4 py-2.5 border border-[#2a2a2a] text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 transition-all"
                        >
                          BACK TO GALLERY
                        </button>
                        <span className="text-[8px] font-mono text-zinc-600 ml-auto uppercase tracking-wider">
                          Type: {selectedTemplate.measurementType?.toUpperCase()}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Enterprise Upgrade Modal */}
      {showEnterpriseModal && (
        <EnterpriseUpgradeModal onClose={() => setShowEnterpriseModal(false)} />
      )}
    </>
  );
}
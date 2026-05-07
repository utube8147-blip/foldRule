// app/(project)/presets/page.tsx
'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, ChevronRight, RotateCcw, Check,
  Search, Lock, Sparkles, Layers, Ruler,
  Square, Hash, CircleDot,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import {
  ELEMENT_PRESETS,
  PRESET_FORM_MAP,
  PresetTemplate,
} from '@/components/presets/PresetTemplates';
import { useTakeoffContext } from '@/context/TakeoffContext';
import { usePresetContext }  from '@/context/PresetContext';
import { TakeoffRow } from '@/types';
import { ToastContainer } from '@/components/Toast';

const LOCKED_COUNT = 3;

const CATEGORY_IMAGES: Record<string, string> = {
  STRUCTURE: 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=600&h=300&fit=crop&auto=format',
  WALLS:     'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=600&h=300&fit=crop&auto=format',
  ENVELOPE:  'https://images.unsplash.com/photo-1487958449943-2429e8be8625?w=600&h=300&fit=crop&auto=format',
  OPENINGS:  'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=600&h=300&fit=crop&auto=format',
  INTERIOR:  'https://images.unsplash.com/photo-1618219944342-824e40a13285?w=600&h=300&fit=crop&auto=format',
  FINISHES:  'https://images.unsplash.com/photo-1562259949-e8e7689d7828?w=600&h=300&fit=crop&auto=format',
  SERVICES:  'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=600&h=300&fit=crop&auto=format',
  DEFAULT:   'https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=600&h=300&fit=crop&auto=format',
};

const TYPE_ICONS: Record<string, React.ElementType> = {
  linear: Ruler, area: Square, count: Hash, point: CircleDot, default: Layers,
};

function getCategoryImage(cat: string) {
  return CATEGORY_IMAGES[cat?.toUpperCase().split('/')[0].trim()] ?? CATEGORY_IMAGES.DEFAULT;
}

// ─── Corner brackets ──────────────────────────────────────────────────────────

function Brackets({ active = false }: { active?: boolean }) {
  const c = active
    ? 'border-amber-500'
    : 'border-zinc-800 group-hover:border-amber-500/40';
  return (
    <>
      <div className={cn('absolute top-0 left-0 w-3 h-3 border-t border-l transition-colors', c)} />
      <div className={cn('absolute top-0 right-0 w-3 h-3 border-t border-r transition-colors', c)} />
      <div className={cn('absolute bottom-0 left-0 w-3 h-3 border-b border-l transition-colors', c)} />
      <div className={cn('absolute bottom-0 right-0 w-3 h-3 border-b border-r transition-colors', c)} />
    </>
  );
}

// ─── Enterprise modal ─────────────────────────────────────────────────────────

function EnterpriseModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative bg-[#161616] border border-amber-500/40 max-w-md w-full mx-4 p-8"
        onClick={e => e.stopPropagation()}
      >
        <Brackets active />
        <div className="flex flex-col items-center text-center gap-5">
          <div className="w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
            <Sparkles className="w-8 h-8 text-amber-500" />
          </div>
          <h3 className="text-xl font-black uppercase tracking-tight text-zinc-100">
            Enterprise Feature
          </h3>
          <p className="text-[11px] font-mono text-zinc-400 leading-relaxed max-w-xs">
            This template is part of our Enterprise library. Upgrade to access advanced
            structural templates, custom formulas, and team collaboration tools.
          </p>
          <div className="flex gap-3 w-full mt-2">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 border border-zinc-700 text-[10px] font-black uppercase tracking-widest text-zinc-400 hover:border-zinc-500 transition-all"
            >
              Cancel
            </button>
            <button
              onClick={() => { window.open('https://example.com/enterprise', '_blank'); onClose(); }}
              className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-black uppercase tracking-widest transition-all active:scale-95"
            >
              Upgrade Now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Template card ────────────────────────────────────────────────────────────

function TemplateCard({
  template, isSelected, isLocked, onClick, onUpgrade,
}: {
  template: PresetTemplate;
  isSelected: boolean;
  isLocked: boolean;
  onClick: () => void;
  onUpgrade: () => void;
}) {
  const Icon = TYPE_ICONS[template.measurementType] ?? TYPE_ICONS.default;

  return (
    <button
      onClick={isLocked ? onUpgrade : onClick}
      className={cn(
        'group relative flex flex-col text-left border transition-all duration-150 overflow-hidden',
        isLocked   ? 'border-zinc-800 opacity-50 cursor-not-allowed bg-[#0f0f0f]' :
        isSelected ? 'border-amber-500/70 bg-amber-500/[0.04]' :
                     'border-zinc-800 hover:border-zinc-600 bg-[#111] hover:bg-[#141414]',
      )}
    >
      <Brackets active={isSelected && !isLocked} />

      {/* thumbnail */}
      <div className="relative h-36 overflow-hidden">
        <img
          src={getCategoryImage(template.category)}
          alt={template.category}
          className="w-full h-full object-cover filter grayscale brightness-50 group-hover:brightness-[0.65] transition-all duration-300"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#111] via-[#111]/20 to-transparent" />
        {isLocked && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
            <Lock className="w-8 h-8 text-amber-500/40" />
          </div>
        )}
        <div className="absolute bottom-2 left-3 right-3 flex items-end justify-between">
          <span className={cn(
            'text-[8px] font-black uppercase tracking-widest px-2 py-0.5 border',
            isLocked   ? 'border-zinc-700 bg-zinc-900/80 text-zinc-500' :
            isSelected ? 'border-amber-500/60 bg-amber-500/10 text-amber-400' :
                         'border-amber-600/40 bg-black/70 text-amber-500',
          )}>
            {isLocked ? 'Enterprise' : template.category}
          </span>
          <Icon className={cn(
            'w-4 h-4',
            isSelected && !isLocked ? 'text-amber-500' : 'text-zinc-500 group-hover:text-zinc-300',
          )} />
        </div>
      </div>

      {/* body */}
      <div className="flex flex-col flex-1 p-4">
        <h3 className={cn(
          'text-[14px] font-black uppercase tracking-tight leading-tight mb-1 transition-colors',
          isSelected && !isLocked ? 'text-amber-500' : 'text-zinc-100 group-hover:text-amber-400',
        )}>
          {template.name}
        </h3>
        <p className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold mb-3">
          {template.measurementType}
        </p>
        <p className="text-[10px] text-zinc-500 leading-relaxed line-clamp-2 flex-1">
          {template.description}
        </p>
        <div className="mt-3 pt-3 border-t border-zinc-800/60 text-[8px] text-zinc-600 uppercase tracking-widest font-bold">
          {isLocked
            ? '— Enterprise only —'
            : isSelected
            ? '▸ Selected — configure on right'
            : 'Click to configure →'}
        </div>
      </div>
    </button>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PresetsPage() {
  const router = useRouter();

  // ── toast state ────────────────────────────────────────────────────────────
  const [toasts, setToasts] = useState<{ id: string; message: string; type: 'success' | 'info' }[]>([]);

  const addToast = (message: string, type: 'success' | 'info' = 'info') => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  };

  // project data only from takeoff context
  const { projectState: ps, addMeasurement } = useTakeoffContext();

  // all preset UI state from preset context
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

  const activeDrawing   = ps.drawings.find(d => d.id === ps.activeDrawingId) ?? null;
  const categories      = Array.from(new Set(ELEMENT_PRESETS.map(p => p.category)));
  const currentFormData = selectedTemplate ? getFormData(selectedTemplate.id) : {};

  const filtered = ELEMENT_PRESETS.filter(t => {
    const matchSearch =
      searchTerm === '' ||
      t.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchCat = !activeCategory || t.category === activeCategory;
    return matchSearch && matchCat;
  });

  const handleSelectTemplate = (t: PresetTemplate) => setSelectedTemplate(t);

  const handleChange = (key: string, value: any) => {
    if (!selectedTemplate) return;
    setFormField(selectedTemplate.id, key, value);
  };

  const handleReset = () => {
    if (!selectedTemplate) return;
    resetForm(selectedTemplate.id);
  };

  // ── add to takeoff ─────────────────────────────────────────────────────────
  const handleConfirm = () => {
    if (!selectedTemplate) return;
    if (!activeDrawing) {
      addToast('PLEASE SELECT OR IMPORT A DRAWING FIRST', 'info');
      return;
    }

    const groupId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const t       = selectedTemplate;
    const fd      = currentFormData;

    if (t.id === 'carcass') {
      const W         = parseFloat(String(fd.width ?? 600)) / 1000;
      const H         = parseFloat(String(fd.height ?? 720)) / 1000;
      const D         = parseFloat(String(fd.depth ?? 550)) / 1000;
      const T         = parseFloat(String(fd.panelThickness ?? 18)) / 1000;
      const shelves   = parseInt(String(fd.shelfCount ?? 2));
      const doorCount = parseInt(String(fd.doorCount ?? 1));
      const iW        = W - 2 * T;
      const iH        = H - 2 * T;
      const groupName = `${fd.customName || 'Cabinet'} (${fd.width || 600}×${fd.height || 720}×${fd.depth || 550}mm)`;

      const parts: Partial<TakeoffRow>[] = [];
      if (fd.hasBack)      parts.push({ description: 'Back Panel',       type: 'Area',   quantity: +(iW * iH).toFixed(3),                  unit: 'm²',  category: 'Board Materials', notes: `Material: ${fd.boardMaterial || '18mm MDF'}` });
      if (fd.hasTop)       parts.push({ description: 'Top Panel',        type: 'Area',   quantity: +(iW * D).toFixed(3),                   unit: 'm²',  category: 'Board Materials', notes: `Material: ${fd.boardMaterial || '18mm MDF'}` });
      if (fd.hasBottom)    parts.push({ description: 'Bottom Panel',     type: 'Area',   quantity: +(iW * D).toFixed(3),                   unit: 'm²',  category: 'Board Materials', notes: `Material: ${fd.boardMaterial || '18mm MDF'}` });
      if (fd.hasLeftSide)  parts.push({ description: 'Left Side Panel',  type: 'Area',   quantity: +(D * H).toFixed(3),                    unit: 'm²',  category: 'Board Materials', notes: `Material: ${fd.boardMaterial || '18mm MDF'}` });
      if (fd.hasRightSide) parts.push({ description: 'Right Side Panel', type: 'Area',   quantity: +(D * H).toFixed(3),                    unit: 'm²',  category: 'Board Materials', notes: `Material: ${fd.boardMaterial || '18mm MDF'}` });
      if (shelves > 0)     parts.push({ description: `Shelves (${shelves} pcs)`, type: 'Area', quantity: +(iW * D * shelves).toFixed(3),   unit: 'm²',  category: 'Shelves',         notes: `Material: ${fd.shelfMaterial || fd.boardMaterial || '18mm MDF'}` });
      if (fd.hasDoors) {
        parts.push({ description: `Doors (${doorCount} pcs)`, type: 'Area',  quantity: +((W / doorCount) * H * doorCount).toFixed(3), unit: 'm²',  category: 'Doors',    notes: `Material: ${fd.doorMaterial || 'MDF Primed'}` });
        parts.push({ description: 'Door Hardware',            type: 'Count', quantity: doorCount,                                      unit: 'sets', category: 'Hardware', notes: `Hinges & handles | Type: ${fd.hingeType || 'Concealed'}` });
      }
      if (fd.hasDrawers) {
        const dc = parseInt(String(fd.drawerCount ?? 2));
        parts.push({ description: `Drawer Fronts (${dc} pcs)`, type: 'Count', quantity: dc, unit: 'pcs',  category: 'Drawers',  notes: `Material: ${fd.drawerMaterial || 'Match doors'}` });
        parts.push({ description: 'Drawer Hardware',           type: 'Count', quantity: dc, unit: 'sets', category: 'Hardware', notes: 'Drawer slides, handles' });
      }
      let eb = 0;
      if (fd.hasTop)       eb += 2 * (iW + D);
      if (fd.hasBottom)    eb += 2 * (iW + D);
      if (fd.hasLeftSide)  eb += 2 * (D + H);
      if (fd.hasRightSide) eb += 2 * (D + H);
      if (shelves > 0)     eb += (2 * iW + D) * shelves;
      if (eb > 0) parts.push({ description: 'Edge Banding', type: 'Length', quantity: +(eb * 1.1).toFixed(2), unit: 'm', category: 'Finishing', notes: `Material: ${fd.edgeTape || 'PVC 0.4mm'} | +10% waste` });
      parts.push({ description: 'Assembly & Installation', type: 'Count', quantity: 1, unit: 'each', category: 'Labor', notes: 'Labor, cam locks, fixing brackets' });
      if (fd.hasToeKick) parts.push({ description: 'Toe Kick / Plinth', type: 'Length', quantity: W, unit: 'm', category: 'Finishing', notes: `Height: ${fd.kickboardHeight || '100mm'}` });

      addMeasurement({
        id:            `${groupId}-header`,
        drawingId:     activeDrawing.id,
        groupId,
        groupName,
        groupType:     t.id,
        isGroupHeader: true,
        isExpanded:    true,
        description:   groupName,
        type:          'Count',
        quantity:      1,
        unit:          'assembly',
        unitRate:      0,
        notes:         'Complete carcass assembly',
        points:        [],
        isOverridden:  true,
        presetId:      t.id,
        presetData:    fd,
        category:      'Group Header',
        color:         '#EF9F27',
        isVisible:     true,
      } as TakeoffRow);

      parts.forEach(part => {
        addMeasurement({
          id:           `${groupId}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
          drawingId:    activeDrawing.id,
          groupId,
          parentId:     `${groupId}-header`,
          unitRate:     0,
          points:       [],
          isOverridden: true,
          presetId:     t.id,
          presetData:   fd,
          color:        '#85B7EB',
          isVisible:    true,
          ...part,
        } as TakeoffRow);
      });

      addToast(`${groupName} ADDED (${parts.length} components)`, 'success');

} else if (t.id === 'roof') {
      const area = parseFloat(String(fd.roofArea ?? 0)) || 0;
      const pitch = parseFloat(String(fd.roofPitch ?? 0)) || 0;
      const pitchFactor = 1 + (pitch * 0.02);
      const adjustedArea = area > 0 ? (area * pitchFactor).toFixed(1) : '0';
      const groupName = `Roof (${fd.roofType || 'Pitched'} · ${fd.material || 'Tile'} · ${area} M²)`;

      const parts: Partial<TakeoffRow>[] = [];
      if (area > 0) {
        parts.push({ description: 'Roof Covering', type: 'Area', quantity: +adjustedArea, unit: 'm²', category: 'Roofing', notes: `Material: ${fd.material || 'Tile'} | Pitch: ${pitch}°` });
        parts.push({ description: 'Underlay / Membrane', type: 'Area', quantity: +(parseFloat(adjustedArea) * 1.1).toFixed(2), unit: 'm²', category: 'Roofing', notes: '+10% overlap | Type: Breathable membrane' });
        parts.push({ description: 'Guttering & Downpipes', type: 'Length', quantity: +(area / 10).toFixed(1), unit: 'm', category: 'Drainage', notes: `Material: ${fd.guttering || 'Aluminium'}` });
      }
      if (fd.insulation) parts.push({ description: 'Roof Insulation', type: 'Area', quantity: area, unit: 'm²', category: 'Insulation', notes: `Thickness: ${fd.insulation}` });
      parts.push({ description: 'Installation & Flashing', type: 'Count', quantity: 1, unit: 'each', category: 'Labor', notes: 'Includes valleys, ridges, flashings, & sealing' });

      addMeasurement({
        id: `${groupId}-header`,
        drawingId: activeDrawing.id,
        groupId,
        groupName,
        groupType: t.id,
        isGroupHeader: true,
        isExpanded: true,
        description: groupName,
        type: 'Count',
        quantity: 1,
        unit: 'assembly',
        unitRate: 0,
        notes: 'Complete roof assembly',
        points: [],
        isOverridden: true,
        presetId: t.id,
        presetData: fd,
        category: 'Group Header',
        color: '#97C459',
        isVisible: true,
      } as TakeoffRow);

      parts.forEach((part) => {
        addMeasurement({
          id: `${groupId}-${Math.random().toString(36).substr(2, 9)}`,
          drawingId: activeDrawing.id,
          groupId,
          groupName,
          groupType: t.id,
          description: part.description || '',
          type: part.type as any,
          quantity: part.quantity || 0,
          unit: part.unit || 'm',
          unitRate: 0,
          notes: part.notes || '',
          points: [],
          isOverridden: true,
          presetId: t.id,
          presetData: fd,
          color: '#97C459',
          isVisible: true,
          ...part,
        } as TakeoffRow);
      });

      addToast(`${groupName} ADDED (${parts.length} components)`, 'success');

    } else if (t.id === 'ceiling') {
      const area = parseFloat(String(fd.area ?? 0)) || 0;
      const groupName = `Ceiling (${fd.type || 'Suspended'} · ${fd.material || 'Plaster'} · ${area} M²)`;

      const parts: Partial<TakeoffRow>[] = [];
      if (area > 0) {
        parts.push({ description: 'Ceiling Finishes', type: 'Area', quantity: area, unit: 'm²', category: 'Finishes', notes: `Material: ${fd.material || 'Plaster'} | Type: ${fd.type || 'Suspended'}` });
      }
      
      if (fd.type === 'Suspended') {
        parts.push({ description: 'Suspension Grid System', type: 'Length', quantity: +(area * 0.4).toFixed(1), unit: 'm', category: 'Framework', notes: 'Main & cross tees' });
        parts.push({ description: 'Hanger Wire / Brackets', type: 'Count', quantity: Math.max(1, Math.ceil(area / 2)), unit: 'sets', category: 'Hardware', notes: 'Threaded rod, brackets, clips' });
      }
      
      if (fd.acousticAbsorption) parts.push({ description: 'Acoustic Treatment', type: 'Area', quantity: area, unit: 'm²', category: 'Finishes', notes: 'Acoustic panels / mineral wool backing' });
      
      parts.push({ description: 'Installation & Access', type: 'Count', quantity: 1, unit: 'each', category: 'Labor', notes: 'Includes access panels, fire rating checks' });

      addMeasurement({
        id: `${groupId}-header`,
        drawingId: activeDrawing.id,
        groupId,
        groupName,
        groupType: t.id,
        isGroupHeader: true,
        isExpanded: true,
        description: groupName,
        type: 'Count',
        quantity: 1,
        unit: 'assembly',
        unitRate: 0,
        notes: 'Complete ceiling assembly',
        points: [],
        isOverridden: true,
        presetId: t.id,
        presetData: fd,
        category: 'Group Header',
        color: '#ED93B1',
        isVisible: true,
      } as TakeoffRow);

      parts.forEach((part) => {
        addMeasurement({
          id: `${groupId}-${Math.random().toString(36).substr(2, 9)}`,
          drawingId: activeDrawing.id,
          groupId,
          groupName,
          groupType: t.id,
          description: part.description || '',
          type: part.type as any,
          quantity: part.quantity || 0,
          unit: part.unit || 'm',
          unitRate: 0,
          notes: part.notes || '',
          points: [],
          isOverridden: true,
          presetId: t.id,
          presetData: fd,
          color: '#ED93B1',
          isVisible: true,
          ...part,
        } as TakeoffRow);
      });

      addToast(`${groupName} ADDED (${parts.length} components)`, 'success');

    } else if (t.id === 'staircase') {
      const steps = parseInt(String(fd.steps ?? 12)) || 12;
      const riserHeight = parseFloat(String(fd.riserHeight ?? 200)) || 200;
      const treadsDepth = parseFloat(String(fd.treadsDepth ?? 300)) || 300;
      const width = parseFloat(String(fd.width ?? 900)) || 900;
      const groupName = `Staircase (${steps} Steps · ${fd.material || 'Timber'} · ${width}mm Wide)`;

      const parts: Partial<TakeoffRow>[] = [];
      parts.push({ description: 'Treads', type: 'Count', quantity: steps, unit: 'pcs', category: 'Stair Components', notes: `Material: ${fd.material || 'Timber'} | Depth: ${treadsDepth}mm` });
      parts.push({ description: 'Risers', type: 'Count', quantity: steps, unit: 'pcs', category: 'Stair Components', notes: `Height: ${riserHeight}mm | Material: ${fd.material || 'Timber'}` });
      parts.push({ description: 'Stringers / Carriages', type: 'Count', quantity: 2, unit: 'pcs', category: 'Framework', notes: `Material: ${fd.stringerMaterial || fd.material || 'Timber'}` });
      
      if (fd.handrail) {
        const handrailLength = ((steps * riserHeight) / 1000) / Math.sin((Math.PI) / 6);
        parts.push({ description: 'Handrail', type: 'Length', quantity: +handrailLength.toFixed(2), unit: 'm', category: 'Safety', notes: `Material: ${fd.railMaterial || 'Timber'} | Height: ${fd.railHeight || '900mm'}` });
        parts.push({ description: 'Balustrade Posts', type: 'Count', quantity: Math.max(1, Math.ceil(steps / 3)), unit: 'pcs', category: 'Safety', notes: 'Newel posts' });
        parts.push({ description: 'Balusters / Spindles', type: 'Count', quantity: Math.max(1, steps * 3), unit: 'pcs', category: 'Safety', notes: `Spacing: 100mm max` });
      }
      
      parts.push({ description: 'Installation & Fixing', type: 'Count', quantity: 1, unit: 'each', category: 'Labor', notes: 'Assembly, securing, finishing sanding' });
      if (fd.fireRating) parts.push({ description: 'Fire Rating Treatment', type: 'Count', quantity: 1, unit: 'each', category: 'Protection', notes: `Rating: ${fd.fireRating}` });

      addMeasurement({
        id: `${groupId}-header`,
        drawingId: activeDrawing.id,
        groupId,
        groupName,
        groupType: t.id,
        isGroupHeader: true,
        isExpanded: true,
        description: groupName,
        type: 'Count',
        quantity: 1,
        unit: 'assembly',
        unitRate: 0,
        notes: 'Complete staircase assembly',
        points: [],
        isOverridden: true,
        presetId: t.id,
        presetData: fd,
        category: 'Group Header',
        color: '#F0997B',
        isVisible: true,
      } as TakeoffRow);

      parts.forEach((part) => {
        addMeasurement({
          id: `${groupId}-${Math.random().toString(36).substr(2, 9)}`,
          drawingId: activeDrawing.id,
          groupId,
          groupName,
          groupType: t.id,
          description: part.description || '',
          type: part.type as any,
          quantity: part.quantity || 0,
          unit: part.unit || 'm',
          unitRate: 0,
          notes: part.notes || '',
          points: [],
          isOverridden: true,
          presetId: t.id,
          presetData: fd,
          color: '#F0997B',
          isVisible: true,
          ...part,
        } as TakeoffRow);
      });

      addToast(`${groupName} ADDED (${parts.length} components)`, 'success');


    } else {
      let quantity = 0;
      let unit     = 'm';
      switch (t.measurementType as string) {

        case 'linear': quantity = parseFloat(String(fd.length ?? fd.pipeLength ?? 0)) || 0;                                                             unit = 'm';   break;
        case 'area':   quantity = parseFloat(String(fd.area ?? 0)) || (parseFloat(String(fd.width ?? 0)) * parseFloat(String(fd.height ?? 0))) / 1e6 || 0;              unit = 'm²';  break;
        case 'count':  quantity = parseInt(String(fd.quantity ?? fd.doorCount ?? fd.windowCount ?? 1));                                                  unit = 'pcs'; break;
      }
      addMeasurement({
        id:           `${activeDrawing.id}-${Date.now()}`,
        drawingId:    activeDrawing.id,
        description:  t.name,
        type:         t.measurementType === 'linear' ? 'Length' : t.measurementType === 'area' ? 'Area' : 'Count',
        quantity,
        unit,
        unitRate:     0,
        notes:        `Preset: ${t.name} · ${t.category}`,
        points:       [],
        isOverridden: true,
        presetData:   fd,
        presetId:     t.id,
        color:        '#EF9F27',
        isVisible:    true,
      } as TakeoffRow);

      addToast(`${t.name.toUpperCase()} ADDED`, 'success');
    }

    router.push('/workspace');
  };

  const FormComponent = selectedTemplate
    ? (PRESET_FORM_MAP[selectedTemplate.id] ?? null)
    : null;

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-[#0d0d0d] overflow-hidden font-mono">

      {/* top bar */}
      <div className="h-14 flex-shrink-0 bg-[#111] border-b border-zinc-800 flex items-center justify-between px-6 z-40">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.push('/workspace')}
            className="flex items-center gap-2 text-zinc-500 hover:text-zinc-200 transition-colors group"
          >
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
            <span className="text-[10px] font-black uppercase tracking-widest">Back to Workspace</span>
          </button>
          <div className="w-px h-4 bg-zinc-800" />
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-amber-500" />
            <span className="text-[11px] font-black uppercase tracking-widest text-zinc-300">
              Preset Library
            </span>
          </div>
          {ps.projectName && (
            <>
              <div className="w-px h-4 bg-zinc-800" />
              <span className="text-[10px] text-zinc-600 uppercase tracking-widest">{ps.projectName}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="relative flex items-center">
            <Search className="w-3 h-3 absolute left-2.5 text-zinc-600 pointer-events-none" />
            <input
              type="text"
              placeholder="Search templates…"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="bg-[#1a1a1a] border border-zinc-800 pl-8 pr-3 py-1.5 text-[10px]
                         focus:border-amber-500 outline-none w-52 uppercase tracking-widest
                         placeholder-zinc-700 transition-colors text-zinc-300"
            />
          </div>
          <span className="text-[9px] text-zinc-600 uppercase tracking-widest border border-zinc-800 px-2 py-1">
            {filtered.length} templates · {LOCKED_COUNT} locked
          </span>
        </div>
      </div>

      {/* body */}
      <div className="flex flex-1 overflow-hidden">

        {/* left: gallery */}
        <div className="flex flex-col w-[580px] xl:w-[680px] flex-shrink-0 border-r border-zinc-800 overflow-hidden">

          {/* category pills */}
          <div className="flex-shrink-0 flex items-center gap-1.5 px-4 py-2.5 border-b border-zinc-800 overflow-x-auto">
            <button
              onClick={() => setActiveCategory(null)}
              className={cn(
                'px-3 py-1 text-[9px] font-black uppercase tracking-widest border flex-shrink-0 transition-all',
                !activeCategory
                  ? 'bg-amber-500 text-black border-amber-500'
                  : 'bg-transparent text-zinc-600 border-zinc-800 hover:border-zinc-600 hover:text-zinc-300',
              )}
            >
              ALL
            </button>
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={cn(
                  'px-3 py-1 text-[9px] font-black uppercase tracking-widest border flex-shrink-0 transition-all',
                  activeCategory === cat
                    ? 'bg-amber-500 text-black border-amber-500'
                    : 'bg-transparent text-zinc-600 border-zinc-800 hover:border-zinc-600 hover:text-zinc-300',
                )}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* grid */}
          <div
            className="flex-1 overflow-y-auto p-4"
            style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}
          >
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <Lock className="w-8 h-8 text-zinc-700" />
                <span className="text-[10px] text-zinc-600 uppercase tracking-widest">
                  No templates match your filters
                </span>
              </div>
            ) : (
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
                {filtered.map(template => {
                  const originalIndex = ELEMENT_PRESETS.findIndex(t => t.id === template.id);
                  const isLocked      = originalIndex >= ELEMENT_PRESETS.length - LOCKED_COUNT;
                  return (
                    <TemplateCard
                      key={template.id}
                      template={template}
                      isSelected={selectedTemplate?.id === template.id}
                      isLocked={isLocked}
                      onClick={() => handleSelectTemplate(template)}
                      onUpgrade={() => setShowEnterpriseModal(true)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* right: form */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <AnimatePresence mode="wait">
            {!selectedTemplate ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8"
              >
                <div className="w-16 h-16 border border-zinc-800 flex items-center justify-center">
                  <Layers className="w-7 h-7 text-zinc-700" />
                </div>
                <p className="text-[11px] text-zinc-600 uppercase tracking-widest font-bold">
                  Select a template from the gallery
                </p>
                <p className="text-[10px] text-zinc-700 max-w-xs leading-relaxed">
                  Choose any preset on the left to configure it. Your settings are preserved as you browse.
                </p>
              </motion.div>
            ) : (
              <motion.div
                key={selectedTemplate.id}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
                className="flex-1 flex flex-col overflow-hidden"
              >
                {/* form header */}
                <div className="flex-shrink-0 flex items-start justify-between px-6 py-4 border-b border-zinc-800 bg-[#111]">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-1.5 h-1.5 bg-amber-500" />
                      <span className="text-[9px] text-zinc-600 uppercase tracking-widest">
                        {selectedTemplate.category}
                      </span>
                      <ChevronRight className="w-3 h-3 text-zinc-700" />
                      <span className="text-[9px] text-zinc-600 uppercase tracking-widest">
                        {selectedTemplate.measurementType}
                      </span>
                    </div>
                    <h2 className="text-xl font-black uppercase tracking-tight text-amber-500">
                      {selectedTemplate.name}
                    </h2>
                    {selectedTemplate.description && (
                      <p className="text-[10px] text-zinc-500 mt-1 max-w-md leading-relaxed">
                        {selectedTemplate.description}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={handleReset}
                    className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest
                               px-3 py-1.5 border border-zinc-800 text-zinc-600
                               hover:border-zinc-600 hover:text-zinc-300 transition-all shrink-0 mt-1"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset
                  </button>
                </div>

                {/* form body */}
                <div
                  className="flex-1 overflow-y-auto px-6 py-5"
                  style={{ scrollbarWidth: 'thin', scrollbarColor: '#2a2a2a transparent' }}
                >
                  {FormComponent ? (
                    <FormComponent
                      formData={currentFormData}
                      onChange={handleChange}
                      template={selectedTemplate}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full border border-dashed border-zinc-800">
                      <p className="text-[10px] text-zinc-600 italic">
                        No form configured for "{selectedTemplate.id}".
                      </p>
                    </div>
                  )}
                </div>

                {/* action bar */}
                <div className="flex-shrink-0 flex items-center gap-3 px-6 py-4 border-t border-zinc-800 bg-[#0d0d0d]">
                  <button
                    onClick={handleConfirm}
                    className="flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-black
                               font-black text-[11px] uppercase tracking-widest
                               px-6 py-3 transition-all active:scale-95"
                  >
                    <Check className="w-4 h-4" />
                    Add to Takeoff
                  </button>

                  <button
                    onClick={() => setSelectedTemplate(null)}
                    className="text-[10px] font-black uppercase tracking-widest px-4 py-3
                               border border-zinc-800 text-zinc-500
                               hover:border-zinc-600 hover:text-zinc-300 transition-all"
                  >
                    ← Back to Gallery
                  </button>

                  {!activeDrawing && (
                    <span className="text-[9px] font-bold text-amber-500/60 uppercase tracking-widest ml-2 border border-amber-500/20 px-2 py-1">
                      ⚠ No drawing selected
                    </span>
                  )}

                  <span className="text-[8px] text-zinc-700 ml-auto uppercase tracking-wider">
                    {selectedTemplate.measurementType?.toUpperCase()} · {selectedTemplate.category}
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* status bar */}
      <footer className="h-6 flex-shrink-0 bg-[#0a0a0a] border-t border-zinc-800 flex items-center justify-between px-6">
        <div className="flex items-center gap-6">
          <span className="text-[9px] text-zinc-700 uppercase tracking-widest font-bold">
            {ps.projectName || 'Untitled Project'}
          </span>
          <div className="w-px h-3 bg-zinc-800" />
          <span className="text-[9px] text-zinc-700 uppercase tracking-widest font-bold">
            Objects: {ps.measurements.length}
          </span>
          <div className="w-px h-3 bg-zinc-800" />
          <span className="text-[9px] text-zinc-700 uppercase tracking-widest font-bold">
            Drawings: {ps.drawings.length}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[9px] text-zinc-700 uppercase tracking-widest font-bold">
            Preset Library · {ELEMENT_PRESETS.length} templates
          </span>
          <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse" />
        </div>
      </footer>

      {/* ── Toast notifications ──────────────────────────────────────────────── */}
      <ToastContainer
        toasts={toasts}
        onRemove={(id) => setToasts(prev => prev.filter(t => t.id !== id))}
      />

      {showEnterpriseModal && (
        <EnterpriseModal onClose={() => setShowEnterpriseModal(false)} />
      )}
    </div>
  );
}

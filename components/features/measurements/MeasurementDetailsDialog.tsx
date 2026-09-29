import React, { useState, useEffect } from 'react';
import { DoorOpen, Wind, Fan, Zap, Plug, Library } from 'lucide-react';
import { useTakeoffData } from '@/context/TakeoffContext';
import { formatCurrency } from '@/lib/utils';
import type { Material } from '@/types';
import { MaterialPicker, materialRate } from '@/components/common/MaterialPicker';

interface MeasurementDetailsDialogProps {
  isOpen: boolean;
  defaultName: string;
  defaultMaterial: string;
  measurementType?: string;
  /** `materialId` is the id of a material from the bank, or '' for none. */
  onConfirm: (name: string, materialId: string, icon?: string) => void;
  onSkip: () => void;
}

const COUNT_ICON_OPTIONS = [
  { id: 'door', label: 'Door', icon: DoorOpen },
  { id: 'window', label: 'Window', icon: Wind },
  { id: 'fan', label: 'Fan', icon: Fan },
  { id: 'ac', label: 'AC Unit', icon: Zap },
  { id: 'outlet', label: 'Outlet', icon: Plug },
];

export function MeasurementDetailsDialog({ 
  isOpen, 
  defaultName, 
  defaultMaterial, 
  measurementType,
  onConfirm, 
  onSkip 
}: MeasurementDetailsDialogProps) {
  const [name, setName] = useState(defaultName);
  const [material, setMaterial] = useState(defaultMaterial);
  const [selectedIcon, setSelectedIcon] = useState<string | undefined>(undefined);
  const isCountType = measurementType === 'Count';
  const { projectState, setMaterialLibraryOpen } = useTakeoffData();
  const materials = projectState.materials as Material[];
  const rateOf = (m: Material) => (m.materialCost ?? 0) + (m.laborCost ?? 0) + (m.equipmentCost ?? 0) || m.unitRate || 0;

  useEffect(() => {
    if (isOpen) {
      setName(defaultName);
      setMaterial(defaultMaterial);
      setSelectedIcon(undefined);
    }
  }, [isOpen, defaultName, defaultMaterial]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div 
        className="bg-zinc-900 border border-industrial-border shadow-2xl p-6 w-full max-w-96"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-mono font-bold text-zinc-200 uppercase tracking-widest mb-4">
          Measurement Details
        </h3>
        
        <div className="space-y-4">
          <div>
            <label className="block text-[10px] font-mono font-bold text-zinc-400 uppercase tracking-widest mb-1.5">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-zinc-800 border border-industrial-border px-3 py-2 text-sm font-mono text-zinc-200 focus:outline-none focus:border-amber-400 transition-colors"
              placeholder={isCountType ? "e.g., Fans, Doors, Windows, etc." : "e.g., Wall Section A, Column Base, etc."}
              autoFocus
            />
          </div>
          
          <div>
            <label htmlFor="md-material" className="block text-[10px] font-mono font-bold text-zinc-400 uppercase tracking-widest mb-1.5">
              Material <span className="normal-case tracking-normal font-normal text-zinc-600">(optional — sets the rate)</span>
            </label>
            {materials.length > 0 ? (
              <>
                <MaterialPicker
                  id="md-material"
                  materials={materials}
                  value={material || null}
                  onChange={id => setMaterial(id ?? '')}
                  onOpenBank={() => setMaterialLibraryOpen(true)}
                  measurementType={measurementType}
                />
                {(() => {
                  const chosen = materials.find(m => m.id === material);
                  if (!chosen || materialRate(chosen) > 0) return null;
                  return (
                    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono text-zinc-400">
                      <span><span className="text-amber-400">No rate set</span> for this material yet — its cost won’t be counted until it has one.</span>
                      <button
                        type="button"
                        onClick={() => setMaterialLibraryOpen(true)}
                        className="font-bold uppercase tracking-widest text-[10px] text-amber-400 hover:text-amber-300"
                      >
                        Set rate
                      </button>
                      <span className="text-zinc-600">or continue without it.</span>
                    </p>
                  );
                })()}
              </>
            ) : (
              <div className="flex items-center justify-between gap-3 border border-dashed border-industrial-border px-3 py-2">
                <span className="text-[11px] font-mono text-zinc-500">Your material bank is empty.</span>
                <button
                  type="button"
                  onClick={() => setMaterialLibraryOpen(true)}
                  className="shrink-0 flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-widest text-amber-400 hover:text-amber-300"
                >
                  <Library className="w-3.5 h-3.5" /> Open material bank
                </button>
              </div>
            )}
          </div>

          {isCountType && (
            <div>
              <label className="block text-[10px] font-mono font-bold text-zinc-400 uppercase tracking-widest mb-2">
                Icon Type
              </label>
              <div className="grid grid-cols-5 gap-2">
                {COUNT_ICON_OPTIONS.map(option => {
                  const IconComp = option.icon;
                  return (
                    <button
                      key={option.id}
                      onClick={() => setSelectedIcon(option.id)}
                      className={`p-2 border transition-all flex items-center justify-center ${
                        selectedIcon === option.id
                          ? 'border-amber-400 bg-amber-400/10'
                          : 'border-zinc-700 hover:border-zinc-600'
                      }`}
                      title={option.label}
                    >
                      <IconComp className="w-5 h-5 text-zinc-200" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onSkip}
            className="flex-1 text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-2 border border-zinc-700 text-zinc-400 hover:border-zinc-500 transition-all"
          >
            Skip
          </button>
          <button
            onClick={() => onConfirm(name, material, selectedIcon)}
            className="flex-1 text-[10px] font-mono font-bold uppercase tracking-widest px-3 py-2 bg-amber-400 text-black hover:bg-amber-300 transition-all"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

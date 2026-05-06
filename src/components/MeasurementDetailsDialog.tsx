import React, { useState, useEffect } from 'react';
import { DoorOpen, Wind, Fan, Zap, Plug } from 'lucide-react';

interface MeasurementDetailsDialogProps {
  isOpen: boolean;
  defaultName: string;
  defaultMaterial: string;
  measurementType?: string;
  onConfirm: (name: string, material: string, icon?: string) => void;
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
          
          {!isCountType && (
            <div>
              <label className="block text-[10px] font-mono font-bold text-zinc-400 uppercase tracking-widest mb-1.5">
                Material
              </label>
              <input
                type="text"
                value={material}
                onChange={e => setMaterial(e.target.value)}
                className="w-full bg-zinc-800 border border-industrial-border px-3 py-2 text-sm font-mono text-zinc-200 focus:outline-none focus:border-amber-400 transition-colors"
                placeholder="e.g., Concrete, Steel, Wood, etc."
              />
            </div>
          )}

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

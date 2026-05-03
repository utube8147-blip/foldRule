// components/presets/ui.tsx
'use client';

import React from 'react';

export const inputBase =
  'w-full bg-[#0d0d0d] border border-[#2a2a2a] text-white font-mono text-[11px] px-3 py-2 focus:outline-none focus:border-amber-500 transition-colors';

export function FieldLabel({ children, unit }: { children: React.ReactNode; unit?: string }) {
  return (
    <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-600 mb-1">
      {children}
      {unit && <span className="ml-1 text-zinc-700">({unit})</span>}
    </p>
  );
}

export function NumberInput({
  fieldKey, label, unit, placeholder, value, onChange,
}: {
  fieldKey: string; label: string; unit?: string;
  placeholder?: string; value: any; onChange: (k: string, v: any) => void;
}) {
  return (
    <div>
      <FieldLabel unit={unit}>{label}</FieldLabel>
      <input
        type="number" step="any"
        placeholder={placeholder ?? '0'}
        value={value ?? ''}
        onChange={e => onChange(fieldKey, parseFloat(e.target.value) || 0)}
        className={inputBase}
      />
    </div>
  );
}

export function SelectInput({
  fieldKey, label, options, value, onChange,
}: {
  fieldKey: string; label: string; options: string[]; value: any;
  onChange: (k: string, v: any) => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <select
        value={value ?? ''}
        onChange={e => onChange(fieldKey, e.target.value)}
        className={inputBase + ' cursor-pointer'}
      >
        <option value="">Select…</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

export function ToggleGroup({
  fieldKey, label, options, value, onChange,
}: {
  fieldKey: string; label: string; options: string[]; value: any;
  onChange: (k: string, v: any) => void;
}) {
  return (
    <div className="col-span-2">
      <FieldLabel>{label}</FieldLabel>
      <div className="flex gap-2 mt-1">
        {options.map(opt => (
          <button key={opt} type="button" onClick={() => onChange(fieldKey, opt)}
            className={`flex-1 py-2 border text-[10px] font-bold uppercase tracking-widest transition-colors ${
              value === opt
                ? 'border-amber-500 text-amber-500 bg-amber-500/10'
                : 'border-[#2a2a2a] text-zinc-600 hover:border-zinc-600 hover:text-zinc-400'
            }`}>
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CheckLeaf({
  fieldKey, label, qty, value, onChange,
}: {
  fieldKey: string; label: string; qty?: string; value: boolean;
  onChange: (k: string, v: any) => void;
}) {
  return (
    <label className="flex items-center justify-between cursor-pointer p-2.5 hover:bg-[#1a1a1a]
                       border border-transparent hover:border-[#2a2a2a] transition-all col-span-2">
      <div className="flex items-center gap-3" onClick={() => onChange(fieldKey, !value)}>
        <svg viewBox="0 0 24 24" className={`w-5 h-5 shrink-0 ${value ? 'text-amber-500' : 'text-zinc-600'}`} fill="currentColor">
          {value
            ? <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            : <path d="M19 5v14H5V5h14m0-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/>}
        </svg>
        <span className="text-[10px] font-mono uppercase tracking-wide text-zinc-400">{label}</span>
      </div>
      {qty && <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-700 shrink-0 ml-4">{qty}</span>}
    </label>
  );
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="col-span-2 text-[9px] font-black uppercase tracking-widest text-amber-500/70
                   border-b border-[#1e1e1e] pb-1 mb-1 mt-2">
      {children}
    </h4>
  );
}

export function StatStrip({ stats }: {
  stats: { label: string; value: number | string; unit: string }[]
}) {
  if (!stats.length) return null;
  return (
    <div className={`col-span-2 mt-2 grid gap-2 border border-[#1e1e1e] p-3 bg-[#0d0d0d]`}
         style={{ gridTemplateColumns: `repeat(${Math.min(stats.length, 4)}, 1fr)` }}>
      {stats.map(({ label, value, unit }) => (
        <div key={label} className="text-center">
          <p className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">{label}</p>
          <p className="text-[18px] font-black text-amber-500 leading-none mt-0.5">{value}</p>
          <p className="text-[8px] font-mono text-zinc-700 uppercase">{unit}</p>
        </div>
      ))}
    </div>
  );
}

export function Stepper({ fieldKey, label, unit, value, onChange, min = 1 }: {
  fieldKey: string; label: string; unit?: string; value: any;
  onChange: (k: string, v: any) => void; min?: number;
}) {
  const qty = parseInt(value ?? min);
  return (
    <div className="col-span-2">
      <FieldLabel>{label}</FieldLabel>
      <div className="flex items-center gap-3 mt-1">
        <button type="button"
          onClick={() => onChange(fieldKey, Math.max(min, qty - 1))}
          className="w-8 h-8 border border-[#2a2a2a] text-zinc-400 hover:border-zinc-500 hover:text-white transition-colors text-lg">−</button>
        <span className="text-[28px] font-black text-amber-500 w-12 text-center leading-none">{qty}</span>
        <button type="button"
          onClick={() => onChange(fieldKey, qty + 1)}
          className="w-8 h-8 border border-[#2a2a2a] text-zinc-400 hover:border-zinc-500 hover:text-white transition-colors text-lg">+</button>
        {unit && <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">{unit}</span>}
      </div>
    </div>
  );
}
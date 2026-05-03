'use client';

import React, { useState, useMemo } from 'react';

// ─── Shared Types ──────────────────────────────────────────────────────────────

export interface PresetTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  measurementType: 'linear' | 'area' | 'count' | 'point';
  fields: {
    key: string;
    label: string;
    type: 'text' | 'number' | 'select' | 'boolean';
    default?: any;
    options?: string[];
    unit?: string;
    placeholder?: string;
    required?: boolean;
    fullWidth?: boolean;
    hint?: string;
  }[];
}

/** Props every individual preset form component receives */
export interface PresetFormComponentProps {
  formData: Record<string, any>;
  onChange: (key: string, value: any) => void;
  template: PresetTemplate;
}

// ─── Shared UI Primitives ──────────────────────────────────────────────────────

const inputBase =
  'w-full bg-[#0d0d0d] border border-[#2a2a2a] text-white font-mono text-[11px] px-3 py-2 focus:outline-none focus:border-amber-500 transition-colors';

function FieldLabel({ children, unit }: { children: React.ReactNode; unit?: string }) {
  return (
    <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-600 mb-1">
      {children}
      {unit && <span className="ml-1 text-zinc-700">({unit})</span>}
    </p>
  );
}

function NumberInput({
  fieldKey, label, unit, placeholder, value, onChange,
}: {
  fieldKey: string; label: string; unit?: string;
  placeholder?: string; value: any; onChange: (k: string, v: any) => void;
}) {
  return (
    <div>
      <FieldLabel unit={unit}>{label}</FieldLabel>
      <input
        type="number"
        step="any"
        placeholder={placeholder ?? '0'}
        value={value ?? ''}
        onChange={e => onChange(fieldKey, parseFloat(e.target.value) || 0)}
        className={inputBase}
      />
    </div>
  );
}

function SelectInput({
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

function ToggleGroup({
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
          <button
            key={opt}
            type="button"
            onClick={() => onChange(fieldKey, opt)}
            className={`flex-1 py-2 border text-[10px] font-bold uppercase tracking-widest transition-colors ${
              value === opt
                ? 'border-amber-500 text-amber-500 bg-amber-500/10'
                : 'border-[#2a2a2a] text-zinc-600 hover:border-zinc-600 hover:text-zinc-400'
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

function CheckLeaf({
  fieldKey, label, qty, value, onChange,
}: {
  fieldKey: string; label: string; qty?: string; value: boolean;
  onChange: (k: string, v: any) => void;
}) {
  return (
    <label
      className="flex items-center justify-between cursor-pointer p-2.5 hover:bg-[#1a1a1a]
                 border border-transparent hover:border-[#2a2a2a] transition-all col-span-2"
    >
      <div className="flex items-center gap-3" onClick={() => onChange(fieldKey, !value)}>
        <svg viewBox="0 0 24 24" className={`w-5 h-5 shrink-0 ${value ? 'text-amber-500' : 'text-zinc-600'}`} fill="currentColor">
          {value
            ? <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            : <path d="M19 5v14H5V5h14m0-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/>
          }
        </svg>
        <span className="text-[10px] font-mono uppercase tracking-wide text-zinc-400">{label}</span>
      </div>
      {qty && <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-700 shrink-0 ml-4">{qty}</span>}
    </label>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="col-span-2 text-[9px] font-black uppercase tracking-widest text-amber-500/70
                   border-b border-[#1e1e1e] pb-1 mb-1 mt-2">
      {children}
    </h4>
  );
}

// ─── Individual Preset Form Components ────────────────────────────────────────

function StudWallForm({ formData, onChange }: PresetFormComponentProps) {
  const L = parseFloat(formData.length ?? 0);
  const H = parseFloat(formData.height ?? 0);
  const spacingMm = formData.spacing === '600mm' ? 600 : 450;
  const studCount = L > 0 ? Math.ceil((L / spacingMm) * 1000) + 1 : 0;
  const timberLength = L > 0 && H > 0 ? +((studCount * H / 1000) + (L / 1000) * 3).toFixed(1) : 0;
  const plasterArea = L > 0 && H > 0 ? +((L / 1000) * (H / 1000) * 2 * 1.05).toFixed(1) : 0;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Dimensions</SectionHeading>
      <NumberInput fieldKey="length" label="Length" unit="MM" placeholder="12500" value={formData.length} onChange={onChange} />
      <NumberInput fieldKey="height" label="Height" unit="MM" placeholder="2700"  value={formData.height} onChange={onChange} />

      <SectionHeading>Framing</SectionHeading>
      <ToggleGroup fieldKey="spacing"    label="Stud Spacing"        options={['450mm','600mm','Custom']}    value={formData.spacing}    onChange={onChange} />
      <SelectInput fieldKey="nogginRows" label="Noggin Rows"         options={['1 Row','2 Rows','3 Rows']}   value={formData.nogginRows} onChange={onChange} />
      <SelectInput fieldKey="thickness"  label="Material Thickness"  options={['45mm','70mm','90mm']}        value={formData.thickness}  onChange={onChange} />

      <SectionHeading>Leaves</SectionHeading>
      <CheckLeaf fieldKey="facePlasterboard" label="Plasterboard (Face) — 12.5mm FireShield"  qty={studCount > 0 ? `~${Math.ceil(plasterArea / 3.6)} sheets` : undefined} value={!!formData.facePlasterboard} onChange={onChange} />
      <CheckLeaf fieldKey="backPlasterboard" label="Plasterboard (Back) — 12.5mm SoundShield" qty={studCount > 0 ? `~${Math.ceil(plasterArea / 3.6)} sheets` : undefined} value={!!formData.backPlasterboard} onChange={onChange} />
      <CheckLeaf fieldKey="insulation"       label="Acoustic Insulation — 50mm Rockwool"       qty={plasterArea > 0 ? `${plasterArea} M²` : undefined}                    value={!!formData.insulation}       onChange={onChange} />

      {/* Live calc strip */}
      {studCount > 0 && (
        <div className="col-span-2 mt-2 grid grid-cols-3 gap-2 border border-[#1e1e1e] p-3 bg-[#0d0d0d]">
          {[
            { label: 'Studs', value: studCount, unit: 'pcs' },
            { label: 'Timber', value: timberLength, unit: 'LM' },
            { label: 'Plasterboard', value: plasterArea, unit: 'M²' },
          ].map(({ label, value, unit }) => (
            <div key={label} className="text-center">
              <p className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">{label}</p>
              <p className="text-[20px] font-black text-amber-500 leading-none mt-0.5">{value}</p>
              <p className="text-[8px] font-mono text-zinc-700 uppercase">{unit}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CarcassForm({ formData, onChange }: PresetFormComponentProps) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Dimensions</SectionHeading>
      <NumberInput fieldKey="length" label="Length" unit="M" value={formData.length} onChange={onChange} />
      <NumberInput fieldKey="width"  label="Width"  unit="M" value={formData.width}  onChange={onChange} />
      <NumberInput fieldKey="height" label="Height" unit="M" value={formData.height} onChange={onChange} />

      <SectionHeading>Specification</SectionHeading>
      <SelectInput fieldKey="material" label="Material" options={['Concrete','Steel','Mixed']} value={formData.material} onChange={onChange} />

      <div className="col-span-2">
        <FieldLabel>Notes</FieldLabel>
        <textarea
          value={formData.notes ?? ''}
          onChange={e => onChange('notes', e.target.value)}
          rows={3}
          className={inputBase + ' resize-none'}
          placeholder="Site notes, constraints…"
        />
      </div>
    </div>
  );
}

function FloorSlabForm({ formData, onChange }: PresetFormComponentProps) {
  const area = (parseFloat(formData.length ?? 0) * parseFloat(formData.width ?? 0)).toFixed(1);
  const thicknessMm = parseInt(formData.thickness ?? '100');
  const volume = area && thicknessMm ? +((parseFloat(area) * thicknessMm) / 1000).toFixed(2) : 0;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Dimensions</SectionHeading>
      <NumberInput fieldKey="length" label="Length" unit="M" value={formData.length} onChange={onChange} />
      <NumberInput fieldKey="width"  label="Width"  unit="M" value={formData.width}  onChange={onChange} />

      <SectionHeading>Specification</SectionHeading>
      <SelectInput fieldKey="thickness"     label="Thickness"          options={['100mm','150mm','200mm','250mm']}    value={formData.thickness}     onChange={onChange} />
      <SelectInput fieldKey="reinforcement" label="Reinforcement Type" options={['Mesh','Bars','Fibre']}              value={formData.reinforcement} onChange={onChange} />
      <SelectInput fieldKey="finishType"    label="Finish Type"        options={['Smooth','Rough','Polished']}        value={formData.finishType}    onChange={onChange} />

      {volume > 0 && (
        <div className="col-span-2 mt-2 grid grid-cols-2 gap-2 border border-[#1e1e1e] p-3 bg-[#0d0d0d]">
          <div className="text-center">
            <p className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">Area</p>
            <p className="text-[20px] font-black text-amber-500 leading-none mt-0.5">{area}</p>
            <p className="text-[8px] font-mono text-zinc-700 uppercase">M²</p>
          </div>
          <div className="text-center">
            <p className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">Concrete Vol.</p>
            <p className="text-[20px] font-black text-amber-500 leading-none mt-0.5">{volume}</p>
            <p className="text-[8px] font-mono text-zinc-700 uppercase">M³</p>
          </div>
        </div>
      )}
    </div>
  );
}

function RoofForm({ formData, onChange }: PresetFormComponentProps) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Dimensions</SectionHeading>
      <NumberInput fieldKey="roofArea"  label="Roof Area"  unit="M²"  value={formData.roofArea}  onChange={onChange} />
      <NumberInput fieldKey="roofPitch" label="Roof Pitch" unit="DEG" value={formData.roofPitch} onChange={onChange} />

      <SectionHeading>Specification</SectionHeading>
      <SelectInput fieldKey="roofType"   label="Roof Type"             options={['Pitched','Flat','Curved']}          value={formData.roofType}   onChange={onChange} />
      <SelectInput fieldKey="material"   label="Material"              options={['Tile','Slate','Metal','Asphalt']}    value={formData.material}   onChange={onChange} />
      <SelectInput fieldKey="insulation" label="Insulation Thickness"  options={['100mm','150mm','200mm']}             value={formData.insulation} onChange={onChange} />
    </div>
  );
}

function DoorForm({ formData, onChange }: PresetFormComponentProps) {
  const qty = parseInt(formData.quantity ?? 1);
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Quantity</SectionHeading>
      {/* Stepper widget — more intuitive than a plain number field for doors */}
      <div className="col-span-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => onChange('quantity', Math.max(1, qty - 1))}
          className="w-8 h-8 border border-[#2a2a2a] text-zinc-400 hover:border-zinc-500 hover:text-white transition-colors text-lg"
        >−</button>
        <span className="text-[28px] font-black text-amber-500 w-12 text-center leading-none">{qty}</span>
        <button
          type="button"
          onClick={() => onChange('quantity', qty + 1)}
          className="w-8 h-8 border border-[#2a2a2a] text-zinc-400 hover:border-zinc-500 hover:text-white transition-colors text-lg"
        >+</button>
        <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">doors</span>
      </div>

      <SectionHeading>Dimensions</SectionHeading>
      <SelectInput fieldKey="width"  label="Width"  options={['750mm','800mm','900mm','1000mm']} value={formData.width}  onChange={onChange} />
      <SelectInput fieldKey="height" label="Height" options={['2000mm','2100mm','2400mm']}       value={formData.height} onChange={onChange} />

      <SectionHeading>Specification</SectionHeading>
      <SelectInput fieldKey="doorType"  label="Door Type"   options={['Swing','Sliding','Folding','Bi-fold']}    value={formData.doorType}  onChange={onChange} />
      <SelectInput fieldKey="material"  label="Material"    options={['Wood','Steel','Aluminium','Glass']}       value={formData.material}  onChange={onChange} />
      <SelectInput fieldKey="frameType" label="Frame Type"  options={['Timber','Steel','Aluminium']}             value={formData.frameType} onChange={onChange} />
    </div>
  );
}

function WindowForm({ formData, onChange }: PresetFormComponentProps) {
  const qty = parseInt(formData.quantity ?? 1);
  const w = parseFloat(formData.width ?? 0);
  const h = parseFloat(formData.height ?? 0);
  const glassArea = w > 0 && h > 0 ? +((w / 1000) * (h / 1000) * qty).toFixed(2) : 0;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Quantity</SectionHeading>
      <div className="col-span-2 flex items-center gap-3">
        <button type="button" onClick={() => onChange('quantity', Math.max(1, qty - 1))}
          className="w-8 h-8 border border-[#2a2a2a] text-zinc-400 hover:border-zinc-500 hover:text-white transition-colors text-lg">−</button>
        <span className="text-[28px] font-black text-amber-500 w-12 text-center leading-none">{qty}</span>
        <button type="button" onClick={() => onChange('quantity', qty + 1)}
          className="w-8 h-8 border border-[#2a2a2a] text-zinc-400 hover:border-zinc-500 hover:text-white transition-colors text-lg">+</button>
        <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">windows</span>
      </div>

      <SectionHeading>Dimensions (per unit)</SectionHeading>
      <NumberInput fieldKey="width"  label="Width"  unit="MM" value={formData.width}  onChange={onChange} />
      <NumberInput fieldKey="height" label="Height" unit="MM" value={formData.height} onChange={onChange} />

      <SectionHeading>Glazing & Frame</SectionHeading>
      <SelectInput fieldKey="windowType" label="Window Type"  options={['Casement','Sash','Slider','Fixed']}        value={formData.windowType} onChange={onChange} />
      <SelectInput fieldKey="glazing"    label="Glazing Type" options={['Single','Double','Triple']}                 value={formData.glazing}    onChange={onChange} />
      <SelectInput fieldKey="frameType"  label="Frame Type"   options={['Timber','UPVC','Aluminium','Steel']}        value={formData.frameType}  onChange={onChange} />

      {glassArea > 0 && (
        <div className="col-span-2 mt-2 flex items-center gap-4 border border-[#1e1e1e] p-3 bg-[#0d0d0d]">
          <div>
            <p className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">Total glass area</p>
            <p className="text-[24px] font-black text-amber-500 leading-none mt-0.5">{glassArea} <span className="text-sm font-mono text-zinc-500">M²</span></p>
          </div>
        </div>
      )}
    </div>
  );
}

function CeilingForm({ formData, onChange }: PresetFormComponentProps) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Area</SectionHeading>
      <NumberInput fieldKey="area"   label="Area"              unit="M²" value={formData.area}   onChange={onChange} />
      <NumberInput fieldKey="height" label="Height from Floor" unit="M"  value={formData.height} onChange={onChange} />

      <SectionHeading>System</SectionHeading>
      <SelectInput fieldKey="ceilingType" label="Ceiling Type" options={['Suspended','Direct Fix','Plasterboard','Acoustic']} value={formData.ceilingType} onChange={onChange} />
      <SelectInput fieldKey="gridType"    label="Grid Type"    options={['T-bar','Clips','Adhesive']}                         value={formData.gridType}    onChange={onChange} />
      <SelectInput fieldKey="fireRating"  label="Fire Rating"  options={['None','30min','60min','90min']}                     value={formData.fireRating}  onChange={onChange} />
    </div>
  );
}

function StaircaseForm({ formData, onChange }: PresetFormComponentProps) {
  const steps = parseInt(formData.stepCount ?? 0);
  const riser = steps > 0 && formData.flightRise
    ? +((parseFloat(formData.flightRise) / steps) * 1000).toFixed(0)
    : null;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Quantity & Size</SectionHeading>
      <NumberInput fieldKey="quantity"   label="Quantity"        value={formData.quantity}   onChange={onChange} />
      <NumberInput fieldKey="flightRise" label="Flight Rise" unit="M" value={formData.flightRise} onChange={onChange} />
      <NumberInput fieldKey="stepCount"  label="No. of Steps"    value={formData.stepCount}  onChange={onChange} />

      {riser && (
        <div className="flex flex-col justify-end">
          <FieldLabel>Riser Height (calc)</FieldLabel>
          <p className="text-[20px] font-black text-amber-500 leading-none">{riser}<span className="text-xs font-mono text-zinc-500 ml-1">MM</span></p>
        </div>
      )}

      <SectionHeading>Specification</SectionHeading>
      <SelectInput fieldKey="stringType" label="String Type"   options={['Open','Closed']}                          value={formData.stringType} onChange={onChange} />
      <SelectInput fieldKey="material"   label="Material"      options={['Timber','Concrete','Steel','Composite']}   value={formData.material}   onChange={onChange} />
      <SelectInput fieldKey="railing"    label="Railing Type"  options={['Timber','Metal','Glass','None']}           value={formData.railing}    onChange={onChange} />
    </div>
  );
}

function BeamForm({ formData, onChange }: PresetFormComponentProps) {
  const qty    = parseInt(formData.quantity ?? 1);
  const length = parseFloat(formData.length ?? 0);
  const total  = qty > 0 && length > 0 ? +(qty * length).toFixed(1) : 0;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Quantity & Length</SectionHeading>
      <NumberInput fieldKey="quantity" label="Quantity"          value={formData.quantity} onChange={onChange} />
      <NumberInput fieldKey="length"   label="Length" unit="M"   value={formData.length}   onChange={onChange} />
      {total > 0 && (
        <div className="col-span-2 text-[10px] font-mono text-zinc-500">
          Total run: <span className="text-amber-500 font-black">{total} LM</span>
        </div>
      )}

      <SectionHeading>Section</SectionHeading>
      <SelectInput fieldKey="beamType"    label="Beam Type"       options={['I-Beam','H-Beam','Channel','Box']}               value={formData.beamType}    onChange={onChange} />
      <SelectInput fieldKey="material"    label="Material"        options={['Steel','Concrete','Timber']}                      value={formData.material}    onChange={onChange} />
      <div className="col-span-2">
        <FieldLabel>Section Size</FieldLabel>
        <input type="text" placeholder="e.g. 305×165×40 UB"
          value={formData.sectionSize ?? ''}
          onChange={e => onChange('sectionSize', e.target.value)}
          className={inputBase} />
      </div>

      <SectionHeading>Protection</SectionHeading>
      <SelectInput fieldKey="fireProtection" label="Fire Protection" options={['None','Paint','Boarding','Intumescent']} value={formData.fireProtection} onChange={onChange} />
    </div>
  );
}

function ColumnForm({ formData, onChange }: PresetFormComponentProps) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Quantity & Height</SectionHeading>
      <NumberInput fieldKey="quantity" label="Quantity"        value={formData.quantity} onChange={onChange} />
      <NumberInput fieldKey="height"   label="Height" unit="M" value={formData.height}   onChange={onChange} />

      <SectionHeading>Section</SectionHeading>
      <SelectInput fieldKey="columnType"  label="Column Type"    options={['Circular','Square','Rectangular','I-Section']} value={formData.columnType}  onChange={onChange} />
      <SelectInput fieldKey="material"    label="Material"       options={['Steel','Concrete','Timber']}                   value={formData.material}    onChange={onChange} />
      <div className="col-span-2">
        <FieldLabel>Section Size</FieldLabel>
        <input type="text" placeholder="e.g. 300×300"
          value={formData.sectionSize ?? ''}
          onChange={e => onChange('sectionSize', e.target.value)}
          className={inputBase} />
      </div>

      <SectionHeading>Foundations</SectionHeading>
      <SelectInput fieldKey="foundations" label="Foundation Type" options={['Pile','Pad','Strip','Raft']} value={formData.foundations} onChange={onChange} />
    </div>
  );
}

function TilingForm({ formData, onChange }: PresetFormComponentProps) {
  const area = parseFloat(formData.area ?? 0);
  // tile size e.g. "300x300" → 0.3 × 0.3 = 0.09 m² per tile
  const tileSizeStr = formData.tileSize ?? '';
  const [tw, th] = tileSizeStr.split('x').map((n: string) => parseInt(n) / 1000);
  const tileCount = tw && th && area > 0 ? Math.ceil((area * 1.1) / (tw * th)) : null;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Area</SectionHeading>
      <NumberInput fieldKey="area" label="Area" unit="M²" value={formData.area} onChange={onChange} />
      <SelectInput fieldKey="tilingLocation" label="Location" options={['Wall','Floor','Both']} value={formData.tilingLocation} onChange={onChange} />

      <SectionHeading>Tile Spec</SectionHeading>
      <SelectInput fieldKey="tileSize"  label="Tile Size"  options={['200x200','300x300','400x400','600x600']} value={formData.tileSize}  onChange={onChange} />
      <SelectInput fieldKey="material"  label="Material"   options={['Ceramic','Porcelain','Glass','Natural Stone']} value={formData.material}  onChange={onChange} />
      <SelectInput fieldKey="groutType" label="Grout Type" options={['Cement','Epoxy','Urethane']}             value={formData.groutType} onChange={onChange} />
      <SelectInput fieldKey="jointWidth" label="Joint Width" options={['3mm','4mm','5mm','6mm']}               value={formData.jointWidth} onChange={onChange} />

      {tileCount && (
        <div className="col-span-2 mt-2 border border-[#1e1e1e] p-3 bg-[#0d0d0d]">
          <p className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">Est. tile count (incl. 10% wastage)</p>
          <p className="text-[28px] font-black text-amber-500 leading-none mt-1">{tileCount} <span className="text-sm font-mono text-zinc-500">tiles</span></p>
        </div>
      )}
    </div>
  );
}

function PlumbingForm({ formData, onChange }: PresetFormComponentProps) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Pipe Run</SectionHeading>
      <NumberInput fieldKey="pipeLength"   label="Pipe Length"  unit="M"  value={formData.pipeLength}   onChange={onChange} />
      <SelectInput fieldKey="pipeDiameter" label="Diameter"               options={['15mm','20mm','25mm','32mm','50mm']}              value={formData.pipeDiameter} onChange={onChange} />

      <SectionHeading>System</SectionHeading>
      <SelectInput fieldKey="pipeType"   label="Pipe Type"     options={['Copper','PVC','HDPE','Steel']}                    value={formData.pipeType}   onChange={onChange} />
      <SelectInput fieldKey="systemType" label="System Type"   options={['Cold Water','Hot Water','Waste','Vent']}           value={formData.systemType} onChange={onChange} />

      <SectionHeading>Fittings</SectionHeading>
      <SelectInput fieldKey="fittings" label="Fittings Type"       options={['Compression','Push-Fit','Soldered','Threaded']} value={formData.fittings} onChange={onChange} />
      <NumberInput fieldKey="quantity" label="Qty of Fittings"     value={formData.quantity} onChange={onChange} />
    </div>
  );
}

// ─── PRESET_FORM_MAP ───────────────────────────────────────────────────────────
// This is the only place you touch when adding a new preset.
// key = template.id, value = the form component for that preset.

export const PRESET_FORM_MAP: Record<string, React.ComponentType<PresetFormComponentProps>> = {
  'carcass':    CarcassForm,
  'stud-wall':  StudWallForm,
  'floor-slab': FloorSlabForm,
  'roof':       RoofForm,
  'door':       DoorForm,
  'window':     WindowForm,
  'ceiling':    CeilingForm,
  'staircase':  StaircaseForm,
  'beam':       BeamForm,
  'column':     ColumnForm,
  'tiling':     TilingForm,
  'plumbing':   PlumbingForm,
};

// ─── ELEMENT_PRESETS (metadata only — no fields needed for the drawer gallery) ─

export const ELEMENT_PRESETS: PresetTemplate[] = [
  { id: 'carcass',    name: 'Carcass',    category: 'Structure', measurementType: 'area',   description: 'Building structural carcass and framework', fields: [] },
  { id: 'stud-wall',  name: 'Stud Wall',  category: 'Walls',     measurementType: 'linear', description: 'Interior stud wall framing',                fields: [] },
  { id: 'floor-slab', name: 'Floor Slab', category: 'Structure', measurementType: 'area',   description: 'Concrete floor slabs and platforms',         fields: [] },
  { id: 'roof',       name: 'Roof',       category: 'Envelope',  measurementType: 'area',   description: 'Roof structures and coverings',              fields: [] },
  { id: 'door',       name: 'Door',       category: 'Openings',  measurementType: 'count',  description: 'Door frames and installations',              fields: [] },
  { id: 'window',     name: 'Window',     category: 'Openings',  measurementType: 'count',  description: 'Window frames and glazing',                  fields: [] },
  { id: 'ceiling',    name: 'Ceiling',    category: 'Interior',  measurementType: 'area',   description: 'Ceiling systems and finishes',               fields: [] },
  { id: 'staircase',  name: 'Staircase',  category: 'Structure', measurementType: 'count',  description: 'Stair construction and railings',            fields: [] },
  { id: 'beam',       name: 'Beam',       category: 'Structure', measurementType: 'linear', description: 'Structural beams and supports',              fields: [] },
  { id: 'column',     name: 'Column',     category: 'Structure', measurementType: 'count',  description: 'Structural columns and supports',            fields: [] },
  { id: 'tiling',     name: 'Tiling',     category: 'Finishes',  measurementType: 'area',   description: 'Wall and floor tiling installation',         fields: [] },
  { id: 'plumbing',   name: 'Plumbing',   category: 'Services',  measurementType: 'linear', description: 'Water supply and drainage systems',          fields: [] },
];
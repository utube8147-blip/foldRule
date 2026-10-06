'use client';

import React from 'react';
import dynamic from 'next/dynamic';

// three.js (~140 KB gzipped) is only needed when a preset form with a 3D
// preview is open, so it loads on demand instead of with the workspace.
const Preset3DVisualizer = dynamic(() => import('./Preset3DVisualizer'), {
  ssr: false,
  loading: () => (
    <div
      className="flex h-full min-h-[450px] w-full items-center justify-center text-xs text-zinc-500"
      role="status"
    >
      Loading 3D preview…
    </div>
  ),
});

// ─── Shared Types ──────────────────────────────────────────────────────────────

type FormFieldValue = string | number | boolean | null | undefined;
type MeasurementType = 'linear' | 'area' | 'count' | 'point';
type FieldType = 'text' | 'number' | 'select' | 'boolean';

export interface PresetFieldDefinition {
  key: string;
  label: string;
  type: FieldType;
  default?: FormFieldValue;
  options?: string[];
  unit?: string;
  placeholder?: string;
  required?: boolean;
  fullWidth?: boolean;
  hint?: string;
}

export interface PresetTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  measurementType: MeasurementType;
  fields: PresetFieldDefinition[];
}

export interface FormDataRecord {
  [key: string]: FormFieldValue;
}

export interface PresetFormComponentProps {
  formData: FormDataRecord;
  onChange: (key: string, value: FormFieldValue) => void;
  template: PresetTemplate;
}

// ─── Shared UI Primitives ──────────────────────────────────────────────────────

export const inputBase =
  'w-full bg-[#0d0d0d] border border-[#2a2a2a] text-white font-mono text-xs px-3 py-2 focus:outline-none focus:border-amber-500 transition-colors';

export function FieldLabel({ children, unit }: { children: React.ReactNode; unit?: string }) {
  return (
    <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-600 mb-1">
      {children}
      {unit && <span className="ml-1 text-zinc-700">({unit})</span>}
    </p>
  );
}

export function NumberInput({
  fieldKey, label, unit, placeholder, value, onChange,
}: {
  fieldKey: string; label: string; unit?: string;
  placeholder?: string; value: FormFieldValue; onChange: (k: string, v: FormFieldValue) => void;
}): React.ReactElement {
  return (
    <div>
      <FieldLabel unit={unit}>{label}</FieldLabel>
      <input
        type="number"
        step="any"
        placeholder={placeholder ?? '0'}
        value={typeof value === 'number' || typeof value === 'string' ? value : ''}
        onChange={e => onChange(fieldKey, parseFloat(e.target.value) || 0)}
        className={inputBase}
      />
    </div>
  );
}

export function SelectInput({
  fieldKey, label, options, value, onChange,
}: {
  fieldKey: string; label: string; options: string[]; value: FormFieldValue;
  onChange: (k: string, v: FormFieldValue) => void;
}): React.ReactElement {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <select
        value={typeof value === 'string' ? value : ''}
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
  fieldKey: string; label: string; options: string[]; value: FormFieldValue;
  onChange: (k: string, v: FormFieldValue) => void;
}): React.ReactElement {
  return (
    <div className="col-span-2">
      <FieldLabel>{label}</FieldLabel>
      <div className="flex gap-2 mt-1">
        {options.map(opt => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(fieldKey, opt)}
            className={`flex-1 py-2 border text-[11px] font-bold uppercase tracking-widest transition-colors ${
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

export function CheckLeaf({
  fieldKey, label, qty, value, onChange,
}: {
  fieldKey: string; label: string; qty?: string; value: boolean;
  onChange: (k: string, v: FormFieldValue) => void;
}): React.ReactElement {
  return (
    <label className="flex items-center justify-between cursor-pointer p-2.5 hover:bg-[#1a1a1a] border border-transparent hover:border-[#2a2a2a] transition-all col-span-2">
      <div className="flex items-center gap-3" onClick={() => onChange(fieldKey, !value)}>
        <svg viewBox="0 0 24 24" className={`w-5 h-5 shrink-0 ${value ? 'text-amber-500' : 'text-zinc-600'}`} fill="currentColor">
          {value
            ? <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            : <path d="M19 5v14H5V5h14m0-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/>
          }
        </svg>
        <span className="text-[11px] font-mono uppercase tracking-wide text-zinc-400">{label}</span>
      </div>
      {qty && <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-700 shrink-0 ml-4">{qty}</span>}
    </label>
  );
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="col-span-2 text-[10px] font-black uppercase tracking-widest text-amber-500/70 border-b border-[#1e1e1e] pb-1 mb-1 mt-2">
      {children}
    </h4>
  );
}

export function StatStrip({ stats }: { stats: { label: string; value: number | string; unit: string }[] }) {
  return (
    <div className="col-span-2 mt-2 grid gap-2 border border-[#1e1e1e] p-3 bg-[#0d0d0d]"
      style={{ gridTemplateColumns: `repeat(${stats.length}, 1fr)` }}>
      {stats.map(({ label, value, unit }) => (
        <div key={label} className="text-center">
          <p className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">{label}</p>
          <p className="text-[20px] font-black text-amber-500 leading-none mt-0.5">{value}</p>
          <p className="text-[10px] font-mono text-zinc-700 uppercase">{unit}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Wrapper that places 3D viz beside the form ────────────────────────────────
// Updated to use side-by-side layout instead of stacked

// ─── Wrapper that places 3D viz beside the form ────────────────────────────────

function withViz(
  FormComponent: React.ComponentType<PresetFormComponentProps>,
): React.ComponentType<PresetFormComponentProps> {
  return function WrappedForm(props: PresetFormComponentProps) {
    return (
      <div className="flex flex-row gap-4 relative" style={{ isolation: 'isolate', minHeight: '450px' }}>
        {/* ── 3D Visualizer - Left Side ── */}
        <div style={{ flex: '0 0 45%', position: 'relative', zIndex: 20, backgroundColor: '#16191C', border: '1px solid #2a2a2a' }}>
          <Preset3DVisualizer
            presetId={props.template.id}
            formData={props.formData}
            height={450}
          />
        </div>
        
        {/* ── Form fields - Right Side ── */}
        <div style={{ flex: '0 0 53%', position: 'relative', zIndex: 5, maxHeight: '70vh', overflowY: 'auto', paddingRight: '4px' }}>
          <FormComponent {...props} />
        </div>
      </div>
    );
  };
}

// ─── Individual Preset Form Components ────────────────────────────────────────

// ── Carcass (detailed — from preset1-carcass.tsx) ──────────────────────────

function calcCarcassQuantities(fd: FormDataRecord): {
  boardArea: number;
  edgeBanding: number;
  doorArea: number;
  toeKickArea: number;
} {
  const W = parseFloat(String(fd.width ?? 600)) / 1000;
  const H = parseFloat(String(fd.height ?? 720)) / 1000;
  const D = parseFloat(String(fd.depth ?? 550)) / 1000;
  const T = parseFloat(String(fd.panelThickness ?? 18)) / 1000;
  const shelves   = parseInt(String(fd.shelfCount ?? 2));
  const doorCount = parseInt(String(fd.doorCount ?? 1));

  const iW = W - 2 * T;
  const iH = H - 2 * T;

  let totalBoard = 0;
  if (fd.hasBack)      totalBoard += iW * iH;
  if (fd.hasTop)       totalBoard += iW * D;
  if (fd.hasBottom)    totalBoard += iW * D;
  if (fd.hasLeftSide)  totalBoard += D * H;
  if (fd.hasRightSide) totalBoard += D * H;
  if (shelves > 0)     totalBoard += iW * D * shelves;
  if (fd.hasDivider)   totalBoard += H * D * parseInt(String(fd.dividerCount ?? 1));

  const edgeBanding =
    (fd.hasTop    ? 2 * (iW + D) : 0) +
    (fd.hasBottom ? 2 * (iW + D) : 0) +
    (fd.hasLeftSide  ? 2 * (D + H) : 0) +
    (fd.hasRightSide ? 2 * (D + H) : 0) +
    (shelves > 0 ? (2 * iW + D) * shelves : 0);

  const doorArea    = fd.hasDoors   ? (W / doorCount) * H * doorCount : 0;
  const toeKickArea = fd.hasToeKick ? W * 0.15 : 0;

  return {
    boardArea:    +totalBoard.toFixed(3),
    edgeBanding:  +edgeBanding.toFixed(2),
    doorArea:     +doorArea.toFixed(3),
    toeKickArea:  +toeKickArea.toFixed(3),
  };
}

function CarcassForm({ formData, onChange }: PresetFormComponentProps) {
  const q       = calcCarcassQuantities(formData);
  const W       = parseFloat(String(formData.width ?? 600));
  const H       = parseFloat(String(formData.height ?? 720));
  const D       = parseFloat(String(formData.depth ?? 550));
  const shelves = parseInt(String(formData.shelfCount ?? 2));

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">

      <SectionHeading>Carcass Dimensions</SectionHeading>
      <NumberInput fieldKey="width"          label="Width"           unit="MM" placeholder="600" value={formData.width}          onChange={onChange} />
      <NumberInput fieldKey="height"         label="Height"          unit="MM" placeholder="720" value={formData.height}         onChange={onChange} />
      <NumberInput fieldKey="depth"          label="Depth"           unit="MM" placeholder="550" value={formData.depth}          onChange={onChange} />
      <NumberInput fieldKey="panelThickness" label="Panel Thickness" unit="MM" placeholder="18"  value={formData.panelThickness} onChange={onChange} />

      <SectionHeading>Material</SectionHeading>
      <SelectInput fieldKey="boardMaterial" label="Board Material"
        options={['18mm MDF','18mm MFC','18mm Ply','25mm MDF','25mm Ply','16mm HMR MDF']}
        value={formData.boardMaterial} onChange={onChange} />
      <SelectInput fieldKey="edgeTape" label="Edge Tape"
        options={['PVC 0.4mm','PVC 2mm ABS','Veneer','Solid Timber']}
        value={formData.edgeTape} onChange={onChange} />

      <SectionHeading>Panels (check what to include)</SectionHeading>
      <CheckLeaf fieldKey="hasBack"      label="Back Panel"       qty={W > 0 && H > 0 ? `${+((W-36)*(H-36)/1e6).toFixed(3)} M²` : undefined} value={!!formData.hasBack}      onChange={onChange} />
      <CheckLeaf fieldKey="hasTop"       label="Top Panel"        qty={W > 0 && D > 0 ? `${+((W-36)*D/1e6).toFixed(3)} M²` : undefined}       value={!!formData.hasTop}       onChange={onChange} />
      <CheckLeaf fieldKey="hasBottom"    label="Bottom Panel"     qty={W > 0 && D > 0 ? `${+((W-36)*D/1e6).toFixed(3)} M²` : undefined}       value={!!formData.hasBottom}    onChange={onChange} />
      <CheckLeaf fieldKey="hasLeftSide"  label="Left Side Panel"  qty={H > 0 && D > 0 ? `${+(D*H/1e6).toFixed(3)} M²` : undefined}            value={!!formData.hasLeftSide}  onChange={onChange} />
      <CheckLeaf fieldKey="hasRightSide" label="Right Side Panel" qty={H > 0 && D > 0 ? `${+(D*H/1e6).toFixed(3)} M²` : undefined}            value={!!formData.hasRightSide} onChange={onChange} />

      <SectionHeading>Shelves & Dividers</SectionHeading>
      <div>
        <FieldLabel>Shelf Count</FieldLabel>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => onChange('shelfCount', Math.max(0, shelves - 1))}
            className="w-7 h-7 border border-[#2a2a2a] text-zinc-400 hover:border-zinc-500 hover:text-white transition-colors">−</button>
          <span className="text-[20px] font-black text-amber-500 w-8 text-center leading-none">{shelves}</span>
          <button type="button" onClick={() => onChange('shelfCount', Math.min(12, shelves + 1))}
            className="w-7 h-7 border border-[#2a2a2a] text-zinc-400 hover:border-zinc-500 hover:text-white transition-colors">+</button>
        </div>
      </div>
      <SelectInput fieldKey="shelfSpacing" label="Shelf Spacing" options={['Equal','Custom']} value={formData.shelfSpacing} onChange={onChange} />

      <CheckLeaf fieldKey="hasDivider" label="Vertical Divider(s)" value={!!formData.hasDivider} onChange={onChange} />
      {formData.hasDivider && (
        <NumberInput fieldKey="dividerCount" label="Divider Count" placeholder="1" value={formData.dividerCount} onChange={onChange} />
      )}

      <SectionHeading>Doors & Hardware</SectionHeading>
      <CheckLeaf fieldKey="hasDoors" label="Doors" value={!!formData.hasDoors} onChange={onChange} />
      {formData.hasDoors && (
        <>
          <NumberInput fieldKey="doorCount"    label="No. of Doors"  placeholder="1"                                                          value={formData.doorCount}    onChange={onChange} />
          <SelectInput fieldKey="doorSwing"    label="Door Swing"    options={['Left Hinge','Right Hinge','Both','Sliding']}                   value={formData.doorSwing}    onChange={onChange} />
          <SelectInput fieldKey="doorMaterial" label="Door Material" options={['MDF Primed','MFC Wrapped','Veneer','Glass','Acrylic']}          value={formData.doorMaterial} onChange={onChange} />
        </>
      )}
      <CheckLeaf fieldKey="hasDrawers" label="Drawer Fronts" value={!!formData.hasDrawers} onChange={onChange} />
      {formData.hasDrawers && (
        <NumberInput fieldKey="drawerCount" label="Drawer Count" placeholder="2" value={formData.drawerCount} onChange={onChange} />
      )}
      <CheckLeaf fieldKey="hasToeKick" label="Toe Kick / Plinth" value={!!formData.hasToeKick} onChange={onChange} />

      <StatStrip stats={[
        { label: 'Board Area',   value: q.boardArea,   unit: 'M²' },
        { label: 'Edge Banding', value: q.edgeBanding, unit: 'LM' },
        { label: 'Door Area',    value: q.doorArea,    unit: 'M²' },
        { label: 'Shelves',      value: shelves,        unit: 'pcs' },
      ]} />
    </div>
  );
}

// ── Stud Wall ──────────────────────────────────────────────────────────────

function StudWallForm({ formData, onChange }: PresetFormComponentProps) {
  const L = parseFloat(String(formData.length ?? 0));
  const H = parseFloat(String(formData.height ?? 0));
  const isCustomSpacing = formData.spacing === 'Custom';
  const customSpacingMm = isCustomSpacing ? parseInt(String(formData.customSpacing ?? 600)) : null;
  const spacingMm = isCustomSpacing && customSpacingMm ? customSpacingMm : (formData.spacing === '600mm' ? 600 : 450);
  const studCount = L > 0 ? Math.ceil((L / spacingMm) * 1000) + 1 : 0;
  const timberLength = L > 0 && H > 0 ? +((studCount * H / 1000) + (L / 1000) * 3).toFixed(1) : 0;
  const plasterArea  = L > 0 && H > 0 ? +((L / 1000) * (H / 1000) * 2 * 1.05).toFixed(1) : 0;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Dimensions</SectionHeading>
      <NumberInput fieldKey="length" label="Length" unit="MM" placeholder="12500" value={formData.length} onChange={onChange} />
      <NumberInput fieldKey="height" label="Height" unit="MM" placeholder="2700"  value={formData.height} onChange={onChange} />

      <SectionHeading>Framing</SectionHeading>
      <ToggleGroup fieldKey="spacing"    label="Stud Spacing"       options={['450mm','600mm','Custom']}  value={formData.spacing}    onChange={onChange} />
      {isCustomSpacing && (
        <NumberInput fieldKey="customSpacing" label="Custom Spacing" unit="MM" value={formData.customSpacing} onChange={onChange} />
      )}
      <SelectInput fieldKey="nogginRows" label="Noggin Rows"        options={['1 Row','2 Rows','3 Rows']} value={formData.nogginRows} onChange={onChange} />
      <SelectInput fieldKey="thickness"  label="Material Thickness" options={['45mm','70mm','90mm']}      value={formData.thickness}  onChange={onChange} />

      <SectionHeading>Leaves</SectionHeading>
      <CheckLeaf fieldKey="facePlasterboard" label="Plasterboard (Face) — 12.5mm FireShield"  qty={studCount > 0 ? `~${Math.ceil(plasterArea / 3.6)} sheets` : undefined} value={!!formData.facePlasterboard} onChange={onChange} />
      <CheckLeaf fieldKey="backPlasterboard" label="Plasterboard (Back) — 12.5mm SoundShield" qty={studCount > 0 ? `~${Math.ceil(plasterArea / 3.6)} sheets` : undefined} value={!!formData.backPlasterboard} onChange={onChange} />
      <CheckLeaf fieldKey="insulation"       label="Acoustic Insulation — 50mm Rockwool"       qty={plasterArea > 0 ? `${plasterArea} M²` : undefined}                    value={!!formData.insulation}       onChange={onChange} />

      {studCount > 0 && (
        <StatStrip stats={[
          { label: 'Studs',        value: studCount,     unit: 'pcs' },
          { label: 'Timber',       value: timberLength,  unit: 'LM'  },
          { label: 'Plasterboard', value: plasterArea,   unit: 'M²'  },
        ]} />
      )}
    </div>
  );
}

// ── Floor Slab ─────────────────────────────────────────────────────────────

function FloorSlabForm({ formData, onChange }: PresetFormComponentProps) {
  const area        = (parseFloat(String(formData.length ?? 0)) * parseFloat(String(formData.width ?? 0))).toFixed(1);
  const thicknessMm = parseInt(String(formData.thickness ?? '100'));
  const volume      = area && thicknessMm ? +((parseFloat(area) * thicknessMm) / 1000).toFixed(2) : 0;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Dimensions</SectionHeading>
      <NumberInput fieldKey="length" label="Length" unit="M" value={formData.length} onChange={onChange} />
      <NumberInput fieldKey="width"  label="Width"  unit="M" value={formData.width}  onChange={onChange} />

      <SectionHeading>Specification</SectionHeading>
      <SelectInput fieldKey="thickness"     label="Thickness"          options={['100mm','150mm','200mm','250mm']} value={formData.thickness}     onChange={onChange} />
      <SelectInput fieldKey="reinforcement" label="Reinforcement Type" options={['Mesh','Bars','Fibre']}           value={formData.reinforcement} onChange={onChange} />
      <SelectInput fieldKey="finishType"    label="Finish Type"        options={['Smooth','Rough','Polished']}     value={formData.finishType}    onChange={onChange} />

      {volume > 0 && (
        <StatStrip stats={[
          { label: 'Area',         value: area,   unit: 'M²' },
          { label: 'Concrete Vol', value: volume, unit: 'M³' },
        ]} />
      )}
    </div>
  );
}

// ── Roof ───────────────────────────────────────────────────────────────────

function RoofForm({ formData, onChange }: PresetFormComponentProps) {
  const area = parseFloat(String(formData.roofArea ?? 0)) || 0;
  const pitch = parseFloat(String(formData.roofPitch ?? 0)) || 0;
  const pitchFactor = 1 + (pitch * 0.02);
  const adjustedArea = parseFloat(String(area)) > 0 ? (area * pitchFactor).toFixed(1) : '0';

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Dimensions</SectionHeading>
      <NumberInput fieldKey="roofArea"  label="Roof Area"  unit="M²"  value={formData.roofArea}  onChange={onChange} />
      <NumberInput fieldKey="roofPitch" label="Roof Pitch" unit="DEG" value={formData.roofPitch} onChange={onChange} />

      <SectionHeading>Specification</SectionHeading>
      <SelectInput fieldKey="roofType"   label="Roof Type"            options={['Pitched','Flat','Curved']}       value={formData.roofType}   onChange={onChange} />
      <SelectInput fieldKey="material"   label="Material"             options={['Tile','Slate','Metal','Asphalt']} value={formData.material}   onChange={onChange} />
      <SelectInput fieldKey="insulation" label="Insulation Thickness" options={['100mm','150mm','200mm']}          value={formData.insulation} onChange={onChange} />

      <SectionHeading>Details</SectionHeading>
      <SelectInput fieldKey="guttering"  label="Guttering"            options={['Plastic','Aluminium','Cast Iron']} value={formData.guttering}  onChange={onChange} />
      <SelectInput fieldKey="underlayType" label="Underlay Type"      options={['Standard','Breathable','Premium']} value={formData.underlayType} onChange={onChange} />

      {parseFloat(String(adjustedArea)) > 0 && (
        <StatStrip stats={[
          { label: 'Adjusted Area', value: adjustedArea, unit: 'M²' },
        ]} />
      )}
    </div>
  );
}

// ── Door ───────────────────────────────────────────────────────────────────

function DoorForm({ formData, onChange }: PresetFormComponentProps) {
  const qty = parseInt(String(formData.quantity ?? 1));
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Quantity</SectionHeading>
      <div className="col-span-2 flex items-center gap-3">
        <button type="button" onClick={() => onChange('quantity', Math.max(1, qty - 1))}
          className="w-8 h-8 border border-[#2a2a2a] text-zinc-400 hover:border-zinc-500 hover:text-white transition-colors text-lg">−</button>
        <span className="text-[28px] font-black text-amber-500 w-12 text-center leading-none">{qty}</span>
        <button type="button" onClick={() => onChange('quantity', qty + 1)}
          className="w-8 h-8 border border-[#2a2a2a] text-zinc-400 hover:border-zinc-500 hover:text-white transition-colors text-lg">+</button>
        <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">doors</span>
      </div>

      <SectionHeading>Dimensions</SectionHeading>
      <SelectInput fieldKey="width"  label="Width"  options={['750mm','800mm','900mm','1000mm']} value={formData.width}  onChange={onChange} />
      <SelectInput fieldKey="height" label="Height" options={['2000mm','2100mm','2400mm']}       value={formData.height} onChange={onChange} />

      <SectionHeading>Specification</SectionHeading>
      <SelectInput fieldKey="doorType"  label="Door Type"  options={['Swing','Sliding','Folding','Bi-fold']} value={formData.doorType}  onChange={onChange} />
      <SelectInput fieldKey="material"  label="Material"   options={['Wood','Steel','Aluminium','Glass']}    value={formData.material}  onChange={onChange} />
      <SelectInput fieldKey="frameType" label="Frame Type" options={['Timber','Steel','Aluminium']}          value={formData.frameType} onChange={onChange} />
      
      <SectionHeading>Safety</SectionHeading>
      <SelectInput fieldKey="fireRating" label="Fire Rating" options={['None','30 mins','60 mins','90 mins','120 mins']} value={formData.fireRating} onChange={onChange} />
      <SelectInput fieldKey="acoustic" label="Acoustic Rating" options={['Standard','30dB','40dB','50dB']} value={formData.acoustic} onChange={onChange} />
    </div>
  );
}

// ── Window ─────────────────────────────────────────────────────────────────

function WindowForm({ formData, onChange }: PresetFormComponentProps) {
  const qty       = parseInt(String(formData.quantity ?? 1));
  const w         = parseFloat(String(formData.width ?? 0));
  const h         = parseFloat(String(formData.height ?? 0));
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
        <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">windows</span>
      </div>

      <SectionHeading>Dimensions (per unit)</SectionHeading>
      <NumberInput fieldKey="width"  label="Width"  unit="MM" value={formData.width}  onChange={onChange} />
      <NumberInput fieldKey="height" label="Height" unit="MM" value={formData.height} onChange={onChange} />

      <SectionHeading>Glazing & Frame</SectionHeading>
      <SelectInput fieldKey="windowType" label="Window Type"  options={['Casement','Sash','Slider','Fixed']}   value={formData.windowType} onChange={onChange} />
      <SelectInput fieldKey="glazing"    label="Glazing Type" options={['Single','Double','Triple']}            value={formData.glazing}    onChange={onChange} />
      <SelectInput fieldKey="frameType"  label="Frame Type"   options={['Timber','UPVC','Aluminium','Steel']}   value={formData.frameType}  onChange={onChange} />

      {glassArea > 0 && (
        <StatStrip stats={[{ label: 'Total Glass Area', value: glassArea, unit: 'M²' }]} />
      )}
    </div>
  );
}

// ── Ceiling ────────────────────────────────────────────────────────────────

function CeilingForm({ formData, onChange }: PresetFormComponentProps) {
  const area = parseFloat(String(formData.area ?? 0)) || 0;
  const panelArea = 0.6 * 0.6; // Standard 600x600
  const panelCount = parseFloat(String(area)) > 0 ? Math.ceil(area / panelArea) : 0;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Area</SectionHeading>
      <NumberInput fieldKey="area"   label="Area"              unit="M²" value={formData.area}   onChange={onChange} />
      <NumberInput fieldKey="height" label="Height from Floor" unit="M"  value={formData.height} onChange={onChange} />

      <SectionHeading>System</SectionHeading>
      <SelectInput fieldKey="ceilingType" label="Ceiling Type" options={['Suspended','Direct Fix','Plasterboard','Acoustic']} value={formData.ceilingType} onChange={onChange} />
      <SelectInput fieldKey="gridType"    label="Grid Type"    options={['T-bar','Clips','Adhesive']}                         value={formData.gridType}    onChange={onChange} />
      <SelectInput fieldKey="fireRating"  label="Fire Rating"  options={['None','30min','60min','90min']}                     value={formData.fireRating}  onChange={onChange} />

      <SectionHeading>Panels</SectionHeading>
      <SelectInput fieldKey="panelType"   label="Panel Type"   options={['Acoustic','Mineral','Gypsum','Metal']}              value={formData.panelType}  onChange={onChange} />
      <SelectInput fieldKey="panelSize"   label="Panel Size"   options={['600x600','600x1200','1200x1200']}                   value={formData.panelSize}  onChange={onChange} />

      {panelCount > 0 && (
        <StatStrip stats={[
          { label: 'Est. Panels', value: panelCount, unit: 'pcs' },
        ]} />
      )}
    </div>
  );
}

// ── Staircase ──────────────────────────────────────────────────────────────

function StaircaseForm({ formData, onChange }: PresetFormComponentProps) {
  const steps = parseInt(String(formData.stepCount ?? 0));
  const riser = steps > 0 && formData.flightRise
    ? +((parseFloat(String(formData.flightRise)) / steps) * 1000).toFixed(0)
    : null;
  const tread = parseFloat(String(formData.treadWidth ?? 250)) || 250;
  const totalRun = steps > 0 ? ((steps - 1) * tread / 1000).toFixed(2) : 0;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Quantity & Size</SectionHeading>
      <NumberInput fieldKey="quantity"   label="Quantity"           value={formData.quantity}   onChange={onChange} />
      <NumberInput fieldKey="flightRise" label="Flight Rise" unit="M" value={formData.flightRise} onChange={onChange} />
      <NumberInput fieldKey="stepCount"  label="No. of Steps"       value={formData.stepCount}  onChange={onChange} />
      {riser && (
        <div className="flex flex-col justify-end">
          <FieldLabel>Riser Height (calc)</FieldLabel>
          <p className="text-[20px] font-black text-amber-500 leading-none">{riser}<span className="text-xs font-mono text-zinc-500 ml-1">MM</span></p>
        </div>
      )}

      <SectionHeading>Dimensions</SectionHeading>
      <NumberInput fieldKey="treadWidth"  label="Tread Width" unit="MM" value={formData.treadWidth}  onChange={onChange} />
      <NumberInput fieldKey="stairWidth"  label="Stair Width" unit="MM" value={formData.stairWidth}  onChange={onChange} />

      <SectionHeading>Specification</SectionHeading>
      <SelectInput fieldKey="stringType" label="String Type"  options={['Open','Closed']}                         value={formData.stringType} onChange={onChange} />
      <SelectInput fieldKey="material"   label="Material"     options={['Timber','Concrete','Steel','Composite']}  value={formData.material}   onChange={onChange} />
      <SelectInput fieldKey="railing"    label="Railing Type" options={['Timber','Metal','Glass','None']}          value={formData.railing}    onChange={onChange} />

      {parseFloat(String(totalRun)) > 0 && (
        <StatStrip stats={[
          { label: 'Total Run', value: totalRun, unit: 'M' },
        ]} />
      )}
    </div>
  );
}

// ── Beam ───────────────────────────────────────────────────────────────────

function BeamForm({ formData, onChange }: PresetFormComponentProps) {
  const qty    = parseInt(String(formData.quantity ?? 1));
  const length = parseFloat(String(formData.length ?? 0));
  const total  = qty > 0 && length > 0 ? +(qty * length).toFixed(1) : 0;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Quantity & Length</SectionHeading>
      <NumberInput fieldKey="quantity" label="Quantity"         value={formData.quantity} onChange={onChange} />
      <NumberInput fieldKey="length"   label="Length"  unit="M" value={formData.length}   onChange={onChange} />
      {total > 0 && (
        <div className="col-span-2 text-[11px] font-mono text-zinc-500">
          Total run: <span className="text-amber-500 font-black">{total} LM</span>
        </div>
      )}

      <SectionHeading>Section</SectionHeading>
      <SelectInput fieldKey="beamType" label="Beam Type" options={['I-Beam','H-Beam','Channel','Box']}  value={formData.beamType} onChange={onChange} />
      <SelectInput fieldKey="material" label="Material"  options={['Steel','Concrete','Timber']}        value={formData.material} onChange={onChange} />
      <SelectInput fieldKey="sectionSize" label="Section Size" options={['100×50×5','150×75×7','200×100×8','250×125×10','305×165×40 UB','406×178×54 UB']} value={formData.sectionSize} onChange={onChange} />

      <SectionHeading>Protection</SectionHeading>
      <SelectInput fieldKey="fireProtection" label="Fire Protection" options={['None','Paint','Boarding','Intumescent']} value={formData.fireProtection} onChange={onChange} />
    </div>
  );
}

// ── Column ─────────────────────────────────────────────────────────────────

function ColumnForm({ formData, onChange }: PresetFormComponentProps) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Quantity & Height</SectionHeading>
      <NumberInput fieldKey="quantity" label="Quantity"         value={formData.quantity} onChange={onChange} />
      <NumberInput fieldKey="height"   label="Height"  unit="M" value={formData.height}   onChange={onChange} />

      <SectionHeading>Section</SectionHeading>
      <SelectInput fieldKey="columnType" label="Column Type" options={['Circular','Square','Rectangular','I-Section']} value={formData.columnType} onChange={onChange} />
      <SelectInput fieldKey="material"   label="Material"    options={['Steel','Concrete','Timber']}                   value={formData.material}   onChange={onChange} />
      <SelectInput fieldKey="sectionSize" label="Section Size" options={['100mm','150mm','200mm','250mm','300×300','400×400','PFC 100','PFC 150']} value={formData.sectionSize} onChange={onChange} />

      <SectionHeading>Foundations</SectionHeading>
      <SelectInput fieldKey="foundations" label="Foundation Type" options={['Pile','Pad','Strip','Raft']} value={formData.foundations} onChange={onChange} />
    </div>
  );
}

// ── Tiling ─────────────────────────────────────────────────────────────────

function TilingForm({ formData, onChange }: PresetFormComponentProps) {
  const area        = parseFloat(String(formData.area ?? 0));
  const tileSizeStr = typeof formData.tileSize === 'string' ? formData.tileSize : '';
  const [tw, th]    = tileSizeStr.split('x').map((n: string) => parseInt(n) / 1000);
  const tileCount   = tw && th && area > 0 ? Math.ceil((area * 1.1) / (tw * th)) : null;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Area</SectionHeading>
      <NumberInput fieldKey="area"           label="Area"     unit="M²" value={formData.area}           onChange={onChange} />
      <SelectInput fieldKey="tilingLocation" label="Location" options={['Wall','Floor','Both']}          value={formData.tilingLocation} onChange={onChange} />

      <SectionHeading>Tile Spec</SectionHeading>
      <SelectInput fieldKey="tileSize"   label="Tile Size"   options={['200x200','300x300','400x400','600x600']}     value={formData.tileSize}   onChange={onChange} />
      <SelectInput fieldKey="material"   label="Material"    options={['Ceramic','Porcelain','Glass','Natural Stone']} value={formData.material}   onChange={onChange} />
      <SelectInput fieldKey="groutType"  label="Grout Type"  options={['Cement','Epoxy','Urethane']}                 value={formData.groutType}  onChange={onChange} />
      <SelectInput fieldKey="jointWidth" label="Joint Width" options={['3mm','4mm','5mm','6mm']}                     value={formData.jointWidth} onChange={onChange} />

      {tileCount && (
        <div className="col-span-2 mt-2 border border-[#1e1e1e] p-3 bg-[#0d0d0d]">
          <p className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">Est. tile count (incl. 10% wastage)</p>
          <p className="text-[28px] font-black text-amber-500 leading-none mt-1">{tileCount} <span className="text-sm font-mono text-zinc-500">tiles</span></p>
        </div>
      )}
    </div>
  );
}

// ── Plumbing ───────────────────────────────────────────────────────────────

function PlumbingForm({ formData, onChange }: PresetFormComponentProps) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3">
      <SectionHeading>Pipe Run</SectionHeading>
      <NumberInput fieldKey="pipeLength"   label="Pipe Length" unit="M" value={formData.pipeLength}   onChange={onChange} />
      <SelectInput fieldKey="pipeDiameter" label="Diameter"    options={['15mm','20mm','25mm','32mm','50mm']} value={formData.pipeDiameter} onChange={onChange} />

      <SectionHeading>System</SectionHeading>
      <SelectInput fieldKey="pipeType"   label="Pipe Type"   options={['Copper','PVC','HDPE','Steel']}               value={formData.pipeType}   onChange={onChange} />
      <SelectInput fieldKey="systemType" label="System Type" options={['Cold Water','Hot Water','Waste','Vent']}      value={formData.systemType} onChange={onChange} />

      <SectionHeading>Fittings</SectionHeading>
      <SelectInput fieldKey="fittings" label="Fittings Type"   options={['Compression','Push-Fit','Soldered','Threaded']} value={formData.fittings} onChange={onChange} />
      <NumberInput fieldKey="quantity" label="Number of Joints" value={formData.quantity} onChange={onChange} />
    </div>
  );
}

// ─── PRESET_FORM_MAP ───────────────────────────────────────────────────────────
// withViz() wraps each form so the 3D visualizer appears beside the fields.
// The PresetDrawer renders FormComponent directly — no changes needed there.

export const PRESET_FORM_MAP: Record<string, React.ComponentType<PresetFormComponentProps>> = {
  'carcass':    withViz(CarcassForm),
  'stud-wall':  withViz(StudWallForm),
  'floor-slab': withViz(FloorSlabForm),
  'roof':       withViz(RoofForm),
  'door':       withViz(DoorForm),
  'window':     withViz(WindowForm),
  'ceiling':    withViz(CeilingForm),
  'staircase':  withViz(StaircaseForm),
  'beam':       withViz(BeamForm),
  'column':     withViz(ColumnForm),
  'tiling':     withViz(TilingForm),
  'plumbing':   withViz(PlumbingForm),
};

// ─── ELEMENT_PRESETS ──────────────────────────────────────────────────────────

export const ELEMENT_PRESETS: PresetTemplate[] = [
  { id: 'carcass',    name: 'Carcass',    category: 'Structure', measurementType: 'area',   description: 'Cabinet / joinery carcass with panel takeoff',  fields: [] },
  { id: 'stud-wall',  name: 'Stud Wall',  category: 'Walls',     measurementType: 'linear', description: 'Interior stud wall framing',                     fields: [] },
  { id: 'floor-slab', name: 'Floor Slab', category: 'Structure', measurementType: 'area',   description: 'Concrete floor slabs and platforms',             fields: [] },
  { id: 'roof',       name: 'Roof',       category: 'Envelope',  measurementType: 'area',   description: 'Roof structures and coverings',                  fields: [] },
  { id: 'door',       name: 'Door',       category: 'Openings',  measurementType: 'count',  description: 'Door frames and installations',                  fields: [] },
  { id: 'window',     name: 'Window',     category: 'Openings',  measurementType: 'count',  description: 'Window frames and glazing',                      fields: [] },
  { id: 'ceiling',    name: 'Ceiling',    category: 'Interior',  measurementType: 'area',   description: 'Ceiling systems and finishes',                   fields: [] },
  { id: 'staircase',  name: 'Staircase',  category: 'Structure', measurementType: 'count',  description: 'Stair construction and railings',                fields: [] },
  { id: 'beam',       name: 'Beam',       category: 'Structure', measurementType: 'linear', description: 'Structural beams and supports',                  fields: [] },
  { id: 'column',     name: 'Column',     category: 'Structure', measurementType: 'count',  description: 'Structural columns and supports',                fields: [] },
  { id: 'tiling',     name: 'Tiling',     category: 'Finishes',  measurementType: 'area',   description: 'Wall and floor tiling installation',             fields: [] },
  { id: 'plumbing',   name: 'Plumbing',   category: 'Services',  measurementType: 'linear', description: 'Water supply and drainage systems',              fields: [] },
];

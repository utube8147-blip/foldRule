'use client';

import React, { ReactNode, useState, useMemo } from 'react';
import {
  Download,
  HardHat,
  Settings,
  Bell,
  Plus,
  LayoutTemplate,
  Layers,
  Boxes,
  Wrench,
  HelpCircle,
  X,
} from 'lucide-react';

/* ─────────────────────────────────────────
   TYPES
───────────────────────────────────────── */
export interface PresetTemplate {
  id: string;
  name: string;
  category: string;
  icon: string;
  fields: PresetField[];
  description: string;
}

export interface PresetField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'textarea' | 'checkbox';
  required: boolean;
  placeholder?: string;
  options?: string[];
  defaultValue?: string | number | boolean;
  unit?: string;
  group?: 'dimensions' | 'spacing' | 'options' | 'leaves' | 'other';
}

interface PresetFormProps {
  template: PresetTemplate;
  onSubmit: (data: Record<string, any>) => void;
  onClose: () => void;
}

/* ─────────────────────────────────────────
   PRESETS DATA
───────────────────────────────────────── */
export const ELEMENT_PRESETS: PresetTemplate[] = [
  {
    id: 'carcass',
    name: 'Carcass',
    category: 'Structure',
    icon: '🏗️',
    description: 'Building structural carcass and framework',
    fields: [
      { name: 'length',   label: 'Length (L)', type: 'number',   required: true,  placeholder: '0', unit: 'M', group: 'dimensions' },
      { name: 'width',    label: 'Width (W)',  type: 'number',   required: true,  placeholder: '0', unit: 'M', group: 'dimensions' },
      { name: 'height',   label: 'Height (H)', type: 'number',   required: true,  placeholder: '0', unit: 'M', group: 'dimensions' },
      { name: 'material', label: 'Material',   type: 'select',   required: true,  options: ['Concrete','Steel','Mixed'], group: 'options' },
      { name: 'notes',    label: 'Notes',      type: 'textarea', required: false, group: 'other' },
    ],
  },
  {
    id: 'stud-wall',
    name: 'Stud Wall',
    category: 'Walls',
    icon: '🧱',
    description: 'Interior stud wall framing',
    fields: [
      { name: 'length',           label: 'Length (L)',                                type: 'number',   required: true,  placeholder: '12500', unit: 'MM', group: 'dimensions' },
      { name: 'height',           label: 'Height (H)',                                type: 'number',   required: true,  placeholder: '2700',  unit: 'MM', group: 'dimensions' },
      { name: 'spacing',          label: 'Stud Spacing',                              type: 'select',   required: true,  options: ['450mm','600mm','Custom'], group: 'spacing' },
      { name: 'nogginRows',       label: 'Noggin Rows',                               type: 'select',   required: true,  options: ['1 Row','2 Rows','3 Rows'], group: 'options', defaultValue: '2 Rows' },
      { name: 'thickness',        label: 'Material Thickness',                        type: 'select',   required: true,  options: ['45mm','70mm','90mm'], group: 'options', defaultValue: '70mm' },
      { name: 'facePlasterboard', label: 'Plasterboard (Face) - 12.5mm FireShield',  type: 'checkbox', required: false, group: 'leaves', defaultValue: true },
      { name: 'backPlasterboard', label: 'Plasterboard (Back) - 12.5mm SoundShield', type: 'checkbox', required: false, group: 'leaves', defaultValue: true },
      { name: 'insulation',       label: 'Acoustic Insulation - 50mm Rockwool',      type: 'checkbox', required: false, group: 'leaves', defaultValue: true },
    ],
  },
  {
    id: 'floor-slab',
    name: 'Floor Slab',
    category: 'Structure',
    icon: '📐',
    description: 'Concrete floor slabs and platforms',
    fields: [
      { name: 'length',        label: 'Length (L)',         type: 'number', required: true, placeholder: '0', unit: 'M', group: 'dimensions' },
      { name: 'width',         label: 'Width (W)',          type: 'number', required: true, placeholder: '0', unit: 'M', group: 'dimensions' },
      { name: 'thickness',     label: 'Thickness',          type: 'select', required: true, options: ['100mm','150mm','200mm','250mm'], group: 'options' },
      { name: 'reinforcement', label: 'Reinforcement Type', type: 'select', required: true, options: ['Mesh','Bars','Fibre'], group: 'options' },
      { name: 'finishType',    label: 'Finish Type',        type: 'select', required: true, options: ['Smooth','Rough','Polished'], group: 'options' },
    ],
  },
  {
    id: 'roof',
    name: 'Roof',
    category: 'Envelope',
    icon: '🏘️',
    description: 'Roof structures and coverings',
    fields: [
      { name: 'roofArea',   label: 'Roof Area',           type: 'number', required: true,  placeholder: '0', unit: 'M²',  group: 'dimensions' },
      { name: 'roofPitch',  label: 'Roof Pitch',          type: 'number', required: false, placeholder: '0', unit: 'DEG', group: 'dimensions' },
      { name: 'roofType',   label: 'Roof Type',           type: 'select', required: true,  options: ['Pitched','Flat','Curved'], group: 'options' },
      { name: 'material',   label: 'Material',            type: 'select', required: true,  options: ['Tile','Slate','Metal','Asphalt'], group: 'options' },
      { name: 'insulation', label: 'Insulation Thickness',type: 'select', required: false, options: ['100mm','150mm','200mm'], group: 'options' },
    ],
  },
  {
    id: 'door',
    name: 'Door',
    category: 'Openings',
    icon: '🚪',
    description: 'Door frames and installations',
    fields: [
      { name: 'quantity',  label: 'Quantity',   type: 'number', required: true, placeholder: '1', group: 'dimensions' },
      { name: 'width',     label: 'Width',      type: 'select', required: true, options: ['750mm','800mm','900mm','1000mm'], group: 'dimensions' },
      { name: 'height',    label: 'Height',     type: 'select', required: true, options: ['2000mm','2100mm','2400mm'], group: 'dimensions' },
      { name: 'doorType',  label: 'Door Type',  type: 'select', required: true, options: ['Swing','Sliding','Folding','Bi-fold'], group: 'options' },
      { name: 'material',  label: 'Material',   type: 'select', required: true, options: ['Wood','Steel','Aluminium','Glass'], group: 'options' },
      { name: 'frameType', label: 'Frame Type', type: 'select', required: true, options: ['Timber','Steel','Aluminium'], group: 'options' },
    ],
  },
  {
    id: 'window',
    name: 'Window',
    category: 'Openings',
    icon: '🪟',
    description: 'Window frames and glazing',
    fields: [
      { name: 'quantity',   label: 'Quantity',     type: 'number', required: true, placeholder: '1', group: 'dimensions' },
      { name: 'width',      label: 'Width',        type: 'number', required: true, placeholder: '0', unit: 'MM', group: 'dimensions' },
      { name: 'height',     label: 'Height',       type: 'number', required: true, placeholder: '0', unit: 'MM', group: 'dimensions' },
      { name: 'windowType', label: 'Window Type',  type: 'select', required: true, options: ['Casement','Sash','Slider','Fixed'], group: 'options' },
      { name: 'glazing',    label: 'Glazing Type', type: 'select', required: true, options: ['Single','Double','Triple'], group: 'options' },
      { name: 'frameType',  label: 'Frame Type',   type: 'select', required: true, options: ['Timber','UPVC','Aluminium','Steel'], group: 'options' },
    ],
  },
  {
    id: 'ceiling',
    name: 'Ceiling',
    category: 'Interior',
    icon: '🎪',
    description: 'Ceiling systems and finishes',
    fields: [
      { name: 'area',        label: 'Area',             type: 'number', required: true,  placeholder: '0', unit: 'M²', group: 'dimensions' },
      { name: 'height',      label: 'Height from Floor', type: 'number', required: false, placeholder: '0', unit: 'M',  group: 'dimensions' },
      { name: 'ceilingType', label: 'Ceiling Type',     type: 'select', required: true,  options: ['Suspended','Direct Fix','Plasterboard','Acoustic'], group: 'options' },
      { name: 'gridType',    label: 'Grid Type',        type: 'select', required: false, options: ['T-bar','Clips','Adhesive'], group: 'options' },
      { name: 'fireRating',  label: 'Fire Rating',      type: 'select', required: false, options: ['None','30min','60min','90min'], group: 'options' },
    ],
  },
  {
    id: 'staircase',
    name: 'Staircase',
    category: 'Structure',
    icon: '🪜',
    description: 'Stair construction and railings',
    fields: [
      { name: 'quantity',   label: 'Quantity',        type: 'number', required: true, placeholder: '1', group: 'dimensions' },
      { name: 'flightRise', label: 'Flight Rise',     type: 'number', required: true, placeholder: '0', unit: 'M', group: 'dimensions' },
      { name: 'stepCount',  label: 'Number of Steps', type: 'number', required: true, placeholder: '0', group: 'dimensions' },
      { name: 'stringType', label: 'String Type',     type: 'select', required: true, options: ['Open','Closed'], group: 'options' },
      { name: 'material',   label: 'Material',        type: 'select', required: true, options: ['Timber','Concrete','Steel','Composite'], group: 'options' },
      { name: 'railing',    label: 'Railing Type',    type: 'select', required: false,options: ['Timber','Metal','Glass','None'], group: 'options' },
    ],
  },
  {
    id: 'beam',
    name: 'Beam',
    category: 'Structure',
    icon: '➡️',
    description: 'Structural beams and supports',
    fields: [
      { name: 'quantity',       label: 'Quantity',        type: 'number', required: true,  placeholder: '1', group: 'dimensions' },
      { name: 'length',         label: 'Length',          type: 'number', required: true,  placeholder: '0', unit: 'M', group: 'dimensions' },
      { name: 'beamType',       label: 'Beam Type',       type: 'select', required: true,  options: ['I-Beam','H-Beam','Channel','Box'], group: 'options' },
      { name: 'material',       label: 'Material',        type: 'select', required: true,  options: ['Steel','Concrete','Timber'], group: 'options' },
      { name: 'sectionSize',    label: 'Section Size',    type: 'text',   required: true,  placeholder: 'e.g., 305x165x40', group: 'options' },
      { name: 'fireProtection', label: 'Fire Protection', type: 'select', required: false, options: ['None','Paint','Boarding','Intumescent'], group: 'options' },
    ],
  },
  {
    id: 'column',
    name: 'Column',
    category: 'Structure',
    icon: '📏',
    description: 'Structural columns and supports',
    fields: [
      { name: 'quantity',    label: 'Quantity',        type: 'number', required: true,  placeholder: '1', group: 'dimensions' },
      { name: 'height',      label: 'Height',          type: 'number', required: true,  placeholder: '0', unit: 'M', group: 'dimensions' },
      { name: 'columnType',  label: 'Column Type',     type: 'select', required: true,  options: ['Circular','Square','Rectangular','I-Section'], group: 'options' },
      { name: 'material',    label: 'Material',        type: 'select', required: true,  options: ['Steel','Concrete','Timber'], group: 'options' },
      { name: 'sectionSize', label: 'Section Size',    type: 'text',   required: true,  placeholder: 'e.g., 300x300', group: 'options' },
      { name: 'foundations', label: 'Foundation Type', type: 'select', required: false, options: ['Pile','Pad','Strip','Raft'], group: 'options' },
    ],
  },
  {
    id: 'tiling',
    name: 'Tiling',
    category: 'Finishes',
    icon: '🧩',
    description: 'Wall and floor tiling installation',
    fields: [
      { name: 'area',           label: 'Area',       type: 'number', required: true, placeholder: '0', unit: 'M²', group: 'dimensions' },
      { name: 'tilingLocation', label: 'Location',   type: 'select', required: true, options: ['Wall','Floor','Both'], group: 'options' },
      { name: 'tileSize',       label: 'Tile Size',  type: 'select', required: true, options: ['200x200','300x300','400x400','600x600'], group: 'options' },
      { name: 'material',       label: 'Material',   type: 'select', required: true, options: ['Ceramic','Porcelain','Glass','Natural Stone'], group: 'options' },
      { name: 'groutType',      label: 'Grout Type', type: 'select', required: true, options: ['Cement','Epoxy','Urethane'], group: 'options' },
      { name: 'jointWidth',     label: 'Joint Width',type: 'select', required: false,options: ['3mm','4mm','5mm','6mm'], group: 'options' },
    ],
  },
  {
    id: 'plumbing',
    name: 'Plumbing',
    category: 'Services',
    icon: '🔧',
    description: 'Water supply and drainage systems',
    fields: [
      { name: 'pipeLength',   label: 'Pipe Length',           type: 'number', required: true,  placeholder: '0', unit: 'M', group: 'dimensions' },
      { name: 'pipeDiameter', label: 'Diameter',              type: 'select', required: true,  options: ['15mm','20mm','25mm','32mm','50mm'], group: 'dimensions' },
      { name: 'pipeType',     label: 'Pipe Type',             type: 'select', required: true,  options: ['Copper','PVC','HDPE','Steel'], group: 'options' },
      { name: 'systemType',   label: 'System Type',           type: 'select', required: true,  options: ['Cold Water','Hot Water','Waste','Vent'], group: 'options' },
      { name: 'fittings',     label: 'Fittings Type',         type: 'select', required: false, options: ['Compression','Push-Fit','Soldered','Threaded'], group: 'options' },
      { name: 'quantity',     label: 'Quantity of Fittings',  type: 'number', required: false, placeholder: '0', group: 'options' },
    ],
  },
];

/* ─────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────── */
const SIDE_NAV = [
  { icon: LayoutTemplate, label: 'Templates'  },
  { icon: Layers,         label: 'Assemblies' },
  { icon: Boxes,          label: 'Materials'  },
  { icon: HardHat,        label: 'Labor'      },
  { icon: Wrench,         label: 'Equipment'  },
];
const TOP_NAV = ['Library', 'Estimates', 'Workflows', 'Analytics'];
const PHASES  = ['Phase 1: Structure', 'Phase 2: Openings', 'Phase 3: Finishes'];

/* ─────────────────────────────────────────
   BLUEPRINT BRACKETS
───────────────────────────────────────── */
function Bracket({ amber = true }: { amber?: boolean }) {
  const c = amber
    ? 'border-amber-500'
    : 'border-zinc-700 group-hover:border-amber-500/40';
  return (
    <>
      <div className={`absolute top-0 left-0 w-2 h-2 border-t border-l transition-colors ${c}`} />
      <div className={`absolute top-0 right-0 w-2 h-2 border-t border-r transition-colors ${c}`} />
      <div className={`absolute bottom-0 left-0 w-2 h-2 border-b border-l transition-colors ${c}`} />
      <div className={`absolute bottom-0 right-0 w-2 h-2 border-b border-r transition-colors ${c}`} />
    </>
  );
}

/* ─────────────────────────────────────────
   PANEL HEADING
───────────────────────────────────────── */
function PanelHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-white mb-6">
      <span className="w-2 h-2 bg-amber-500 shrink-0" />
      {children}
    </h2>
  );
}

/* ─────────────────────────────────────────
   FIELD LABEL
───────────────────────────────────────── */
function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-600 mb-1">
      {children}
    </p>
  );
}

/* ─────────────────────────────────────────
   TECHNICAL DIAGRAM
───────────────────────────────────────── */
function TechnicalDiagram({ template }: { template: PresetTemplate }) {
  const cat = template.category.toUpperCase();

  if (cat === 'WALLS') {
    return (
      <div className="w-44 h-72 border-x-2 border-zinc-700 relative flex justify-center items-center">
        <div className="absolute inset-y-0 left-4 w-3 bg-zinc-800/50 border-x border-zinc-600" />
        <div className="absolute inset-y-0 right-4 w-3 bg-zinc-800/50 border-x border-zinc-600" />
        <div className="absolute top-1/4 left-0 right-0 h-3 border-y border-zinc-600 bg-zinc-800/30" />
        <div className="absolute top-2/4 left-0 right-0 h-3 border-y border-zinc-600 bg-zinc-800/30" />
        <div className="absolute top-3/4 left-0 right-0 h-3 border-y border-zinc-600 bg-zinc-800/30" />
        <div className="absolute -left-10 top-1/2 -translate-y-1/2 -rotate-90 text-[9px] font-mono text-zinc-600 uppercase tracking-tight whitespace-nowrap">
          Vertical Stud (Typical)
        </div>
        <div className="absolute -right-14 top-1/2 -translate-y-1/2 rotate-90 text-[9px] font-mono text-amber-500 uppercase tracking-tight whitespace-nowrap">
          Noggin Row Level
        </div>
      </div>
    );
  }

  if (cat === 'STRUCTURE') {
    return (
      <svg viewBox="0 0 200 280" className="w-full h-full max-h-64" xmlns="http://www.w3.org/2000/svg">
        <rect x="20" y="20" width="20" height="240" fill="#292524" stroke="#52525b" strokeWidth="1.5" />
        <rect x="160" y="20" width="20" height="240" fill="#292524" stroke="#52525b" strokeWidth="1.5" />
        <rect x="20" y="20" width="160" height="14" fill="#3f3f46" stroke="#52525b" strokeWidth="1" />
        <rect x="20" y="246" width="160" height="14" fill="#3f3f46" stroke="#52525b" strokeWidth="1" />
        {[90, 160].map(y => (
          <rect key={y} x="40" y={y} width="120" height="8" fill="#1c1917" stroke="#52525b" strokeWidth="1" strokeDasharray="4,2" />
        ))}
        <text x="8" y="140" fill="#f59e0b" fontSize="7" fontFamily="monospace" transform="rotate(-90,8,140)">STRUCTURAL FRAME</text>
      </svg>
    );
  }

  if (cat === 'ENVELOPE') {
    return (
      <svg viewBox="0 0 200 260" className="w-full h-full max-h-64" xmlns="http://www.w3.org/2000/svg">
        <polygon points="100,20 180,140 20,140" fill="none" stroke="#52525b" strokeWidth="1.5" />
        {[40, 60, 80, 120, 140, 160].map(x => (
          <line key={x} x1="100" y1="20" x2={x} y2="140" stroke="#3f3f46" strokeWidth="1" strokeDasharray="3,2" />
        ))}
        <polygon points="100,30 172,138 28,138" fill="#1c1917" stroke="none" opacity="0.6" />
        <line x1="100" y1="10" x2="100" y2="20" stroke="#f59e0b" strokeWidth="1.5" />
        <path d="M 100 140 A 30 30 0 0 0 130 115" fill="none" stroke="#f59e0b" strokeWidth="0.8" />
        <text x="118" y="130" fill="#f59e0b" fontSize="7" fontFamily="monospace">θ</text>
        <line x1="20" y1="140" x2="180" y2="140" stroke="#52525b" strokeWidth="2" />
        <text x="65" y="160" fill="#71717a" fontSize="7" fontFamily="monospace">SPAN: L</text>
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 200 240" className="w-full h-full max-h-64" xmlns="http://www.w3.org/2000/svg">
      <rect x="20" y="20" width="160" height="200" fill="none" stroke="#52525b" strokeWidth="1.5" />
      {[60, 100, 140].map(x => (
        <line key={x} x1={x} y1="20" x2={x} y2="220" stroke="#3f3f46" strokeWidth="0.8" strokeDasharray="4,4" />
      ))}
      {[70, 120, 170].map(y => (
        <line key={y} x1="20" y1={y} x2="180" y2={y} stroke="#3f3f46" strokeWidth="0.8" strokeDasharray="4,4" />
      ))}
      <text x="55" y="125" fill="#f59e0b" fontSize="9" fontFamily="monospace" fontWeight="bold">
        {template.name.slice(0, 6).toUpperCase()}
      </text>
      <text x="40" y="238" fill="#52525b" fontSize="6" fontFamily="monospace">SCALE: 1:20 @ A3</text>
      <text x="130" y="238" fill="#52525b" fontSize="6" fontFamily="monospace">DWG-001</text>
    </svg>
  );
}

/* ─────────────────────────────────────────
   COMPUTED CALCS
───────────────────────────────────────── */
function useComputedCalcs(template: PresetTemplate, data: Record<string, any>) {
  return useMemo(() => {
    const L = parseFloat(data.length ?? data.pipeLength ?? data.roofArea ?? data.area ?? data.flightRise ?? 0);
    const H = parseFloat(data.height ?? data.width ?? data.roofPitch ?? 0);
    const spacingMm    = data.spacing === '600mm' ? 600 : 450;
    const studCount    = L > 0 ? Math.ceil((L / spacingMm) * 1000) + 1 : 0;
    const timberLength = L > 0 && H > 0 ? parseFloat(((studCount * H / 1000) + (L / 1000) * 3).toFixed(1)) : 0;
    const plasterArea  = L > 0 && H > 0 ? parseFloat(((L / 1000) * (H / 1000) * 2 * 1.05).toFixed(1)) : 0;
    const subtotal     = (studCount * 4.5 + timberLength * 8.2 + plasterArea * 14.3).toFixed(2);
    return {
      studCount, timberLength, plasterArea, subtotal,
      studPct:    Math.min(studCount / 30, 1),
      timberPct:  Math.min(timberLength / 120, 1),
      plasterPct: Math.min(plasterArea / 80, 1),
    };
  }, [data, template]);
}

/* ─────────────────────────────────────────
   PROGRESS BAR
───────────────────────────────────────── */
function ProgressBar({ pct }: { pct: number }) {
  const filled = Math.round(pct * 6);
  return (
    <div className="flex gap-1 mt-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className={`h-1 flex-1 ${i < filled ? 'bg-amber-500' : 'bg-zinc-800'}`} />
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────
   CHECKBOX ICON
───────────────────────────────────────── */
function CheckboxIcon({ checked }: { checked: boolean }) {
  return checked ? (
    <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0 text-amber-500" fill="currentColor">
      <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0 text-zinc-600" fill="currentColor">
      <path d="M19 5v14H5V5h14m0-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" />
    </svg>
  );
}

/* ─────────────────────────────────────────
   MAIN FORM COMPONENT
   FIX: Converted from fixed inset-0 fullscreen takeover
        to a right-edge slide-over with dim backdrop.
        The blueprint canvas stays visible behind it.
───────────────────────────────────────── */
export function PresetForm({ template, onSubmit, onClose }: PresetFormProps) {
  const [formData,    setFormData]    = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {};
    template.fields.forEach(f => { if (f.defaultValue !== undefined) init[f.name] = f.defaultValue; });
    return init;
  });
  const [activeNav,   setActiveNav]   = useState('Templates');
  const [activePhase, setActivePhase] = useState('Phase 2: Openings');

  const calcs = useComputedCalcs(template, formData);

  const handleChange = (name: string, value: any) =>
    setFormData(prev => ({ ...prev, [name]: value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  const dimensionFields = template.fields.filter(f => f.group === 'dimensions');
  const spacingFields   = template.fields.filter(f => f.group === 'spacing');
  const optionFields    = template.fields.filter(f => f.group === 'options');
  const leafFields      = template.fields.filter(f => f.group === 'leaves');
  const otherFields     = template.fields.filter(f => !f.group || f.group === 'other');

  const leafQtyMap: Record<string, string> = {
    facePlasterboard: 'QTY: 13.5 SHEETS',
    backPlasterboard: 'QTY: 13.5 SHEETS',
    insulation:       `QTY: ${calcs.plasterArea || '—'} M²`,
  };

  const inputBase =
    'bg-[#0d0d0d] border border-[#2a2a2a] text-white font-mono text-[13px] focus:outline-none focus:border-amber-500 transition-colors';
  const selectCls =
    `w-full ${inputBase} text-[11px] px-3 py-2 cursor-pointer`;

  return (
    <>
      {/* ── Dim backdrop — click to close, blueprint canvas still visible behind ── */}
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[1px]"
        onClick={onClose}
      />

      {/* ── Slide-over panel from right edge ── */}
      <div className="fixed right-0 top-0 h-screen w-[860px] max-w-[95vw] z-50 flex font-mono text-zinc-300 antialiased overflow-hidden shadow-2xl shadow-black/80 border-l border-[#2a2a2a]">
        <style>{`
          .form-scrollbar::-webkit-scrollbar       { width: 3px; }
          .form-scrollbar::-webkit-scrollbar-track  { background: transparent; }
          .form-scrollbar::-webkit-scrollbar-thumb  { background: #2a2a2a; border-radius: 2px; }
          .form-scrollbar::-webkit-scrollbar-thumb:hover { background: #f59e0b; }
          input[type=number]::-webkit-outer-spin-button,
          input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        `}</style>

        {/* ══ SIDEBAR ══ */}
        <aside className="w-[52px] shrink-0 flex flex-col bg-[#0d0d0d] border-r border-[#1e1e1e] h-full z-40">
          {/* Logo icon only (narrow sidebar) */}
          <div className="h-14 flex items-center justify-center border-b border-[#1e1e1e] shrink-0">
            <HardHat className="w-5 h-5 text-amber-500" />
          </div>
          {/* Icon nav */}
          <nav className="flex-1 flex flex-col items-center pt-2 gap-1">
            {SIDE_NAV.map(({ icon: Icon, label }) => {
              const isActive = activeNav === label;
              return (
                <button
                  key={label}
                  onClick={() => setActiveNav(label)}
                  title={label}
                  className={`w-10 h-10 flex items-center justify-center rounded transition-all ${
                    isActive
                      ? 'text-amber-500 bg-[#1a1a1a]'
                      : 'text-zinc-600 hover:text-zinc-300 hover:bg-[#181818]'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </button>
              );
            })}
          </nav>
          {/* Bottom icons */}
          <div className="border-t border-[#1e1e1e] py-2 flex flex-col items-center gap-1">
            <button className="w-10 h-10 flex items-center justify-center text-zinc-600 hover:text-zinc-300 transition-colors" title="Support">
              <HelpCircle className="w-4 h-4" />
            </button>
            <div className="w-7 h-7 rounded-full bg-zinc-800 border border-[#2a2a2a] flex items-center justify-center text-[10px] font-black text-amber-500">
              N
            </div>
          </div>
        </aside>

        {/* ══ RIGHT COLUMN ══ */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden bg-[#111]">

          {/* ── TOP BAR ── */}
          {/* FIX: active tab stays on "Estimates" only when coming from estimate flow.
                    Passed via activeTopNav prop; defaults to "Library" if opened from Viewer. */}
          <header className="h-14 shrink-0 flex items-center justify-between px-5 bg-[#111] border-b border-[#1e1e1e] z-50">
            <nav className="flex items-center h-full">
              {TOP_NAV.map(link => (
                <button
                  key={link}
                  className={`px-3 h-full text-[11px] font-bold uppercase tracking-widest flex items-center border-b-2 transition-all ${
                    link === 'Estimates'
                      ? 'border-amber-500 text-amber-500'
                      : 'border-transparent text-zinc-600 hover:text-zinc-300'
                  }`}
                >
                  {link}
                </button>
              ))}
            </nav>

            <div className="flex items-center gap-2">
              <div className="hidden md:flex flex-col items-end mr-1">
                <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-amber-500 leading-none mb-0.5">
                  Active Workflow
                </span>
                <span className="text-[12px] font-black uppercase tracking-tight text-white leading-none">
                  Template: {template.name}
                </span>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="border border-[#3a3a3a] text-zinc-500 px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest hover:bg-[#1e1e1e] hover:text-zinc-300 transition-colors"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => onSubmit(formData)}
                className="bg-amber-500 text-black px-4 py-1.5 text-[9px] font-black uppercase tracking-widest hover:bg-amber-400 transition-colors active:scale-95"
              >
                Commit To Estimate
              </button>
              <button className="w-8 h-8 flex items-center justify-center text-zinc-600 hover:text-zinc-300 transition-colors">
                <Settings className="w-4 h-4" />
              </button>
              <button className="w-8 h-8 flex items-center justify-center text-zinc-600 hover:text-zinc-300 transition-colors">
                <Bell className="w-4 h-4" />
              </button>
              {/* FIX: X button always visible and prominent to close the slide-over */}
              <button
                type="button"
                onClick={onClose}
                className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-white hover:bg-[#2a2a2a] transition-colors ml-1 border border-[#2a2a2a]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </header>

          {/* ── 3-COLUMN FORM ── */}
          <form onSubmit={handleSubmit} className="flex flex-1 overflow-hidden gap-px bg-[#0d0d0d]">

            {/* faint blueprint grid */}
            <div
              className="pointer-events-none fixed inset-0 z-0 opacity-[0.025]"
              style={{
                backgroundImage:
                  'linear-gradient(to right,#fff 1px,transparent 1px),linear-gradient(to bottom,#fff 1px,transparent 1px)',
                backgroundSize: '28px 28px',
              }}
            />

            {/* ════ LEFT: Cross-Section Diagram ════ */}
            <section className="w-[27%] bg-[#161616] border-r border-[#1e1e1e] flex flex-col p-5 relative">
              <Bracket />
              <PanelHeading>Cross-Section</PanelHeading>
              <div className="flex-1 bg-[#0d0d0d] border border-[#222] flex items-center justify-center relative overflow-hidden min-h-0">
                <div className="relative z-10 w-full h-full p-4 flex items-center justify-center">
                  <TechnicalDiagram template={template} />
                </div>
              </div>
              <footer className="mt-3 flex justify-between text-[9px] text-zinc-700 font-mono uppercase tracking-widest">
                <span>1:20 @ A3</span>
                <span>DWG-{template.id.slice(0, 6).toUpperCase()}-001</span>
              </footer>
            </section>

            {/* ════ CENTER: Parameters ════ */}
            <section className="flex-1 flex flex-col overflow-hidden bg-[#161616] border-r border-[#1e1e1e]">
              <div className="flex-1 overflow-y-auto form-scrollbar p-5 space-y-4">

                {/* FRAMING PARAMETERS */}
                <div className="border border-[#242424] p-4 relative">
                  <Bracket />
                  <PanelHeading>Framing Parameters</PanelHeading>

                  {dimensionFields.length > 0 && (
                    <div className="grid grid-cols-2 gap-3 mb-5">
                      {dimensionFields.map(field => (
                        <div key={field.name}>
                          <FieldLabel>{field.label}</FieldLabel>
                          {field.type === 'number' ? (
                            <div className={`flex items-center ${inputBase} focus-within:border-amber-500`}>
                              <input
                                type="number"
                                step="any"
                                placeholder={field.placeholder}
                                value={formData[field.name] ?? ''}
                                onChange={e => handleChange(field.name, e.target.value)}
                                className="bg-transparent border-none text-white font-mono text-[13px] w-full focus:outline-none px-3 py-2"
                              />
                              {field.unit && (
                                <span className="text-zinc-600 text-[9px] font-mono pr-3 uppercase shrink-0">
                                  {field.unit}
                                </span>
                              )}
                            </div>
                          ) : field.type === 'select' ? (
                            <select
                              value={formData[field.name] ?? ''}
                              onChange={e => handleChange(field.name, e.target.value)}
                              className={selectCls}
                            >
                              <option value="">Select…</option>
                              {field.options?.map(o => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : (
                            <input
                              type="text"
                              placeholder={field.placeholder}
                              value={formData[field.name] ?? ''}
                              onChange={e => handleChange(field.name, e.target.value)}
                              className={`${inputBase} w-full px-3 py-2`}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {spacingFields.map(field => (
                    <div key={field.name} className="mb-5">
                      <FieldLabel>{field.label}</FieldLabel>
                      <div className="flex gap-2 mt-1">
                        {field.options?.map(opt => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => handleChange(field.name, opt)}
                            className={`flex-1 py-2 border text-[10px] font-bold uppercase tracking-widest font-mono transition-colors ${
                              formData[field.name] === opt
                                ? 'border-amber-500 text-amber-500 bg-amber-500/10'
                                : 'border-[#2a2a2a] text-zinc-600 hover:border-zinc-600 hover:text-zinc-400'
                            }`}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}

                  {optionFields.length > 0 && (
                    <div className="grid grid-cols-2 gap-3">
                      {optionFields.map(field => (
                        <div key={field.name}>
                          <FieldLabel>{field.label}</FieldLabel>
                          {field.type === 'select' ? (
                            <select
                              value={formData[field.name] ?? ''}
                              onChange={e => handleChange(field.name, e.target.value)}
                              className={selectCls}
                            >
                              <option value="">Select…</option>
                              {field.options?.map(o => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : field.type === 'number' ? (
                            <input
                              type="number"
                              step="any"
                              placeholder={field.placeholder}
                              value={formData[field.name] ?? ''}
                              onChange={e => handleChange(field.name, e.target.value)}
                              className={`${inputBase} w-full px-3 py-2 text-[11px]`}
                            />
                          ) : (
                            <input
                              type="text"
                              placeholder={field.placeholder}
                              value={formData[field.name] ?? ''}
                              onChange={e => handleChange(field.name, e.target.value)}
                              className={`${inputBase} w-full px-3 py-2 text-[11px]`}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {otherFields.map(field => (
                    <div key={field.name} className="mt-4">
                      <FieldLabel>{field.label}</FieldLabel>
                      <textarea
                        value={formData[field.name] ?? ''}
                        onChange={e => handleChange(field.name, e.target.value)}
                        rows={2}
                        className={`${inputBase} w-full px-3 py-2 text-[11px] resize-none`}
                      />
                    </div>
                  ))}
                </div>

                {/* FINISHING LEAVES */}
                {leafFields.length > 0 && (
                  <div className="border border-[#242424] p-4 relative">
                    <Bracket />
                    <PanelHeading>Finishing Leaves</PanelHeading>
                    <div className="space-y-0.5">
                      {leafFields.map(field => (
                        <label
                          key={field.name}
                          className="flex items-center justify-between cursor-pointer p-2.5 hover:bg-[#1a1a1a] border border-transparent hover:border-[#2a2a2a] transition-all"
                        >
                          <div
                            className="flex items-center gap-3"
                            onClick={() => handleChange(field.name, !formData[field.name])}
                          >
                            <CheckboxIcon checked={!!formData[field.name]} />
                            <span className="text-[10px] font-mono uppercase tracking-wide text-zinc-400">
                              {field.label}
                            </span>
                          </div>
                          <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-700 shrink-0 ml-4">
                            {leafQtyMap[field.name] ?? ''}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* ════ RIGHT: Material Calcs ════ */}
            <section className="w-[23%] bg-[#161616] flex flex-col p-5 relative overflow-hidden">
              <Bracket />

              {/* Watermark */}
              <div className="absolute -right-4 top-1/2 -translate-y-1/2 rotate-90 text-[28px] font-black text-[#1c1c1c] pointer-events-none select-none leading-none whitespace-nowrap z-0">
                DATA CALCULATION ENGINE
              </div>

              <PanelHeading>Material Calcs</PanelHeading>

              <div className="flex-1 space-y-6 relative z-10">
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-600 mb-1">Total Stud Count</p>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[36px] font-black text-amber-500 leading-none">{calcs.studCount}</span>
                    <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold">Units</span>
                  </div>
                  <ProgressBar pct={calcs.studPct} />
                </div>
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-600 mb-1">Total Timber Length</p>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[36px] font-black text-amber-500 leading-none">
                      {calcs.timberLength || '—'}
                    </span>
                    {calcs.timberLength > 0 && (
                      <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold">LM</span>
                    )}
                  </div>
                  <ProgressBar pct={calcs.timberPct} />
                </div>
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-600 mb-1">Plasterboard Area</p>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[36px] font-black text-amber-500 leading-none">
                      {calcs.plasterArea || '—'}
                    </span>
                    {calcs.plasterArea > 0 && (
                      <span className="text-[9px] text-zinc-600 uppercase tracking-widest font-bold">M²</span>
                    )}
                  </div>
                  {calcs.plasterArea > 0 && (
                    <p className="text-[9px] text-zinc-700 italic mt-1 leading-relaxed">
                      Double-sided + 5% wastage.
                    </p>
                  )}
                  <ProgressBar pct={calcs.plasterPct} />
                </div>
              </div>

              <div className="border-t border-[#242424] pt-4 mt-4 space-y-3 relative z-10">
                <div className="flex justify-between items-center">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-400">Est. Subtotal</span>
                  <span className="text-amber-500 font-black text-sm font-mono">
                    ${Number(calcs.subtotal).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <button
                  type="button"
                  className="w-full bg-[#1a1a1a] border border-[#2a2a2a] hover:bg-[#222] text-zinc-400 py-2.5 text-[9px] font-black uppercase tracking-[0.2em] flex items-center justify-center gap-2 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export BOM (CSV)
                </button>
              </div>
            </section>

          </form>
        </div>
      </div>
    </>
  );
}
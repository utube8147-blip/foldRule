'use client';
// ─── components/Viewer/PerimeterOffsetPanel.tsx ───────────────────────────────

import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react';
import {
  X, ArrowLeftRight, Check, AlertTriangle, MousePointer2,
  Plus, Trash2, ChevronDown, ChevronUp, Layers, Ruler,
  Square, LayoutGrid, Settings2, TriangleAlert, Info,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { TakeoffRow } from '@/types';
import type {
  CommitOffsetParams, CommitOpenPathParams,
  OffsetOutputType, OpenOutputType,
  CommitOffsetResult,
} from '@/hooks/perimeterOffset/usePerimeterOffset';
import type {
  OffsetDirection, JoinStyle, OpenPathDirection, OpenEndStyle,
} from '@/hooks/perimeterOffset/perimeterOffsetGeometry';

// ─── Types ────────────────────────────────────────────────────────────────────

type DirectionChoice = OffsetDirection | 'both';

interface OffsetRing {
  id:            string;
  distance:      string;
  distanceIn:    string;
  useAsymmetric: boolean;
  direction:     DirectionChoice;
  label:         string;
  unit:          'mm' | 'm';
}

interface TradePreset {
  label:     string;
  distanceM: number;
  direction: OffsetDirection;
  rowLabel:  string;
  hint:      string;
}

interface TradeGroup {
  name:    string;
  icon:    React.ReactNode;
  presets: TradePreset[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const QUICK_DISTANCES_M = [0.1, 0.15, 0.2, 0.3, 0.5, 1.0];

const TRADE_GROUPS: TradeGroup[] = [
  {
    name: 'Roofing',
    icon: <Layers className="w-3 h-3" />,
    presets: [
      { label: '150 mm overhang', distanceM: 0.15, direction: 'outward', rowLabel: 'Roof overhang',       hint: 'Drip edge / fascia line' },
      { label: '300 mm gravel',   distanceM: 0.30, direction: 'inward',  rowLabel: 'Gravel border strip', hint: 'Perimeter ballast ring' },
      { label: '500 mm membrane', distanceM: 0.50, direction: 'inward',  rowLabel: 'Membrane overlap',    hint: 'Flat roof perimeter lap' },
      { label: '1 m setback',     distanceM: 1.0,  direction: 'inward',  rowLabel: 'Roof setback zone',   hint: 'Edge protection / walkway' },
    ],
  },
  {
    name: 'Flooring',
    icon: <LayoutGrid className="w-3 h-3" />,
    presets: [
      { label: '75 mm skirting',  distanceM: 0.075, direction: 'inward', rowLabel: 'Skirting deduct',  hint: 'Floor field minus skirting' },
      { label: '150 mm border',   distanceM: 0.15,  direction: 'inward', rowLabel: 'Border tile strip', hint: 'Tile perimeter border ring' },
      { label: '300 mm border',   distanceM: 0.30,  direction: 'inward', rowLabel: 'Wide border tile',  hint: 'Double-row tile border' },
      { label: '600 mm hardwood', distanceM: 0.60,  direction: 'inward', rowLabel: 'Hardwood field',    hint: 'Floating floor setback' },
    ],
  },
  {
    name: 'Concrete',
    icon: <Square className="w-3 h-3" />,
    presets: [
      { label: '100 mm apron',    distanceM: 0.10, direction: 'outward', rowLabel: 'Concrete apron',    hint: 'Slab edge chamfer / apron' },
      { label: '300 mm apron',    distanceM: 0.30, direction: 'outward', rowLabel: 'Perimeter apron',   hint: 'Wide slab surround' },
      { label: '200 mm formwork', distanceM: 0.20, direction: 'outward', rowLabel: 'Formwork strip',    hint: 'Edge form setout' },
      { label: '1 m expansion',   distanceM: 1.0,  direction: 'inward',  rowLabel: 'Expansion joint',  hint: 'Inset joint perimeter' },
    ],
  },
  {
    name: 'Landscaping',
    icon: <Ruler className="w-3 h-3" />,
    presets: [
      { label: '300 mm edging',   distanceM: 0.30, direction: 'inward',  rowLabel: 'Planting border',  hint: 'Garden edge strip' },
      { label: '500 mm mulch',    distanceM: 0.50, direction: 'inward',  rowLabel: 'Mulch border ring', hint: 'Perimeter mulch band' },
      { label: '600 mm path',     distanceM: 0.60, direction: 'outward', rowLabel: 'Perimeter path',    hint: 'Surrounding footpath' },
      { label: '1.2 m setback',   distanceM: 1.2,  direction: 'inward',  rowLabel: 'Turf setback',      hint: 'Lawn field minus border' },
    ],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRing(
  distanceM: number | null = null,
  direction: DirectionChoice = 'outward',
  label = '',
): OffsetRing {
  return {
    id:            crypto.randomUUID(),
    distance:      distanceM != null ? String(distanceM) : '',
    distanceIn:    distanceM != null ? String(distanceM) : '',
    useAsymmetric: false,
    direction,
    label,
    unit:          'm',
  };
}

function toMetres(val: string, unit: 'mm' | 'm'): number {
  const n = parseFloat(val);
  if (isNaN(n)) return NaN;
  return unit === 'mm' ? n / 1000 : n;
}

function fromMetres(m: number, unit: 'mm' | 'm'): string {
  return unit === 'mm' ? String(Math.round(m * 1000)) : String(m);
}

function fmtDistance(m: number): string {
  if (m < 1) return `${Math.round(m * 1000)} mm`;
  return `${m} m`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[8px] text-zinc-500 uppercase tracking-widest mb-1">
      {children}
    </p>
  );
}

function UnitToggle({
  value, onChange,
}: {
  value: 'mm' | 'm';
  onChange: (u: 'mm' | 'm') => void;
}) {
  return (
    <div className="flex border border-zinc-700 h-5">
      {(['mm', 'm'] as const).map(u => (
        <button
          key={u}
          onClick={() => onChange(u)}
          className={cn(
            'px-1.5 text-[8px] font-bold uppercase tracking-widest transition-all',
            value === u
              ? 'bg-amber-400 text-black'
              : 'text-zinc-500 hover:text-zinc-300',
            u === 'm' && 'border-l border-zinc-700',
          )}
        >
          {u}
        </button>
      ))}
    </div>
  );
}

function DirectionToggle({
  value, onChange,
}: {
  value: DirectionChoice;
  onChange: (d: DirectionChoice) => void;
}) {
  return (
    <div className="flex gap-1">
      {([
        { key: 'outward', label: '← Out →' },
        { key: 'inward',  label: '→ In ←'  },
        { key: 'both',    label: '↔ Both'  },
      ] as { key: DirectionChoice; label: string }[]).map(opt => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={cn(
            'flex-1 py-1 text-[9px] font-bold uppercase tracking-widest border transition-all',
            value === opt.key
              ? 'bg-amber-400 text-black border-amber-400'
              : 'bg-transparent border-zinc-700 text-zinc-400 hover:border-zinc-500',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function JoinStyleSelector({
  value, onChange,
}: {
  value: JoinStyle;
  onChange: (j: JoinStyle) => void;
}) {
  return (
    <div className="flex gap-1">
      {([
        { key: 'miter',  label: 'Miter',  hint: 'Sharp corners (default)' },
        { key: 'round',  label: 'Round',  hint: 'Rounded corners' },
        { key: 'square', label: 'Square', hint: 'Chamfered corners' },
      ] as { key: JoinStyle; label: string; hint: string }[]).map(opt => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          title={opt.hint}
          className={cn(
            'flex-1 py-1 text-[8px] font-bold uppercase tracking-widest border transition-all',
            value === opt.key
              ? 'bg-zinc-700 text-zinc-200 border-zinc-600'
              : 'bg-transparent border-zinc-800 text-zinc-500 hover:border-zinc-700',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── DistanceInput ────────────────────────────────────────────────────────────

function DistanceInput({
  value, unit, onChangeValue, onChangeUnit, placeholder, label,
}: {
  value:         string;
  unit:          'mm' | 'm';
  onChangeValue: (v: string) => void;
  onChangeUnit:  (u: 'mm' | 'm') => void;
  placeholder?:  string;
  label?:        string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {label && <span className="text-[8px] text-zinc-500 w-6 flex-shrink-0">{label}</span>}
      <input
        type="number"
        min="0.001"
        step={unit === 'mm' ? '5' : '0.05'}
        value={value}
        onChange={e => onChangeValue(e.target.value)}
        className="w-20 bg-zinc-900 border border-zinc-700 text-zinc-200 text-[11px] font-mono px-2 py-1 focus:outline-none focus:border-amber-400"
        placeholder={placeholder ?? (unit === 'mm' ? '200' : '0.200')}
      />
      <UnitToggle value={unit} onChange={onChangeUnit} />
    </div>
  );
}

// ─── CollapseWarning ──────────────────────────────────────────────────────────

function CollapseWarning({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-1.5 text-[8px] text-amber-400 border border-amber-800/50 bg-amber-900/20 px-2 py-1.5">
      <TriangleAlert className="w-3 h-3 flex-shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  );
}

// ─── InfoNote ─────────────────────────────────────────────────────────────────

function InfoNote({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-1.5 text-[8px] text-sky-400 border border-sky-800/50 bg-sky-900/20 px-2 py-1.5">
      <Info className="w-3 h-3 flex-shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  );
}

// ─── AdvancedSection ──────────────────────────────────────────────────────────

function AdvancedSection({
  show, onToggle, joinStyle, onJoinStyleChange, note, disabled,
}: {
  show:              boolean;
  onToggle:          () => void;
  joinStyle:         JoinStyle;
  onJoinStyleChange: (j: JoinStyle) => void;
  note?:             string;
  disabled?:         boolean;
}) {
  return (
    <div className={cn(disabled && 'opacity-40 pointer-events-none')}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between text-[8px] uppercase tracking-widest text-zinc-600 hover:text-zinc-400 transition-colors"
      >
        <div className="flex items-center gap-1">
          <Settings2 className="w-2.5 h-2.5" />Corner style
        </div>
        {show ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {show && (
        <div className="mt-1.5 space-y-1">
          <JoinStyleSelector value={joinStyle} onChange={onJoinStyleChange} />
          <p className="text-[7px] text-zinc-600 leading-relaxed px-0.5">
            {note ?? 'Miter = sharp corners (default). Round = arcs. Square = chamfer.'}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── RingRow ──────────────────────────────────────────────────────────────────

function RingRow({
  ring, index, total, onChange, onRemove, showCumulative, runningTotal,
}: {
  ring:            OffsetRing;
  index:           number;
  total:           number;
  onChange:        (id: string, patch: Partial<OffsetRing>) => void;
  onRemove:        (id: string) => void;
  showCumulative?: boolean;
  runningTotal?:   number;
}) {
  const metres   = toMetres(ring.distance, ring.unit);
  const metresIn = toMetres(ring.distanceIn, ring.unit);
  const valid    = !isNaN(metres) && metres > 0;

  const handleUnitChange = (newUnit: 'mm' | 'm') => {
    const curMetres   = toMetres(ring.distance,   ring.unit);
    const curMetresIn = toMetres(ring.distanceIn, ring.unit);
    const newDist   = !isNaN(curMetres)   ? fromMetres(curMetres,   newUnit) : '';
    const newDistIn = !isNaN(curMetresIn) ? fromMetres(curMetresIn, newUnit) : '';
    onChange(ring.id, { unit: newUnit, distance: newDist, distanceIn: newDistIn });
  };

  return (
    <div className="border border-zinc-800 bg-zinc-900/50 p-2 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] text-zinc-500 uppercase tracking-widest">Ring {index + 1}</span>
          {showCumulative && runningTotal != null && valid && (
            <span className="text-[7px] text-zinc-600 font-mono">
              → {fmtDistance(runningTotal)} total
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {valid && (
            <span className={cn(
              'text-[8px] px-1.5 py-0.5 font-mono',
              ring.direction === 'both'
                ? 'bg-violet-900/40 text-violet-400 border border-violet-800/50'
                : ring.direction === 'outward'
                ? 'bg-sky-900/40 text-sky-400 border border-sky-800/50'
                : 'bg-orange-900/40 text-orange-400 border border-orange-800/50',
            )}>
              {fmtDistance(metres)}
              {ring.direction === 'both' && ring.useAsymmetric && !isNaN(metresIn)
                ? `/${fmtDistance(metresIn)}`
                : ''}
              {' '}
              {ring.direction === 'both' ? '↔' : ring.direction === 'outward' ? '↗' : '↙'}
            </span>
          )}
          {total > 1 && (
            <button
              onClick={() => onRemove(ring.id)}
              className="text-zinc-600 hover:text-red-400 transition-colors"
              title="Remove ring"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {ring.direction === 'both' && ring.useAsymmetric ? (
        <div className="space-y-1">
          <DistanceInput
            value={ring.distance} unit={ring.unit}
            onChangeValue={v => onChange(ring.id, { distance: v })}
            onChangeUnit={handleUnitChange}
            label="Out"
          />
          <DistanceInput
            value={ring.distanceIn} unit={ring.unit}
            onChangeValue={v => onChange(ring.id, { distanceIn: v })}
            onChangeUnit={() => {}}
            label="In"
          />
        </div>
      ) : (
        <DistanceInput
          value={ring.distance} unit={ring.unit}
          onChangeValue={v => onChange(ring.id, { distance: v })}
          onChangeUnit={handleUnitChange}
        />
      )}

      <div className="flex items-center gap-1">
        <div className="flex gap-0.5 flex-1">
          {([
            { key: 'outward', label: 'Out'  },
            { key: 'inward',  label: 'In'   },
            { key: 'both',    label: 'Both' },
          ] as { key: DirectionChoice; label: string }[]).map(opt => (
            <button
              key={opt.key}
              onClick={() => onChange(ring.id, { direction: opt.key })}
              className={cn(
                'flex-1 px-2 py-1 text-[8px] font-bold uppercase tracking-widest border transition-all',
                ring.direction === opt.key
                  ? 'bg-amber-400 text-black border-amber-400'
                  : 'bg-transparent border-zinc-700 text-zinc-400 hover:border-zinc-600',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {ring.direction === 'both' && (
          <button
            onClick={() => onChange(ring.id, { useAsymmetric: !ring.useAsymmetric })}
            title={ring.useAsymmetric ? 'Switch to equal distances' : 'Set different distances each side'}
            className={cn(
              'px-1.5 py-1 text-[8px] border transition-all',
              ring.useAsymmetric
                ? 'border-violet-500/60 text-violet-400 bg-violet-900/30'
                : 'border-zinc-700 text-zinc-500 hover:border-zinc-600',
            )}
          >
            ≠
          </button>
        )}
      </div>

      <input
        type="text"
        value={ring.label}
        onChange={e => onChange(ring.id, { label: e.target.value })}
        className="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 text-[10px] font-mono px-2 py-1 focus:outline-none focus:border-amber-400"
        placeholder="Row label…"
      />
    </div>
  );
}

// ─── TradePresetsPanel ────────────────────────────────────────────────────────

function TradePresetsPanel({ onSelect }: { onSelect: (preset: TradePreset) => void }) {
  const [activeGroup, setActiveGroup] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      {TRADE_GROUPS.map(group => (
        <div key={group.name} className="border border-zinc-800">
          <button
            onClick={() => setActiveGroup(activeGroup === group.name ? null : group.name)}
            className="w-full flex items-center justify-between px-2 py-1.5 text-[9px] font-bold uppercase tracking-widest text-zinc-300 hover:bg-zinc-800/50 transition-colors"
          >
            <div className="flex items-center gap-1.5">{group.icon}{group.name}</div>
            {activeGroup === group.name
              ? <ChevronUp className="w-3 h-3 text-zinc-500" />
              : <ChevronDown className="w-3 h-3 text-zinc-500" />}
          </button>

          {activeGroup === group.name && (
            <div className="border-t border-zinc-800 divide-y divide-zinc-800/50">
              {group.presets.map(preset => (
                <button
                  key={preset.label}
                  onClick={() => onSelect(preset)}
                  className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-zinc-800/60 transition-colors text-left"
                >
                  <div>
                    <p className="text-[9px] font-bold text-zinc-200 uppercase tracking-wider">{preset.label}</p>
                    <p className="text-[8px] text-zinc-500 mt-0.5">{preset.hint}</p>
                  </div>
                  <span className={cn(
                    'text-[8px] px-1.5 py-0.5 font-mono flex-shrink-0 ml-2',
                    preset.direction === 'outward'
                      ? 'bg-sky-900/40 text-sky-400 border border-sky-800/50'
                      : 'bg-orange-900/40 text-orange-400 border border-orange-800/50',
                  )}>
                    {fmtDistance(preset.distanceM)} {preset.direction === 'outward' ? '↗' : '↙'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── PerimeterOffsetPanel ─────────────────────────────────────────────────────

interface PerimeterOffsetPanelProps {
  sourceMeasurement:   TakeoffRow | null;
  isValidSource:       (row: TakeoffRow) => boolean;
  isValidOpenSource:   (row: TakeoffRow) => boolean;
  isEffectivelyClosed: (row: TakeoffRow) => boolean;
  collapseRadius:      number;
  onCommit:            (params: CommitOffsetParams) => CommitOffsetResult;
  onOpenCommit:        (params: CommitOpenPathParams) => CommitOffsetResult;
  onBatchCommit:       (params: CommitOffsetParams[], opts?: { cumulative?: boolean }) => CommitOffsetResult;
  onCancel:            () => void;
  onPreviewChange:     (polygons: Array<{ x: number; y: number }[]> | null) => void;
  previewFn:           (source: TakeoffRow, offsetMetres: number, direction: OffsetDirection) => Array<{ x: number; y: number }>[] | null;
  previewOpenFn: (
    source:       TakeoffRow,
    offsetMetres: number,
    direction:    OpenPathDirection,
    joinStyle?:   JoinStyle,
    endStyle?:    OpenEndStyle,
  ) => Array<{ x: number; y: number }>[] | null;
  commitError:              string | null;
  onOutputTypeChange?:      (type: OffsetOutputType) => void;
  onOpenEndStyleChange?:    (style: OpenEndStyle) => void;
  onOpenOutputTypeChange?:  (type: OpenOutputType) => void;
}

export function PerimeterOffsetPanel({
  sourceMeasurement,
  isValidSource,
  isValidOpenSource,
  isEffectivelyClosed,
  collapseRadius,
  onCommit,
  onOpenCommit,
  onBatchCommit,
  onCancel,
  onPreviewChange,
  previewFn,
  previewOpenFn,
  commitError,
  onOutputTypeChange,
  onOpenEndStyleChange,
  onOpenOutputTypeChange,
}: PerimeterOffsetPanelProps) {

  // ── Source type detection ──────────────────────────────────────────────────
  const sourceIsValid  = sourceMeasurement ? isValidSource(sourceMeasurement)     : false;
  const sourceIsOpen   = sourceMeasurement ? isValidOpenSource(sourceMeasurement) : false;
  const sourceIsClosedLinear = useMemo(() => {
    if (!sourceMeasurement) return false;
    return sourceMeasurement.type === 'Length' && isEffectivelyClosed(sourceMeasurement);
  }, [sourceMeasurement, isEffectivelyClosed]);

  // ── Mode ───────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'single' | 'multi'>('single');

  // ── Shared join style (all modes) ──────────────────────────────────────────
  const [joinStyle,    setJoinStyle]    = useState<JoinStyle>('miter');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Single closed-path state ───────────────────────────────────────────────
  const [distanceStr,    setDistanceStr]    = useState('0.200');
  const [distanceInStr,  setDistanceInStr]  = useState('0.200');
  const [distUnit,       setDistUnit]       = useState<'mm' | 'm'>('m');
  const [useAsymmetric,  setUseAsymmetric]  = useState(false);
  const [baseOutputType, setBaseOutputType] = useState<'area' | 'length'>('length');
  const [donutMode,      setDonutMode]      = useState(false);
  const [direction,      setDirection]      = useState<DirectionChoice>('outward');
  const [label,          setLabel]          = useState('');

  // ── Open path state ────────────────────────────────────────────────────────
  const [openDirection,  setOpenDirection]  = useState<OpenPathDirection>('both');
  const [openOutputType, setOpenOutputType] = useState<OpenOutputType>('parallel-length');
  const [openEndStyle,   setOpenEndStyle]   = useState<OpenEndStyle>('square');

  // ── Multi-ring state ───────────────────────────────────────────────────────
  const [rings,           setRings]           = useState<OffsetRing[]>([makeRing(0.2, 'outward', '')]);
  const [multiBaseType,   setMultiBaseType]   = useState<'area' | 'length'>('length');
  const [multiDonutMode,  setMultiDonutMode]  = useState(false);
  const [multiCumulative, setMultiCumulative] = useState(false);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [showPresets, setShowPresets] = useState(false);
  const [localError,  setLocalError]  = useState<string | null>(null);
  const [localWarn,   setLocalWarn]   = useState<string | null>(null);

  // ── Collapse warning ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!sourceIsValid || collapseRadius <= 0) { setLocalWarn(null); return; }
    const isInwardRelevant = direction === 'inward' || direction === 'both';
    if (!isInwardRelevant) { setLocalWarn(null); return; }

    const checkDist = direction === 'both' && useAsymmetric
      ? toMetres(distanceInStr, distUnit)
      : toMetres(distanceStr, distUnit);

    if (!isNaN(checkDist) && checkDist > collapseRadius * 0.95) {
      setLocalWarn(`Inward ${fmtDistance(checkDist)} may collapse shape (max ≈${fmtDistance(collapseRadius)})`);
    } else {
      setLocalWarn(null);
    }
  }, [distanceStr, distanceInStr, distUnit, direction, useAsymmetric, collapseRadius, sourceIsValid]);

  // ── open path: one-side-area + both = unsupported combination note ─────────
  const openBothOneSideNote =
    sourceIsOpen && openDirection === 'both' && openOutputType === 'one-side-area'
      ? '"One-side area" requires a specific direction (Left or Right). Using buffer-area instead.'
      : null;

  // ── 'none' end style forces parallel-length output type ───────────────────
  const effectiveOpenOutputType: OpenOutputType = useMemo(() => {
    if (openEndStyle === 'none') return 'parallel-length';
    if (openDirection === 'both' && openOutputType === 'one-side-area') return 'buffer-area';
    return openOutputType;
  }, [openEndStyle, openDirection, openOutputType]);

  useEffect(() => {
    onOpenOutputTypeChange?.(effectiveOpenOutputType);
  }, [effectiveOpenOutputType, onOpenOutputTypeChange]);

  // ── effectiveSingleOutputType ─────────────────────────────────────────────
  const effectiveSingleOutputType: OffsetOutputType = useMemo(() => {
    if (sourceIsOpen) return 'length';
    if (direction === 'both') {
      return baseOutputType === 'length' ? 'perimeter-both' : 'donut-both';
    }
    if (baseOutputType === 'length') return 'length';
    if (donutMode) return 'donut';
    return 'area';
  }, [baseOutputType, donutMode, direction, sourceIsOpen]);

  const effectiveMultiOutputType: OffsetOutputType = useMemo(() => {
    if (multiBaseType === 'length') return 'length';
    if (multiDonutMode) return 'donut';
    return 'area';
  }, [multiBaseType, multiDonutMode]);

  const activeOutputType = mode === 'single' ? effectiveSingleOutputType : effectiveMultiOutputType;
  useEffect(() => { onOutputTypeChange?.(activeOutputType); }, [activeOutputType, onOutputTypeChange]);

  // ── Auto-populate label ────────────────────────────────────────────────────
  const autoLabelRef = useRef(false);
  useEffect(() => {
    if (sourceMeasurement && !autoLabelRef.current) {
      const base = sourceMeasurement.label ?? sourceMeasurement.description ?? 'Offset';
      setLabel(`${base} offset`);
      setRings(prev => prev.map((r, i) => i === 0 ? { ...r, label: `${base} offset` } : r));
      autoLabelRef.current = true;
    }
    if (!sourceMeasurement) autoLabelRef.current = false;
  }, [sourceMeasurement]);

  // ── Live preview (closed path) ─────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'single' || sourceIsOpen) { onPreviewChange(null); return; }
    if (!sourceIsValid || !sourceMeasurement) { onPreviewChange(null); return; }
    const metres = toMetres(distanceStr, distUnit);
    if (isNaN(metres) || metres <= 0) { onPreviewChange(null); return; }

    if (direction === 'both') {
      const outDist = metres;
      const inDist  = useAsymmetric ? toMetres(distanceInStr, distUnit) : metres;
      const outward = (!isNaN(outDist) && outDist > 0)
        ? (previewFn(sourceMeasurement, outDist, 'outward') ?? []) : [];
      const inward  = (!isNaN(inDist) && inDist > 0)
        ? (previewFn(sourceMeasurement, inDist, 'inward') ?? []) : [];
      const combined = [...outward, ...inward];
      onPreviewChange(combined.length > 0 ? combined : null);
    } else {
      const result = previewFn(sourceMeasurement, metres, direction as OffsetDirection);
      onPreviewChange(result);
    }
  }, [
    mode, sourceIsValid, sourceIsOpen, sourceMeasurement, distanceStr, distanceInStr,
    distUnit, direction, useAsymmetric, previewFn, onPreviewChange,
  ]);

  // ── Live preview (open path) ───────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'single' || !sourceIsOpen) return;
    if (!sourceMeasurement) { onPreviewChange(null); return; }
    const metres = toMetres(distanceStr, distUnit);
    if (isNaN(metres) || metres <= 0) { onPreviewChange(null); return; }
    const result = previewOpenFn(
      sourceMeasurement,
      metres,
      openDirection,
      joinStyle,
      openEndStyle,
    );
    onPreviewChange(result);
  }, [
    mode, sourceIsOpen, sourceMeasurement, distanceStr, distUnit,
    openDirection, joinStyle, openEndStyle,
    previewOpenFn, onPreviewChange,
  ]);

  useEffect(() => () => onPreviewChange(null), [onPreviewChange]);
  useEffect(() => { if (baseOutputType !== 'area') setDonutMode(false); }, [baseOutputType]);
  useEffect(() => { if (multiBaseType !== 'area') setMultiDonutMode(false); }, [multiBaseType]);

  useEffect(() => {
    if (openEndStyle === 'none') setOpenOutputType('parallel-length');
  }, [openEndStyle]);

  // ── Unit conversion ────────────────────────────────────────────────────────
  const handleDistUnitChange = (newUnit: 'mm' | 'm') => {
    const curMetres   = toMetres(distanceStr,   distUnit);
    const curMetresIn = toMetres(distanceInStr, distUnit);
    if (!isNaN(curMetres))   setDistanceStr(fromMetres(curMetres, newUnit));
    if (!isNaN(curMetresIn)) setDistanceInStr(fromMetres(curMetresIn, newUnit));
    setDistUnit(newUnit);
  };

  // ── Ring management ────────────────────────────────────────────────────────
  const updateRing = useCallback((id: string, patch: Partial<OffsetRing>) => {
    setRings(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  }, []);
  const removeRing = useCallback((id: string) => {
    setRings(prev => prev.length > 1 ? prev.filter(r => r.id !== id) : prev);
  }, []);
  const addRing = useCallback(() => {
    setRings(prev => {
      const last     = prev[prev.length - 1];
      const lastDist = toMetres(last.distance, last.unit);
      const nextDist = !isNaN(lastDist) && lastDist > 0 ? lastDist + 0.1 : 0.2;
      return [...prev, makeRing(+nextDist.toFixed(3), last.direction, '')];
    });
  }, []);

  // ── Cumulative running totals ──────────────────────────────────────────────
  const ringRunningTotals = useMemo(() => {
    if (!multiCumulative) return null;
    const totals: number[] = [];
    const accByDir: Record<string, number> = {};
    for (const r of rings) {
      const key  = r.direction;
      const dist = toMetres(r.distance, r.unit);
      const prev = accByDir[key] ?? 0;
      const abs  = prev + (isNaN(dist) ? 0 : dist);
      accByDir[key] = abs;
      totals.push(abs);
    }
    return totals;
  }, [rings, multiCumulative]);

  // ── Trade preset apply ─────────────────────────────────────────────────────
  const applyPreset = useCallback((preset: TradePreset) => {
    if (mode === 'single') {
      setDistanceStr(String(preset.distanceM));
      setDistUnit('m');
      setDirection(preset.direction);
      setLabel(preset.rowLabel);
    } else {
      setRings(prev => {
        const last      = prev[prev.length - 1];
        const lastEmpty = !parseFloat(last.distance) || last.distance === '';
        if (lastEmpty) {
          return prev.map((r, i) =>
            i === prev.length - 1
              ? { ...r, distance: String(preset.distanceM), unit: 'm', direction: preset.direction, label: preset.rowLabel }
              : r,
          );
        }
        return [...prev, makeRing(preset.distanceM, preset.direction, preset.rowLabel)];
      });
    }
    setShowPresets(false);
  }, [mode]);

  // ── handleCommit ───────────────────────────────────────────────────────────
  const handleCommit = useCallback(() => {
    if (!sourceMeasurement || (!sourceIsValid && !sourceIsOpen)) return;

    setLocalError(null);
    setLocalWarn(null);

    // ── Open path ─────────────────────────────────────────────────────────
    if (sourceIsOpen) {
      const metres = toMetres(distanceStr, distUnit);
      if (isNaN(metres) || metres <= 0) {
        setLocalError('Enter a valid distance greater than 0.');
        return;
      }
      onPreviewChange(null);
      const result = onOpenCommit({
        sourceMeasurement,
        offsetMetres: metres,
        direction:    openDirection,
        outputType:   effectiveOpenOutputType,
        label:        label.trim() || `${sourceMeasurement.label ?? 'Line'} offset`,
        joinStyle,
        endStyle:     openEndStyle,
      });
      if (result.error)   setLocalError(result.error);
      if (result.warning) setLocalWarn(result.warning);
      return;
    }

    // ── Single closed path ────────────────────────────────────────────────
    if (mode === 'single') {
      const metres   = toMetres(distanceStr,   distUnit);
      const metresIn = useAsymmetric ? toMetres(distanceInStr, distUnit) : metres;
      if (isNaN(metres) || metres <= 0) {
        setLocalError('Enter a valid distance greater than 0.');
        return;
      }
      onPreviewChange(null);

      let result: CommitOffsetResult;
      if (direction === 'both') {
        result = onCommit({
          sourceMeasurement,
          offsetMetres:  metres,
          outwardMetres: metres,
          inwardMetres:  metresIn,
          direction:     'outward',
          outputType:    effectiveSingleOutputType,
          label:         label.trim() || `${sourceMeasurement.label ?? 'Shape'} offset`,
          joinStyle,
        });
      } else {
        result = onCommit({
          sourceMeasurement,
          offsetMetres: metres,
          direction:    direction as OffsetDirection,
          outputType:   effectiveSingleOutputType,
          label:        label.trim() || `${sourceMeasurement.label ?? 'Shape'} offset`,
          joinStyle,
        });
      }
      if (result.error)   setLocalError(result.error);
      if (result.warning) setLocalWarn(result.warning);
      return;
    }

    // ── Multi-ring ────────────────────────────────────────────────────────
    const validRings = rings.filter(r => {
      const m = toMetres(r.distance, r.unit);
      return !isNaN(m) && m > 0;
    });
    if (validRings.length === 0) {
      setLocalError('Add at least one ring with a valid distance.');
      return;
    }
    onPreviewChange(null);

    const params: CommitOffsetParams[] = validRings.map((r, i) => {
      const ringDir  = r.direction;
      const isBoth   = ringDir === 'both';
      const metres   = toMetres(r.distance,   r.unit);
      const metresIn = r.useAsymmetric ? toMetres(r.distanceIn, r.unit) : metres;

      let outType: OffsetOutputType = effectiveMultiOutputType;
      if (isBoth) {
        outType = multiBaseType === 'length' ? 'perimeter-both' : 'donut-both';
      } else if (multiDonutMode && multiBaseType === 'area') {
        outType = 'donut';
      }

      return {
        sourceMeasurement,
        offsetMetres:  metres,
        outwardMetres: isBoth ? metres   : undefined,
        inwardMetres:  isBoth ? metresIn : undefined,
        direction:     isBoth ? 'outward' : (ringDir as OffsetDirection),
        outputType:    outType,
        label:         r.label.trim() || `${sourceMeasurement.label ?? 'Shape'} offset ${i + 1}`,
        joinStyle,
      };
    });

    const result = onBatchCommit(params, { cumulative: multiCumulative });
    if (result.error)   setLocalError(result.error);
    if (result.warning) setLocalWarn(result.warning);
  }, [
    sourceMeasurement, sourceIsValid, sourceIsOpen, mode,
    distanceStr, distanceInStr, distUnit, useAsymmetric,
    direction, effectiveSingleOutputType, effectiveMultiOutputType,
    donutMode, multiDonutMode, multiBaseType, label, joinStyle,
    rings, multiCumulative, openDirection, openEndStyle, effectiveOpenOutputType,
    onCommit, onOpenCommit, onBatchCommit, onPreviewChange,
  ]);

  // ── Enter key ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Enter' && (sourceIsValid || sourceIsOpen)) {
        e.preventDefault();
        handleCommit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCommit, sourceIsValid, sourceIsOpen]);

  const error = localError ?? commitError;

  // ── commit label ───────────────────────────────────────────────────────────
  const commitLabel = useMemo(() => {
    if (sourceIsOpen) {
      if (openEndStyle === 'none' && openDirection === 'both') return 'Commit 2 rows';
      return 'Commit offset';
    }
    if (mode === 'multi') {
      const validCount = rings.filter(r => toMetres(r.distance, r.unit) > 0).length;
      const bothCount  = rings.filter(r => r.direction === 'both' && toMetres(r.distance, r.unit) > 0).length;
      const rowCount   = validCount + bothCount;
      return `Commit ${rowCount} row${rowCount !== 1 ? 's' : ''}`;
    }
    if (direction === 'both') return 'Commit 2 rows';
    return 'Commit offset';
  }, [mode, rings, direction, sourceIsOpen, openEndStyle, openDirection]);

  const isAnyValid = sourceIsValid || sourceIsOpen;

  // ── openEndStyle setter that also notifies parent ─────────────────────────
  const handleOpenEndStyleChange = useCallback((style: OpenEndStyle) => {
    setOpenEndStyle(style);
    onOpenEndStyleChange?.(style);
  }, [onOpenEndStyleChange]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Themed scrollbar — zinc track, amber on hover, matches industrial UI */}
      <style>{`
        .offset-panel-scroll::-webkit-scrollbar {
          width: 3px;
        }
        .offset-panel-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .offset-panel-scroll::-webkit-scrollbar-thumb {
          background: #3f3f46;
          border-radius: 0px;
        }
        .offset-panel-scroll::-webkit-scrollbar-thumb:hover {
          background: #fbbf24;
        }
        .offset-panel-scroll {
          scrollbar-width: thin;
          scrollbar-color: #3f3f46 transparent;
        }
      `}</style>

      {/*
        Panel sits centred vertically at 15vh from top, filling 70vh total.
        h-[70vh] gives flex a concrete height so flex-1 + overflow-y-auto work.
      */}
      <div className="absolute top-[15vh] right-4 z-[80] w-80 bg-industrial-panel border border-industrial-border shadow-2xl font-mono flex flex-col h-[70vh] overflow-hidden">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-industrial-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-200">
              Perimeter Offset
            </span>
            {sourceIsOpen && (
              <span className="text-[7px] px-1.5 py-0.5 bg-teal-900/40 border border-teal-600/40 text-teal-400 uppercase tracking-widest">
                Open path
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!sourceIsOpen && (
              <div className="flex border border-zinc-700">
                <button
                  onClick={() => setMode('single')}
                  className={cn('px-2 py-1 text-[8px] font-bold uppercase tracking-widest transition-all',
                    mode === 'single' ? 'bg-amber-400 text-black' : 'text-zinc-500 hover:text-zinc-300')}
                  title="Single offset"
                >1×</button>
                <button
                  onClick={() => setMode('multi')}
                  className={cn('px-2 py-1 text-[8px] font-bold uppercase tracking-widest border-l border-zinc-700 transition-all',
                    mode === 'multi' ? 'bg-amber-400 text-black' : 'text-zinc-500 hover:text-zinc-300')}
                  title="Multiple rings"
                >N×</button>
              </div>
            )}
            <button onClick={onCancel} className="text-zinc-500 hover:text-zinc-200 transition-colors" title="Cancel (Escape)">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* ── Scrollable body — min-h-0 lets it shrink below content size ── */}
        <div className="offset-panel-scroll overflow-y-auto flex-1 min-h-0 px-3 py-3 space-y-3">

          {/* ── Source indicator ── */}
          <div className={cn(
            'px-2 py-1.5 border text-[9px] uppercase tracking-widest',
            (sourceIsValid || sourceIsOpen)
              ? 'border-green-600/50 bg-green-900/20 text-green-400'
              : 'border-zinc-700 bg-zinc-900/40 text-zinc-500',
          )}>
            {(sourceIsValid || sourceIsOpen) && sourceMeasurement ? (
              <div className="flex items-center gap-1.5 min-w-0">
                <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
                <span className="truncate text-zinc-300">
                  {sourceMeasurement.label ?? sourceMeasurement.description}
                </span>
                {sourceIsClosedLinear && (
                  <span className="flex-shrink-0 px-1 py-0.5 text-[7px] font-bold uppercase tracking-widest bg-sky-900/60 border border-sky-600/40 text-sky-400">
                    closed
                  </span>
                )}
                {sourceIsOpen && (
                  <span className="flex-shrink-0 px-1 py-0.5 text-[7px] font-bold uppercase tracking-widest bg-teal-900/60 border border-teal-600/40 text-teal-400">
                    open
                  </span>
                )}
                <span className="text-zinc-600 ml-auto flex-shrink-0">
                  {sourceMeasurement.quantity.toFixed(2)}
                  {sourceMeasurement.unit === 'sq m' ? 'm²' : sourceMeasurement.unit}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-zinc-500">
                <MousePointer2 className="w-3 h-3 flex-shrink-0" />
                <span>Click a highlighted shape</span>
              </div>
            )}
          </div>

          {/* ── Collapse warning ── */}
          {localWarn && <CollapseWarning message={localWarn} />}

          {/* ── Open-path both+one-side-area note ── */}
          {openBothOneSideNote && <InfoNote message={openBothOneSideNote} />}

          {/* ── Trade presets (closed path only) ── */}
          {!sourceIsOpen && (
            <div>
              <button
                onClick={() => setShowPresets(v => !v)}
                className="w-full flex items-center justify-between text-[8px] uppercase tracking-widest text-zinc-500 hover:text-zinc-300 transition-colors pb-1"
              >
                <span>Trade presets</span>
                {showPresets ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
              {showPresets && <TradePresetsPanel onSelect={applyPreset} />}
            </div>
          )}

          <div className="border-t border-zinc-800" />

          {/* ══════════════════════════════════════════════════════════════════
              OPEN PATH MODE
          ══════════════════════════════════════════════════════════════════ */}
          {sourceIsOpen && (
            <>
              {/* Distance */}
              <div>
                <SectionLabel>Offset distance</SectionLabel>
                <DistanceInput
                  value={distanceStr} unit={distUnit}
                  onChangeValue={v => { setDistanceStr(v); setLocalError(null); }}
                  onChangeUnit={handleDistUnitChange}
                />
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {QUICK_DISTANCES_M.map(d => (
                    <button
                      key={d}
                      onClick={() => {
                        setDistanceStr(distUnit === 'mm' ? String(Math.round(d * 1000)) : String(d));
                        setLocalError(null);
                      }}
                      className={cn(
                        'px-1.5 py-0.5 text-[8px] font-mono border transition-all',
                        toMetres(distanceStr, distUnit) === d
                          ? 'bg-amber-400 text-black border-amber-400'
                          : 'border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300',
                      )}
                    >
                      {fmtDistance(d)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Side (direction) */}
              <div>
                <SectionLabel>Side</SectionLabel>
                <div className="flex gap-1">
                  {([
                    { key: 'left',  label: '← Left'    },
                    { key: 'right', label: 'Right →'    },
                    { key: 'both',  label: '↔ Corridor' },
                  ] as { key: OpenPathDirection; label: string }[]).map(opt => (
                    <button
                      key={opt.key}
                      onClick={() => setOpenDirection(opt.key)}
                      className={cn(
                        'flex-1 py-1 text-[8px] font-bold uppercase tracking-widest border transition-all',
                        openDirection === opt.key
                          ? 'bg-amber-400 text-black border-amber-400'
                          : 'bg-transparent border-zinc-700 text-zinc-400 hover:border-zinc-500',
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Line end treatment */}
              <div>
                <SectionLabel>Line end treatment</SectionLabel>
                <div className="flex flex-col gap-1">
                  {([
                    { key: 'square' as OpenEndStyle, label: 'Square', desc: 'Cap extends ½ offset beyond endpoint' },
                    { key: 'round'  as OpenEndStyle, label: 'Round',  desc: 'Semicircular cap at each endpoint'    },
                    { key: 'butt'   as OpenEndStyle, label: 'Butt',   desc: 'Cap flush with endpoint — no extension' },
                    { key: 'none'   as OpenEndStyle, label: 'None',   desc: 'Two raw parallel lines — no caps, no closing' },
                  ]).map(opt => (
                    <button
                      key={opt.key}
                      onClick={() => handleOpenEndStyleChange(opt.key)}
                      className={cn(
                        'w-full flex items-center justify-between px-2 py-1 text-[9px] border transition-all',
                        openEndStyle === opt.key
                          ? opt.key === 'none'
                            ? 'bg-violet-900/30 text-violet-200 border-violet-600/60'
                            : 'bg-zinc-700 text-zinc-200 border-zinc-600'
                          : 'bg-transparent border-zinc-800 text-zinc-500 hover:border-zinc-700',
                      )}
                    >
                      <span className="font-bold uppercase tracking-widest">{opt.label}</span>
                      <span className="text-[7px] text-zinc-500 normal-case">{opt.desc}</span>
                    </button>
                  ))}
                </div>

                {openEndStyle === 'none' && (
                  <div className="mt-1.5 px-2 py-1.5 border border-violet-800/40 bg-violet-900/15">
                    <p className="text-[7px] text-violet-400/80 leading-relaxed">
                      {openDirection === 'both'
                        ? 'Produces two open parallel strokes — one each side. No caps, no corridor polygon. Committed as two length rows.'
                        : 'Produces a single open parallel stroke offset to the selected side. No caps, no area polygon.'}
                    </p>
                  </div>
                )}
              </div>

              {/* Output type — hidden when endStyle === 'none' */}
              {openEndStyle !== 'none' && (
                <div>
                  <SectionLabel>Measure as</SectionLabel>
                  <div className="flex flex-col gap-1">
                    {([
                      { value: 'parallel-length', label: 'Parallel line (m)',   desc: 'Length of offset line ≈ source'    },
                      { value: 'one-side-area',   label: 'One-side area (m²)',  desc: 'Area on selected side'             },
                      { value: 'buffer-area',     label: 'Corridor area (m²)',  desc: 'Full buffer both sides combined'   },
                    ] as { value: OpenOutputType; label: string; desc: string }[]).map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setOpenOutputType(opt.value)}
                        className={cn(
                          'w-full flex items-center justify-between px-2 py-1.5 text-[9px] border transition-all',
                          openOutputType === opt.value
                            ? 'bg-amber-400/10 border-amber-400/50 text-amber-300'
                            : 'border-zinc-700 text-zinc-400 hover:border-zinc-600',
                          openDirection === 'both' && opt.value === 'one-side-area' ? 'opacity-50' : '',
                        )}
                      >
                        <span className="font-bold uppercase tracking-widest">{opt.label}</span>
                        <span className="text-[7px] text-zinc-500 normal-case">{opt.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Row label */}
              <div>
                <SectionLabel>Row label</SectionLabel>
                <input
                  type="text"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 text-[11px] font-mono px-2 py-1.5 focus:outline-none focus:border-amber-400"
                  placeholder="e.g. Parallel kerb line"
                />
              </div>

              {/* Corner style — disabled when endStyle is 'none' */}
              <AdvancedSection
                show={showAdvanced}
                onToggle={() => setShowAdvanced(v => !v)}
                joinStyle={joinStyle}
                onJoinStyleChange={setJoinStyle}
                note="Affects corridor corners. Miter = sharp. Round = arcs. Square = chamfer."
                disabled={openEndStyle === 'none'}
              />
            </>
          )}

          {/* ══════════════════════════════════════════════════════════════════
              SINGLE MODE (closed path)
          ══════════════════════════════════════════════════════════════════ */}
          {!sourceIsOpen && mode === 'single' && (
            <>
              {/* Distance */}
              <div>
                <SectionLabel>Offset distance</SectionLabel>
                <DistanceInput
                  value={distanceStr} unit={distUnit}
                  onChangeValue={v => { setDistanceStr(v); setLocalError(null); }}
                  onChangeUnit={handleDistUnitChange}
                  label={direction === 'both' && useAsymmetric ? 'Out' : undefined}
                />
                {direction === 'both' && useAsymmetric && (
                  <div className="mt-1">
                    <DistanceInput
                      value={distanceInStr} unit={distUnit}
                      onChangeValue={v => { setDistanceInStr(v); setLocalError(null); }}
                      onChangeUnit={() => {}}
                      label="In"
                    />
                  </div>
                )}
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {QUICK_DISTANCES_M.map(d => (
                    <button
                      key={d}
                      onClick={() => {
                        const v = distUnit === 'mm' ? String(Math.round(d * 1000)) : String(d);
                        setDistanceStr(v);
                        setLocalError(null);
                      }}
                      className={cn(
                        'px-1.5 py-0.5 text-[8px] font-mono border transition-all',
                        toMetres(distanceStr, distUnit) === d
                          ? 'bg-amber-400 text-black border-amber-400'
                          : 'border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300',
                      )}
                    >
                      {fmtDistance(d)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Direction */}
              <div>
                <SectionLabel>Direction</SectionLabel>
                <DirectionToggle
                  value={direction}
                  onChange={v => { setDirection(v); if (v !== 'both') setUseAsymmetric(false); }}
                />
                {direction === 'both' && (
                  <div className="mt-1.5 flex items-center justify-between">
                    <p className="text-[7px] text-violet-400/70 leading-relaxed">
                      Commits two rows: outward + inward.
                    </p>
                    <button
                      onClick={() => setUseAsymmetric(v => !v)}
                      className={cn(
                        'px-2 py-0.5 text-[7px] font-bold border transition-all',
                        useAsymmetric
                          ? 'border-violet-500/60 text-violet-400 bg-violet-900/20'
                          : 'border-zinc-700 text-zinc-500 hover:border-zinc-600',
                      )}
                    >
                      {useAsymmetric ? '≠ Asymmetric' : '= Equal · click to differ'}
                    </button>
                  </div>
                )}
              </div>

              {/* Measure as */}
              <div>
                <SectionLabel>Measure as</SectionLabel>
                <div className="flex gap-1">
                  {([
                    { value: 'length', label: 'Perimeter (m)' },
                    { value: 'area',   label: 'Area (m²)'     },
                  ] as { value: 'area' | 'length'; label: string }[]).map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setBaseOutputType(opt.value)}
                      className={cn(
                        'flex-1 py-1.5 text-[9px] font-bold uppercase tracking-widest border transition-all',
                        baseOutputType === opt.value
                          ? 'bg-amber-400 text-black border-amber-400'
                          : 'bg-transparent border-zinc-700 text-zinc-400 hover:border-zinc-500',
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {direction === 'both' && (
                  <p className="text-[7px] text-violet-400/70 px-0.5 mt-1 leading-relaxed">
                    {baseOutputType === 'length'
                      ? 'Output: two perimeter rows — outward length + inward length.'
                      : 'Output: two ring-area rows — outward band + inward band (donut).'}
                  </p>
                )}

                {baseOutputType === 'area' && direction !== 'both' && (
                  <div className="mt-1.5">
                    <button
                      onClick={() => setDonutMode(v => !v)}
                      className={cn(
                        'w-full flex items-center gap-2 px-2 py-1.5 border text-[9px] font-bold uppercase tracking-widest transition-all',
                        donutMode
                          ? 'border-teal-500/60 bg-teal-900/20 text-teal-300'
                          : 'border-zinc-700 text-zinc-500 hover:border-zinc-600',
                      )}
                    >
                      <div className={cn(
                        'w-3 h-3 border flex-shrink-0 flex items-center justify-center',
                        donutMode ? 'border-teal-400 bg-teal-400' : 'border-zinc-600',
                      )}>
                        {donutMode && <Check className="w-2 h-2 text-black" />}
                      </div>
                      <span>Ring area only (donut)</span>
                      <span className="ml-auto text-zinc-600 normal-case font-normal text-[7px]">
                        offset − source
                      </span>
                    </button>
                  </div>
                )}

                {baseOutputType === 'area' && direction === 'both' && (
                  <div className="mt-1.5 text-[7px] text-zinc-600 px-0.5 leading-relaxed">
                    Ring area is automatic for both-sides: each band = offset polygon − source.
                  </div>
                )}
              </div>

              {/* Row label */}
              <div>
                <SectionLabel>Row label</SectionLabel>
                <input
                  type="text"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 text-[11px] font-mono px-2 py-1.5 focus:outline-none focus:border-amber-400"
                  placeholder="e.g. Gravel border strip"
                />
              </div>

              {/* Corner style */}
              <AdvancedSection
                show={showAdvanced}
                onToggle={() => setShowAdvanced(v => !v)}
                joinStyle={joinStyle}
                onJoinStyleChange={setJoinStyle}
              />
            </>
          )}

          {/* ══════════════════════════════════════════════════════════════════
              MULTI MODE (closed path)
          ══════════════════════════════════════════════════════════════════ */}
          {!sourceIsOpen && mode === 'multi' && (
            <>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <SectionLabel>Offset rings</SectionLabel>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setMultiCumulative(v => !v)}
                      title={multiCumulative
                        ? 'Cumulative mode: each ring adds to the previous'
                        : 'Absolute mode: each ring measured from source'}
                      className={cn(
                        'px-1.5 py-0.5 text-[7px] font-bold border uppercase tracking-widest transition-all',
                        multiCumulative
                          ? 'border-amber-500/60 text-amber-400 bg-amber-900/20'
                          : 'border-zinc-700 text-zinc-500 hover:border-zinc-600',
                      )}
                    >
                      {multiCumulative ? '∑ Cumul.' : 'Abs.'}
                    </button>
                    <button
                      onClick={addRing}
                      className="flex items-center gap-1 text-[8px] text-amber-400 hover:text-amber-300 transition-colors uppercase tracking-widest"
                    >
                      <Plus className="w-3 h-3" />Add ring
                    </button>
                  </div>
                </div>
                {multiCumulative && (
                  <p className="text-[7px] text-amber-400/70 mb-1.5 leading-relaxed px-0.5">
                    Cumulative: each ring distance stacks from the previous ring.
                  </p>
                )}
                <div className="space-y-1.5">
                  {rings.map((ring, i) => (
                    <RingRow
                      key={ring.id} ring={ring} index={i} total={rings.length}
                      onChange={updateRing} onRemove={removeRing}
                      showCumulative={multiCumulative}
                      runningTotal={ringRunningTotals?.[i]}
                    />
                  ))}
                </div>
              </div>

              <div>
                <SectionLabel>Measure all rings as</SectionLabel>
                <div className="flex gap-1">
                  {([
                    { value: 'length', label: 'Perimeter (m)' },
                    { value: 'area',   label: 'Area (m²)'     },
                  ] as { value: 'area' | 'length'; label: string }[]).map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setMultiBaseType(opt.value)}
                      className={cn(
                        'flex-1 py-1.5 text-[9px] font-bold uppercase tracking-widest border transition-all',
                        multiBaseType === opt.value
                          ? 'bg-amber-400 text-black border-amber-400'
                          : 'bg-transparent border-zinc-700 text-zinc-400 hover:border-zinc-500',
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {multiBaseType === 'area' && (
                  <div className="mt-1.5">
                    <button
                      onClick={() => setMultiDonutMode(v => !v)}
                      className={cn(
                        'w-full flex items-center gap-2 px-2 py-1.5 border text-[9px] font-bold uppercase tracking-widest transition-all',
                        multiDonutMode
                          ? 'border-teal-500/60 bg-teal-900/20 text-teal-300'
                          : 'border-zinc-700 text-zinc-500 hover:border-zinc-600',
                      )}
                    >
                      <div className={cn(
                        'w-3 h-3 border flex-shrink-0 flex items-center justify-center',
                        multiDonutMode ? 'border-teal-400 bg-teal-400' : 'border-zinc-600',
                      )}>
                        {multiDonutMode && <Check className="w-2 h-2 text-black" />}
                      </div>
                      <span>Ring area only (donut)</span>
                      <span className="ml-auto text-zinc-600 normal-case font-normal text-[7px]">
                        offset − source
                      </span>
                    </button>
                  </div>
                )}

                {multiBaseType === 'area' && rings.some(r => r.direction === 'both') && (
                  <p className="text-[7px] text-violet-400/70 mt-1 px-0.5 leading-relaxed">
                    ↔ "Both" rings auto-use donut-both (band area each side).
                  </p>
                )}
              </div>

              {/* Summary */}
              {rings.filter(r => toMetres(r.distance, r.unit) > 0).length > 0 && (
                <div className="border border-zinc-800 bg-zinc-900/30 px-2 py-1.5 space-y-0.5">
                  <p className="text-[8px] text-zinc-500 uppercase tracking-widest mb-1">Summary</p>
                  {rings.filter(r => toMetres(r.distance, r.unit) > 0).map((r, i) => (
                    <div key={r.id} className="flex items-center gap-1.5 text-[9px]">
                      <span className={cn(
                        'w-2 h-2 rounded-full flex-shrink-0',
                        r.direction === 'both'    ? 'bg-violet-400'
                        : r.direction === 'outward' ? 'bg-sky-400'
                        : 'bg-orange-400',
                      )} />
                      <span className="text-zinc-400 font-mono">
                        {fmtDistance(toMetres(r.distance, r.unit))}
                        {r.direction === 'both' && r.useAsymmetric
                          ? `/${fmtDistance(toMetres(r.distanceIn, r.unit))}`
                          : ''}
                      </span>
                      <span className="text-zinc-600">
                        {r.direction === 'both' ? 'both' : r.direction}
                      </span>
                      {multiCumulative && ringRunningTotals && (
                        <span className="text-zinc-600 text-[7px] font-mono">
                          →{fmtDistance(ringRunningTotals[i])}
                        </span>
                      )}
                      {r.label && <span className="text-zinc-500 truncate">— {r.label}</span>}
                    </div>
                  ))}
                  {rings.some(r => r.direction === 'both') && (
                    <p className="text-[7px] text-violet-400/70 pt-0.5">
                      ↔ "Both" rings each commit two rows (outward + inward)
                    </p>
                  )}
                </div>
              )}

              <AdvancedSection
                show={showAdvanced}
                onToggle={() => setShowAdvanced(v => !v)}
                joinStyle={joinStyle}
                onJoinStyleChange={setJoinStyle}
              />
            </>
          )}

          {/* ── Error ── */}
          {error && (
            <div className="flex items-center gap-1.5 text-[9px] text-red-400 border border-red-800/50 bg-red-900/20 px-2 py-1.5">
              <AlertTriangle className="w-3 h-3 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* ── Actions ── */}
          <div className="flex gap-2 pt-1 pb-1">
            <button
              onClick={onCancel}
              className="flex-1 py-1.5 text-[9px] font-bold uppercase tracking-widest border border-zinc-700 text-zinc-400 hover:border-zinc-500 transition-all"
            >
              Cancel
            </button>
            <button
              onClick={handleCommit}
              disabled={!isAnyValid}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[9px] font-bold uppercase tracking-widest border transition-all',
                isAnyValid
                  ? 'bg-amber-400 text-black border-amber-400 hover:bg-amber-300 active:scale-95'
                  : 'bg-zinc-800 text-zinc-600 border-zinc-700 cursor-not-allowed',
              )}
            >
              <Check className="w-3 h-3" />
              {commitLabel}
            </button>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="px-3 py-2 border-t border-industrial-border flex-shrink-0">
          <p className="text-[8px] text-zinc-600 uppercase tracking-widest">
            Esc to cancel · Enter to commit
          </p>
        </div>
      </div>
    </>
  );
}
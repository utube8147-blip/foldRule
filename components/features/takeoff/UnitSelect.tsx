'use client';

import { UNIT_OPTIONS, type DisplayUnit } from '@/hooks/measurements/useMeasurements/unitConversion';
import type { TakeoffRow } from '@/types';

const AREA_UNITS = new Set(['sq m', 'sq cm', 'sq mm', 'sq ft', 'sq in']);
const COUNT_UNITS = new Set(['EA', 'PT']);

function unitFamily(unit?: string, type?: TakeoffRow['type']) {
  if (COUNT_UNITS.has(unit ?? '') || type === 'Count' || type === 'Point') return 'count';
  if (AREA_UNITS.has(unit ?? '') || type === 'Area' || type === 'Polygon' || type === 'Rectangle') return 'area';
  return 'length';
}

function normalizeUnit(unit: string | undefined, family: string) {
  if (family === 'area' && (!unit || unit === 'm')) return 'sq m';
  return unit;
}

function toDisplayUnit(unit: string | undefined): DisplayUnit {
  const value = unit?.replace(/^sq /, '') as DisplayUnit;
  return UNIT_OPTIONS.some(option => option.value === value) ? value : 'm';
}

function convert(value: number, from: string | undefined, to: string, type?: TakeoffRow['type']): number {
  const family = unitFamily(from, type);
  const normalizedFrom = normalizeUnit(from, family);
  const normalizedTo = normalizeUnit(to, family);
  if (family !== unitFamily(to, type) || family === 'count' || normalizedFrom === normalizedTo) return value;

  const lengthFactors: Record<DisplayUnit, number> = { m: 1, cm: 100, mm: 1000, ft: 3.28084, in: 39.3701 };
  const fromFactor = lengthFactors[toDisplayUnit(normalizedFrom)];
  const toFactor = lengthFactors[toDisplayUnit(normalizedTo)];
  const exponent = family === 'area' ? 2 : 1;
  return value * (toFactor / fromFactor) ** exponent;
}

export function unitLabel(unit?: string) {
  return unit?.startsWith('sq ') ? unit : unit || 'm';
}

export function UnitSelect({
  row,
  onChange,
  className = '',
  childrenRows,
}: {
  row: TakeoffRow;
  onChange: (updates: Partial<TakeoffRow>) => void;
  className?: string;
  childrenRows?: TakeoffRow[];
}) {
  const family = unitFamily(row.unit, row.type);
  const isGroup = row.isGroupHeader && childrenRows;
  const sourceRows = isGroup ? childrenRows : [row];
  const aggregateQuantity = isGroup
    ? sourceRows.reduce((sum, child) => sum + convert(child.quantity, child.unit, row.unit || 'm', child.type), 0)
    : row.quantity;
  const currentUnit = normalizeUnit(row.unit, family) ?? (family === 'area' ? 'sq m' : family === 'count' ? 'EA' : 'm');
  const options = family === 'count'
    ? [{ value: row.unit || 'EA', label: row.unit || 'EA' }]
    : UNIT_OPTIONS.map(option => ({
        value: family === 'area' ? `sq ${option.value}` : option.value,
        label: family === 'area' ? `sq ${option.label}` : option.label,
      }));

  return (
    <select
      aria-label={`Unit for ${row.description || row.label || 'measurement'}`}
      value={currentUnit}
      disabled={family === 'count'}
      onClick={event => event.stopPropagation()}
      onChange={event => {
        const nextUnit = event.target.value;
        const nextQuantity = isGroup
          ? sourceRows.reduce((sum, child) => sum + convert(child.quantity, child.unit, nextUnit, child.type), 0)
          : convert(row.quantity, currentUnit, nextUnit, row.type);
        const nextUnitRate = nextQuantity !== 0
          ? row.unitRate * (isGroup ? aggregateQuantity : row.quantity) / nextQuantity
          : row.unitRate;

        onChange({
          unit: nextUnit,
          quantity: nextQuantity,
          unitRate: nextUnitRate,
        });
      }}
      className={`bg-transparent border border-transparent hover:border-zinc-700 focus:border-amber-accent text-inherit text-[11px] font-mono px-1 py-0.5 outline-none cursor-pointer ${className}`}
    >
      {options.map(option => <option key={option.value} value={option.value} className="bg-zinc-900 text-zinc-200">{option.label}</option>)}
    </select>
  );
}

export function convertQuantity(value: number, from: string | undefined, to: string) {
  return convert(value, from, to);
}

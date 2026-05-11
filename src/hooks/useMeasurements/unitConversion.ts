// ─── hooks/useMeasurements/unitConversion.ts ──────────────────────────────────
//
//  Stateless unit conversion helpers. All quantities are stored in base SI
//  units (metres for length, sq metres for area). This module converts to
//  display units without touching stored data.
//
// ─────────────────────────────────────────────────────────────────────────────

export type DisplayUnit = 'm' | 'cm' | 'mm' | 'ft' | 'in';

export const UNIT_OPTIONS: { value: DisplayUnit; label: string }[] = [
  { value: 'm',  label: 'm'  },
  { value: 'cm', label: 'cm' },
  { value: 'mm', label: 'mm' },
  { value: 'ft', label: 'ft' },
  { value: 'in', label: 'in' },
];

// ── Linear conversion (stored metres → display unit) ──────────────────────────

export function convertLength(metres: number, to: DisplayUnit): number {
  switch (to) {
    case 'cm': return metres * 100;
    case 'mm': return metres * 1000;
    case 'ft': return metres * 3.28084;
    case 'in': return metres * 39.3701;
    default:   return metres;
  }
}

// ── Area conversion (stored sq metres → display unit²) ───────────────────────

export function convertArea(sqMetres: number, to: DisplayUnit): number {
  switch (to) {
    case 'cm': return sqMetres * 10_000;
    case 'mm': return sqMetres * 1_000_000;
    case 'ft': return sqMetres * 10.7639;
    case 'in': return sqMetres * 1_550.0031;
    default:   return sqMetres;
  }
}

// ── Area unit label ───────────────────────────────────────────────────────────

export function areaUnitLabel(to: DisplayUnit): string {
  switch (to) {
    case 'cm': return 'sq cm';
    case 'mm': return 'sq mm';
    case 'ft': return 'sq ft';
    case 'in': return 'sq in';
    default:   return 'sq m';
  }
}

// ── Single formatter ─────────────────────────────────────────────────────────
//
//  Pass the stored unit string to detect linear vs area vs count.
//  Returns a display string like "12.34 ft" or "3.50 sq m".

export function formatQuantity(
  quantity:    number,
  storedUnit:  string,
  displayUnit: DisplayUnit,
): string {
  const isArea  = storedUnit === 'sq m'  || storedUnit === 'sq ft'
               || storedUnit === 'sq cm' || storedUnit === 'sq mm'
               || storedUnit === 'sq in';
  const isCount = storedUnit === 'EA' || storedUnit === 'PT';

  if (isCount) return `${quantity} ${storedUnit}`;

  if (isArea) {
    const v = convertArea(quantity, displayUnit);
    return `${v.toFixed(2)} ${areaUnitLabel(displayUnit)}`;
  }

  // Linear (m, cm, mm, ft, in)
  const v = convertLength(quantity, displayUnit);
  return `${v.toFixed(2)} ${displayUnit}`;
}
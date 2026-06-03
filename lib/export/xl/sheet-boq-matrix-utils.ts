// sheet-boq-matrix-utils.ts – Helper utilities and constants for BOQ matrix sheet

// ── Column indices (must match Python constants) ───────────────────────────
export const COL_SNO   = 2;
export const COL_DESC  = 3;
export const COL_UNIT  = 4;
export const COL_TIMES = 5;
export const COL_L     = 6;
export const COL_W     = 7;
export const COL_H     = 8;
export const COL_QTY   = 9;
export const MAT_START = 10;

// BASE_H matches Python constant used for label-row height calculation
export const BASE_H = 16;

/**
 * Convert column letter to 1-based number
 * Examples: "A"→1, "C"→3, "AA"→27
 * Used for freeze_panes xSplit instead of string.length
 */
export function columnNameToNumber(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

/**
 * Get default unit categories for material calculation type detection
 */
export function getDefaultUnitCategories(): Record<string, string[]> {
  return {
    area_based:   ['M²', 'm2', 'SQ M', 'SQM', 'M2'],
    volume_based: ['M³', 'm3', 'CU M', 'M3'],
    linear_based: ['LM', 'lm', 'L M', 'M', 'm'],
    count_based:  ['Nr', 'nos', 'PC', 'pcs', 'Each', 'each'],
    pair_based:   ['Pr', 'Pair'],
    set_based:    ['Set', 'Kit', 'Box'],
  };
}

/**
 * Detect calculation type based on unit string
 */
export function getCalculationType(
  unit: string,
  unitCategories: Record<string, string[]>,
): string {
  const u = (unit || '').toUpperCase();
  for (const [calcType, units] of Object.entries(unitCategories)) {
    if (units.some(x => x.toUpperCase() === u)) return calcType;
  }
  if (['NR', 'NOS', 'PC', 'PCS', 'EACH'].includes(u)) return 'count_based';
  if (['PR', 'PAIR'].includes(u))                       return 'pair_based';
  if (['SET', 'KIT', 'BOX'].includes(u))                return 'set_based';
  if (['M²', 'M2', 'SQ M', 'SQM'].includes(u))         return 'area_based';
  if (['M³', 'M3', 'CU M'].includes(u))                 return 'volume_based';
  if (['LM', 'L M', 'M'].includes(u))                   return 'linear_based';
  return 'count_based';
}

// Show a cell value the way Excel would, using its number format (SheetJS SSF, Apache-2.0).

import SSF from 'ssf';
import type { Scalar } from './sheetModel';

export function display(v: Scalar, numFmt?: string): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) return '#NUM!';
  const fmt = numFmt && numFmt !== 'General' ? numFmt : undefined;
  if (!fmt) return Number.isInteger(v) ? String(v) : String(parseFloat(v.toPrecision(10)));
  try { return SSF.format(fmt, v); } catch { return String(v); }
}

export const isError = (v: Scalar) => typeof v === 'string' && /^#[A-Z/0!?]+[!?]?$/.test(v) && v.length <= 8;

/** Number formats offered in the toolbar. `money` is filled in with the project currency. */
export function formatChoices(money: string): Array<{ id: string; label: string; fmt: string }> {
  return [
    { id: 'general', label: 'General', fmt: 'General' },
    { id: 'n0', label: '1,234', fmt: '#,##0' },
    { id: 'n2', label: '1,234.00', fmt: '#,##0.00' },
    { id: 'n3', label: '1,234.000', fmt: '#,##0.000' },
    { id: 'money', label: 'Currency', fmt: money },
    { id: 'pct', label: 'Percent', fmt: '0.0%' },
    { id: 'date', label: 'Date', fmt: 'yyyy-mm-dd' },
  ];
}

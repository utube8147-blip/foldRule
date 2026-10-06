// Takeoff as CSV: every row, then totals by kind of quantity.
import type { TakeoffRow, Material } from '@/types';
import { orderRowsForExport } from './takeoffSheet';

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // Quote when needed; a leading = + - @ would be run as a formula by spreadsheets.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const num = (n: number) => (Number.isFinite(n) ? String(parseFloat(n.toFixed(4))) : '0');

export function takeoffToCsv(input: {
  projectName: string;
  measurements: TakeoffRow[];
  materials?: Material[];
  drawings?: { id: string; name: string }[];
}): string {
  const mats = new Map((input.materials ?? []).map(m => [m.id, m]));
  const drawings = new Map((input.drawings ?? []).map(d => [d.id, d.name]));
  const rate = (r: TakeoffRow) => r.unitRate || (r.materialId ? mats.get(r.materialId)?.unitRate ?? 0 : 0);
  const lines: string[] = [];
  lines.push(['No', 'Description', 'Type', 'Quantity', 'Unit', 'Rate', 'Amount', 'Material', 'Drawing', 'Page', 'Notes'].map(cell).join(','));

  const totals = new Map<string, { qty: number; amount: number; rows: number }>();
  let n = 0, sub = 0, grand = 0;
  for (const { row, level } of orderRowsForExport(input.measurements)) {
    if (level === 0) { n += 1; sub = 0; } else sub += 1;
    const amount = row.isGroupHeader ? 0 : row.quantity * rate(row);
    if (!row.isGroupHeader) {
      grand += amount;
      const key = `${row.type === 'Polygon' || row.type === 'Rectangle' ? 'Area' : row.type}|${row.unit}`;
      const t = totals.get(key) ?? { qty: 0, amount: 0, rows: 0 };
      t.qty += row.quantity; t.amount += amount; t.rows += 1;
      totals.set(key, t);
    }
    lines.push([
      level === 0 ? String(n) : `${n}.${sub}`,
      row.label || row.description,
      row.isGroupHeader ? 'Group' : (row.type === 'Polygon' || row.type === 'Rectangle' ? 'Area' : row.type),
      num(row.quantity), row.unit,
      row.isGroupHeader ? '' : num(rate(row)), row.isGroupHeader ? '' : num(amount),
      row.materialId ? mats.get(row.materialId)?.name ?? '' : '',
      drawings.get(row.drawingId) ?? '', row.pageNumber ?? 1, row.notes ?? '',
    ].map(cell).join(','));
  }

  lines.push('', cell('Summary'), ['Type', 'Unit', 'Rows', 'Total quantity', 'Total amount'].map(cell).join(','));
  for (const [key, t] of [...totals].sort()) {
    const [type, unit] = key.split('|');
    lines.push([type, unit, t.rows, num(t.qty), num(t.amount)].map(cell).join(','));
  }
  lines.push(['Grand total', '', '', '', num(grand)].map(cell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';      // BOM so Excel reads UTF-8 (m², names)
}

export function downloadCsv(csv: string, filename: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename.replace(/\.(xlsx|csv)$/i, '') + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

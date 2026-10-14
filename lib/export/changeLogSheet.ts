// "Change log": who changed which quantity, rate, material or setting, and when.
// Repeated "group added" noise is folded away; names are cleaned to one line.

import type * as ExcelJS from 'exceljs';
import { addSheet, banner, note, headerRow, bodyRow, footer, font, align, Palette } from './theme';
import { cleanName } from './workbookModel';
import { projectLine, type TakeoffExportInput } from './exportTypes';

const WHAT: Record<string, string> = {
  added: 'Added', removed: 'Removed', quantity: 'Quantity', name: 'Renamed', material: 'Material',
  multiplier: 'Times', money: 'Setting', rate: 'Rate', price: 'Price',
};
const TONE: Record<string, string> = { added: 'FF1A5C3A', removed: 'FF9A3412' };

type Entry = NonNullable<TakeoffExportInput['auditLog']>[number];

/** Newest first; drops a "group added" entry logged alongside another change at the same moment. */
export function changeLogEntries(log: Entry[]): Entry[] {
  const at = new Map<string, number>();
  for (const e of log) at.set(e.at, (at.get(e.at) ?? 0) + 1);
  const t = (e: Entry) => { const n = Date.parse(e.at); return Number.isNaN(n) ? 0 : n; };
  return log.map((e, i) => ({ e, i })).sort((a, b) => t(b.e) - t(a.e) || b.i - a.i).map(x => x.e).filter(e => !(e.what === 'added' && e.to === 'group' && (at.get(e.at) ?? 0) > 1));
}

export function addChangeLogSheet(workbook: ExcelJS.Workbook, input: TakeoffExportInput): ExcelJS.Worksheet | null {
  const entries = changeLogEntries(input.auditLog ?? []);
  if (!entries.length) return null;
  const { ws, last } = addSheet(workbook, 'Change log', { widths: [17, 16, 12, 38, 28, 28], landscape: true, freezeBelow: 8, tab: 'FF6C7A8D' });
  banner(ws, last, 'CHANGE LOG  ·  WHO CHANGED WHAT', projectLine(input));
  note(ws, 5, last, '★  Every change to a quantity, rate, material, price or estimate setting, newest first.');
  ws.getRow(6).height = 6;
  headerRow(ws, 7, ['When', 'Who', 'What', 'Item', 'From', 'To'], { center: [4] });
  let r = 8;
  entries.forEach((e, i) => {
    const row = bodyRow(ws, r, last, i % 2 === 1);
    const d = new Date(e.at);
    row.getCell(2).value = Number.isNaN(d.getTime()) ? e.at : d; row.getCell(2).numFmt = 'yyyy-mm-dd hh:mm';
    row.getCell(2).font = font(9, false, Palette.MID_GREY);
    row.getCell(3).value = e.by;
    row.getCell(4).value = WHAT[e.what] ?? e.what; row.getCell(4).alignment = align('center');
    row.getCell(4).font = font(10, true, TONE[e.what] ?? Palette.NAVY);
    row.getCell(5).value = cleanName(e.target);
    row.getCell(6).value = cleanName(e.from); row.getCell(6).font = font(10, false, Palette.MID_GREY);
    row.getCell(7).value = cleanName(e.to);
    r++;
  });
  footer(ws, r, last, 'Times are in the exporting computer\'s clock.');
  ws.autoFilter = { from: { row: 7, column: 2 }, to: { row: 7, column: 7 } };
  return ws;
}

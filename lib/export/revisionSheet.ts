// "Revision changes": for each accepted drawing revision, the quantity of every
// affected item before and after, the difference and what it costs.

import type * as ExcelJS from 'exceljs';
import { excelMoneyFormat } from '@/lib/takeoff/currency';
import { addSheet, banner, note, sectionBar, headerRow, bodyRow, rateCell, moneyCell, totalRow, footer, fitWidth, font, align, Palette, QTY_FMT } from './theme';
import { projectLine, type TakeoffExportInput } from './exportTypes';

const LABEL: Record<string, string> = { changed: 'Changed', added: 'Added', removed: 'Removed', same: 'Same' };
const TONE: Record<string, string> = { added: 'FF1A5C3A', removed: 'FF9A3412', changed: 'FF1A3A5C' };

export function addRevisionSheet(workbook: ExcelJS.Workbook, input: TakeoffExportInput): ExcelJS.Worksheet | null {
  const revisions = (input.revisionChanges ?? []).filter(r => r.lines.some(l => l.status !== 'same'));
  if (!revisions.length) return null;

  const { ws, last } = addSheet(workbook, 'Revision changes', { widths: [46, 11, 13, 13, 13, 8, 14, 18], landscape: true, tab: 'WARN_TEXT' });
  const money = excelMoneyFormat(input.currency);
  banner(ws, last, 'REVISION CHANGES  ·  WHAT EACH NEW DRAWING CHANGED', projectLine(input));
  let r = note(ws, 5, last, '★  Quantities as billed, before and after each accepted drawing revision. Unchanged items are left out.');
  r++;

  for (const rev of revisions) {
    r = sectionBar(ws, r, last, 'Δ', `${rev.record.from.name}  →  ${rev.record.to.name}`, rev.record.at.slice(0, 10), false);
    r = headerRow(ws, r, ['Item', 'Change', 'Before', 'After', 'Difference', 'Unit', 'Rate', 'Cost of change'], { center: [3, 7], right: [4, 5, 6, 8, 9] });
    const first = r;
    let alt = false;
    for (const l of rev.lines) {
      if (l.status === 'same') continue;
      const row = bodyRow(ws, r, last, alt); alt = !alt;
      row.getCell(2).value = l.group ? `${l.description} (${l.group})` : l.description; row.getCell(2).alignment = align('left', true);
      row.getCell(3).value = LABEL[l.status] ?? l.status; row.getCell(3).alignment = align('center');
      row.getCell(3).font = font(10, true, TONE[l.status] ?? Palette.DARK_TEXT);
      row.getCell(4).value = l.before; row.getCell(4).numFmt = QTY_FMT; row.getCell(4).alignment = align('right');
      row.getCell(5).value = l.after;  row.getCell(5).numFmt = QTY_FMT; row.getCell(5).alignment = align('right');
      row.getCell(6).value = { formula: `E${r}-D${r}` }; row.getCell(6).numFmt = `+${QTY_FMT};-${QTY_FMT};0.00`;
      row.getCell(6).font = font(10, true, Palette.NAVY); row.getCell(6).alignment = align('right');
      row.getCell(7).value = l.unit; row.getCell(7).alignment = align('center'); row.getCell(7).font = font(10, false, Palette.MID_GREY);
      rateCell(row.getCell(8), l.rate || null, money);
      moneyCell(row.getCell(9), { formula: `F${r}*H${r}` }, money);
      r++;
    }
    r = totalRow(ws, r, last, { label: 'Net change', labelFrom: 7, valueCol: 9, kind: 'grand', fmt: money, value: { formula: `SUM(I${first}:I${r - 1})` } });
    ws.getRow(r).height = 10; r++;
  }
  footer(ws, r, last, 'Positive = more work than before; negative = less.');
  fitWidth(ws, 2, revisions.flatMap(v => v.lines.map(l => l.group ? `${l.description} (${l.group})` : l.description)), 30, 60);
  return ws;
}

// "Revision changes" worksheet: for each accepted drawing revision, the quantity of
// every affected item before and after, the difference and its cost.

import type * as ExcelJS from 'exceljs';
import { excelMoneyFormat } from '@/lib/takeoff/currency';
import type { TakeoffExportInput } from './takeoffSheet';

const INK = 'FF1F2328', MUTED = 'FF5B6470', RULE = 'FFD0D4DA', HEAD_BG = 'FF26303B', SECTION_BG = 'FFEEF1F4';
const LABEL: Record<string, string> = { changed: 'Changed', added: 'Added', removed: 'Removed', same: 'Same' };

export function addRevisionSheet(workbook: ExcelJS.Workbook, input: TakeoffExportInput): ExcelJS.Worksheet | null {
  const revisions = (input.revisionChanges ?? []).filter(r => r.lines.some(l => l.status !== 'same'));
  if (!revisions.length) return null;

  const ws = workbook.addWorksheet('Revision changes', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  ws.columns = [{ width: 48 }, { width: 11 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 8 }, { width: 14 }, { width: 18 }];
  const money = excelMoneyFormat(input.currency);
  const qty = '#,##0.00';

  ws.mergeCells('A1:H1');
  ws.getCell('A1').value = `${input.projectName} — Revision changes`;
  ws.getCell('A1').font = { bold: true, size: 15, color: { argb: INK } };
  ws.mergeCells('A2:H2');
  ws.getCell('A2').value = 'Quantities as billed, before and after each accepted drawing revision. Unchanged items are left out.';
  ws.getCell('A2').font = { size: 9, italic: true, color: { argb: MUTED } };

  let r = 4;
  for (const rev of revisions) {
    const title = ws.getRow(r);
    ws.mergeCells(`A${r}:H${r}`);
    title.getCell(1).value = `${rev.record.from.name}  →  ${rev.record.to.name}   (${rev.record.at.slice(0, 10)})`;
    title.font = { bold: true, color: { argb: INK } };
    title.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SECTION_BG } };
    r += 1;
    const head = ws.getRow(r);
    ['Item', 'Change', 'Before', 'After', 'Difference', 'Unit', 'Rate', 'Cost of change'].forEach((h, i) => { head.getCell(i + 1).value = h; });
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    for (let c = 1; c <= 8; c++) head.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } };
    [3, 4, 5, 7, 8].forEach(c => { head.getCell(c).alignment = { horizontal: 'right' }; });
    r += 1;
    const first = r;
    for (const l of rev.lines) {
      if (l.status === 'same') continue;
      const row = ws.getRow(r);
      row.getCell(1).value = l.group ? `${l.description} (${l.group})` : l.description;
      row.getCell(2).value = LABEL[l.status] ?? l.status;
      row.getCell(3).value = l.before; row.getCell(3).numFmt = qty;
      row.getCell(4).value = l.after;  row.getCell(4).numFmt = qty;
      row.getCell(5).value = { formula: `D${r}-C${r}` }; row.getCell(5).numFmt = `+${qty};-${qty};0.00`;
      row.getCell(6).value = l.unit;
      row.getCell(7).value = l.rate; row.getCell(7).numFmt = money;
      row.getCell(8).value = { formula: `E${r}*G${r}` }; row.getCell(8).numFmt = money;
      for (let c = 1; c <= 8; c++) row.getCell(c).border = { bottom: { style: 'hair', color: { argb: RULE } } };
      r += 1;
    }
    const total = ws.getRow(r);
    total.getCell(7).value = 'Net change';
    total.getCell(7).alignment = { horizontal: 'right' };
    total.getCell(8).value = { formula: `SUM(H${first}:H${r - 1})` };
    total.getCell(8).numFmt = money;
    total.getCell(8).border = { top: { style: 'thin' }, bottom: { style: 'double' } };
    total.font = { bold: true, color: { argb: INK } };
    r += 3;
  }
  return ws;
}

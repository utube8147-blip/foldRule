// "Value engineering" worksheet: each proposed alternative against the designed
// material, with quantity, both costs, the saving and whether it was accepted.

import type * as ExcelJS from 'exceljs';
import { excelMoneyFormat } from '@/lib/takeoff/currency';
import type { TakeoffExportInput } from './takeoffSheet';

const INK = 'FF1F2328', MUTED = 'FF5B6470', RULE = 'FFD0D4DA', HEAD_BG = 'FF26303B';
const LABEL: Record<string, string> = { proposed: 'Proposed', accepted: 'Accepted', rejected: 'Rejected' };

export function addVeSheet(workbook: ExcelJS.Workbook, input: TakeoffExportInput): ExcelJS.Worksheet | null {
  const ve = input.valueEngineering;
  if (!ve?.lines.length) return null;
  const ws = workbook.addWorksheet('Value engineering', {
    views: [{ state: 'frozen', ySplit: 4 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  ws.columns = [{ width: 34 }, { width: 34 }, { width: 12 }, { width: 7 }, { width: 13 }, { width: 16 }, { width: 13 }, { width: 16 }, { width: 16 }, { width: 9 }, { width: 11 }, { width: 36 }];
  const money = excelMoneyFormat(input.currency);

  ws.mergeCells('A1:L1');
  ws.getCell('A1').value = `${input.projectName} — Value engineering`;
  ws.getCell('A1').font = { bold: true, size: 15, color: { argb: INK } };
  ws.mergeCells('A2:L2');
  ws.getCell('A2').value = 'Alternatives to the designed materials. Quantities are as billed and do not change; accepted alternatives are already in the takeoff and the bill.';
  ws.getCell('A2').font = { size: 9, italic: true, color: { argb: MUTED } };

  const head = ws.getRow(4);
  ['As designed', 'Alternative', 'Quantity', 'Unit', 'Designed rate', 'Designed cost', 'Alt. rate', 'Alt. cost', 'Saving', 'Saving %', 'Status', 'Note']
    .forEach((h, i) => { head.getCell(i + 1).value = h; });
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  for (let c = 1; c <= 12; c++) head.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } };
  [3, 5, 6, 7, 8, 9, 10].forEach(c => { head.getCell(c).alignment = { horizontal: 'right' }; });

  let r = 5;
  for (const l of ve.lines) {
    const row = ws.getRow(r);
    row.getCell(1).value = l.designed;
    row.getCell(2).value = l.alternative;
    row.getCell(3).value = l.quantity; row.getCell(3).numFmt = '#,##0.00';
    row.getCell(4).value = l.unit;
    row.getCell(5).value = l.designedRate; row.getCell(5).numFmt = money;
    row.getCell(6).value = l.designedCost; row.getCell(6).numFmt = money;
    row.getCell(7).value = l.alternativeRate; row.getCell(7).numFmt = money;
    row.getCell(8).value = l.alternativeCost; row.getCell(8).numFmt = money;
    row.getCell(9).value = { formula: `F${r}-H${r}` }; row.getCell(9).numFmt = money;
    row.getCell(10).value = { formula: `IF(F${r}=0,0,I${r}/F${r})` }; row.getCell(10).numFmt = '0.0%';
    row.getCell(11).value = LABEL[l.status] ?? l.status;
    row.getCell(12).value = l.note ?? '';
    if (l.status === 'rejected') row.font = { color: { argb: MUTED } };
    for (let c = 1; c <= 12; c++) row.getCell(c).border = { bottom: { style: 'hair', color: { argb: RULE } } };
    r += 1;
  }
  const last = r - 1;
  r += 1;
  const total = (label: string, formula: string) => {
    const row = ws.getRow(r);
    row.getCell(8).value = label;
    row.getCell(8).alignment = { horizontal: 'right' };
    row.getCell(9).value = { formula };
    row.getCell(9).numFmt = money;
    row.font = { bold: true, color: { argb: INK } };
    r += 1;
  };
  total('Saving accepted', `SUMIF(K5:K${last},"Accepted",I5:I${last})`);
  // Pending options for one material are either/or, so this figure is worked out, not summed.
  const pend = ws.getRow(r);
  pend.getCell(8).value = 'Saving still on offer';
  pend.getCell(8).alignment = { horizontal: 'right' };
  pend.getCell(9).value = ve.pending; pend.getCell(9).numFmt = money;
  pend.font = { bold: true, color: { argb: INK } };
  return ws;
}

// "Value engineering": each proposed alternative against the designed material,
// with quantity, both costs, the saving and whether it was accepted.

import type * as ExcelJS from 'exceljs';
import { excelMoneyFormat } from '@/lib/takeoff/currency';
import { addSheet, banner, note, headerRow, bodyRow, moneyCell, totalRow, footer, fitWidth, font, align, Palette, QTY_FMT } from './theme';
import { projectLine, type TakeoffExportInput } from './exportTypes';

const LABEL: Record<string, string> = { proposed: 'Proposed', accepted: 'Accepted', rejected: 'Rejected' };
const TONE: Record<string, string> = { accepted: 'FF1A5C3A', rejected: 'FF6C7A8D', proposed: 'FF9A6B00' };

export function addVeSheet(workbook: ExcelJS.Workbook, input: TakeoffExportInput): ExcelJS.Worksheet | null {
  const ve = input.valueEngineering;
  if (!ve?.lines.length) return null;
  const { ws, last } = addSheet(workbook, 'Value engineering', {
    widths: [30, 30, 11, 7, 13, 15, 13, 15, 15, 9, 11, 32], landscape: true, tab: 'GREEN_TEXT',
  });
  const money = excelMoneyFormat(input.currency);
  banner(ws, last, 'VALUE ENGINEERING  ·  ALTERNATIVES TO THE DESIGNED MATERIALS', projectLine(input));
  note(ws, 5, last, '★  Quantities are as billed and do not change. Accepted alternatives are already in the takeoff and the bill; proposed ones are options still on the table.');
  ws.getRow(6).height = 6;
  headerRow(ws, 7, ['As designed', 'Alternative', 'Quantity', 'Unit', 'Designed\nrate', 'Designed\ncost', 'Alt.\nrate', 'Alt.\ncost', 'Saving', 'Saving %', 'Status', 'Note'],
    { center: [5, 11, 12], right: [4, 6, 7, 8, 9, 10] });

  let r = 8;
  ve.lines.forEach((l, i) => {
    const row = bodyRow(ws, r, last, i % 2 === 1);
    row.getCell(2).value = l.designed; row.getCell(2).alignment = align('left', true);
    row.getCell(3).value = l.alternative; row.getCell(3).alignment = align('left', true);
    row.getCell(4).value = l.quantity; row.getCell(4).numFmt = QTY_FMT; row.getCell(4).alignment = align('right');
    row.getCell(5).value = l.unit; row.getCell(5).alignment = align('center'); row.getCell(5).font = font(10, false, Palette.MID_GREY);
    for (const [c, v] of [[6, l.designedRate], [7, l.designedCost], [8, l.alternativeRate], [9, l.alternativeCost]] as const) moneyCell(row.getCell(c), v, money);
    moneyCell(row.getCell(10), { formula: `G${r}-I${r}` }, money, true);
    row.getCell(11).value = { formula: `IF(G${r}=0,0,J${r}/G${r})` }; row.getCell(11).numFmt = '0.0%'; row.getCell(11).alignment = align('right');
    row.getCell(12).value = LABEL[l.status] ?? l.status; row.getCell(12).alignment = align('center');
    row.getCell(12).font = font(10, true, TONE[l.status] ?? Palette.DARK_TEXT);
    row.getCell(13).value = l.note ?? ''; row.getCell(13).font = font(9, false, Palette.REMARK, true);
    r++;
  });
  const lastRow = r - 1;
  r++;
  r = totalRow(ws, r, last, { label: 'Saving accepted', labelFrom: 7, valueCol: 10, kind: 'sub', fmt: money, value: { formula: `SUMIF(L8:L${lastRow},"Accepted",J8:J${lastRow})` } });
  // Pending options for one material are either/or, so this figure is worked out, not summed.
  r = totalRow(ws, r, last, { label: 'Saving still on offer', labelFrom: 7, valueCol: 10, kind: 'grand', fmt: money, value: ve.pending });
  footer(ws, r, last, 'Saving = designed cost − alternative cost.');
  fitWidth(ws, 2, ve.lines.map(l => l.designed), 22, 40);
  fitWidth(ws, 3, ve.lines.map(l => l.alternative), 22, 40);
  return ws;
}

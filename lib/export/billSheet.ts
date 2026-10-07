// "Bill of Quantities" worksheet: items by POMI work section, each section carried
// to a summary with VAT. Quantities here are billed (timesed and rounded); the
// Takeoff sheet keeps the measured figures.

import type * as ExcelJS from 'exceljs';
import { buildBill } from '@/lib/takeoff/pomi';
import { excelMoneyFormat } from '@/lib/takeoff/currency';
import type { TakeoffExportInput } from './takeoffSheet';

const INK = 'FF1F2328', MUTED = 'FF5B6470', RULE = 'FFD0D4DA', HEAD_BG = 'FF26303B', SECTION_BG = 'FFEEF1F4';

export function addBillSheet(workbook: ExcelJS.Workbook, input: TakeoffExportInput): ExcelJS.Worksheet | null {
  const bill = buildBill(input.measurements, input.materials);
  if (!bill.length) return null;

  const ws = workbook.addWorksheet('Bill of Quantities', {
    views: [{ state: 'frozen', ySplit: 5 }],
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  ws.columns = [{ width: 7 }, { width: 58 }, { width: 11 }, { width: 7 }, { width: 14 }, { width: 18 }];
  const money = excelMoneyFormat(input.currency);

  ws.mergeCells('A1:F1');
  ws.getCell('A1').value = `${input.projectName} — Bill of Quantities`;
  ws.getCell('A1').font = { bold: true, size: 15, color: { argb: INK } };
  ws.mergeCells('A2:F2');
  ws.getCell('A2').value = [
    input.projectNumber ? `Project no. ${input.projectNumber}` : '', input.location ?? '',
    input.revision ? `Rev ${input.revision}` : '', input.documentDate ?? new Date().toISOString().slice(0, 10),
  ].filter(Boolean).join('   |   ');
  ws.getCell('A2').font = { size: 10, color: { argb: MUTED } };
  ws.mergeCells('A3:F3');
  ws.getCell('A3').value = 'Sections follow the Principles of Measurement (International). Quantities are given to the '
    + 'nearest whole unit (tonnes to two decimal places); measured figures are on the Takeoff sheet.';
  ws.getCell('A3').font = { size: 9, italic: true, color: { argb: MUTED } };
  ws.getCell('A3').alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(3).height = 26;

  const head = ws.getRow(5);
  ['Item', 'Description', 'Quantity', 'Unit', 'Rate', 'Amount'].forEach((h, i) => { head.getCell(i + 1).value = h; });
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } };
  head.height = 20;
  [3, 5, 6].forEach(c => { head.getCell(c).alignment = { horizontal: 'right', vertical: 'middle' }; });

  let r = 6;
  const sectionTotals: { label: string; cell: string }[] = [];
  for (const s of bill) {
    const title = ws.getRow(r);
    title.getCell(1).value = s.code;
    title.getCell(2).value = s.title.toUpperCase();
    title.font = { bold: true, color: { argb: INK } };
    for (let c = 1; c <= 6; c++) title.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SECTION_BG } };
    r += 1;
    const first = r;
    for (const it of s.items) {
      const row = ws.getRow(r);
      row.getCell(1).value = it.ref;
      row.getCell(2).value = it.description;
      row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
      row.getCell(3).value = it.quantity;
      row.getCell(3).numFmt = it.unit === 't' ? '#,##0.00' : '#,##0';
      row.getCell(4).value = it.unit;
      row.getCell(5).value = it.rate;
      row.getCell(5).numFmt = money;
      row.getCell(6).value = { formula: `C${r}*E${r}` };
      row.getCell(6).numFmt = money;
      for (let c = 1; c <= 6; c++) row.getCell(c).border = { bottom: { style: 'hair', color: { argb: RULE } } };
      r += 1;
    }
    const total = ws.getRow(r);
    total.getCell(5).value = 'To summary';
    total.getCell(5).alignment = { horizontal: 'right' };
    total.getCell(6).value = { formula: `SUM(F${first}:F${r - 1})` };
    total.getCell(6).numFmt = money;
    total.getCell(6).border = { top: { style: 'thin' } };
    total.font = { bold: true, color: { argb: INK } };
    sectionTotals.push({ label: s.code ? `${s.code}  ${s.title}` : s.title, cell: `F${r}` });
    r += 2;
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const sumHead = ws.getRow(r);
  sumHead.getCell(2).value = 'SUMMARY';
  sumHead.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  for (let c = 1; c <= 6; c++) sumHead.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } };
  r += 1;
  const firstSum = r;
  for (const t of sectionTotals) {
    ws.getRow(r).getCell(2).value = t.label;
    ws.getRow(r).getCell(6).value = { formula: t.cell };
    ws.getRow(r).getCell(6).numFmt = money;
    r += 1;
  }
  const line = (label: string, formula: string, bold = false) => {
    const row = ws.getRow(r);
    row.getCell(5).value = label;
    row.getCell(5).alignment = { horizontal: 'right' };
    row.getCell(6).value = { formula };
    row.getCell(6).numFmt = money;
    row.font = { bold, color: { argb: INK } };
    r += 1;
  };
  const sub = r;
  line('Subtotal', `SUM(F${firstSum}:F${r - 1})`, true);
  const vat = Math.max(0, Number(input.vatPercent) || 0);
  if (vat > 0) {
    line(`VAT ${vat}%`, `F${sub}*${vat}/100`);
    line('Total', `F${sub}+F${sub + 1}`, true);
  } else line('Total', `F${sub}`, true);
  ws.getRow(r - 1).getCell(6).border = { top: { style: 'thin' }, bottom: { style: 'double' } };
  return ws;
}

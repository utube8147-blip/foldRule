// Three worksheets for whoever signs the number off:
//   "Estimate summary"   measured work → preliminaries → contingency → overheads → profit → VAT
//   "Materials to order" net quantity + waste, converted to how each material is bought
//   "Change log"         who changed which quantity, rate or setting, and when

import type * as ExcelJS from 'exceljs';
import { excelMoneyFormat } from '@/lib/takeoff/currency';
import type { TakeoffExportInput } from './takeoffSheet';

const INK = 'FF1F2328', MUTED = 'FF5B6470', HEAD_BG = 'FF26303B', BAND = 'FFF3F4F6';

function title(ws: ExcelJS.Worksheet, span: string, text: string, sub: string) {
  ws.mergeCells(`A1:${span}1`); ws.getCell('A1').value = text; ws.getCell('A1').font = { bold: true, size: 15, color: { argb: INK } };
  ws.mergeCells(`A2:${span}2`); ws.getCell('A2').value = sub; ws.getCell('A2').font = { size: 9, italic: true, color: { argb: MUTED } };
}
function head(ws: ExcelJS.Worksheet, row: number, labels: string[], right: number[]) {
  const h = ws.getRow(row);
  labels.forEach((l, i) => { const c = h.getCell(i + 1); c.value = l; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } }; });
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  right.forEach(c => { h.getCell(c).alignment = { horizontal: 'right' }; });
}

export function addEstimateSheets(workbook: ExcelJS.Workbook, input: TakeoffExportInput): void {
  const money = excelMoneyFormat(input.currency);
  const est = input.estimate;

  if (est?.lines.length) {
    const ws = workbook.addWorksheet('Estimate summary', { pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    ws.columns = [{ width: 34 }, { width: 10 }, { width: 20 }, { width: 52 }];
    title(ws, 'D', `${input.projectName} — Estimate summary`, `From the measured work to the tender sum${input.currency ? `, in ${input.currency}` : ''}. Amounts as at export; the bill sheets hold the detail.`);
    head(ws, 4, ['', '%', 'Amount', 'Note'], [2, 3]);
    let r = 5;
    for (const l of est.lines) {
      const row = ws.getRow(r++);
      row.getCell(1).value = l.label;
      if (l.percent !== undefined && l.percent !== null) { row.getCell(2).value = l.percent / 100; row.getCell(2).numFmt = '0.0#%'; }
      row.getCell(3).value = l.amount; row.getCell(3).numFmt = money;
      row.getCell(4).value = l.note ?? ''; row.getCell(4).font = { size: 9, color: { argb: MUTED } };
      if (l.total) {
        row.font = { bold: true, color: { argb: INK } };
        for (let c = 1; c <= 4; c++) { row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } }; row.getCell(c).border = { top: { style: 'thin', color: { argb: MUTED } } }; }
      }
    }
    if (est.provisional?.length) {
      r++;
      ws.getCell(`A${r}`).value = 'Provisional sums'; ws.getCell(`A${r}`).font = { bold: true }; r++;
      for (const p of est.provisional) { ws.getCell(`A${r}`).value = p.name; ws.getCell(`C${r}`).value = p.amount; ws.getCell(`C${r}`).numFmt = money; r++; }
    }
  }

  if (est?.order.length) {
    const ws = workbook.addWorksheet('Materials to order', { views: [{ state: 'frozen', ySplit: 4 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    ws.columns = [{ width: 12 }, { width: 40 }, { width: 13 }, { width: 7 }, { width: 9 }, { width: 13 }, { width: 9 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 26 }];
    title(ws, 'K', `${input.projectName} — Materials to order`, 'Net quantity from the bill, plus waste, converted to the unit each material is bought in. Whole packs are rounded up. Material cost only: no labour or equipment.');
    head(ws, 4, ['Code', 'Material', 'Net quantity', 'Unit', 'Waste', 'Order', 'Buy by', 'One covers', 'Price each', 'Cost', 'Supplier'], [3, 5, 6, 8, 9, 10]);
    let r = 5;
    for (const o of est.order) {
      const row = ws.getRow(r);
      row.getCell(1).value = o.code; row.getCell(2).value = o.name;
      row.getCell(3).value = o.net; row.getCell(3).numFmt = '#,##0.00';
      row.getCell(4).value = o.unit;
      row.getCell(5).value = o.wastePercent / 100; row.getCell(5).numFmt = '0.0#%';
      row.getCell(6).value = o.orderQty; row.getCell(6).numFmt = Number.isInteger(o.orderQty) ? '#,##0' : '#,##0.00'; row.getCell(6).font = { bold: true };
      row.getCell(7).value = o.buyUnit;
      row.getCell(8).value = o.covers === 1 ? '' : `${o.covers} ${o.unit}`; row.getCell(8).alignment = { horizontal: 'right' };
      row.getCell(9).value = o.price; row.getCell(9).numFmt = money;
      row.getCell(10).value = { formula: `F${r}*I${r}`, result: o.cost }; row.getCell(10).numFmt = money;
      row.getCell(11).value = o.supplier ?? '';
      r++;
    }
    const t = ws.getRow(r);
    t.getCell(2).value = 'Materials to buy'; t.getCell(10).value = { formula: `SUM(J5:J${r - 1})` }; t.getCell(10).numFmt = money; t.font = { bold: true };
  }

  if (input.auditLog?.length) {
    const ws = workbook.addWorksheet('Change log', { views: [{ state: 'frozen', ySplit: 4 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    ws.columns = [{ width: 20 }, { width: 22 }, { width: 16 }, { width: 44 }, { width: 26 }, { width: 26 }];
    title(ws, 'F', `${input.projectName} — Change log`, 'Every change to a quantity, rate, material, price or estimate setting, newest first.');
    head(ws, 4, ['When', 'Who', 'What', 'Item', 'From', 'To'], []);
    let r = 5;
    for (const e of [...input.auditLog].reverse()) {
      const row = ws.getRow(r++);
      const d = new Date(e.at);
      row.getCell(1).value = Number.isNaN(d.getTime()) ? e.at : d; row.getCell(1).numFmt = 'yyyy-mm-dd hh:mm';
      row.getCell(2).value = e.by; row.getCell(3).value = e.what; row.getCell(4).value = e.target;
      row.getCell(5).value = e.from ?? ''; row.getCell(6).value = e.to ?? '';
    }
  }
}

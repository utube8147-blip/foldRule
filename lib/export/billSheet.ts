// "Bill of Quantities": items by POMI work section, each section carried to a summary
// with (× units,) VAT and total. Quantities are billed (timesed) and given to two
// decimals so the bill adds up to the same money as the Takeoff sheet.

import type * as ExcelJS from 'exceljs';
import { buildBill, type BillSection } from '@/lib/takeoff/pomi';
import { excelMoneyFormat } from '@/lib/takeoff/currency';
import { refRows, addSheet, banner, note, sectionBar, headerRow, bodyRow, qtyCell, rateCell, moneyCell, totalRow, footer, fitWidth, font, align, Palette } from './theme';
import { cleanName } from './workbookModel';
import { projectLine, unitsOf, type TakeoffExportInput } from './exportTypes';
import { TAKEOFF, TK } from './takeoffSheet';

export const BILL = 'Bill of Quantities';

export interface BillSheetRefs {
  sections: Array<{ code: string; title: string; items: number; cell: string }>;
  netCell: string;
  totalCell: string;
}

/**
 * With `takeoff`, each item's quantity is the sum of its Takeoff rows and its rate is their
 * amount ÷ quantity — so a change on the Takeoff carries through to the bill.
 */
export function addBillSheet(workbook: ExcelJS.Workbook, input: TakeoffExportInput, takeoff?: { rowOf: Map<string, number> }): BillSheetRefs | null {
  const bill: BillSection[] = buildBill(input.measurements, input.materials, { round: false });
  if (!bill.length) return null;

  const { ws, last } = addSheet(workbook, BILL, { widths: [8, 58, 12, 7, 14, 17], tab: 'MID_BLUE' });
  const money = excelMoneyFormat(input.currency);
  const units = unitsOf(input);

  banner(ws, last, 'BILL OF QUANTITIES', projectLine(input));
  note(ws, 5, last, `★  Items follow the work sections of the Principles of Measurement (International). Groups whose rows share a unit are billed as one item. Quantities and rates follow the Takeoff sheet${units > 1 ? `; they are per unit (${units} units)` : ''}.`);
  ws.getRow(6).height = 6;
  headerRow(ws, 7, ['Item', 'Description', 'Quantity', 'Unit', 'Rate', 'Amount'], { center: [2, 5], right: [4, 6, 7] });

  let r = 8;
  const sections: BillSheetRefs['sections'] = [];
  for (const s of bill) {
    r = sectionBar(ws, r, last, s.code || '—', s.title, `${s.items.length} item${s.items.length === 1 ? '' : 's'}`);
    const first = r;
    s.items.forEach((it, i) => {
      const row = bodyRow(ws, r, last, i % 2 === 1, Math.max(18, Math.ceil(it.description.length / 62) * 15));
      row.getCell(2).value = it.ref; row.getCell(2).font = font(10, true, Palette.NAVY); row.getCell(2).alignment = align('center');
      row.getCell(3).value = cleanName(it.description); row.getCell(3).alignment = align('left', true);
      const rows = takeoff ? it.rowIds.map(id => takeoff.rowOf.get(id)).filter((x): x is number => !!x) : [];
      const linked = rows.length === it.rowIds.length && rows.length > 0;
      qtyCell(row.getCell(4), linked ? { formula: `SUM(${refRows(TAKEOFF, TK.qty, rows)})`, result: it.measured } : it.quantity);
      row.getCell(5).value = it.unit; row.getCell(5).font = font(10, false, Palette.MID_GREY); row.getCell(5).alignment = align('center');
      rateCell(row.getCell(6), it.rate, money);
      if (linked) row.getCell(6).value = { formula: `IFERROR(SUM(${refRows(TAKEOFF, TK.amount, rows)})/D${r},0)`, result: it.rate };
      moneyCell(row.getCell(7), { formula: `D${r}*F${r}` }, money);
      r++;
    });
    const cell = `G${r}`;
    r = totalRow(ws, r, last, { label: 'Carried to summary', labelFrom: 5, valueCol: 7, kind: 'sub', fmt: money, value: { formula: `SUM(G${first}:G${r - 1})` } });
    sections.push({ code: s.code, title: s.title, items: s.items.length, cell });
    ws.getRow(r).height = 8; r++;
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  r = sectionBar(ws, r, last, 'Σ', 'Summary');
  const firstSum = r;
  sections.forEach((s, i) => {
    const row = bodyRow(ws, r, last, i % 2 === 1);
    row.getCell(2).value = s.code || '—'; row.getCell(2).font = font(10, true, Palette.NAVY); row.getCell(2).alignment = align('center');
    row.getCell(3).value = s.title;
    moneyCell(row.getCell(7), { formula: s.cell }, money);
    r++;
  });
  const sub = r;
  r = totalRow(ws, r, last, { label: units > 1 ? 'Subtotal, one unit' : 'Subtotal', labelFrom: 5, valueCol: 7, kind: 'sub', fmt: money, value: { formula: `SUM(G${firstSum}:G${r - 1})` } });
  let net = sub;
  if (units > 1) { net = r; r = totalRow(ws, r, last, { label: `${units} units`, labelFrom: 5, valueCol: 7, kind: 'sub', fmt: money, value: { formula: `G${sub}*${units}` } }); }
  const vat = Math.max(0, Number(input.vatPercent) || 0);
  let total: number;
  if (vat > 0) {
    r = totalRow(ws, r, last, { label: `VAT ${vat}%`, labelFrom: 5, valueCol: 7, fmt: money, value: { formula: `G${net}*${vat}/100` } });
    total = r;
    r = totalRow(ws, r, last, { label: 'Total', labelFrom: 5, valueCol: 7, kind: 'grand', fmt: money, value: { formula: `G${net}+G${net + 1}` } });
  } else {
    total = r;
    r = totalRow(ws, r, last, { label: 'Total', labelFrom: 5, valueCol: 7, kind: 'grand', fmt: money, value: { formula: `G${net}` } });
  }
  footer(ws, r, last, 'All quantities subject to field verification. Amber rates are still to be priced.');
  fitWidth(ws, 3, bill.flatMap(s => s.items.map(i => i.description)), 36, 62);
  return { sections, netCell: `G${net}`, totalCell: `G${total}` };
}

// ─── lib/export/takeoffSheet.ts ──────────────────────────────────────────────
//
//  "Takeoff": one row per measurement, under its group, with drawing, page,
//  how it was measured, its material, quantity, rate and a live amount formula.
//  Group subtotals, subtotal (× units), VAT and total at the foot.
// ─────────────────────────────────────────────────────────────────────────────

import type * as ExcelJS from 'exceljs';
import { excelMoneyFormat } from '@/lib/takeoff/currency';
import { billUnit } from '@/lib/takeoff/pomi';
import {
  addSheet, banner, note, headerRow, groupRow, bodyRow, qtyCell, rateCell, moneyCell, totalRow, footer,
  fitWidth, font, align, col, Palette,
} from './theme';
import { cleanName, shapeLabel, type WorkbookModel } from './workbookModel';
import { projectLine, unitsOf, type TakeoffExportInput } from './exportTypes';

export type { TakeoffExportInput, TakeoffExportDrawing } from './exportTypes';
export { orderRowsForExport } from './workbookModel';

export const TAKEOFF = 'Takeoff';

// Columns (A is the accent stripe)
export const TK = { item: 2, desc: 3, drawing: 4, page: 5, shape: 6, material: 7, qty: 8, unit: 9, rate: 10, amount: 11, notes: 12, flag: 13 } as const;

export interface TakeoffSheetRefs {
  /** Row number of each measurement, by id. */
  rowOf: Map<string, number>;
  /** Cell holding the grand total (incl. VAT), and the amount before VAT for all units. */
  totalCell: string;
  netCell: string;
}

export function addTakeoffSheet(workbook: ExcelJS.Workbook, input: TakeoffExportInput, model: WorkbookModel): TakeoffSheetRefs {
  const { ws, last } = addSheet(workbook, TAKEOFF, {
    widths: [7, 40, 26, 6, 8, 24, 12, 7, 13, 15, 34],
    landscape: true, freezeBelow: 8, tab: 'FFB8962E',
  });
  ws.getColumn(TK.flag).hidden = true;

  const money = excelMoneyFormat(input.currency);
  const units = unitsOf(input);
  const drawings = new Map(input.drawings.map(d => [d.id, d]));

  banner(ws, last, (input.documentTitle || 'Quantity takeoff').toUpperCase() + '  ·  MEASURED QUANTITIES', projectLine(input));

  const uncalibrated = input.measurements.some(m => {
    if (m.isGroupHeader || !m.points?.length) return false;
    const d = drawings.get(m.drawingId);
    const page = m.pageNumber ?? 1;
    const s = d?.pageScales?.[page] ?? (d && !d.pageScales && d.scaleFactor !== 1 ? d.scaleFactor : undefined);
    return !(s && s > 0);
  });
  note(ws, 5, last, uncalibrated
    ? 'Warning: some quantities were measured on pages without a calibrated scale and are in drawing units, not real-world units.'
    : `★  One line per measurement, grouped as in Foldrule. Quantities include any timesing (see Notes)${units > 1 ? `, and are per unit — ${units} units in total` : ''}. Rate = the row's own rate, else its material's. Amounts are live formulas.`,
    uncalibrated);
  ws.getRow(6).height = 6;

  const HEAD = 7;
  headerRow(ws, HEAD, ['Item', 'Description', 'Drawing', 'Page', 'Measured as', 'Material', 'Quantity', 'Unit', 'Rate', 'Amount', 'Notes'],
    { center: [TK.item, TK.page, TK.shape, TK.unit], right: [TK.qty, TK.rate, TK.amount] });

  // ── Body ──────────────────────────────────────────────────────────────────
  const rowOf = new Map<string, number>();
  let r = HEAD + 1;
  let open: { at: number; first: number } | null = null;
  let alt = false;
  const close = () => {
    if (!open) return;
    const lastChild = r - 1;
    const c = ws.getCell(open.at, TK.amount);
    moneyCell(c, lastChild >= open.first ? { formula: `SUM(${col(TK.amount)}${open.first}:${col(TK.amount)}${lastChild})` } : 0, money, true);
    open = null;
  };

  for (const { row: m, level, item } of model.rows) {
    if (m.isGroupHeader) {
      close();
      groupRow(ws, r, last);
      ws.getCell(r, TK.item).value = item;
      ws.getCell(r, TK.item).alignment = align('center');
      ws.getCell(r, TK.desc).value = cleanName(m.groupName || m.description || m.label) || 'Group';
      ws.getCell(r, TK.drawing).value = model.drawingName(m.drawingId);
      ws.getCell(r, TK.drawing).font = font(9, false, Palette.MID_GREY, true);
      ws.getCell(r, TK.notes).value = m.notes || '';
      ws.getCell(r, TK.flag).value = 1;
      rowOf.set(m.id, r);
      open = { at: r, first: r + 1 };
      alt = false;
      r += 1;
      continue;
    }
    if (level === 0) close();

    const row = bodyRow(ws, r, last, alt);
    alt = !alt;
    const mat = m.materialId ? model.materials.get(m.materialId) : undefined;
    const set = (c: number, v: ExcelJS.CellValue, f?: Partial<ExcelJS.Font>, a?: Partial<ExcelJS.Alignment>) => {
      const cell = row.getCell(c); cell.value = v; if (f) cell.font = f; if (a) cell.alignment = a;
    };
    set(TK.item, item, font(10, true, Palette.NAVY), align('center'));
    set(TK.desc, (level === 1 ? '   ' : '') + (cleanName(m.description || m.label) || 'Untitled'), undefined, align('left', true));
    set(TK.drawing, model.drawingName(m.drawingId), font(9, false, Palette.MID_GREY));
    set(TK.page, m.points?.length ? (m.pageNumber ?? 1) : '', font(9, false, Palette.MID_GREY), align('center'));
    set(TK.shape, m.points?.length ? shapeLabel(m.type) : 'Typed in', font(9, false, Palette.MID_GREY), align('center'));
    set(TK.material, mat ? cleanName(mat.name) : '—', font(10, false, mat ? Palette.DARK_TEXT : Palette.MID_GREY));
    qtyCell(row.getCell(TK.qty), Number.isFinite(m.quantity) ? Number(m.quantity) : 0);
    set(TK.unit, billUnit(m.unit), font(10, false, Palette.MID_GREY), align('center'));
    rateCell(row.getCell(TK.rate), model.rateOf(m), money);
    moneyCell(row.getCell(TK.amount), { formula: `${col(TK.qty)}${r}*${col(TK.rate)}${r}` }, money);
    set(TK.notes, [m.notes, m.isOverridden ? '(quantity typed in)' : ''].filter(Boolean).join(' '), font(9, false, Palette.REMARK, true), align('left', true));
    if (level === 0) ws.getCell(r, TK.flag).value = 1;
    rowOf.set(m.id, r);
    r += 1;
  }
  close();

  if (model.rows.length === 0) {
    bodyRow(ws, r, last, false);
    ws.getCell(r, TK.desc).value = 'No measurements yet.';
    ws.getCell(r, TK.desc).font = font(10, false, Palette.MID_GREY, true);
    r += 1;
  }
  const lastBody = r - 1;

  // ── Totals ────────────────────────────────────────────────────────────────
  r += 1;
  const vat = Math.max(0, Number(input.vatPercent) || 0);
  const A = col(TK.amount);
  const sub = r;
  // Column M flags top-level rows (group headers + ungrouped items) so children are not counted twice.
  r = totalRow(ws, r, last, {
    label: units > 1 ? 'Subtotal, one unit' : 'Subtotal', labelFrom: TK.rate, valueCol: TK.amount, kind: 'sub', fmt: money,
    value: model.rows.length ? { formula: `SUMIF(${col(TK.flag)}${HEAD + 1}:${col(TK.flag)}${lastBody},1,${A}${HEAD + 1}:${A}${lastBody})` } : 0,
  });
  let net = sub;
  if (units > 1) {
    net = r;
    r = totalRow(ws, r, last, { label: `${units} units`, labelFrom: TK.rate, valueCol: TK.amount, kind: 'sub', fmt: money, value: { formula: `${A}${sub}*${units}` } });
  }
  let total = net;
  if (vat > 0) {
    r = totalRow(ws, r, last, { label: `VAT ${vat}%`, labelFrom: TK.rate, valueCol: TK.amount, fmt: money, value: { formula: `${A}${net}*${vat}/100` } });
    total = r;
    r = totalRow(ws, r, last, { label: 'Total', labelFrom: TK.rate, valueCol: TK.amount, kind: 'grand', fmt: money, value: { formula: `${A}${net}+${A}${net + 1}` } });
  } else {
    total = r;
    r = totalRow(ws, r, last, { label: 'Total', labelFrom: TK.rate, valueCol: TK.amount, kind: 'grand', fmt: money, value: { formula: `${A}${net}` } });
  }

  footer(ws, r, last, `Prepared with Foldrule · ${new Date().toISOString().slice(0, 10)} · Amber rates are still to be priced.`);

  fitWidth(ws, TK.desc, model.rows.map(x => cleanName(x.row.description || x.row.groupName)), 30, 54);
  fitWidth(ws, TK.drawing, input.drawings.map(d => d.name), 14, 34);
  fitWidth(ws, TK.material, model.columns.map(c => c.name), 14, 30);
  ws.autoFilter = { from: { row: HEAD, column: TK.item }, to: { row: HEAD, column: TK.notes } };

  return { rowOf, totalCell: `${A}${total}`, netCell: `${A}${net}` };
}

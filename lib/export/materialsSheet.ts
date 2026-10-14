// ─── lib/export/materialsSheet.ts ────────────────────────────────────────────
//
//  "Materials": what to buy. One line per material (and unit) in use:
//    net quantity (live from BOQ_Matrix) → + waste → gross → ÷ sheet / pack size
//    → order quantity (whole sheets / packs) → × price each → purchase cost.
//  Replaces the old "Materials_List" and "Materials to order" sheets.
// ─────────────────────────────────────────────────────────────────────────────

import type * as ExcelJS from 'exceljs';
import { excelMoneyFormat } from '@/lib/takeoff/currency';
import { coverage } from '@/lib/takeoff/materialRate';
import {
  addSheet, banner, note, headerRow, bodyRow, linkCell, rateCell, moneyCell, qtyCell, totalRow, footer, fitWidth,
  fill, font, align, ref, Palette, PCT_FMT, QTY_FMT,
} from './theme';
import type { WorkbookModel } from './workbookModel';
import { MATRIX, type MatrixSheetRefs } from './matrixSheet';
import { projectLine, unitsOf, type TakeoffExportInput } from './exportTypes';

export const MATERIALS = 'Materials';

const K = { no: 2, code: 3, name: 4, unit: 5, net: 6, waste: 7, gross: 8, pack: 9, buy: 10, order: 11, price: 12, cost: 13, supplier: 14, remarks: 15 } as const;

export interface MaterialsSheetRefs {
  /** Cell with the net quantity of each material column, by key. */
  netOf: Map<string, string>;
  costTotal: string;
}

export function addMaterialsSheet(workbook: ExcelJS.Workbook, input: TakeoffExportInput, model: WorkbookModel, matrix: MatrixSheetRefs): MaterialsSheetRefs {
  const { ws, last } = addSheet(workbook, MATERIALS, {
    widths: [5, 11, 30, 7, 12, 8, 12, 11, 9, 11, 13, 15, 18, 34],
    landscape: true, freezeBelow: 8, tab: 'FF1A5C3A',
  });
  const money = excelMoneyFormat(input.currency);
  const units = unitsOf(input);

  banner(ws, last, 'MATERIALS LIST  ·  WHAT TO ORDER', `${projectLine(input)}${units > 1 ? `   ·   ${units} units` : ''}`);
  note(ws, 5, last, `★  Net quantities are live from ${MATRIX} (project totals). Gross = net + waste. Enter a sheet or pack size (amber) and the order rounds up to whole sheets / packs; leave it blank to order the gross quantity. Price each is the material price per "buy by" unit — material only, no labour or equipment.`);
  ws.getRow(6).height = 6;
  headerRow(ws, 7, ['#', 'Code', 'Material', 'Unit', 'Net\nquantity', 'Waste', 'Gross\nquantity', 'Sheet / pack\nsize', 'Buy by', 'Order\nquantity', 'Price each', 'Purchase\ncost', 'Supplier', 'Remarks'],
    { center: [K.no, K.unit, K.waste, K.pack, K.buy], right: [K.net, K.gross, K.order, K.price, K.cost] });

  const netOf = new Map<string, string>();
  let r = 8;
  model.columns.forEach((c, i) => {
    const m = c.material;
    const row = bodyRow(ws, r, last, i % 2 === 1, 20);
    const sold = !!m.purchase && m.purchase.covers > 0 && !c.unitMismatch;
    row.getCell(K.no).value = i + 1; row.getCell(K.no).font = font(10, true, Palette.NAVY); row.getCell(K.no).alignment = align('center');
    row.getCell(K.code).value = m.code || ''; row.getCell(K.code).font = font(9, false, Palette.MID_GREY, true);
    row.getCell(K.name).value = c.name; row.getCell(K.name).alignment = align('left', true);
    row.getCell(K.unit).value = c.unit; row.getCell(K.unit).font = font(10, false, Palette.MID_GREY); row.getCell(K.unit).alignment = align('center');
    linkCell(row.getCell(K.net), ref(MATRIX, matrix.totalOf.get(c.key) ?? 'A1'), QTY_FMT, c.net * units);
    netOf.set(c.key, ref(MATERIALS, `F${r}`));

    const waste = row.getCell(K.waste);
    waste.value = Math.max(0, m.wastePercent ?? 0) / 100; waste.numFmt = PCT_FMT; waste.alignment = align('center');
    waste.fill = fill(Palette.AMBER_HL);
    qtyCell(row.getCell(K.gross), { formula: `F${r}*(1+G${r})` });

    const pack = row.getCell(K.pack);
    pack.value = sold ? coverage(m) : null; pack.numFmt = '#,##0.###'; pack.alignment = align('center');
    pack.fill = fill(Palette.AMBER_HL); pack.font = font(10, false, Palette.CHARCOAL);

    row.getCell(K.buy).value = sold ? (m.purchase!.unit || 'pack') : c.unit;
    row.getCell(K.buy).alignment = align('center'); row.getCell(K.buy).font = font(10, false, Palette.MID_GREY);

    const order = row.getCell(K.order);
    order.value = { formula: `IF(I${r}="",ROUND(H${r},2),CEILING(H${r}/I${r},1))` };
    order.numFmt = QTY_FMT; order.font = font(11, true, Palette.NAVY); order.fill = fill(Palette.PALE_BLUE); order.alignment = align('right');

    if (c.unitMismatch) {
      row.getCell(K.price).value = '—'; row.getCell(K.price).alignment = align('center');
      row.getCell(K.cost).value = '—'; row.getCell(K.cost).alignment = align('center');
    } else {
      rateCell(row.getCell(K.price), m.materialCost || null, money);
      moneyCell(row.getCell(K.cost), { formula: `K${r}*L${r}` }, money);
    }
    row.getCell(K.supplier).value = m.supplier ?? '';
    const remark = c.unitMismatch
      ? `Measured in ${c.unit} but sold per ${c.materialUnit}: convert (e.g. length × girth) before ordering`
      : sold ? `One ${m.purchase!.unit || 'pack'} covers ${coverage(m)} ${c.unit}` : '';
    row.getCell(K.remarks).value = remark;
    row.getCell(K.remarks).font = font(9, false, c.unitMismatch ? Palette.WARN_TEXT : Palette.REMARK, true);
    row.getCell(K.remarks).alignment = align('left', true);
    r++;
  });
  const lastRow = r - 1;
  const costTotal = `M${r}`;
  r = totalRow(ws, r, last, {
    label: 'Materials to buy (excl. VAT)', labelFrom: K.pack, valueCol: K.cost, kind: 'grand', fmt: money,
    value: model.columns.length ? { formula: `SUM(M8:M${lastRow})` } : 0,
  });
  footer(ws, r, last, 'Order quantities include waste and round up to whole sheets / packs where a size is given. Check against site conditions before ordering.');
  fitWidth(ws, K.name, model.columns.map(c => c.name), 20, 40);
  return { netOf, costTotal: ref(MATERIALS, costTotal) };
}

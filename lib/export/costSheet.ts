// ─── lib/export/costSheet.ts ─────────────────────────────────────────────────
//
//  "Cost_Breakdown": the money, material by material.
//    quantity (live from Materials) × unit rate (material + labour + equipment)
//  then items priced without a material, subtotal, VAT, grand total, and a
//  check against the Takeoff total so any difference is visible.
// ─────────────────────────────────────────────────────────────────────────────

import type * as ExcelJS from 'exceljs';
import { excelMoneyFormat } from '@/lib/takeoff/currency';
import { materialPart } from '@/lib/takeoff/materialRate';
import { billUnit } from '@/lib/takeoff/pomi';
import {
  addSheet, banner, note, sectionBar, headerRow, bodyRow, linkCell, rateCell, moneyCell, totalRow, footer, fitWidth,
  font, align, ref, refRows, col, Palette,
} from './theme';
import { cleanName, type WorkbookModel } from './workbookModel';
import type { MaterialsSheetRefs } from './materialsSheet';
import { TAKEOFF, TK, type TakeoffSheetRefs } from './takeoffSheet';
import { projectLine, unitsOf, type TakeoffExportInput } from './exportTypes';

export const COST = 'Cost_Breakdown';

const K = { no: 2, code: 3, desc: 4, unit: 5, qty: 6, mat: 7, lab: 8, eqp: 9, rate: 10, amount: 11, notes: 12 } as const;

export interface CostSheetRefs { netCell: string; totalCell: string }

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function addCostSheet(
  workbook: ExcelJS.Workbook, input: TakeoffExportInput, model: WorkbookModel,
  materials: MaterialsSheetRefs, takeoff: TakeoffSheetRefs,
): CostSheetRefs {
  const { ws, last } = addSheet(workbook, COST, {
    widths: [5, 11, 32, 7, 12, 12, 12, 12, 13, 16, 34],
    landscape: true, tab: 'GOLD_LIGHT',
  });
  const money = excelMoneyFormat(input.currency);
  const units = unitsOf(input);
  const vat = Math.max(0, Number(input.vatPercent) || 0);

  banner(ws, last, 'COST BREAKDOWN  ·  QUANTITIES × UNIT RATES',
    `${projectLine(input)}   ·   ${input.currency || 'Currency not set'}${vat ? `   ·   VAT ${vat}%` : ''}`);
  note(ws, 5, last, '★  Quantities are live from the Materials sheet. Unit rates follow the Takeoff (amount ÷ quantity of each material\'s rows), so a rate changed there changes here; the material / labour / equipment columns show the build-up from the material library. Amber = still to be priced.');
  ws.getRow(6).height = 6;
  headerRow(ws, 7, ['#', 'Code', 'Description', 'Unit', 'Quantity', 'Material\nrate', 'Labour\nrate', 'Equipment\nrate', 'Unit rate', 'Amount', 'Notes'],
    { center: [K.no, K.unit], right: [K.qty, K.mat, K.lab, K.eqp, K.rate, K.amount] });

  let r = 8;
  const amountRows: number[] = [];
  const Q = col(K.qty), R = col(K.rate);

  if (model.columns.length) {
    r = sectionBar(ws, r, last, 'M', 'Materials', `${model.columns.length} line${model.columns.length === 1 ? '' : 's'}`);
    model.columns.forEach((c, i) => {
      const m = c.material;
      const row = bodyRow(ws, r, last, i % 2 === 1, 20);
      row.getCell(K.no).value = i + 1; row.getCell(K.no).font = font(10, true, Palette.NAVY); row.getCell(K.no).alignment = align('center');
      row.getCell(K.code).value = m.code || ''; row.getCell(K.code).font = font(9, false, Palette.MID_GREY, true);
      row.getCell(K.desc).value = c.label; row.getCell(K.desc).alignment = align('left', true);
      row.getCell(K.unit).value = c.unit; row.getCell(K.unit).font = font(10, false, Palette.MID_GREY); row.getCell(K.unit).alignment = align('center');
      linkCell(row.getCell(K.qty), materials.netOf.get(c.key) ?? '0', undefined, c.net * units);

      const parts = [r4(materialPart(m)), r4(m.laborCost ?? 0), r4(m.equipmentCost ?? 0)];
      const built = r4(parts[0] + parts[1] + parts[2]);
      const effective = c.net > 0 ? c.amount / c.net : (m.unitRate ?? 0);
      [K.mat, K.lab, K.eqp].forEach((k, j) => {
        const cell = row.getCell(k);
        cell.value = parts[j] || null; cell.numFmt = money; cell.alignment = align('right');
        cell.font = font(10, false, Palette.CHARCOAL);
      });
      // The rate follows the Takeoff: amount ÷ quantity of this material's rows there.
      const rows = c.rowIds.map(id => takeoff.rowOf.get(id)).filter((x): x is number => !!x);
      const usesParts = built > 0 && Math.abs(built - effective) < 0.005;
      rateCell(row.getCell(K.rate), effective || null, money);
      if (rows.length === c.rowIds.length && rows.length) {
        row.getCell(K.rate).value = {
          formula: `IFERROR(SUM(${refRows(TAKEOFF, TK.amount, rows)})/SUM(${refRows(TAKEOFF, TK.qty, rows)}),0)`,
          result: effective,
        };
      }
      moneyCell(row.getCell(K.amount), { formula: `${Q}${r}*${R}${r}` }, money);
      const notes = [
        c.unitMismatch ? `Measured in ${c.unit}, priced per ${c.materialUnit}` : '',
        !usesParts && built > 0
          ? (c.rateOverridden ? `Rows carry own rates (build-up ${built})` : `Stored rate (build-up ${built})`)
          : '',
        !effective ? 'Not priced yet' : '',
      ].filter(Boolean).join(' · ');
      row.getCell(K.notes).value = notes;
      if (notes.length > 34) row.height = 30;
      row.getCell(K.notes).font = font(9, false, c.unitMismatch ? Palette.WARN_TEXT : Palette.REMARK, true);
      row.getCell(K.notes).alignment = align('left', true);
      amountRows.push(r);
      r++;
    });
    ws.getRow(r).height = 8; r++;
  }

  const priced = model.unassigned;
  if (priced.length) {
    r = sectionBar(ws, r, last, 'O', 'Items without a material', `${priced.length} item${priced.length === 1 ? '' : 's'}`);
    priced.forEach((m, i) => {
      const row = bodyRow(ws, r, last, i % 2 === 1);
      const item = model.rows.find(x => x.row.id === m.id)?.item ?? '';
      row.getCell(K.no).value = item; row.getCell(K.no).font = font(10, true, Palette.NAVY); row.getCell(K.no).alignment = align('center');
      row.getCell(K.desc).value = cleanName(m.description || m.label) || 'Untitled'; row.getCell(K.desc).alignment = align('left', true);
      row.getCell(K.unit).value = billUnit(m.unit); row.getCell(K.unit).font = font(10, false, Palette.MID_GREY); row.getCell(K.unit).alignment = align('center');
      const at = takeoff.rowOf.get(m.id);
      const q = Number.isFinite(m.quantity) ? m.quantity : 0;
      linkCell(row.getCell(K.qty), at ? `${ref(TAKEOFF, `${col(TK.qty)}${at}`)}${units > 1 ? `*${units}` : ''}` : String(q * units), undefined, q * units);
      rateCell(row.getCell(K.rate), model.rateOf(m) || null, money);
      if (at) row.getCell(K.rate).value = { formula: ref(TAKEOFF, `${col(TK.rate)}${at}`), result: model.rateOf(m) };
      moneyCell(row.getCell(K.amount), { formula: `${Q}${r}*${R}${r}` }, money);
      row.getCell(K.notes).value = `Takeoff item ${item}`; row.getCell(K.notes).font = font(9, false, Palette.REMARK, true);
      amountRows.push(r);
      r++;
    });
    ws.getRow(r).height = 8; r++;
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const A = col(K.amount);
  const sub = r;
  r = totalRow(ws, r, last, {
    label: 'Subtotal  (excl. VAT)', labelFrom: K.rate - 2, valueCol: K.amount, kind: 'sub', fmt: money,
    value: amountRows.length ? { formula: amountRows.map(x => `${A}${x}`).join('+') } : 0,
  });
  let total = sub;
  if (vat > 0) {
    r = totalRow(ws, r, last, { label: `VAT  (${vat}%)`, labelFrom: K.rate - 2, valueCol: K.amount, fmt: money, value: { formula: `${A}${sub}*${vat}/100` } });
    total = r;
    r = totalRow(ws, r, last, { label: 'GRAND TOTAL  (incl. VAT)', labelFrom: K.rate - 2, valueCol: K.amount, kind: 'grand', fmt: money, value: { formula: `${A}${sub}+${A}${sub + 1}` } });
  } else {
    total = r;
    r = totalRow(ws, r, last, { label: 'GRAND TOTAL', labelFrom: K.rate - 2, valueCol: K.amount, kind: 'grand', fmt: money, value: { formula: `${A}${sub}` } });
  }
  r++;
  r = totalRow(ws, r, last, { label: 'Check: Takeoff total before VAT', labelFrom: K.rate - 2, valueCol: K.amount, fmt: money, value: { formula: ref(TAKEOFF, takeoff.netCell) } });
  const diff = r;
  r = totalRow(ws, r, last, { label: 'Difference (should be 0)', labelFrom: K.rate - 2, valueCol: K.amount, fmt: money, value: { formula: `ROUND(${A}${sub}-${A}${diff - 1},2)` } });
  ws.getCell(diff, K.amount).font = font(10, true, Palette.WARN_TEXT);

  footer(ws, r, last, 'Rates to be confirmed by the tendering contractor. All quantities are subject to field verification.');
  fitWidth(ws, K.desc, [...model.columns.map(c => c.label), ...priced.map(m => cleanName(m.description))], 24, 46);
  return { netCell: ref(COST, `${A}${sub}`), totalCell: ref(COST, `${A}${total}`) };
}

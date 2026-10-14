// ─── lib/export/summarySheet.ts ──────────────────────────────────────────────
//
//  "Summary": the cover. Project information, who is involved, the drawings,
//  the bill by section, the estimate build-up from measured work to the tender
//  sum (live formulas) and a guide to the other sheets.
//  Replaces the old "Summary" and "Estimate summary" sheets.
// ─────────────────────────────────────────────────────────────────────────────

import type * as ExcelJS from 'exceljs';
import { excelMoneyFormat } from '@/lib/takeoff/currency';
import { buildUp } from '@/lib/takeoff/estimate';
import { addSheet, banner, sectionBar, headerRow, bodyRow, moneyCell, totalRow, footer, fill, font, align, side, ref, Palette, PCT_FMT } from './theme';
import { unitsOf, type TakeoffExportInput } from './exportTypes';
import { BILL, type BillSheetRefs } from './billSheet';
import { TAKEOFF, type TakeoffSheetRefs } from './takeoffSheet';

export const SUMMARY = 'Summary';

/** Columns: B label · C–E value · F amount. */
const S = { label: 2, value: 3, pct: 5, amount: 6 } as const;

export function createSummarySheet(workbook: ExcelJS.Workbook) {
  return addSheet(workbook, SUMMARY, { widths: [26, 34, 16, 12, 20], tab: 'FFB8962E' });
}

export function fillSummarySheet(
  sheet: { ws: ExcelJS.Worksheet; last: number },
  input: TakeoffExportInput,
  refs: { takeoff: TakeoffSheetRefs; bill: BillSheetRefs | null; sheets: Array<{ name: string; about: string }> },
) {
  const { ws, last } = sheet;
  const money = excelMoneyFormat(input.currency);
  const units = unitsOf(input);
  const vat = Math.max(0, Number(input.vatPercent) || 0);
  const date = input.documentDate ?? new Date().toISOString().slice(0, 10);

  let r = banner(ws, last,
    `${(input.documentTitle || 'Bill of quantities').toUpperCase()}${input.projectType && input.projectType !== input.documentTitle ? `  ·  TYPE ${input.projectType}` : ''}`,
    [input.projectName, input.location, input.phase].filter(Boolean).join('   ·   '));
  ws.getRow(r).height = 6; r++;

  // ── key / value rows ──────────────────────────────────────────────────────
  let alt = false;
  const detail = (label: string, value: string) => {
    ws.getRow(r).height = 21;
    const bg = alt ? Palette.PALE_BLUE : Palette.WHITE;
    alt = !alt;
    const thin = side('thin', alt ? 'FFE8E8E8' : 'FFDDEEFF');
    ws.getCell(r, 1).fill = fill(Palette.GOLD);
    const l = ws.getCell(r, S.label);
    l.value = label; l.font = font(9, true, Palette.MID_GREY); l.fill = fill(bg); l.alignment = align('left');
    l.border = { left: side('medium', Palette.GOLD), bottom: thin };
    ws.mergeCells(r, S.value, r, last);
    const v = ws.getCell(r, S.value);
    v.value = value; v.font = font(10, true, Palette.NAVY); v.fill = fill(bg); v.alignment = align('left', true);
    v.border = { right: side('medium', Palette.GOLD), bottom: thin };
    r++;
  };
  const gap = () => { ws.getRow(r).height = 8; r++; };

  r = sectionBar(ws, r, last, '1', 'Project information');
  alt = false;
  const info: Array<[string, string | undefined]> = [
    ['Project', input.projectName],
    ['Project number', input.projectNumber],
    ['Location', input.location],
    ['Phase', input.phase],
    ['Type', input.projectType],
    ['Number of units', units > 1 ? String(units) : undefined],
    ['Date', date],
    ['Revision', input.revision],
    ['Currency / VAT', `${input.currency || '—'}${vat ? `   (VAT ${vat}%)` : '   (no VAT)'}`],
  ];
  for (const [k, v] of info) if (v) detail(k, v);
  const st = input.stakeholders ?? {};
  const people: Array<[string, string | undefined]> = [
    ['Main contractor', st.mainContractor], ['Design consultant', st.designConsultant], ['Supervision', st.supervision],
  ];
  if (people.some(([, v]) => v)) for (const [k, v] of people) detail(k, v || '—');
  gap();

  // ── Drawings ──────────────────────────────────────────────────────────────
  const refsList = (input.drawingReferences ?? []).filter(Boolean);
  const drawingNames = refsList.length ? refsList : input.drawings.map(d => d.name).filter(Boolean);
  r = sectionBar(ws, r, last, '2', 'Drawings', `${drawingNames.length} sheet${drawingNames.length === 1 ? '' : 's'}`);
  alt = false;
  if (drawingNames.length) drawingNames.forEach((d, i) => detail(`Ref ${String(i + 1).padStart(2, '0')}`, d));
  else detail('Ref 01', '—');
  gap();

  // ── Bill by section ───────────────────────────────────────────────────────
  if (refs.bill?.sections.length) {
    r = sectionBar(ws, r, last, '3', 'Bill summary by section');
    r = headerRow(ws, r, ['Section', 'Description', 'Items', '', 'Amount'], { center: [2, 4], right: [6] });
    const first = r;
    refs.bill.sections.forEach((s, i) => {
      const row = bodyRow(ws, r, last, i % 2 === 1, 20);
      row.getCell(2).value = s.code || '—'; row.getCell(2).font = font(10, true, Palette.NAVY); row.getCell(2).alignment = align('center');
      row.getCell(3).value = s.title;
      row.getCell(4).value = s.items; row.getCell(4).alignment = align('center');
      moneyCell(row.getCell(6), { formula: ref(BILL, s.cell) }, money);
      r++;
    });
    r = totalRow(ws, r, last, { label: units > 1 ? 'Total of the bill, one unit' : 'Total of the bill', labelFrom: 3, valueCol: S.amount, kind: 'sub', fmt: money, value: { formula: `SUM(F${first}:F${r - 1})` } });
    gap();
  }

  // ── Estimate build-up (live) ──────────────────────────────────────────────
  r = sectionBar(ws, r, last, '4', 'Estimate  ·  measured work to tender sum');
  r = headerRow(ws, r, ['', 'Note', '', '%', 'Amount'], { right: [5, 6] });
  const lines = input.estimate?.lines?.length
    ? input.estimate.lines
    : buildUp(0, undefined, input.vatPercent).map(l => ({ ...l }));
  const at = new Map<string, number>();
  const F = (key: string) => `F${at.get(key)}`;
  const start = r;
  // Row numbers are fixed before writing so formulas can point forward/back.
  lines.forEach((l, i) => { if (l.key) at.set(l.key, start + i); });
  const hasKeys = lines.every(l => !!l.key);
  lines.forEach((l, i) => {
    const row = r;
    const isTotal = !!l.total;
    const line = bodyRow(ws, r, last, i % 2 === 1, isTotal ? 22 : 19);
    line.getCell(S.label).value = l.label; line.getCell(S.label).font = font(10, isTotal, isTotal ? Palette.NAVY : Palette.DARK_TEXT);
    ws.mergeCells(r, 3, r, 4);
    line.getCell(3).value = l.note ?? ''; line.getCell(3).font = font(9, false, Palette.REMARK, true);
    const pctCell = line.getCell(S.pct);
    const pct = typeof l.percent === 'number' ? l.percent : null;
    if (pct !== null) { pctCell.value = pct / 100; pctCell.numFmt = PCT_FMT; pctCell.fill = fill(Palette.AMBER_HL); pctCell.alignment = align('right'); }
    const P = `E${row}`;
    let formula: string | undefined;
    if (hasKeys) {
      switch (l.key) {
        case 'measured': formula = ref(TAKEOFF, refs.takeoff.netCell); break;
        case 'prelims': formula = pct !== null ? `${F('measured')}*${P}` : undefined; break;
        case 'works': formula = `${F('measured')}+${F('prelims')}+${F('provisional')}`; break;
        case 'contingency': formula = `${F('works')}*${P}`; break;
        case 'overheads': formula = `(${F('works')}+${F('contingency')})*${P}`; break;
        case 'profit': formula = `(${F('works')}+${F('contingency')}+${F('overheads')})*${P}`; break;
        case 'tender': formula = `${F('works')}+${F('contingency')}+${F('overheads')}+${F('profit')}`; break;
        case 'vat': formula = `${F('tender')}*${P}`; break;
        case 'total': formula = `${F('tender')}+${F('vat')}`; break;
      }
    }
    const amount = line.getCell(S.amount);
    moneyCell(amount, formula ? { formula, result: l.amount } : l.amount, money, isTotal);
    if (isTotal) {
      for (let c = 2; c <= last; c++) { ws.getCell(r, c).fill = fill(l.key === 'total' ? Palette.NAVY : Palette.PALE_BLUE); ws.getCell(r, c).border = { top: side('thin', Palette.MID_BLUE) }; }
      if (l.key === 'total') {
        line.getCell(S.label).font = font(12, true, Palette.WHITE);
        amount.font = font(12, true, Palette.GOLD_LIGHT);
      }
    }
    r++;
  });
  if (input.estimate?.provisional?.length) {
    gap();
    r = sectionBar(ws, r, last, '4a', 'Provisional sums');
    alt = false;
    input.estimate.provisional.forEach((p, i) => {
      const row = bodyRow(ws, r, last, i % 2 === 1);
      row.getCell(2).value = p.name; moneyCell(row.getCell(6), p.amount, money); r++;
    });
  }
  gap();

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (input.assumptions?.length) {
    r = sectionBar(ws, r, last, '5', 'General assumptions'); alt = false;
    for (const a of input.assumptions) detail(a.category || 'Note', a.content || '');
    gap();
  }
  if (input.exclusions?.length) {
    r = sectionBar(ws, r, last, '6', 'Excluded from scope'); alt = false;
    for (const e of input.exclusions) detail(e.item || '', e.reason || '');
    gap();
  }

  // ── Sheet guide ───────────────────────────────────────────────────────────
  r = sectionBar(ws, r, last, 'i', 'In this workbook'); alt = false;
  for (const s of refs.sheets) detail(s.name, s.about);

  footer(ws, r, last, 'All quantities subject to field verification. Amber cells are inputs: rates still to price, percentages you can change.');
  ws.pageSetup.printArea = `A1:F${r + 2}`;
  ws.pageSetup.fitToHeight = 1;
}

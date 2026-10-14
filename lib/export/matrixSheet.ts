// ─── lib/export/matrixSheet.ts ───────────────────────────────────────────────
//
//  "BOQ_Matrix": every measured row against one column per material (and unit).
//  A row's quantity is carried into the column of its material, so each column
//  sums to that material's net quantity — per work section, then for the
//  project (× units). Materials and Cost_Breakdown read their quantities here.
// ─────────────────────────────────────────────────────────────────────────────

import type * as ExcelJS from 'exceljs';
import { billUnit } from '@/lib/takeoff/pomi';
import {
  addSheet, banner, note, sectionBar, headerRow, groupRow, bodyRow, qtyCell, fitWidth,
  fill, font, align, side, col, ref, Palette, QTY3_FMT,
} from './theme';
import { TAKEOFF, TK } from './takeoffSheet';
import { cleanName, type WorkbookModel } from './workbookModel';
import { projectLine, unitsOf, type TakeoffExportInput } from './exportTypes';

export const MATRIX = 'BOQ_Matrix';

const M = { sno: 2, desc: 3, unit: 4, times: 5, measured: 6, total: 7, mat: 8 } as const;

export interface MatrixSheetRefs {
  /** Project-total cell of each material column, by column key. */
  totalOf: Map<string, string>;
}

export function addMatrixSheet(workbook: ExcelJS.Workbook, input: TakeoffExportInput, model: WorkbookModel, takeoff?: { rowOf: Map<string, number> }): MatrixSheetRefs {
  const cols = model.columns;
  const REM = M.mat + cols.length;
  const { ws, last } = addSheet(workbook, MATRIX, {
    widths: [8, 40, 7, 7, 11, 12, ...cols.map(() => 14), 34],
    landscape: true, tab: 'NAVY',
  });
  const units = unitsOf(input);
  const T = col(M.times), Q = col(M.measured);

  const type = input.projectType && input.projectType !== input.documentTitle ? input.projectType : '';
  banner(ws, last, `BOQ MATRIX${input.documentTitle ? `  ·  ${input.documentTitle.toUpperCase()}` : ''}${type ? `  ·  TYPE ${type}` : ''}  ·  QUANTITIES BY MATERIAL`, projectLine(input));
  note(ws, 5, last, `★  Measured quantities follow the Takeoff sheet; each row's quantity is carried into its material's column. "Times" multiplies a row (blank = 1). Section totals add up each column${units > 1 ? `; project totals are × ${units} units` : ''}. Materials and Cost_Breakdown take their quantities from the PROJECT TOTALS row.`);
  ws.getRow(6).height = 6;

  const headers = ['S.No', 'Description', 'Unit', 'Times', 'Measured', 'Total QTY', ...cols.map(c => `${c.name}\n${c.unit ? `(${c.unit})` : ''}`.trim()), 'Remarks'];
  const headerOpts = { center: [M.sno, M.unit, M.times, M.measured, M.total, ...cols.map((_, i) => M.mat + i)] };
  headerRow(ws, 7, headers, headerOpts);

  let r = 8;
  const sectionTotalRows: number[] = [];
  for (const s of model.sections) {
    r = sectionBar(ws, r, last, s.code || '—', s.title, `${s.components.length} group${s.components.length === 1 ? '' : 's'}`);
    const first = r;
    for (const comp of s.components) {
      groupRow(ws, r, last);
      ws.getCell(r, M.desc).value = comp.name;
      ws.getCell(r, REM).value = comp.drawing;
      ws.getCell(r, REM).font = font(9, false, Palette.MID_GREY, true);
      for (const c of [M.unit, M.times, M.measured, M.total]) {
        ws.getCell(r, c).value = '—'; ws.getCell(r, c).alignment = align('center');
        ws.getCell(r, c).font = font(10, false, Palette.CHARCOAL);
      }
      r++;
      let alt = false;
      for (const row of comp.rows) {
        const line = bodyRow(ws, r, last, alt);
        alt = !alt;
        const item = model.rows.find(x => x.row.id === row.id)?.item ?? '';
        line.getCell(M.sno).value = item; line.getCell(M.sno).font = font(10, true, Palette.NAVY); line.getCell(M.sno).alignment = align('center');
        line.getCell(M.desc).value = cleanName(row.description || row.label) || 'Untitled'; line.getCell(M.desc).alignment = align('left', true);
        line.getCell(M.unit).value = billUnit(row.unit); line.getCell(M.unit).font = font(10, false, Palette.MID_GREY); line.getCell(M.unit).alignment = align('center');
        const times = line.getCell(M.times);
        times.value = null; times.fill = fill(Palette.AMBER_HL); times.alignment = align('center'); times.font = font(10, true, Palette.GOLD);
        const measured = line.getCell(M.measured);
        const q = Number.isFinite(row.quantity) ? row.quantity : 0;
        const at = takeoff?.rowOf.get(row.id);
        measured.value = at ? { formula: ref(TAKEOFF, `${col(TK.qty)}${at}`), result: q } : q; measured.numFmt = QTY3_FMT;
        measured.font = font(10, false, Palette.DARK_TEXT); measured.alignment = align('right');
        qtyCell(line.getCell(M.total), { formula: `${Q}${r}*IF(${T}${r}<>"",${T}${r},1)` }, QTY3_FMT);
        const c = model.columnOf(row);
        const ci = c ? cols.indexOf(c) : -1;
        if (ci >= 0) {
          const cell = line.getCell(M.mat + ci);
          cell.value = { formula: `${col(M.total)}${r}` }; cell.numFmt = QTY3_FMT;
          cell.fill = fill(Palette.LINK_BG); cell.font = font(10, false, Palette.LINK_BLUE); cell.alignment = align('center');
        }
        const remarks = [row.notes, c?.unitMismatch ? `Measured in ${c.unit}; ${c.name} is sold per ${c.materialUnit}` : ''].filter(Boolean).join(' · ');
        line.getCell(REM).value = remarks; line.getCell(REM).font = font(9, false, c?.unitMismatch ? Palette.WARN_TEXT : Palette.REMARK, true);
        line.getCell(REM).alignment = align('left', true);
        r++;
      }
    }
    // Section total per material column
    const lastRow = r - 1;
    ws.getRow(r).height = 20;
    ws.getCell(r, 1).fill = fill(Palette.GOLD);
    for (let c = 2; c <= last; c++) ws.getCell(r, c).fill = fill(Palette.LIME_HL);
    ws.mergeCells(r, M.sno, r, M.total);
    const lbl = ws.getCell(r, M.sno);
    lbl.value = `Section ${s.code || '—'} total`; lbl.font = font(10, true, Palette.NAVY); lbl.alignment = align('right');
    cols.forEach((_, i) => {
      const L = col(M.mat + i);
      const cell = ws.getCell(r, M.mat + i);
      cell.value = { formula: `SUM(${L}${first}:${L}${lastRow})` }; cell.numFmt = QTY3_FMT;
      cell.font = font(10, true, Palette.NAVY); cell.alignment = align('center');
      cell.border = { top: side('thin', Palette.MID_BLUE), bottom: side('thin', Palette.MID_BLUE) };
    });
    sectionTotalRows.push(r);
    r += 2;
  }

  // ── Project totals ────────────────────────────────────────────────────────
  for (const h of [5, 5]) { ws.getRow(r).height = h; for (let c = 1; c <= last; c++) ws.getCell(r, c).fill = fill(Palette.GOLD); r++; }
  ws.getRow(r).height = 26;
  ws.mergeCells(r, 1, r, last);
  const ban = ws.getCell(r, 1);
  ban.value = 'PROJECT TOTALS  —  All sections'; ban.font = font(13, true, Palette.WHITE); ban.fill = fill(Palette.CHARCOAL); ban.alignment = align('center');
  r++;

  const totalOf = new Map<string, string>();
  const sumRow = (label: string, bg: string, formulaOf: (L: string) => string, grand: boolean) => {
    ws.getRow(r).height = grand ? 28 : 22;
    ws.getCell(r, 1).fill = fill(Palette.GOLD);
    for (let c = 2; c <= last; c++) ws.getCell(r, c).fill = fill(Palette.WHITE);
    ws.mergeCells(r, M.sno, r, M.total);
    const l = ws.getCell(r, M.sno);
    l.value = label; l.font = font(grand ? 12 : 11, true, grand ? Palette.WHITE : Palette.DARK_TEXT); l.fill = fill(grand ? Palette.NAVY : bg); l.alignment = align('right');
    cols.forEach((c, i) => {
      const L = col(M.mat + i);
      const cell = ws.getCell(r, M.mat + i);
      cell.value = { formula: formulaOf(L) }; cell.numFmt = QTY3_FMT;
      cell.font = font(grand ? 12 : 11, true, grand ? Palette.GOLD_LIGHT : Palette.DARK_TEXT);
      cell.fill = fill(grand ? Palette.NAVY : bg); cell.alignment = align('center');
      cell.border = { top: side('medium', Palette.GOLD_LIGHT), bottom: side('medium', Palette.GOLD_LIGHT), left: side('medium', Palette.GOLD_LIGHT), right: side('medium', Palette.GOLD_LIGHT) };
      if (grand) totalOf.set(c.key, `${L}${r}`);
    });
    r++;
  };
  const perUnit = r;
  if (cols.length) {
    const sum = (L: string) => sectionTotalRows.length ? sectionTotalRows.map(x => `${L}${x}`).join('+') : '0';
    if (units > 1) {
      sumRow('Per unit', Palette.LIME_HL, sum, false);
      sumRow(`Total QTY  (× ${units} units)`, Palette.PEACH_HL, L => `${L}${perUnit}*${units}`, true);
    } else {
      sumRow('Total QTY', Palette.PEACH_HL, sum, true);
    }
    // Material names again under the totals, as in the original matrix
    const lines = Math.max(1, ...cols.map(c => c.name.length > 14 ? 3 : 2));
    ws.getRow(r).height = Math.max(40, lines * 14 + 8);
    cols.forEach((c, i) => {
      const cell = ws.getCell(r, M.mat + i);
      cell.value = `${c.name}\n${c.unit ? `(${c.unit})` : ''}`.trim();
      cell.font = font(10, true, Palette.WHITE); cell.fill = fill(Palette.MID_BLUE); cell.alignment = align('center', true);
      cell.border = { top: side('thin', Palette.GOLD_LIGHT), bottom: side('thin', Palette.GOLD_LIGHT), left: side('thin', Palette.GOLD_LIGHT), right: side('thin', Palette.GOLD_LIGHT) };
    });
    r++;
  }

  fitWidth(ws, M.desc, model.sections.flatMap(s => s.components.flatMap(c => [c.name, ...c.rows.map(x => cleanName(x.description))])), 30, 50);
  fitWidth(ws, REM, model.sections.flatMap(s => s.components.map(c => c.drawing)), 24, 44);
  return { totalOf };
}

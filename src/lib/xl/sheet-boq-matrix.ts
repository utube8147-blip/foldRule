// sheet-boq-matrix.ts  –  pixel-perfect match to Python _build_matrix_sheet
//
// FIXES vs previous TypeScript version:
//  FIX-1  bg color strings no longer have 'FF' prefix (was 'FFF8F9FC' → 'F8F9FC', etc.)
//  FIX-2  qtyCell font uses green '1A5C3A', not Colors.DARK_TEXT
//  FIX-3  matched-material cell fill uses '`EBF3FA`', not Colors.PALE_BLUE
//  FIX-4  __value__ sentinel: stored as '__value__:<number>' consistently (unchanged)
//         but writeItem now also handles the plain tuple-style fallback path
//  FIX-5  Two-row gold stripe (10px + 5px) before PROJECT TOTALS banner, matching Python
//  FIX-6  Material-label row written BELOW gtRow (was completely missing)
//  FIX-7  brd applied to every cell in fixture rows (COL_TIMES, COL_QTY, REM_INTERNAL)
//  FIX-8  Merged L→H dim cell in fixture rows gets brd border
//  FIX-9  freeze_panes xSplit uses columnNameToNumber(), not string length
//  FIX-10 countOnlyKeys also checks c.count_only === true (direct boolean flag)

import * as ExcelJS from 'exceljs';
import {
  Colors,
  getColumnLetter,
  createFill,
  createFont,
  createBorder,
  createFullBorder,
  createThickBorder,
} from './styles';
import {
  KitchenSection,
  Fixture,
  SectionGroup,
  MaterialColumn,
  MatrixItem,
  DimensionValue,
} from './types';

// ── Extracted utilities ────────────────────────────────────────────────────
import {
  COL_SNO, COL_DESC, COL_UNIT, COL_TIMES, COL_L, COL_W, COL_H, COL_QTY, MAT_START,
  BASE_H,
  columnNameToNumber,
  getCalculationType,
  getDefaultUnitCategories,
} from './sheet-boq-matrix-utils';

// Re-export for backward compatibility
export {
  COL_SNO, COL_DESC, COL_UNIT, COL_TIMES, COL_L, COL_W, COL_H, COL_QTY, MAT_START,
  BASE_H,
  getDefaultUnitCategories,
};

function detectMaterials(item: MatrixItem, materialRules: any): string[] {
  const spec = (item.specification || '').toLowerCase();
  const desc = (item.description  || '').toLowerCase();
  const detected: string[] = [];

  // ── board_rules (transformed format) ──────────────────────────────────
  const boardRules: any[] = materialRules.board_rules || [];
  for (const rule of boardRules) {
    const tOk = !rule.thickness || spec.includes((rule.thickness as string).toLowerCase());
    const mOk = !rule.material  || spec.includes((rule.material  as string).toLowerCase());
    let cOk = true;
    if (rule.context) {
      const ctx = rule.context;
      cOk = Array.isArray(ctx)
        ? ctx.some((kw: string) => desc.includes(kw.toLowerCase()))
        : desc.includes((ctx as string).toLowerCase());
    }
    if (tOk && mOk && cOk) { detected.push(rule.key); break; }
  }

  // ── fallback: raw sheet_materials format ───────────────────────────────
  if (boardRules.length === 0) {
    for (const rule of (materialRules.sheet_materials || [])) {
      const tOk = !rule.required_thickness || spec.includes(rule.required_thickness.toLowerCase());
      const mOk = !rule.material_type      || spec.includes(rule.material_type.toLowerCase());
      let cOk = true;
      if (rule.context_keywords) {
        cOk = rule.context_keywords.some((kw: string) => desc.includes(kw.toLowerCase()));
      }
      if (tOk && mOk && cOk) { detected.push(rule.material_id); break; }
    }
  }

  // ── addon_rules (transformed format) ──────────────────────────────────
  const addonRules: any[] = materialRules.addon_rules || [];
  for (const rule of addonRules) {
    const trigSpec: string[] = rule.trigger_spec || [];
    const trigDesc: string[] = rule.trigger_desc || [];
    const sf: string | undefined = rule.size_filter;
    const specMatch = trigSpec.some(t => spec.includes(t.toLowerCase()));
    const descMatch = trigDesc.some(t => desc.includes(t.toLowerCase()));
    if (specMatch || descMatch) {
      if (sf) {
        if (spec.includes(sf.toLowerCase()) || desc.includes(sf.toLowerCase())) {
          detected.push(rule.key);
        }
      } else {
        detected.push(rule.key);
      }
    }
  }

  // ── fallback: raw additional_materials format ──────────────────────────
  if (addonRules.length === 0) {
    for (const rule of (materialRules.additional_materials || [])) {
      const trigSpec = rule.triggers_in_specification || [];
      const trigDesc = rule.triggers_in_description   || [];
      const specMatch = trigSpec.some((t: string) => spec.includes(t.toLowerCase()));
      const descMatch = trigDesc.some((t: string) => desc.includes(t.toLowerCase()));
      if (specMatch || descMatch) detected.push(rule.material_id);
    }
  }

  return [...new Set(detected)];
}

function buildQtyFormula(
  unit: string,
  row: number,
  activeDimCols: string[],
  unitCategories: Record<string, string[]>,
): string {
  const timesCol = getColumnLetter(COL_TIMES);
  const calcType = getCalculationType(unit, unitCategories);

  if (calcType === 'area_based') {
    if (activeDimCols.length === 0) {
      return `=IF(${timesCol}${row}<>"",${timesCol}${row},1)`;
    }
    const dimMult = activeDimCols.map(c => `${c}${row}`).join('*');
    return `=IFERROR(${dimMult}*IF(${timesCol}${row}<>"",${timesCol}${row},1),"")`;
  }

  if (calcType === 'volume_based') {
    if (activeDimCols.length < 3) return '""';
    const dimMult = activeDimCols.map(c => `${c}${row}`).join('*');
    return `=IFERROR(${dimMult}*IF(${timesCol}${row}<>"",${timesCol}${row},1),"")`;
  }

  if (calcType === 'linear_based') {
    if (activeDimCols.length > 0) {
      return `=IFERROR(${activeDimCols[0]}${row}*IF(${timesCol}${row}<>"",${timesCol}${row},1),"")`;
    }
    return `=IF(${timesCol}${row}<>"",${timesCol}${row},0)`;
  }

  // count / pair / set
  return `=IF(${timesCol}${row}<>"",${timesCol}${row},0)`;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════════════

export async function buildBOQMatrixSheet(
  workbook: ExcelJS.Workbook,
  doc: any,
  sections: KitchenSection[],
  fixtures: Fixture[],
  sectionMap: Record<string, SectionGroup>,
  materialCols: MaterialColumn[],
  sheetAreaM2: number,
  outputOptions: any,
  unitCategories: Record<string, string[]>,
): Promise<number> {
  const ws = workbook.addWorksheet('BOQ_Matrix');
  ws.views = [{ showGridLines: false }];

  const paddingBottom: number =
    outputOptions?.bottom_padding_rows ?? outputOptions?.padding_bottom ?? 10;

  const materialColumns = materialCols.filter(c => !c.key?.startsWith('_blank'));
  const spacerColumns   = materialCols.filter(c =>  c.key?.startsWith('_blank'));

  // FIX-10: also honour the direct boolean flag set during JSON transformation
  const countOnlyKeys = new Set(
    materialCols
      .filter(c =>
        (c as any).count_only === true ||
        c.calculation_type === 'count_based'  ||
        c.calculation_type === 'pair_based'   ||
        c.calculation_type === 'set_based'    ||
        c.calculation_type === 'fixture_based',
      )
      .map(c => c.key || (c as any).id || ''),
  );

  const REM_INTERNAL = MAT_START + materialColumns.length + spacerColumns.length;
  const TOTAL_COLS   = REM_INTERNAL;

  // ── column-width tracker ───────────────────────────────────────────────
  const colMax: Record<number, number> = {
    1: 0, 2: 10, 3: 46, 4: 9, 5: 9, 6: 9, 7: 9, 8: 9, 9: 17,
  };
  for (let i = 0; i < materialColumns.length; i++) {
    colMax[MAT_START + i] =
      materialColumns[i].column_width ?? (materialColumns[i] as any).width ?? 14;
  }
  for (let i = 0; i < spacerColumns.length; i++) {
    colMax[MAT_START + materialColumns.length + i] = 3.5;
  }
  colMax[REM_INTERNAL] = 34;

  function trackWidth(ci: number, text: string | number | undefined) {
    if (text == null) return;
    for (const line of String(text).split('\n')) {
      colMax[ci] = Math.max(colMax[ci] ?? 10, line.length + 3);
    }
  }

  let currentRow = 1;

  // ── Title row ─────────────────────────────────────────────────────────
  ws.getRow(currentRow).height = 30;
  ws.mergeCells(currentRow, 1, currentRow, REM_INTERNAL);
  const titleCell = ws.getCell(currentRow, 1);
  titleCell.value = [
    `${doc.document_metadata?.title || 'BILL OF QUANTITIES'}`,
    `(TYPE ${doc.kitchen_type || 'N/A'})`,
    '·',
    `${doc.project || doc.name || ''}`,
    '·',
    `${doc.location || ''}`,
    '·',
    `${doc.phase || ''}`,
  ].join('   ');
  titleCell.font      = createFont(14, true, Colors.WHITE);
  titleCell.fill      = createFill(Colors.NAVY);
  titleCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
  currentRow++;

  // ── Info bar (H2 stores total_units) ─────────────────────────────────
  ws.getRow(currentRow).height = 24;
  for (let ci = 1; ci <= TOTAL_COLS; ci++) {
    ws.getCell(currentRow, ci).fill   = createFill(Colors.MID_BLUE);
    ws.getCell(currentRow, ci).border = { bottom: createBorder('medium', Colors.GOLD) };
  }
  ws.getCell(currentRow, COL_H).value = doc.total_kitchen_units ?? 0;
  ws.getCell(currentRow, COL_H).font  = createFont(11, true, Colors.MID_BLUE);
  ws.getCell(currentRow, COL_H).fill  = createFill(Colors.MID_BLUE);
  currentRow++;

  const totalUnitRows: number[] = [];

  // ── writeSectionHeader ────────────────────────────────────────────────
  function writeSectionHeader(row: number, elevation: string, unitType: string, note = ''): number {
    ws.getRow(row).height = 45;
    const goldBorder = createBorder('medium', Colors.GOLD);
    for (let ci = 1; ci <= TOTAL_COLS; ci++) {
      const cell = ws.getCell(row, ci);
      cell.fill      = createFill(Colors.SEC_BAR_BG);
      cell.border    = { top: goldBorder, bottom: goldBorder };
      // Prevent ExcelJS from auto-expanding the row height via wrap
      cell.alignment = { vertical: 'middle', wrapText: false };
    }

    const tagCell = ws.getCell(row, COL_SNO);
    tagCell.value     = `  ${elevation}  `;
    tagCell.font      = createFont(11, true, Colors.SEC_TAG_FG);
    tagCell.fill      = createFill(Colors.SEC_TAG_BG);
    tagCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    tagCell.border    = {
      left:   createBorder('medium', Colors.GOLD),
      right:  createBorder('thin',   Colors.GOLD_LIGHT),
      top:    goldBorder,
      bottom: goldBorder,
    };

    const ttlCell = ws.getCell(row, COL_DESC);
    ttlCell.value     = unitType.toUpperCase();
    ttlCell.font      = createFont(13, true, Colors.WHITE);
    ttlCell.fill      = createFill(Colors.SEC_BAR_BG);
    ttlCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };
    ttlCell.border    = { top: goldBorder, bottom: goldBorder };

    if (note) {
      const nc = ws.getCell(row, REM_INTERNAL);
      nc.value     = note.substring(0, 100);
      nc.font      = createFont(10, false, Colors.SEC_ACCENT, true);
      nc.fill      = createFill(Colors.SEC_BAR_BG);
      nc.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
      nc.border    = { top: goldBorder, bottom: goldBorder };
      trackWidth(REM_INTERNAL, note);
    }
    return row + 1;
  }

  // ── writeColumnHeaders ────────────────────────────────────────────────
  function writeColumnHeaders(row: number) {
    ws.getRow(row).height = 60;
    const hFill  = createFill(Colors.MID_BLUE);
    const hFont  = createFont(11, true, Colors.WHITE);
    // vertical: 'middle' is ExcelJS's correct value (not 'center')
    const hAlign: ExcelJS.Alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    const hBrd   = createThickBorder();

    const headers = ['', 'S.No', 'Description', 'Unit', 'Times', 'L', 'W', 'H', 'Total QTY'];
    for (let ci = 1; ci <= headers.length; ci++) {
      const cell    = ws.getCell(row, ci);
      cell.value     = headers[ci - 1];
      cell.font      = hFont;
      cell.fill      = hFill;
      cell.alignment = hAlign;
      cell.border    = hBrd;
      trackWidth(ci, headers[ci - 1]);
    }

    for (let i = 0; i < materialColumns.length; i++) {
      const ci   = MAT_START + i;
      const hdr  = materialColumns[i].display_name || (materialColumns[i] as any).label || '';
      const cell = ws.getCell(row, ci);
      cell.value     = hdr;
      cell.font      = hFont;
      cell.fill      = hFill;
      cell.alignment = hAlign;
      cell.border    = hBrd;
      trackWidth(ci, hdr);
    }

    for (let i = 0; i < spacerColumns.length; i++) {
      const ci   = MAT_START + materialColumns.length + i;
      const cell = ws.getCell(row, ci);
      cell.fill   = createFill(Colors.CHARCOAL);
      cell.border = hBrd;
    }

    const remCell = ws.getCell(row, REM_INTERNAL);
    remCell.value     = 'Remarks';
    remCell.font      = hFont;
    remCell.fill      = hFill;
    remCell.alignment = hAlign;
    remCell.border    = hBrd;
  }

  // ── writeComponentHeader ──────────────────────────────────────────────
  function writeComponentHeader(
    row: number,
    name: string,
    dims: Record<string, number>,
  ): { row: number; hrefs: Record<string, string> } {
    ws.getRow(row).height = 28;
    for (let ci = 1; ci <= TOTAL_COLS; ci++) {
      ws.getCell(row, ci).fill = createFill(Colors.SUBGRP_BG);
    }

    const nameCell = ws.getCell(row, COL_DESC);
    nameCell.value     = name;
    nameCell.fill      = createFill(Colors.SUBGRP_BG);
    nameCell.font      = createFont(11, true, Colors.MID_BLUE);
    nameCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };
    trackWidth(COL_DESC, name);

    const dimBorder = {
      left:   createBorder('medium', Colors.GOLD),
      right:  createBorder('medium', Colors.GOLD),
      top:    createBorder('thin',   Colors.GOLD),
      bottom: createBorder('thin',   Colors.GOLD),
    };

    const hrefs: Record<string, string> = {};
    const isBackPanel =
      name.toLowerCase().includes('back') || name.toLowerCase().includes('rear');

    for (const { key, col } of [
      { key: 'L', col: COL_L },
      { key: 'W', col: COL_W },
      { key: 'H', col: COL_H },
    ]) {
      const cell = ws.getCell(row, col);
      if (isBackPanel && key === 'H') {
        cell.value     = '—';
        cell.fill      = createFill(Colors.SUBGRP_BG);
        cell.font      = createFont(11, false, Colors.CHARCOAL);
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
        cell.border    = dimBorder;
        continue;
      }
      const val = dims[key];
      if (val !== undefined && val !== null) {
        cell.value      = val;
        cell.fill       = createFill(Colors.GOLD_LIGHT);
        cell.font       = createFont(11, true, Colors.NAVY);
        cell.alignment  = { horizontal: 'center', vertical: 'middle', wrapText: false };
        cell.border     = dimBorder;
        cell.numFmt     = '0.000';
        hrefs[key]      = `$${getColumnLetter(col)}$${row}`;
      } else {
        cell.value     = '—';
        cell.fill      = createFill(Colors.SUBGRP_BG);
        cell.font      = createFont(11, false, Colors.CHARCOAL);
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
        cell.border    = dimBorder;
      }
    }

    return { row: row + 1, hrefs };
  }

  // ── writeItem ─────────────────────────────────────────────────────────
  function writeItem(
    row: number,
    itemNo: string,
    desc: string,
    unit: string,
    timesVal: number | null,
    hrefs: Record<string, string>,
    materialSet: Set<string>,
    remarks: string,
    alt: boolean,
  ) {
    ws.getRow(row).height = 18;

    // FIX-1: plain 6-char hex, no 'FF' prefix
    const bg         = alt ? 'F8F9FC' : Colors.WHITE;
    const borderColor = alt ? 'E8ECF1' : 'EEF2F7';
    const brd = {
      left:   createBorder('thin', borderColor),
      right:  createBorder('thin', borderColor),
      top:    createBorder('thin', borderColor),
      bottom: createBorder('thin', borderColor),
    };

    // S.No
    const snoCell   = ws.getCell(row, COL_SNO);
    snoCell.value   = itemNo;
    snoCell.fill    = createFill(bg);
    snoCell.font    = createFont(10, true, Colors.NAVY);
    snoCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    snoCell.border  = brd;

    // Description
    const descCell   = ws.getCell(row, COL_DESC);
    descCell.value   = desc;
    descCell.fill    = createFill(bg);
    descCell.font    = createFont(10, false, Colors.DARK_TEXT);
    descCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    descCell.border  = brd;
    trackWidth(COL_DESC, desc);

    // Unit
    const unitCell   = ws.getCell(row, COL_UNIT);
    unitCell.value   = unit;
    unitCell.fill    = createFill(bg);
    unitCell.font    = createFont(10, false, Colors.MID_GREY);
    unitCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    unitCell.border  = brd;

    // Times
    const timesCell  = ws.getCell(row, COL_TIMES);
    if (timesVal !== null && timesVal !== 1) {
      timesCell.value = timesVal;
      timesCell.fill  = createFill(Colors.AMBER_HL);
      timesCell.font  = createFont(10, true, Colors.GOLD);
    } else {
      timesCell.value = '';
      timesCell.fill  = createFill(bg);
    }
    timesCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    timesCell.border    = brd;

    // L / W / H with href references
    // FORMULA-FIX: ExcelJS requires { formula: 'expr' } — assigning '=expr' as a
    // plain string stores it as literal text (what was shown in the screenshot).
    const activeDims: string[] = [];
    for (const { key, col } of [
      { key: 'L', col: COL_L },
      { key: 'W', col: COL_W },
      { key: 'H', col: COL_H },
    ]) {
      const hrefVal = hrefs[key];
      const cell    = ws.getCell(row, col);
      if (hrefVal !== undefined && hrefVal !== null) {
        if (typeof hrefVal === 'string' && hrefVal.startsWith('__value__:')) {
          // Literal numeric value (shelf_length override)
          cell.value = parseFloat(hrefVal.substring('__value__:'.length));
          cell.font  = createFont(10, true, 'B8962E');
        } else {
          // hrefVal is like '$F$5' — wrap as ExcelJS formula object (no leading =)
          cell.value = { formula: hrefVal };
          cell.font  = createFont(10, false, '3A5C8A');
        }
        cell.numFmt = '0.000';
        activeDims.push(getColumnLetter(col));
      } else {
        cell.value  = '';
        cell.font   = createFont(10, false, Colors.MID_GREY);
        cell.numFmt = '0.000';
      }
      cell.fill      = createFill(bg);
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
      cell.border    = brd;
    }

    // Total QTY — buildQtyFormula returns '=IFERROR(...)' style string
    // Strip leading '=' and wrap in ExcelJS formula object
    const qtyCell   = ws.getCell(row, COL_QTY);
    const rawQtyFmla = buildQtyFormula(unit, row, activeDims, unitCategories);
    qtyCell.value   = { formula: rawQtyFmla.replace(/^=/, '') };
    qtyCell.font    = createFont(10, true, '1A5C3A');
    qtyCell.fill    = createFill(Colors.GREEN_HL);
    qtyCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    qtyCell.border  = brd;
    qtyCell.numFmt  = '0.000';

    const qtyRef = `${getColumnLetter(COL_QTY)}${row}`;

    // Material columns — also formula objects
    for (let i = 0; i < materialColumns.length; i++) {
      const ci   = MAT_START + i;
      const key  = materialColumns[i].key || (materialColumns[i] as any).id || '';
      const cell = ws.getCell(row, ci);
      if (materialSet.has(key)) {
        cell.value  = { formula: qtyRef };           // e.g. 'I6' — no leading =
        cell.fill   = createFill('EBF3FA');
        cell.font   = createFont(10, false, '2A6496');
        cell.numFmt = '0.000';
      } else {
        cell.fill = createFill(bg);
      }
      cell.border    = brd;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    }

    // Spacer columns
    for (let i = 0; i < spacerColumns.length; i++) {
      const ci   = MAT_START + materialColumns.length + i;
      const cell = ws.getCell(row, ci);
      cell.fill   = createFill(bg);
      cell.border = brd;
    }

    // Remarks
    const remCell   = ws.getCell(row, REM_INTERNAL);
    remCell.value   = remarks;
    remCell.fill    = createFill(bg);
    remCell.font    = createFont(9, false, '8A9BAE', true);  // matches Python MID_GREY-ish
    remCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    remCell.border  = brd;
    trackWidth(REM_INTERNAL, remarks);
  }

  // ── writeSummary ──────────────────────────────────────────────────────
  function writeSummary(puRow: number, totRow: number, iStart: number, iEnd: number) {
    if (materialColumns.length === 0) return;

    ws.getRow(puRow).height = 20;
    const puQty   = ws.getCell(puRow, COL_QTY);
    puQty.value   = 'Per Unit';
    puQty.font    = createFont(11, true);
    puQty.fill    = createFill(Colors.LIME_HL);
    puQty.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };

    for (let i = 0; i < materialColumns.length; i++) {
      const ci   = MAT_START + i;
      const cl   = getColumnLetter(ci);
      const cell = ws.getCell(puRow, ci);
      cell.value     = { formula: `SUM(${cl}${iStart}:${cl}${iEnd})` };
      cell.font      = createFont(11, false);
      cell.fill      = createFill(Colors.LIME_HL);
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
      cell.border    = createFullBorder();
      cell.numFmt    = '0.000';
    }

    ws.getRow(totRow).height = 22;
    const h2Cell   = ws.getCell(totRow, COL_H);
    h2Cell.value   = { formula: 'H2' };
    h2Cell.font    = createFont(13, true, 'FF0000');
    h2Cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };

    const totQty   = ws.getCell(totRow, COL_QTY);
    totQty.value   = 'Total Unit';
    totQty.font    = createFont(11, true);
    totQty.fill    = createFill(Colors.PEACH_HL);
    totQty.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    totQty.border  = createFullBorder();

    for (let i = 0; i < materialColumns.length; i++) {
      const ci   = MAT_START + i;
      const cl   = getColumnLetter(ci);
      const key  = materialColumns[i].key || (materialColumns[i] as any).id || '';
      const cell = ws.getCell(totRow, ci);
      cell.value     = countOnlyKeys.has(key)
        ? { formula: `${cl}${puRow}*H2` }
        : { formula: `${cl}${puRow}*H2/${sheetAreaM2}` };
      cell.font      = createFont(11, false);
      cell.fill      = createFill(Colors.PEACH_HL);
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
      cell.border    = createFullBorder();
      cell.numFmt    = '0.000';
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // PROCESS SECTIONS
  // ══════════════════════════════════════════════════════════════════════

  const descStripPrefixes: string[] =
    doc.material_detection_rules?.desc_strip_prefixes || [];

  for (const sec of sections) {
    const sid     = sec.section_id || '';
    const secNote = sec.notes || '';
    const sg      = sectionMap[sid] || {};
    const elevation = (sg as any).elevation || sid;
    const unitType  = (sg as any).cabinet_type || (sg as any).unit_type || 'Section';

    currentRow = writeSectionHeader(currentRow, elevation, unitType, secNote);
    writeColumnHeaders(currentRow);
    currentRow++;

    const iStart = currentRow;
    let alt = false;

    const components = (sec as any).components || (sec as any).items || [];
    for (const comp of components) {
      const compName = comp.component_name || comp.name || '';
      const rawDims  = comp.dimensions || {};

      const dims: Record<string, number> = {};
      for (const k of ['L', 'W', 'H'] as const) {
        const v = rawDims[k];
        if (v !== undefined && v !== null) {
          dims[k] = typeof v === 'number' ? v : (v as DimensionValue).value;
        }
      }

      const { row: newRow, hrefs } = writeComponentHeader(currentRow, compName, dims);
      currentRow = newRow;

      const items: MatrixItem[] = comp.items || [];
      for (const item of items) {
        let desc = item.description || '';
        for (const prefix of descStripPrefixes) {
          if (desc.startsWith(prefix)) { desc = desc.substring(prefix.length); break; }
        }

        const unit      = item.measurement_unit || (item as any).unit || 'M²';
        const remarks   = item.remarks || '';
        const pc        = (item as any).panel_count;
        const timesVal  = (pc && pc !== 0 && pc !== 1) ? pc : null;

        const assignedMaterial = (item as any).material;
        const materialSet: Set<string> = assignedMaterial
          ? new Set([assignedMaterial])
          : new Set(detectMaterials(item, doc.material_detection_rules || {}));

        // filter hrefs by qty_formula (mirrors Python _filter_hrefs_by_formula)
        const formula = ((item as any).qty_formula || '').toLowerCase();
        const filteredHrefs: Record<string, string> = {};

        if (formula && !formula.includes('fixed') && formula.trim() !== '') {
          for (const [dimKey, href] of Object.entries(hrefs)) {
            const dimData  = rawDims[dimKey as keyof typeof rawDims];
            const dimLabel = (
              dimData && typeof dimData === 'object' && 'label' in dimData
                ? ((dimData as DimensionValue).label || '')
                : ''
            ).toLowerCase();
            if (dimLabel && formula.includes(dimLabel)) {
              filteredHrefs[dimKey] = href;
            }
          }

          const shelf = (item as any).shelf_length;
          if (shelf) {
            const shelfLabel = (typeof shelf === 'object' ? (shelf.label || '') : '').toLowerCase();
            const shelfValue = typeof shelf === 'object' ? shelf.value : shelf;
            if (shelfLabel && formula.includes(shelfLabel)) {
              // FIX-4: colon sentinel, applied to 'L' key matching Python
              filteredHrefs['L'] = `__value__:${shelfValue}`;
            }
          }
        }

        writeItem(
          currentRow,
          item.item_number,
          desc,
          unit,
          timesVal,
          filteredHrefs,
          materialSet,
          remarks,
          alt,
        );
        alt = !alt;
        currentRow++;
      }
    }

    const iEnd  = currentRow - 1;
    const puRow = currentRow;
    const totRow = currentRow + 1;
    writeSummary(puRow, totRow, iStart, iEnd);
    totalUnitRows.push(totRow);
    currentRow += 2;

    ws.getRow(currentRow).height = 10;
    currentRow++;
  }

  // ══════════════════════════════════════════════════════════════════════
  // FIXTURES SECTION
  // ══════════════════════════════════════════════════════════════════════

  if (fixtures && fixtures.length > 0) {
    currentRow = writeSectionHeader(
      currentRow, 'FX', 'Kitchen Fixtures – Installed Items Schedule',
    );

    // FX column header row
    ws.getRow(currentRow).height = 48;
    for (let ci = 1; ci <= TOTAL_COLS; ci++) {
      ws.getCell(currentRow, ci).fill   = createFill(Colors.CHARCOAL);
      ws.getCell(currentRow, ci).border = {
        top:    createBorder('medium', Colors.GOLD),
        bottom: createBorder('medium', Colors.GOLD),
      };
    }
    ws.getCell(currentRow, 1).fill = createFill(Colors.GOLD);

    const matStartCol = MAT_START;
    const matEndCol   = REM_INTERNAL - 1;

    if (matEndCol >= matStartCol) {
      ws.mergeCells(currentRow, matStartCol, currentRow, matEndCol);
      const mc   = ws.getCell(currentRow, matStartCol);
      mc.value   = '— MATERIAL SCOPE N/A  ·  Installed Fixtures Only —';
      mc.font    = createFont(9, false, Colors.MID_GREY, true);
      mc.fill    = createFill(Colors.CHARCOAL);
      mc.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
      mc.border  = {
        top:    createBorder('medium', Colors.GOLD),
        bottom: createBorder('medium', Colors.GOLD),
      };
    }

    const fxHeaders: { col: number; label: string; align: string; size: number }[] = [
      { col: COL_SNO,      label: 'S.No',                align: 'center', size: 9  },
      { col: COL_DESC,     label: 'Description',         align: 'left',   size: 11 },
      { col: COL_UNIT,     label: 'Unit',                align: 'center', size: 9  },
      { col: COL_TIMES,    label: 'Qty / Unit',          align: 'center', size: 10 },
      { col: COL_QTY,      label: 'Total Qty\n(Project)', align: 'center', size: 10 },
      { col: REM_INTERNAL, label: 'Remarks',             align: 'left',   size: 9  },
    ];

    for (const { col, label, align, size } of fxHeaders) {
      const cell   = ws.getCell(currentRow, col);
      cell.value   = label;
      cell.font    = createFont(size, true, Colors.WHITE);
      cell.fill    = createFill(Colors.MID_BLUE);
      cell.alignment = { horizontal: align as ExcelJS.Alignment['horizontal'], vertical: 'middle', wrapText: true };
      cell.border  = {
        top:    createBorder('medium', Colors.GOLD),
        bottom: createBorder('medium', Colors.GOLD),
        left:   createBorder('thin',   Colors.GOLD_LIGHT),
        right:  createBorder('thin',   Colors.GOLD_LIGHT),
      };
      trackWidth(col, label);
    }
    currentRow++;

    let alt = false;
    for (const fx of fixtures) {
      // FIX-1: plain 6-char hex
      const bg          = alt ? 'F2F4F8' : Colors.WHITE;
      const borderColor = alt ? 'DDE3EE' : 'E8EDF5';

      ws.getRow(currentRow).height = 22;
      const brd = {
        left:   createBorder('thin', borderColor),
        right:  createBorder('thin', borderColor),
        top:    createBorder('thin', borderColor),
        bottom: createBorder('thin', borderColor),
      };

      // Fill all cells
      for (let ci = 1; ci <= TOTAL_COLS; ci++) {
        ws.getCell(currentRow, ci).fill   = createFill(bg);
        ws.getCell(currentRow, ci).border = brd;
      }
      ws.getCell(currentRow, 1).fill   = createFill(Colors.GOLD);
      ws.getCell(currentRow, 1).border = { bottom: createBorder('thin', 'E0C060') };

      // S.No
      const snoC    = ws.getCell(currentRow, COL_SNO);
      snoC.value    = fx.item_number;
      snoC.font     = createFont(10, true, Colors.NAVY);
      snoC.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
      snoC.border   = brd;

      // Description
      const descC    = ws.getCell(currentRow, COL_DESC);
      descC.value    = fx.description;
      descC.font     = createFont(10, false, Colors.DARK_TEXT);
      descC.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      descC.border   = brd;
      trackWidth(COL_DESC, fx.description);

      // Unit
      const unitC    = ws.getCell(currentRow, COL_UNIT);
      unitC.value    = fx.measurement_unit || 'Each';
      unitC.font     = createFont(10, false, Colors.MID_GREY);
      unitC.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
      unitC.border   = brd;

      // Qty / Unit
      // FIX-7: border explicitly applied (was missing)
      const qpuC     = ws.getCell(currentRow, COL_TIMES);
      qpuC.value     = fx.quantity_per_unit ?? 1;
      qpuC.font      = createFont(10, true, Colors.NAVY);
      qpuC.fill      = createFill(Colors.PALE_BLUE);  // matches Python "EBF5FB"
      qpuC.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
      qpuC.border    = brd;

      // L→H merged dim cell
      ws.mergeCells(currentRow, COL_L, currentRow, COL_H);
      const dimC     = ws.getCell(currentRow, COL_L);
      dimC.value     = '—';
      dimC.font      = createFont(9, false, Colors.MID_GREY, true);
      dimC.fill      = createFill(bg);
      dimC.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
      // FIX-8: border was missing
      dimC.border    = brd;

      // Total Qty (project)
      // FIX-7: border explicitly applied; FORMULA-FIX: use formula object
      const qtyC     = ws.getCell(currentRow, COL_QTY);
      qtyC.value     = { formula: `${getColumnLetter(COL_TIMES)}${currentRow}*H2` };
      qtyC.font      = createFont(10, true, '1A5C3A');
      qtyC.fill      = createFill(Colors.GREEN_HL);
      qtyC.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
      qtyC.border    = brd;
      qtyC.numFmt    = '0';

      // Material columns merged + '—'
      if (matEndCol >= matStartCol) {
        ws.mergeCells(currentRow, matStartCol, currentRow, matEndCol);
        const mc2   = ws.getCell(currentRow, matStartCol);
        mc2.value   = '—';
        mc2.font    = createFont(9, false, Colors.MID_GREY, true);
        mc2.fill    = createFill('F0F2F5');
        mc2.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
        mc2.border  = brd;
      }

      // Remarks
      // FIX-7: border explicitly applied
      const remC     = ws.getCell(currentRow, REM_INTERNAL);
      remC.value     = fx.remarks || '';
      remC.font      = createFont(9, false, '8A9BAE', true);
      remC.fill      = createFill(bg);
      remC.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      remC.border    = brd;
      trackWidth(REM_INTERNAL, fx.remarks || '');

      alt = !alt;
      currentRow++;
    }

    ws.getRow(currentRow).height = 10;
    currentRow += 2;
  }

  // ══════════════════════════════════════════════════════════════════════
  // GRAND TOTAL SECTION
  // ══════════════════════════════════════════════════════════════════════

  // Gap row
  ws.getRow(currentRow).height = 10;
  currentRow++;

  // FIX-5: Python writes TWO gold rows (10px + 5px) before the CHARCOAL banner
  // Row 1: full-width gold bar (height=5 in Python loop, but set after the gap)
  for (let ci = 1; ci <= TOTAL_COLS; ci++) {
    ws.getCell(currentRow, ci).fill = createFill(Colors.GOLD);
  }
  ws.getRow(currentRow).height = 5;
  currentRow++;

  // Row 2: another thin gold stripe (height=5)
  for (let ci = 1; ci <= TOTAL_COLS; ci++) {
    ws.getCell(currentRow, ci).fill = createFill(Colors.GOLD);
  }
  ws.getRow(currentRow).height = 5;
  currentRow++;

  // "PROJECT TOTALS" banner
  ws.mergeCells(currentRow, 1, currentRow, REM_INTERNAL);
  const totBanner   = ws.getCell(currentRow, 1);
  totBanner.value   = 'PROJECT TOTALS  —  All Sections';
  totBanner.font    = createFont(13, true, Colors.WHITE);
  totBanner.fill    = createFill(Colors.CHARCOAL);
  totBanner.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
  ws.getRow(currentRow).height = 26;
  currentRow++;

  // Grand total data row (this is gtRow)
  const gtRow = currentRow;
  ws.getRow(gtRow).height = 28;

  const gtQty   = ws.getCell(gtRow, COL_QTY);
  gtQty.value   = 'Total QTY';
  gtQty.font    = createFont(12, true, Colors.WHITE);
  gtQty.fill    = createFill(Colors.NAVY);
  gtQty.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
  gtQty.border  = createThickBorder();

  if (materialColumns.length > 0 && totalUnitRows.length > 0) {
    for (let i = 0; i < materialColumns.length; i++) {
      const ci      = MAT_START + i;
      const cl      = getColumnLetter(ci);
      const sumFmla = totalUnitRows.map(r => `${cl}${r}`).join('+');
      const cell    = ws.getCell(gtRow, ci);
      cell.value    = { formula: sumFmla };     // FORMULA-FIX: no leading =
      cell.font     = createFont(12, true, Colors.GOLD);
      cell.fill     = createFill(Colors.NAVY);
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
      cell.border   = createThickBorder();
      cell.numFmt   = '0.000';
    }
  }
  currentRow++;

  // FIX-6: Material label row BELOW gtRow (was completely missing)
  // Height = max(lines-in-header * BASE_H + 10, 56) matching Python
  const maxLines = materialColumns.reduce((acc, col) => {
    const hdr = col.display_name || (col as any).label || '';
    return Math.max(acc, hdr.split('\n').length);
  }, 1);
  ws.getRow(currentRow).height = Math.max(maxLines * BASE_H + 10, 56);

  for (let i = 0; i < materialColumns.length; i++) {
    const ci   = MAT_START + i;
    const hdr  = materialColumns[i].display_name || (materialColumns[i] as any).label || '';
    const cell = ws.getCell(currentRow, ci);
    cell.value     = hdr;
    cell.font      = createFont(11, true, Colors.WHITE);
    cell.fill      = createFill(Colors.MID_BLUE);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border    = createFullBorder();
  }
  currentRow++;

  // Padding rows
  for (let p = 0; p < paddingBottom; p++) {
    currentRow++;
    ws.getRow(currentRow).height = 8;
  }

  // ── Apply column widths ───────────────────────────────────────────────
  for (const [ci, width] of Object.entries(colMax)) {
    const colNum = parseInt(ci, 10);
    if (colNum <= TOTAL_COLS) {
      ws.getColumn(colNum).width = Math.max(width as number, 8);
    }
  }

  // ── Freeze panes ──────────────────────────────────────────────────────
  if (outputOptions?.freeze_panes) {
    const fp = outputOptions.freeze_panes as string;
    const match = fp.match(/^([A-Za-z]+)(\d+)$/);
    if (match) {
      // FIX-9: use columnNameToNumber, not string length
      ws.views = [{
        state:  'frozen',
        xSplit: columnNameToNumber(match[1]),
        ySplit: parseInt(match[2], 10) - 1,
      }];
    }
  }

  return gtRow;
}

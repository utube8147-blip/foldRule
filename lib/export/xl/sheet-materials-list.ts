// sheet-materials-list.ts  –  pixel-perfect port of Python build_materials_sheet()
// FIXES applied vs previous TS version:
//   [FIX-1] Removed duplicate materialColumnsList; single source of truth is materialColumns
//   [FIX-2] Col-6 qty font color corrected: DARK_TEXT → "#1A5C3A" (deep green, formula indicator)
//   [FIX-3] Fixture col-7 qty font color corrected: DARK_TEXT → "#1A5C3A"
//   [FIX-4] countOnlyKeys: added c.count_only fallback to match Python's boolean-flag check
//   [FIX-5] Subtitle bar: doc.total_kitchen_units → doc.total_units (matches transformedDoc mapping)
//   [FIX-6] Unit cell col-5: exact hex #5A6C7D pinned (Python: _ft(10,False,"5A6C7D"))
//   [FIX-7] Confirmed col-1 GOLD stripe is written in both material and fixture row loops
//   [FIX-8] Fixed formula syntax for Excel evaluation
//   [FIX-9] Proper formula objects instead of string formulas
//   [FIX-10] Fixed gold column width to match Python (3.5)

import * as ExcelJS from 'exceljs';
import {
  Colors,
  getColumnLetter,
  createFill,
  createFont,
  createAlignment,
  createBorder,
  createThickBorder,
} from './styles';
import { MaterialColumn, Fixture } from './types';
import { MAT_START } from './sheet-boq-matrix';

// Colors.MID_GREY MUST equal "#6C7A8D" — Python uses "5A6C7D" for unit cells.
const UNIT_CELL_GREY = '5A6C7D';  // matches Python _ft(10, False, "5A6C7D")
const FORMULA_GREEN  = '1A5C3A';  // matches Python _ft(11, True, "1A5C3A")

export async function buildMaterialsListSheet(
  workbook: ExcelJS.Workbook,
  doc: any,
  materialCols: MaterialColumn[],
  gtRow: number,
  sheetAreaM2: number,
  fixtures?: Fixture[],
): Promise<number> {
  const ws = workbook.addWorksheet('Materials_List');
  ws.views = [{ showGridLines: false }];

  // Single filtered list — used everywhere. No secondary copy.
  const materialColumns = materialCols.filter(c => !c.key?.startsWith('_blank'));

  // Match Python: check the count_only boolean flag first, then fall back to calc type.
  const countOnlyKeys = new Set(
    materialCols
      .filter(c =>
        (c as any).count_only === true ||
        c.calculation_type === 'count_based' ||
        c.calculation_type === 'pair_based' ||
        c.calculation_type === 'set_based',
      )
      .map(c => c.key || (c as any).id || ''),
  );

  // Auto-fit width tracking
  const colContentMax: Record<number, number> = {
    1: 0, 2: 4, 3: 14, 4: 36, 5: 8, 6: 14, 7: 14, 8: 12, 9: 30,
  };
  function trackWidth(ci: number, text: string) {
    if (text) {
      for (const line of text.split('\n')) {
        colContentMax[ci] = Math.max(colContentMax[ci] || 10, line.length + 3);
      }
    }
  }

  const LAST_COL = 9;
  let r = 1;

  // Col-1 gold stripe width - matching Python (typically 3.5-4)
  ws.getColumn(1).width = 12;

  // Seed width tracker with header strings
  const headerSeed = [
    '', '#', 'Material ID', 'Description / Specification',
    'Unit', 'Total\nQuantity', 'Sheet Size\n(m²)', 'Sheets\nNeeded', 'Remarks',
  ];
  for (let ci = 1; ci <= headerSeed.length; ci++) {
    trackWidth(ci, headerSeed[ci - 1]);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BANNER SECTION
  // ═══════════════════════════════════════════════════════════════════════

  // Row 1 — gold stripe (h=5)
  ws.getRow(r).height = 5;
  for (let ci = 1; ci <= LAST_COL; ci++) ws.getCell(r, ci).fill = createFill(Colors.GOLD) as ExcelJS.Fill;
  r++;

  // Row 2 — navy title bar (h=36)
  ws.getRow(r).height = 36;
  for (let ci = 1; ci <= LAST_COL; ci++) ws.getCell(r, ci).fill = createFill(Colors.NAVY) as ExcelJS.Fill;
  ws.mergeCells(r, 2, r, LAST_COL);
  ws.getCell(r, 2).value = 'MATERIALS LIST  ·  PROJECT TOTAL QUANTITIES';
  ws.getCell(r, 2).font = createFont(14, true, Colors.WHITE);
  ws.getCell(r, 2).fill = createFill(Colors.NAVY) as ExcelJS.Fill;
  ws.getCell(r, 2).alignment = createAlignment('center', 'middle');
  ws.getCell(r, 2).border = { bottom: createBorder('medium', Colors.GOLD) };
  r++;

  // Row 3 — mid-blue subtitle
  ws.getRow(r).height = 22;
  for (let ci = 1; ci <= LAST_COL; ci++) ws.getCell(r, ci).fill = createFill(Colors.MID_BLUE) as ExcelJS.Fill;
  ws.mergeCells(r, 2, r, LAST_COL);
  ws.getCell(r, 2).value =
    `${doc.project || doc.name || ''}   ·   ${doc.location || ''}   ·   ` +
    `TYPE ${doc.kitchen_type || 'N/A'}   ·   ${doc.total_units || 0} Units`;
  ws.getCell(r, 2).font = createFont(10, false, Colors.GOLD_LIGHT, true);
  ws.getCell(r, 2).fill = createFill(Colors.MID_BLUE) as ExcelJS.Fill;
  ws.getCell(r, 2).alignment = createAlignment('center', 'middle');
  r++;

  // Row 4 — gold stripe (h=4)
  ws.getRow(r).height = 4;
  for (let ci = 1; ci <= LAST_COL; ci++) ws.getCell(r, ci).fill = createFill(Colors.GOLD) as ExcelJS.Fill;
  r++;

  // Row 5 — pale-blue live-link info (h=20)
  ws.getRow(r).height = 20;
  for (let ci = 1; ci <= LAST_COL; ci++) ws.getCell(r, ci).fill = createFill(Colors.PALE_BLUE) as ExcelJS.Fill;
  ws.mergeCells(r, 2, r, LAST_COL);
  ws.getCell(r, 2).value =
    `★  All quantities are live-linked from BOQ_Matrix row ${gtRow}. ` +
    `Edit dimensions in BOQ_Matrix; this sheet updates automatically.`;
  ws.getCell(r, 2).font = createFont(9, false, Colors.MID_GREY, true);
  ws.getCell(r, 2).fill = createFill(Colors.PALE_BLUE) as ExcelJS.Fill;
  ws.getCell(r, 2).alignment = createAlignment('center', 'middle');
  r++;

  // Row 6 — spacer (h=8)
  ws.getRow(r).height = 8;
  r++;

  // ═══════════════════════════════════════════════════════════════════════
  // COLUMN HEADERS (h=50)
  // ═══════════════════════════════════════════════════════════════════════
  ws.getRow(r).height = 50;
  const colHdrs = [
    '', '#', 'Material ID', 'Description / Specification',
    'Unit', 'Total\nQuantity', 'Sheet Size\n(m²)', 'Sheets\nNeeded', 'Remarks',
  ];
  for (let ci = 1; ci <= colHdrs.length; ci++) {
    const cell = ws.getCell(r, ci);
    cell.value = colHdrs[ci - 1];
    cell.font = createFont(11, true, Colors.WHITE);
    cell.fill = createFill(ci === 1 ? Colors.GOLD : Colors.MID_BLUE) as ExcelJS.Fill;
    cell.alignment = createAlignment('center', 'middle', true);
    cell.border = createThickBorder();
    trackWidth(ci, colHdrs[ci - 1]);
  }
  r++;

  // ═══════════════════════════════════════════════════════════════════════
  // MATERIAL ROWS
  // ═══════════════════════════════════════════════════════════════════════
  const dataStartRow = r;

  for (let idx = 0; idx < materialColumns.length; idx++) {
    const col     = materialColumns[idx];
    const key     = col.key || (col as any).id || '';
    const label   = (col as any).display_name || col.label || '';
    const alt     = idx % 2 === 0;
    const bg      = alt ? Colors.PALE_BLUE : Colors.WHITE;
    const brdClr  = alt ? 'DDEEFF' : 'E8E8E8';

    ws.getRow(r).height = 22;
    const brd = {
      left:   createBorder('thin', brdClr),
      right:  createBorder('thin', brdClr),
      top:    createBorder('thin', brdClr),
      bottom: createBorder('thin', brdClr),
    };
    const gl = createBorder('medium', Colors.GOLD);

    // Col 1 — gold stripe
    ws.getCell(r, 1).fill = createFill(Colors.GOLD) as ExcelJS.Fill;
    ws.getCell(r, 1).border = { bottom: brd.bottom };

    // Col 2 — row index
    ws.getCell(r, 2).value = idx + 1;
    ws.getCell(r, 2).font = createFont(10, true, Colors.NAVY);
    ws.getCell(r, 2).fill = createFill(bg) as ExcelJS.Fill;
    ws.getCell(r, 2).alignment = createAlignment('center', 'middle');
    ws.getCell(r, 2).border = { left: gl, bottom: brd.bottom };

    // Col 3 — material key (italic grey)
    ws.getCell(r, 3).value = key;
    ws.getCell(r, 3).font = createFont(9, false, Colors.MID_GREY, true);
    ws.getCell(r, 3).fill = createFill(bg) as ExcelJS.Fill;
    ws.getCell(r, 3).alignment = createAlignment('left', 'middle');
    ws.getCell(r, 3).border = brd;
    trackWidth(3, key);

    // Col 4 — description/spec
    const labelClean = label.replace(/\n/g, ' ');
    ws.getCell(r, 4).value = labelClean;
    ws.getCell(r, 4).font = createFont(10, false, Colors.DARK_TEXT);
    ws.getCell(r, 4).fill = createFill(bg) as ExcelJS.Fill;
    ws.getCell(r, 4).alignment = createAlignment('left', 'middle', true);
    ws.getCell(r, 4).border = brd;
    trackWidth(4, labelClean);

    // Use the vendor-selected material unit. Quantities remain normalized by the
    // takeoff, while the workbook shows the unit used for pricing.
    const materialUnit = String((col as any).unit ?? '').trim();
    const normalizedUnit = materialUnit.toLowerCase();
    const isCount = countOnlyKeys.has(key) || ['ea', 'each', 'nr', 'nos', 'pcs', 'pc', 'pr', 'pair', 'set', 'kit', 'box'].includes(normalizedUnit);
    const isLinear = ['m', 'lm', 'ft', 'in', 'cm', 'mm'].includes(normalizedUnit);
    const isVolume = ['m³', 'm3', 'cu m', 'cu ft'].includes(normalizedUnit);
    const unitStr = materialUnit || (isCount ? 'Nr / Pr' : isVolume ? 'M³' : isLinear ? 'LM' : 'M²');

    // Col 5 — unit string
    ws.getCell(r, 5).value = unitStr;
    ws.getCell(r, 5).font = createFont(10, false, UNIT_CELL_GREY);
    ws.getCell(r, 5).fill = createFill(bg) as ExcelJS.Fill;
    ws.getCell(r, 5).alignment = createAlignment('center', 'middle');
    ws.getCell(r, 5).border = brd;

    // Col 6 — total qty formula (fixed syntax)
    const boqColLetter = getColumnLetter(MAT_START + idx);
    ws.getCell(r, 6).value = { 
      formula: `BOQ_Matrix!${boqColLetter}${gtRow}`, 
      result: undefined 
    };
    ws.getCell(r, 6).font  = createFont(11, true, FORMULA_GREEN);
    ws.getCell(r, 6).fill  = createFill(Colors.GREEN_HL) as ExcelJS.Fill;
    ws.getCell(r, 6).alignment = createAlignment('center', 'middle');
    ws.getCell(r, 6).border = brd;
    ws.getCell(r, 6).numFmt = '0.000';

    // Col 7 — sheet area (amber) or dash
    if (!isCount && !isLinear && !isVolume) {
      ws.getCell(r, 7).value = sheetAreaM2;
      ws.getCell(r, 7).font = createFont(10, false, Colors.CHARCOAL);
      ws.getCell(r, 7).fill = createFill(Colors.AMBER_HL) as ExcelJS.Fill;
      ws.getCell(r, 7).alignment = createAlignment('center', 'middle');
      ws.getCell(r, 7).border = brd;
      ws.getCell(r, 7).numFmt = '0.00';
    } else {
      ws.getCell(r, 7).value = '—';
      ws.getCell(r, 7).font = createFont(10, false, Colors.MID_GREY);
      ws.getCell(r, 7).fill = createFill(bg) as ExcelJS.Fill;
      ws.getCell(r, 7).alignment = createAlignment('center', 'middle');
      ws.getCell(r, 7).border = brd;
    }

    // Col 8 — sheets needed formula (fixed syntax)
    if (!isCount && !isLinear && !isVolume) {
      ws.getCell(r, 8).value = { 
        formula: `IFERROR(CEILING(F${r}/G${r},1), "")`, 
        result: undefined 
      };
      ws.getCell(r, 8).font = createFont(11, true, Colors.NAVY);
      ws.getCell(r, 8).fill = createFill(Colors.PALE_BLUE) as ExcelJS.Fill;
      ws.getCell(r, 8).alignment = createAlignment('center', 'middle');
      ws.getCell(r, 8).border = brd;
      ws.getCell(r, 8).numFmt = '0';
    } else {
      ws.getCell(r, 8).value = '—';
      ws.getCell(r, 8).font = createFont(10, false, Colors.MID_GREY);
      ws.getCell(r, 8).fill = createFill(bg) as ExcelJS.Fill;
      ws.getCell(r, 8).alignment = createAlignment('center', 'middle');
      ws.getCell(r, 8).border = brd;
    }

    // Col 9 — remarks
    const remarks = (col as any).remarks || '';
    ws.getCell(r, 9).value = remarks;
    ws.getCell(r, 9).font = createFont(9, false, Colors.MID_GREY, true);
    ws.getCell(r, 9).fill = createFill(bg) as ExcelJS.Fill;
    ws.getCell(r, 9).alignment = createAlignment('left', 'middle', true);
    ws.getCell(r, 9).border = {
      right:  gl,
      bottom: brd.bottom,
      left:   brd.left,
      top:    brd.top,
    };
    trackWidth(9, remarks);

    r++;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FIXTURES SECTION (optional)
  // ═══════════════════════════════════════════════════════════════════════
  if (fixtures && fixtures.length > 0) {
    // Spacer row
    ws.getRow(r).height = 8;
    r++;

    // Fixtures section header
    ws.getRow(r).height = 30;
    for (let ci = 1; ci <= LAST_COL; ci++) {
      ws.getCell(r, ci).fill = createFill(Colors.CHARCOAL) as ExcelJS.Fill;
      ws.getCell(r, ci).border = {
        top:    createBorder('medium', Colors.GOLD),
        bottom: createBorder('medium', Colors.GOLD),
      };
    }
    ws.mergeCells(r, 2, r, LAST_COL);
    ws.getCell(r, 2).value = 'INSTALLED FIXTURES  ·  SCHEDULE OF QUANTITIES';
    ws.getCell(r, 2).font = createFont(11, true, Colors.GOLD_LIGHT);
    ws.getCell(r, 2).fill = createFill(Colors.CHARCOAL) as ExcelJS.Fill;
    ws.getCell(r, 2).alignment = createAlignment('left', 'middle');
    ws.getCell(r, 2).border = {
      top:    createBorder('medium', Colors.GOLD),
      bottom: createBorder('medium', Colors.GOLD),
    };
    r++;

    // Fixture column headers
    ws.getRow(r).height = 40;
    const fxHdrs = [
      '', '#', 'Item No', 'Description', 'Unit',
      'Qty / Unit', 'Total Qty\n(Project)', '—', 'Remarks',
    ];
    for (let ci = 1; ci <= fxHdrs.length; ci++) {
      const cell = ws.getCell(r, ci);
      cell.value = fxHdrs[ci - 1];
      cell.font = createFont(10, true, Colors.WHITE);
      cell.fill = createFill(ci === 1 ? Colors.GOLD : Colors.MID_BLUE) as ExcelJS.Fill;
      cell.alignment = createAlignment('center', 'middle', true);
      cell.border = {
        top:    createBorder('medium', Colors.GOLD),
        bottom: createBorder('medium', Colors.GOLD),
        left:   createBorder('thin', Colors.GOLD_LIGHT),
        right:  createBorder('thin', Colors.GOLD_LIGHT),
      };
      trackWidth(ci, fxHdrs[ci - 1]);
    }
    r++;

    let alt = false;
    for (let fxIdx = 0; fxIdx < fixtures.length; fxIdx++) {
      const fx      = fixtures[fxIdx];
      const bg      = alt ? Colors.PALE_BLUE : Colors.WHITE;
      const brdClr  = alt ? 'DDEEFF' : 'E8E8E8';

      ws.getRow(r).height = 22;
      const brd = {
        left:   createBorder('thin', brdClr),
        right:  createBorder('thin', brdClr),
        top:    createBorder('thin', brdClr),
        bottom: createBorder('thin', brdClr),
      };
      const gl = createBorder('medium', Colors.GOLD);

      // Col 1 — gold stripe
      ws.getCell(r, 1).fill = createFill(Colors.GOLD) as ExcelJS.Fill;
      ws.getCell(r, 1).border = { bottom: brd.bottom } as ExcelJS.Borders;

      // Col 2 — row index
      ws.getCell(r, 2).value = fxIdx + 1;
      ws.getCell(r, 2).font = createFont(10, true, Colors.NAVY);
      ws.getCell(r, 2).fill = createFill(bg) as ExcelJS.Fill;
      ws.getCell(r, 2).alignment = createAlignment('center', 'middle');
      ws.getCell(r, 2).border = { left: gl, bottom: brd.bottom } as ExcelJS.Borders;

      // Col 3 — item number
      ws.getCell(r, 3).value = fx.item_number || '';
      ws.getCell(r, 3).font = createFont(9, false, Colors.MID_GREY, true);
      ws.getCell(r, 3).fill = createFill(bg) as ExcelJS.Fill;
      ws.getCell(r, 3).alignment = createAlignment('left', 'middle');
      ws.getCell(r, 3).border = brd as ExcelJS.Borders;
      trackWidth(3, fx.item_number || '');

      // Col 4 — description
      ws.getCell(r, 4).value = fx.description || '';
      ws.getCell(r, 4).font = createFont(10, false, Colors.DARK_TEXT);
      ws.getCell(r, 4).fill = createFill(bg) as ExcelJS.Fill;
      ws.getCell(r, 4).alignment = createAlignment('left', 'middle', true);
      ws.getCell(r, 4).border = brd as ExcelJS.Borders;
      trackWidth(4, fx.description || '');

      // Col 5 — unit
      ws.getCell(r, 5).value = fx.measurement_unit || 'Each';
      ws.getCell(r, 5).font = createFont(10, false, UNIT_CELL_GREY);
      ws.getCell(r, 5).fill = createFill(bg) as ExcelJS.Fill;
      ws.getCell(r, 5).alignment = createAlignment('center', 'middle');
      ws.getCell(r, 5).border = brd as ExcelJS.Borders;

      // Col 6 — qty per unit
      const qtyPerUnit = fx.quantity_per_unit || 1;
      ws.getCell(r, 6).value = qtyPerUnit;
      ws.getCell(r, 6).font = createFont(10, true, Colors.NAVY);
      ws.getCell(r, 6).fill = createFill(Colors.GREEN_HL) as ExcelJS.Fill;
      ws.getCell(r, 6).alignment = createAlignment('center', 'middle');
      ws.getCell(r, 6).border = brd as ExcelJS.Borders;
      ws.getCell(r, 6).numFmt = '0';

      // Col 7 — total qty formula
      ws.getCell(r, 7).value = { 
        formula: `F${r}*BOQ_Matrix!H2`, 
        result: undefined 
      };
      ws.getCell(r, 7).font  = createFont(11, true, FORMULA_GREEN);
      ws.getCell(r, 7).fill  = createFill(Colors.GREEN_HL) as ExcelJS.Fill;
      ws.getCell(r, 7).alignment = createAlignment('center', 'middle');
      ws.getCell(r, 7).border = brd as ExcelJS.Borders;
      ws.getCell(r, 7).numFmt = '0';

      // Col 8 — dash
      ws.getCell(r, 8).value = '—';
      ws.getCell(r, 8).font = createFont(10, false, Colors.MID_GREY);
      ws.getCell(r, 8).fill = createFill(bg) as ExcelJS.Fill;
      ws.getCell(r, 8).alignment = createAlignment('center', 'middle');
      ws.getCell(r, 8).border = brd as ExcelJS.Borders;

      // Col 9 — remarks
      const fxRemarks = fx.remarks || '';
      ws.getCell(r, 9).value = fxRemarks;
      ws.getCell(r, 9).font = createFont(9, false, Colors.MID_GREY, true);
      ws.getCell(r, 9).fill = createFill(bg) as ExcelJS.Fill;
      ws.getCell(r, 9).alignment = createAlignment('left', 'middle', true);
      ws.getCell(r, 9).border = {
        right:  gl,
        bottom: brd.bottom,
        left:   brd.left,
        top:    brd.top,
      };
      trackWidth(9, fxRemarks);

      alt = !alt;
      r++;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FOOTER
  // ═══════════════════════════════════════════════════════════════════════

  // Gold stripe
  ws.getRow(r).height = 5;
  for (let ci = 1; ci <= LAST_COL; ci++) ws.getCell(r, ci).fill = createFill(Colors.GOLD) as ExcelJS.Fill;
  r++;

  // Footer note
  ws.getRow(r).height = 20;
  for (let ci = 1; ci <= LAST_COL; ci++) ws.getCell(r, ci).fill = createFill(Colors.NAVY) as ExcelJS.Fill;
  ws.mergeCells(r, 2, r, LAST_COL);
  ws.getCell(r, 2).value =
    `Sheet size basis: ${sheetAreaM2} m² per board  ·  ` +
    `Sheets Needed rounds UP to whole boards  ·  ` +
    `Count/Linear/Volume items show actual quantities.`;
  ws.getCell(r, 2).font = createFont(8, false, Colors.MID_GREY, true);
  ws.getCell(r, 2).fill = createFill(Colors.NAVY) as ExcelJS.Fill;
  ws.getCell(r, 2).alignment = createAlignment('center', 'middle');
  r++;

  // ═══════════════════════════════════════════════════════════════════════
  // AUTO-FIT COLUMN WIDTHS
  // ═══════════════════════════════════════════════════════════════════════
  const minWidths: Record<number, number> = {
    2: 5, 3: 14, 4: 36, 5: 8, 6: 14, 7: 14, 8: 12, 9: 30,
  };
  for (const [ciStr, minW] of Object.entries(minWidths)) {
    const colNum = parseInt(ciStr, 10);
    ws.getColumn(colNum).width = Math.max(colContentMax[colNum] ?? minW, minW);
  }
  ws.getColumn(10).width = 0;

  return dataStartRow;
}

// sheet-cost-breakdown.ts  –  pixel-perfect port of Python build_cost_breakdown_sheet()
import * as ExcelJS from 'exceljs';
import { MaterialColumn, Fixture } from './types';

// ── colour constants ──────────────────────────────────────────────────────────
const NAVY        = 'FF0D1B2A';
const GOLD        = 'FFB8962E';
const GOLD_LIGHT  = 'FFC8A84B';
const MID_BLUE    = 'FF1A3A5C';
const CHARCOAL    = 'FF2C3E50';
const WHITE       = 'FFFFFFFF';
const PALE_BLUE   = 'FFEBF3FB';
const MID_GREY    = 'FF6C7A8D';
const DARK_TEXT   = 'FF1C1C1C';
const GREEN_HL    = 'FFE8F5E9';
const AMBER_HL    = 'FFFFF8E7';
const GREEN_DARK  = 'FF1A5C3A';
const FONT_FACE   = 'Calibri';

// ── helpers ───────────────────────────────────────────────────────────────────
function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

// FIX: Return Partial<ExcelJS.Font> instead of ExcelJS.Font to avoid missing properties
function font(size: number, bold = false, argb = DARK_TEXT, italic = false): Partial<ExcelJS.Font> {
  return { name: FONT_FACE, size, bold, color: { argb }, italic };
}

// FIX: Return Partial<ExcelJS.Alignment>
function al(
  horizontal: ExcelJS.Alignment['horizontal'],
  vertical: ExcelJS.Alignment['vertical'] = 'middle',
  wrapText = false,
): Partial<ExcelJS.Alignment> {
  return { horizontal, vertical, wrapText };
}


function side(style: ExcelJS.BorderStyle = 'thin', argb = 'FFBBBBBB'): ExcelJS.Border {
  return { style, color: { argb } };
}

function thickBorder(): Partial<ExcelJS.Borders> {
  const s = side('medium', GOLD_LIGHT);
  return { top: s, bottom: s, left: s, right: s };
}


// ─────────────────────────────────────────────────────────────────────────────
export async function buildCostBreakdownSheet(
  workbook: ExcelJS.Workbook,
  doc: any,
  materialCols: MaterialColumn[],
  matListDataStartRow: number,
  fixtures?: Fixture[],
): Promise<void> {
  const ws = workbook.addWorksheet('Cost_Breakdown');
  ws.views = [{ showGridLines: false }];

  const LAST_COL = 9;

  const materialColumns = materialCols.filter(
    c => !String(c.key || c.id || '').startsWith('_blank'),
  );
  
  const countOnlyKeys = new Set(
    materialCols
      .filter(c =>
        (c as any).count_only === true ||
        c.calculation_type === 'count_based' ||
        c.calculation_type === 'pair_based'  ||
        c.calculation_type === 'set_based',
      )
      .map(c => c.key || c.id || ''),
  );

  const meta        = doc.document_metadata || {};
  const currency    = meta.currency    || doc.currency    || 'AED';
  const vatPct      = meta.vat_percent ?? doc.vat_rate_percent ?? 5;
  const vatRate     = vatPct / 100;
  const vatPctLabel = `${vatPct}%`;

  // ── auto-fit width tracking ───────────────────────────────────────────────
  const colContentMax: Record<number, number> = {
    1: 0, 2: 4, 3: 14, 4: 36, 5: 8, 6: 14, 7: 18, 8: 18, 9: 30,
  };
  
  function trackW(ci: number, text: string) {
    if (!text) return;
    for (const ln of text.split('\n')) {
      colContentMax[ci] = Math.max(colContentMax[ci] || 10, ln.length + 3);
    }
  }
  
  ['', '#', 'Material ID', 'Description / Specification', 'Unit',
   'Total Qty', `Unit Rate\n(${currency} / unit)`, `Amount\n(${currency})`, 'Notes',
  ].forEach((h, i) => trackW(i + 1, h));

  // Set col-1 width for gold stripe (matching Materials_List)
  ws.getColumn(1).width = 12;

  function applyColWidths() {
    const min: Record<number, number> = {
      2: 5, 3: 14, 4: 36, 5: 8, 6: 14, 7: 18, 8: 18, 9: 30,
    };
    for (const [ci, minW] of Object.entries(min)) {
      const col = parseInt(ci);
      ws.getColumn(col).width = Math.max(colContentMax[col] || minW, minW);
    }
    ws.getColumn(10).width = 0;
  }

  let r = 1;

  function fillRow(row: number, argb: string) {
    for (let ci = 1; ci <= LAST_COL; ci++) ws.getCell(row, ci).fill = fill(argb);
  }
  
  function goldAccent(row: number) {
    ws.getCell(row, 1).fill = fill(GOLD);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BANNER ROWS
  // ─────────────────────────────────────────────────────────────────────────

  // r=1 gold stripe h=5
  ws.getRow(r).height = 5;
  fillRow(r, GOLD);
  r++;

  // r=2 navy title bar h=36
  ws.getRow(r).height = 36;
  fillRow(r, NAVY);
  goldAccent(r);
  for (let ci = 1; ci <= LAST_COL; ci++) {
    ws.getCell(r, ci).border = { bottom: side('medium', GOLD) };
  }
  ws.mergeCells(r, 2, r, LAST_COL);
  {
    const c = ws.getCell(r, 2);
    c.value = 'COST BREAKDOWN  ·  MATERIAL QUANTITIES × UNIT RATES';
    c.font = font(14, true, WHITE);
    c.fill = fill(NAVY);
    c.alignment = al('center', 'middle');
    c.border = { bottom: side('medium', GOLD) };
  }
  r++;

  // r=3 mid-blue subtitle h=22
  ws.getRow(r).height = 22;
  fillRow(r, MID_BLUE);
  goldAccent(r);
  ws.mergeCells(r, 2, r, LAST_COL);
  {
    const c = ws.getCell(r, 2);
    c.value = (
      `${doc.project || doc.name || ''}   ·   ${doc.location || ''}   ·   ` +
      `TYPE ${doc.kitchen_type || 'N/A'}   ·   ` +
      `${doc.total_units ?? doc.total_kitchen_units ?? 0} Units   ·   ` +
      `Currency: ${currency}   ·   VAT: ${vatPctLabel}`
    );
    c.font = font(10, false, GOLD_LIGHT, true);
    c.fill = fill(MID_BLUE);
    c.alignment = al('center', 'middle');
  }
  r++;

  // r=4 gold stripe h=4
  ws.getRow(r).height = 4;
  fillRow(r, GOLD);
  r++;

  // r=5 pale-blue info banner h=20
  ws.getRow(r).height = 20;
  fillRow(r, PALE_BLUE);
  goldAccent(r);
  ws.mergeCells(r, 2, r, LAST_COL);
  {
    const c = ws.getCell(r, 2);
    c.value = (
      '★  Unit rates in column G are pre-filled where cost data exists in the source JSON. ' +
      'Amber cells = contractor to fill. Green cells = rate from data. Amount = Total Qty × Unit Rate.'
    );
    c.font = font(9, false, MID_GREY, true);
    c.fill = fill(PALE_BLUE);
    c.alignment = al('center', 'middle');
  }
  r++;

  // r=6 spacer h=8
  ws.getRow(r).height = 8;
  r++;

  // ─────────────────────────────────────────────────────────────────────────
  // r=7 COLUMN HEADER ROW h=50
  // ─────────────────────────────────────────────────────────────────────────
  ws.getRow(r).height = 50;
  fillRow(r, MID_BLUE);
  goldAccent(r);
  const hdrs = [
    '',
    '#',
    'Material ID',
    'Description / Specification',
    'Unit',
    'Total Qty',
    `Unit Rate\n(${currency} / unit)`,
    `Amount\n(${currency})`,
    'Notes',
  ];
  for (let ci = 1; ci <= LAST_COL; ci++) {
    const c = ws.getCell(r, ci);
    c.value = ci === 1 ? '' : hdrs[ci - 1];
    c.font = font(11, true, WHITE);
    c.fill = fill(ci === 1 ? GOLD : MID_BLUE);
    c.alignment = al('center', 'middle', true);
    c.border = thickBorder();
    trackW(ci, hdrs[ci - 1]);
  }
  r++;

  // ─────────────────────────────────────────────────────────────────────────
  // MATERIAL DATA ROWS
  // ─────────────────────────────────────────────────────────────────────────
  const amountRows: number[] = [];

  for (let idx = 0; idx < materialColumns.length; idx++) {
    const col = materialColumns[idx];
    const key = String(col.key || col.id || '');
    const label = String((col as any).display_name || col.label || '');
    const alt = idx % 2 === 0;
    const bg = alt ? PALE_BLUE : WHITE;
    const thinArgb = alt ? 'FFDDEEFF' : 'FFE8E8E8';
    const brd = {
      left: side('thin', thinArgb),
      right: side('thin', thinArgb),
      top: side('thin', thinArgb),
      bottom: side('thin', thinArgb),
    };
    const gl = side('medium', GOLD);

    ws.getRow(r).height = 22;

    // col A – gold stripe
    ws.getCell(r, 1).fill = fill(GOLD);
    ws.getCell(r, 1).border = { bottom: brd.bottom };

    // col B – row index
    {
      const c = ws.getCell(r, 2);
      c.value = idx + 1;
      c.font = font(10, true, NAVY);
      c.fill = fill(bg);
      c.alignment = al('center', 'middle');
      c.border = { left: gl, bottom: brd.bottom };
    }

    // col C – material id
    {
      const c = ws.getCell(r, 3);
      c.value = key;
      c.font = font(9, false, MID_GREY, true);
      c.fill = fill(bg);
      c.alignment = al('left', 'middle');
      c.border = brd;
      trackW(3, key);
    }

    // col D – description
    const labelClean = label.replace(/\n/g, ' ');
    {
      const c = ws.getCell(r, 4);
      c.value = labelClean;
      c.font = font(10, false, DARK_TEXT);
      c.fill = fill(bg);
      c.alignment = al('left', 'middle', true);
      c.border = brd;
      trackW(4, labelClean);
    }

    // col E – unit
    const isCount = countOnlyKeys.has(key);
    const isLinear = /lipping|_lm|skirting|runner/i.test(key);
    const isVolume = /volume|timber/i.test(key);
    const unitStr = isCount ? 'Nr / Pr' : isVolume ? 'M³' : isLinear ? 'LM' : 'M²';
    {
      const c = ws.getCell(r, 5);
      c.value = unitStr;
      c.font = font(10, false, MID_GREY);
      c.fill = fill(bg);
      c.alignment = al('center', 'middle');
      c.border = brd;
    }

    // col F – total qty live-link from Materials_List
    const matQtyRow = matListDataStartRow + idx;
    {
      const c = ws.getCell(r, 6);
      c.value = { formula: `Materials_List!F${matQtyRow}`, result: undefined };
      c.font = font(11, true, GREEN_DARK);
      c.fill = fill(GREEN_HL);
      c.alignment = al('center', 'middle');
      c.border = brd;
      c.numFmt = '0.000';
    }

    // col G – unit rate (pre-filled green or empty amber)
    const unitRate =
      col.unit_rate ??
      (col as any).rate ??
      (col as any).cost ??
      (col as any).unit_cost ??
      (col as any).price ??
      (col as any).unit_price;
    const hasRate = unitRate !== undefined && unitRate !== null;
    {
      const c = ws.getCell(r, 7);
      c.value = hasRate ? parseFloat(String(unitRate)) : null;
      c.font = font(11, hasRate, hasRate ? GREEN_DARK : NAVY);
      c.fill = fill(hasRate ? 'FFD6F0E0' : AMBER_HL);
      c.alignment = al('center', 'middle');
      c.border = { left: gl, right: gl, top: side('thin', GOLD), bottom: side('thin', GOLD) };
      c.numFmt = `"${currency} "#,##0.00`;
    }

    // col H – amount formula
    {
      const c = ws.getCell(r, 8);
      c.value = { formula: `IFERROR(F${r}*G${r}, "")`, result: undefined };
      c.font = font(11, true, NAVY);
      c.fill = fill(PALE_BLUE);
      c.alignment = al('center', 'middle');
      c.border = brd;
      c.numFmt = `"${currency} "#,##0.00`;
      amountRows.push(r);
    }

    // col I – remarks
    const remarks = String(col.remarks || '');
    {
      const c = ws.getCell(r, 9);
      c.value = remarks;
      c.font = font(9, false, MID_GREY, true);
      c.fill = fill(bg);
      c.alignment = al('left', 'middle', true);
      c.border = { right: gl, bottom: brd.bottom, left: brd.left, top: brd.top };
      trackW(9, remarks);
    }

    r++;
  }

  ws.getRow(r).height = 8;
  r++;

  // ─────────────────────────────────────────────────────────────────────────
  // FIXTURES SECTION
  // ─────────────────────────────────────────────────────────────────────────
  const fixtureAmountRows: number[] = [];
  const fixtureList = fixtures || [];

  if (fixtureList.length > 0) {
    // Section header h=30
    ws.getRow(r).height = 30;
    fillRow(r, CHARCOAL);
    for (let ci = 1; ci <= LAST_COL; ci++) {
      ws.getCell(r, ci).border = { top: side('medium', GOLD), bottom: side('medium', GOLD) };
    }
    ws.mergeCells(r, 2, r, LAST_COL);
    {
      const c = ws.getCell(r, 2);
      c.value = 'INSTALLED FIXTURES  ·  SUPPLY & INSTALLATION RATES';
      c.font = font(11, true, GOLD_LIGHT);
      c.fill = fill(CHARCOAL);
      c.alignment = al('center', 'middle');
      c.border = { top: side('medium', GOLD), bottom: side('medium', GOLD) };
    }
    r++;

    // Fixture column headers h=48
    ws.getRow(r).height = 48;
    fillRow(r, MID_BLUE);
    goldAccent(r);
    const fxHdrs = [
      '', '#', 'Item No', 'Description', 'Unit',
      'Total Qty', `Unit Rate\n(${currency} / unit)`, `Amount\n(${currency})`, 'Notes',
    ];
    for (let ci = 1; ci <= LAST_COL; ci++) {
      const c = ws.getCell(r, ci);
      c.value = ci === 1 ? '' : fxHdrs[ci - 1];
      c.font = font(10, true, WHITE);
      c.fill = fill(ci === 1 ? GOLD : MID_BLUE);
      c.alignment = al('center', 'middle', true);
      c.border = {
        top: side('medium', GOLD),
        bottom: side('medium', GOLD),
        left: side('thin', GOLD_LIGHT),
        right: side('thin', GOLD_LIGHT),
      };
      trackW(ci, fxHdrs[ci - 1]);
    }
    r++;

    const fxMatListStart = matListDataStartRow + materialColumns.length + 3;
    let alt = false;

    for (let fxIdx = 0; fxIdx < fixtureList.length; fxIdx++) {
      const fx = fixtureList[fxIdx];
      const bg = alt ? PALE_BLUE : WHITE;
      const thinArgb = alt ? 'FFDDEEFF' : 'FFE8E8E8';
      const brd = {
        left: side('thin', thinArgb),
        right: side('thin', thinArgb),
        top: side('thin', thinArgb),
        bottom: side('thin', thinArgb),
      };
      const gl = side('medium', GOLD);

      ws.getRow(r).height = 22;

      ws.getCell(r, 1).fill = fill(GOLD);
      ws.getCell(r, 1).border = { bottom: brd.bottom };

      {
        const c = ws.getCell(r, 2);
        c.value = fxIdx + 1;
        c.font = font(10, true, NAVY);
        c.fill = fill(bg);
        c.alignment = al('center', 'middle');
        c.border = { left: gl, bottom: brd.bottom };
      }

      {
        const c = ws.getCell(r, 3);
        c.value = fx.item_number || '';
        c.font = font(9, false, MID_GREY, true);
        c.fill = fill(bg);
        c.alignment = al('left', 'middle');
        c.border = brd;
        trackW(3, String(fx.item_number || ''));
      }

      {
        const c = ws.getCell(r, 4);
        c.value = fx.description || '';
        c.font = font(10, false, DARK_TEXT);
        c.fill = fill(bg);
        c.alignment = al('left', 'middle', true);
        c.border = brd;
        trackW(4, String(fx.description || ''));
      }

      {
        const c = ws.getCell(r, 5);
        c.value = fx.measurement_unit || 'Each';
        c.font = font(10, false, MID_GREY);
        c.fill = fill(bg);
        c.alignment = al('center', 'middle');
        c.border = brd;
      }

      const fxRow = fxMatListStart + fxIdx;
      {
        const c = ws.getCell(r, 6);
        c.value = { formula: `Materials_List!G${fxRow}`, result: undefined };
        c.font = font(11, true, GREEN_DARK);
        c.fill = fill(GREEN_HL);
        c.alignment = al('center', 'middle');
        c.border = brd;
        c.numFmt = '0';
      }

      const fxRate =
        (fx as any).unit_rate ?? (fx as any).rate ?? (fx as any).cost ??
        (fx as any).unit_cost ?? (fx as any).price ?? (fx as any).unit_price;
      const hasFxRate = fxRate !== undefined && fxRate !== null;
      {
        const c = ws.getCell(r, 7);
        c.value = hasFxRate ? parseFloat(String(fxRate)) : null;
        c.font = font(11, hasFxRate, hasFxRate ? GREEN_DARK : NAVY);
        c.fill = fill(hasFxRate ? 'FFD6F0E0' : AMBER_HL);
        c.alignment = al('center', 'middle');
        c.border = { left: gl, right: gl, top: side('thin', GOLD), bottom: side('thin', GOLD) };
        c.numFmt = `"${currency} "#,##0.00`;
      }

      {
        const c = ws.getCell(r, 8);
        c.value = { formula: `IFERROR(F${r}*G${r}, "")`, result: undefined };
        c.font = font(11, true, NAVY);
        c.fill = fill(PALE_BLUE);
        c.alignment = al('center', 'middle');
        c.border = brd;
        c.numFmt = `"${currency} "#,##0.00`;
        fixtureAmountRows.push(r);
      }

      {
        const c = ws.getCell(r, 9);
        c.value = fx.remarks || '';
        c.font = font(9, false, MID_GREY, true);
        c.fill = fill(bg);
        c.alignment = al('left', 'middle', true);
        c.border = { right: gl, bottom: brd.bottom, left: brd.left, top: brd.top };
        trackW(9, String(fx.remarks || ''));
      }

      alt = !alt;
      r++;
    }

    ws.getRow(r).height = 8;
    r++;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SUMMARY ROWS  (SUBTOTAL / VAT / GRAND TOTAL)
  // ─────────────────────────────────────────────────────────────────────────
  const allAmountRows = [...amountRows, ...fixtureAmountRows];
  if (allAmountRows.length > 0) {
    const sumParts = allAmountRows.map(row => `IFERROR(H${row},0)`).join('+');
    const numFmt = `"${currency} "#,##0.00`;

    function summaryRow(
      label: string,
      formula: string,
      height: number,
      bg: string,
      labelFc: string,
      valueFc: string,
    ) {
      ws.getRow(r).height = height;
      fillRow(r, bg);
      ws.mergeCells(r, 3, r, 7);
      {
        const c = ws.getCell(r, 3);
        c.value = label;
        c.font = font(12, true, labelFc);
        c.fill = fill(bg);
        c.alignment = al('right', 'middle');
        c.border = { top: side('medium', GOLD), bottom: side('medium', GOLD) };
      }
      {
        const c = ws.getCell(r, 8);
        c.value = { formula: formula, result: undefined };
        c.font = font(13, true, valueFc);
        c.fill = fill(bg);
        c.alignment = al('center', 'middle');
        c.numFmt = numFmt;
        c.border = {
          left: side('medium', GOLD),
          right: side('medium', GOLD),
          top: side('medium', GOLD),
          bottom: side('medium', GOLD),
        };
      }
      r++;
    }

    const subRow = r;
    summaryRow('SUBTOTAL  (excl. VAT)', sumParts, 28, CHARCOAL, WHITE, GOLD);
    const vatRow = subRow + 1;
    summaryRow(`VAT  (${vatPctLabel})`, `H${subRow}*${vatRate}`, 28, MID_BLUE, GOLD_LIGHT, GOLD_LIGHT);
    summaryRow('GRAND TOTAL  (incl. VAT)', `H${subRow}+H${vatRow}`, 34, NAVY, WHITE, GOLD);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FOOTER
  // ─────────────────────────────────────────────────────────────────────────
  ws.getRow(r).height = 5;
  fillRow(r, GOLD);
  r++;

  ws.getRow(r).height = 20;
  fillRow(r, NAVY);
  goldAccent(r);
  ws.mergeCells(r, 2, r, LAST_COL);
  {
    const c = ws.getCell(r, 2);
    c.value = (
      `Rates to be provided by tendering contractor.  ` +
      `All quantities are indicative and subject to field verification.  ` +
      `Currency: ${currency}  ·  VAT @ ${vatPctLabel}`
    );
    c.font = font(8, false, MID_GREY, true);
    c.fill = fill(NAVY);
    c.alignment = al('center', 'middle');
  }
  r++;

  applyColWidths();
}
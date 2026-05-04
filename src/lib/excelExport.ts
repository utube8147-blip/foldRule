/**
 * boqExport.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Professional-grade BOQ / Quantity Take-Off Excel export.
 * Modelled on Al-Waha / Hopkins Architects QS standard.
 *
 * Improvements over v1:
 *   • Quantities rounded to user-defined precision (no raw floats)
 *   • Section-letter item numbering  (A1, A2 … B1, B2 …)
 *   • Colour-key legend row on every sheet
 *   • Complete header block (project, contractor, consultant, drawing ref)
 *   • Grand Total → VAT → Total incl. VAT cascade
 *   • Notes & Assumptions sheet auto-generated
 *   • Formula type set correctly so cells recalculate in Excel/LibreOffice
 *   • Spacer rows are genuinely empty (no stray fills)
 *   • `spec` sub-line printed in italic below description
 *   • `remarks` column replaces the flat Notes field
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as XLSX from 'xlsx';

// ═══════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════

export interface ProjectMeta {
  projectName:    string;
  client?:        string;
  location?:      string;
  refNo?:         string;
  drawingRefs?:   string;         // e.g. "FO-6000001 / 6000003 / 6000004"
  mainContractor?:string;
  consultant?:    string;
  preparedBy?:    string;
  revision?:      string;         // defaults to "P01"
  vatRate?:       number;         // 0–1, defaults to 0.05
  currency?:      string;         // defaults to "AED"
  notes?:         NoteItem[];     // extra project-specific notes for the Notes sheet
}

export interface NoteItem {
  category: string;   // e.g. "Material Notes"
  text:     string;
}

export interface Measurement {
  description: string;
  spec?:       string;    // italic sub-line, e.g. "18mm MR MDF melamine + PVC lipping"
  type?:       string;    // sub-group label within a sheet, e.g. "Base Cabinets"
  group?:      string;    // which Takeoff sheet this item belongs to
  unit:        string;
  quantity:    number;
  unitRate:    number;
  times?:      number;    // defaults to 1
  L?:          number | null;
  W?:          number | null;
  H?:          number | null;
  remarks?:    string;    // drawing ref / site note
  qtyPrecision?: number; // decimal places for this item's qty (default 3)
}

export interface ProjectState {
  projectName:  string;
  meta?:        ProjectMeta;
  measurements: Measurement[];
}

// ═══════════════════════════════════════════════════════════════════
// COLOUR PALETTE  (Al-Waha QS standard)
// ═══════════════════════════════════════════════════════════════════

const C = {
  HEADER_BG:     'FF1F3864',   // dark navy
  HEADER_FG:     'FFFFFFFF',
  BAND_BG:       'FF2E75B6',   // medium blue  (sub-headers, meta row)
  BAND_FG:       'FFFFFFFF',
  COL_HDR_BG:    'FF2E75B6',
  COL_HDR_FG:    'FFFFFFFF',
  GROUP_BG:      'FFD6DCE4',   // light blue-grey  (section divider)
  GROUP_FG:      'FF1F3864',
  SUBTOTAL_BG:   'FFDAE3F3',   // pale blue
  SUBTOTAL_FG:   'FF1F3864',
  GRAND_BG:      'FF1F3864',   // dark navy  (grand total)
  GRAND_FG:      'FFFFFFFF',
  VAT_BG:        'FFDAE3F3',
  VAT_FG:        'FF1F3864',
  TOTAL_INC_BG:  'FF1F3864',
  TOTAL_INC_FG:  'FFFFFFFF',
  ROW_ODD:       'FFF2F6FC',   // alternating rows
  ROW_EVEN:      'FFFFFFFF',
  KEY_YELLOW:    'FFFFFF00',   // colour-key swatch: fill-in cells
  KEY_BLUE:      'FF2E75B6',   // section header
  KEY_GREY:      'FFD6DCE4',   // subtotal
  KEY_RED:       'FFFF0000',   // grand total accent
  NOTE_LABEL_BG: 'FFDAE3F3',
  NOTE_LABEL_FG: 'FF1F3864',
} as const;

// ═══════════════════════════════════════════════════════════════════
// BORDER HELPERS
// ═══════════════════════════════════════════════════════════════════

const thinBorder = () => ({
  top:    { style: 'thin'   as const, color: { rgb: 'FFBDD7EE' } },
  bottom: { style: 'thin'   as const, color: { rgb: 'FFBDD7EE' } },
  left:   { style: 'thin'   as const, color: { rgb: 'FFBDD7EE' } },
  right:  { style: 'thin'   as const, color: { rgb: 'FFBDD7EE' } },
});

const mediumBorder = () => ({
  top:    { style: 'medium' as const, color: { rgb: 'FF1F3864' } },
  bottom: { style: 'medium' as const, color: { rgb: 'FF1F3864' } },
  left:   { style: 'medium' as const, color: { rgb: 'FF1F3864' } },
  right:  { style: 'medium' as const, color: { rgb: 'FF1F3864' } },
});

// ═══════════════════════════════════════════════════════════════════
// NUMBER FORMATS
// ═══════════════════════════════════════════════════════════════════

const FMT_CCY  = '#,##0.00';
const FMT_QTY3 = '#,##0.000';
const FMT_QTY2 = '#,##0.00';
const FMT_PCT  = '0.00%';

// ═══════════════════════════════════════════════════════════════════
// LOW-LEVEL CELL / RANGE HELPERS
// ═══════════════════════════════════════════════════════════════════

type CellStyle = Partial<XLSX.CellStyle>;

function addr(row: number, col: number): string {
  return XLSX.utils.encode_cell({ r: row - 1, c: col - 1 });
}

function setCell(
  ws: XLSX.WorkSheet,
  row: number,
  col: number,
  value: XLSX.CellObject['v'],
  type: XLSX.CellObject['t'],
  style: CellStyle,
  numFmt?: string,
): void {
  const a = addr(row, col);
  ws[a] = { t: type, v: value, s: style, ...(numFmt ? { z: numFmt } : {}) };
}

function setFormula(
  ws: XLSX.WorkSheet,
  row: number,
  col: number,
  formula: string,          // without leading =
  computedValue: number,    // pre-computed so the file opens correctly without recalc
  style: CellStyle,
  numFmt?: string,
): void {
  const a = addr(row, col);
  ws[a] = { t: 'n', v: computedValue, f: formula, s: style, ...(numFmt ? { z: numFmt } : {}) };
}

function merge(ws: XLSX.WorkSheet, r1: number, c1: number, r2: number, c2: number): void {
  if (!ws['!merges']) ws['!merges'] = [];
  ws['!merges'].push({ s: { r: r1 - 1, c: c1 - 1 }, e: { r: r2 - 1, c: c2 - 1 } });
}

function setRowHeight(ws: XLSX.WorkSheet, row: number, hpt: number): void {
  if (!ws['!rows']) ws['!rows'] = [];
  ws['!rows'][row - 1] = { hpt };
}

/** Write an empty spacer row – completely unstyled so no fills bleed through */
function spacer(ws: XLSX.WorkSheet, row: number, lastCol: number): void {
  setRowHeight(ws, row, 6);
  for (let c = 1; c <= lastCol; c++) {
    const a = addr(row, c);
    ws[a] = { t: 'z', v: undefined, s: {} };
  }
}

/** Round a number to `dp` decimal places (avoids floating-point display artifacts) */
function rnd(value: number, dp: number): number {
  const factor = Math.pow(10, dp);
  return Math.round(value * factor) / factor;
}

// ═══════════════════════════════════════════════════════════════════
// COLOUR-KEY LEGEND  (one compact row, like Al-Waha colour key)
// ═══════════════════════════════════════════════════════════════════

function writeColourKey(ws: XLSX.WorkSheet, row: number, lastCol: number): void {
  // Label
  setCell(ws, row, 1, 'COLOUR KEY:', 's', {
    font: { bold: true, sz: 8, name: 'Arial', color: { rgb: 'FF1F3864' } },
    alignment: { horizontal: 'right', vertical: 'center' },
  });

  const keys: [string, string, string][] = [
    [C.KEY_YELLOW, 'FF000000', 'Yellow = cells to fill in (take-off / rate)'],
    [C.KEY_BLUE,   'FFFFFFFF', 'Blue header = section'],
    [C.KEY_GREY,   'FF1F3864', 'Grey = sub-total'],
    [C.KEY_RED,    'FFFFFFFF', 'Red = grand total / alert'],
  ];

  let col = 2;
  for (const [bg, fg, label] of keys) {
    setCell(ws, row, col, `■ ${label}`, 's', {
      font: { sz: 8, name: 'Arial', color: { rgb: fg }, bold: false },
      fill: { patternType: 'solid', fgColor: { rgb: bg } },
      alignment: { horizontal: 'left', vertical: 'center' },
      border: thinBorder(),
    });
    col++;
  }
  // fill remaining cols
  for (let c = col; c <= lastCol; c++) {
    const a = addr(row, c);
    ws[a] = { t: 'z', v: undefined, s: { fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFFFF' } } } };
  }
  setRowHeight(ws, row, 14);
}

// ═══════════════════════════════════════════════════════════════════
// COLUMN LAYOUT DEFINITIONS
// ═══════════════════════════════════════════════════════════════════

// ── Summary sheet ──────────────────────────────────────────────────
const SUM_COLS = { NUM: 1, DESC: 2, TYPE: 3, QTY: 4, UNIT: 5, RATE: 6, COST: 7, REMARKS: 8 };
const SUM_LAST = 8;
const SUM_WIDTHS = [5, 36, 14, 12, 8, 13, 15, 28];

// ── Takeoff sheet ──────────────────────────────────────────────────
const TK_COLS = { NUM: 1, DESC: 2, UNIT: 3, TIMES: 4, L: 5, W: 6, H: 7, QTY: 8, RATE: 9, COST: 10, REMARKS: 11 };
const TK_LAST = 11;
const TK_WIDTHS = [6, 40, 8, 7, 10, 10, 10, 13, 13, 14, 30];

// ── Material summary sheet ─────────────────────────────────────────
const MAT_COLS = { NUM: 1, DESC: 2, UNIT: 3, QTY: 4, RATE: 5, COST: 6 };
const MAT_LAST = 6;
const MAT_WIDTHS = [6, 44, 10, 14, 14, 14];

// ═══════════════════════════════════════════════════════════════════
// MAIN EXPORT FUNCTION
// ═══════════════════════════════════════════════════════════════════

export function exportToExcel(state: ProjectState): void {
  const meta     = state.meta ?? { projectName: state.projectName };
  const dateStr  = new Date().toISOString().split('T')[0];
  const safeName = state.projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const filename = `takeoff-${safeName}-${dateStr}.xlsx`;

  const wb = XLSX.utils.book_new();

  buildSummarySheet(wb, state, meta, dateStr);

  // Group measurements into sheets
  const groups = new Map<string, Measurement[]>();
  for (const m of state.measurements) {
    const key = m.group ?? 'Takeoff';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  for (const [groupName, measurements] of groups.entries()) {
    buildTakeoffSheet(wb, state, meta, groupName, measurements);
  }

  buildMaterialSummarySheet(wb, state, meta);
  buildNotesSheet(wb, meta, dateStr);

  XLSX.writeFile(wb, filename);
}

// ═══════════════════════════════════════════════════════════════════
// SHEET 1 · Cover / Project Summary
// ═══════════════════════════════════════════════════════════════════

function buildSummarySheet(
  wb: XLSX.WorkBook,
  state: ProjectState,
  meta: ProjectMeta,
  dateStr: string,
): void {
  const ws: XLSX.WorkSheet = {};
  ws['!merges'] = [];
  ws['!rows']   = [];
  ws['!cols']   = SUM_WIDTHS.map(w => ({ wch: w }));

  const vatRate = meta.vatRate ?? 0.05;
  const currency = meta.currency ?? 'AED';
  let row = 1;

  // ── Title banner ──────────────────────────────────────────────────
  merge(ws, row, 1, row, SUM_LAST);
  setCell(ws, row, 1, meta.projectName.toUpperCase(), 's', {
    font: { bold: true, sz: 18, name: 'Arial', color: { rgb: C.HEADER_FG } },
    fill: { patternType: 'solid', fgColor: { rgb: C.HEADER_BG } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: mediumBorder(),
  });
  setRowHeight(ws, row, 32);
  row++;

  // ── Sub-title ─────────────────────────────────────────────────────
  merge(ws, row, 1, row, SUM_LAST);
  setCell(ws, row, 1, 'QUANTITY TAKE-OFF SUMMARY', 's', {
    font: { bold: true, sz: 11, name: 'Arial', color: { rgb: C.BAND_FG } },
    fill: { patternType: 'solid', fgColor: { rgb: C.BAND_BG } },
    alignment: { horizontal: 'center', vertical: 'center' },
  });
  setRowHeight(ws, row, 18);
  row++;

  // ── Project info block ────────────────────────────────────────────
  const infoItems: [string, string][] = [
    ['Project',           meta.projectName],
    ['Client',            meta.client            ?? '—'],
    ['Location',          meta.location          ?? '—'],
    ['Ref No',            meta.refNo             ?? '—'],
    ['Drawing Ref',       meta.drawingRefs       ?? '—'],
    ['Main Contractor',   meta.mainContractor    ?? '—'],
    ['Consultant',        meta.consultant        ?? '—'],
    ['Prepared by',       meta.preparedBy        ?? '—'],
    ['Date',              dateStr],
    ['Rev',               meta.revision          ?? 'P01'],
    ['Currency',          currency],
    [`VAT Rate`,          `${(vatRate * 100).toFixed(0)}%`],
  ];

  for (const [label, value] of infoItems) {
    setCell(ws, row, 1, label, 's', {
      font: { bold: true, sz: 10, name: 'Arial', color: { rgb: C.GROUP_FG } },
      fill: { patternType: 'solid', fgColor: { rgb: C.GROUP_BG } },
      border: thinBorder(),
      alignment: { horizontal: 'left', vertical: 'center' },
    });
    merge(ws, row, 2, row, 4);
    setCell(ws, row, 2, value, 's', {
      font: { sz: 10, name: 'Arial' },
      border: thinBorder(),
      alignment: { horizontal: 'left', vertical: 'center' },
    });
    // fill remaining cols
    for (let c = 5; c <= SUM_LAST; c++) {
      const a = addr(row, c);
      ws[a] = { t: 'z', v: undefined, s: { border: thinBorder() } };
    }
    setRowHeight(ws, row, 15);
    row++;
  }

  spacer(ws, row, SUM_LAST); row++;

  // ── Colour key ────────────────────────────────────────────────────
  writeColourKey(ws, row, SUM_LAST); row++;

  spacer(ws, row, SUM_LAST); row++;

  // ── Column headers ────────────────────────────────────────────────
  const hdrs = ['#', 'Description', 'Type', 'Quantity', 'Unit', `Unit Rate (${currency})`, `Total Cost (${currency})`, 'Remarks / Drawing Ref'];
  for (let c = 0; c < hdrs.length; c++) {
    setCell(ws, row, c + 1, hdrs[c], 's', {
      font: { bold: true, sz: 10, name: 'Arial', color: { rgb: C.COL_HDR_FG } },
      fill: { patternType: 'solid', fgColor: { rgb: C.COL_HDR_BG } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: thinBorder(),
    });
  }
  setRowHeight(ws, row, 30);
  row++;

  // ── Measurement rows ──────────────────────────────────────────────
  let grandTotal = 0;
  const sectionLetters = new Map<string, string>();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let letterIdx = 0;
  const sectionCounters = new Map<string, number>();

  // Build section-letter mapping
  for (const m of state.measurements) {
    const type = m.type ?? 'General';
    if (!sectionLetters.has(type)) {
      sectionLetters.set(type, alphabet[letterIdx % 26]);
      letterIdx++;
      sectionCounters.set(type, 0);
    }
  }

  state.measurements.forEach((m, _idx) => {
    const type     = m.type ?? 'General';
    const letter   = sectionLetters.get(type)!;
    const counter  = (sectionCounters.get(type) ?? 0) + 1;
    sectionCounters.set(type, counter);
    const itemNo   = `${letter}${counter}`;

    const dp       = m.qtyPrecision ?? 3;
    const qty      = rnd(m.quantity, dp);
    const rate     = rnd(m.unitRate, 2);
    const cost     = rnd(qty * rate, 2);
    grandTotal    += cost;

    const isOdd    = counter % 2 === 1;
    const bg       = isOdd ? C.ROW_ODD : C.ROW_EVEN;

    const baseStyle = (align: string): CellStyle => ({
      font: { sz: 10, name: 'Arial' },
      fill: { patternType: 'solid', fgColor: { rgb: bg } },
      alignment: { horizontal: align as any, vertical: 'center' },
      border: thinBorder(),
    });

    setCell(ws, row, SUM_COLS.NUM,     itemNo,          's', baseStyle('center'));
    setCell(ws, row, SUM_COLS.DESC,    m.description,   's', { ...baseStyle('left'), alignment: { horizontal: 'left', vertical: 'center', wrapText: true } });
    setCell(ws, row, SUM_COLS.TYPE,    type,            's', baseStyle('center'));
    setCell(ws, row, SUM_COLS.QTY,     qty,             'n', baseStyle('right'), FMT_QTY3);
    setCell(ws, row, SUM_COLS.UNIT,    m.unit,          's', baseStyle('center'));
    setCell(ws, row, SUM_COLS.RATE,    rate,            'n', baseStyle('right'), FMT_CCY);
    setCell(ws, row, SUM_COLS.COST,    cost,            'n', baseStyle('right'), FMT_CCY);
    setCell(ws, row, SUM_COLS.REMARKS, m.remarks ?? '', 's', baseStyle('left'));
    setRowHeight(ws, row, 15);
    row++;

    // If spec exists, add italic sub-line
    if (m.spec) {
      merge(ws, row, SUM_COLS.DESC, row, SUM_COLS.REMARKS);
      setCell(ws, row, SUM_COLS.DESC, m.spec, 's', {
        font: { sz: 9, italic: true, name: 'Arial', color: { rgb: '555555' } },
        fill: { patternType: 'solid', fgColor: { rgb: bg } },
        alignment: { horizontal: 'left', vertical: 'center', indent: 2 },
        border: thinBorder(),
      });
      for (let c = SUM_COLS.NUM; c <= SUM_LAST; c++) {
        if (c === SUM_COLS.DESC) continue;
        const a = addr(row, c);
        ws[a] = { t: 'z', v: undefined, s: { fill: { patternType: 'solid', fgColor: { rgb: bg } }, border: thinBorder() } };
      }
      setRowHeight(ws, row, 12);
      row++;
    }
  });

  // ── Totals block ──────────────────────────────────────────────────
  const vat       = rnd(grandTotal * vatRate, 2);
  const totalIncl = rnd(grandTotal + vat, 2);

  const totalsRows: [string, number, CellStyle][] = [
    ['GRAND TOTAL  (excl. VAT)',  grandTotal, {
      font: { bold: true, sz: 11, name: 'Arial', color: { rgb: C.GRAND_FG } },
      fill: { patternType: 'solid', fgColor: { rgb: C.GRAND_BG } },
      alignment: { horizontal: 'right' }, border: mediumBorder(),
    }],
    [`VAT @ ${(vatRate * 100).toFixed(0)}%`, vat, {
      font: { bold: true, sz: 10, name: 'Arial', color: { rgb: C.VAT_FG } },
      fill: { patternType: 'solid', fgColor: { rgb: C.VAT_BG } },
      alignment: { horizontal: 'right' }, border: thinBorder(),
    }],
    [`TOTAL  (incl. VAT)`, totalIncl, {
      font: { bold: true, sz: 12, name: 'Arial', color: { rgb: C.TOTAL_INC_FG } },
      fill: { patternType: 'solid', fgColor: { rgb: C.TOTAL_INC_BG } },
      alignment: { horizontal: 'right' }, border: mediumBorder(),
    }],
  ];

  spacer(ws, row, SUM_LAST); row++;

  for (const [label, value, style] of totalsRows) {
    merge(ws, row, 1, row, SUM_COLS.RATE);
    setCell(ws, row, 1, label, 's', style);
    setCell(ws, row, SUM_COLS.COST, value, 'n', style, FMT_CCY);
    setCell(ws, row, SUM_COLS.REMARKS, '', 's', {
      fill: (style.fill as any), border: (style.border as any)
    });
    setRowHeight(ws, row, 20);
    row++;
  }

  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: row, c: SUM_LAST } });
  XLSX.utils.book_append_sheet(wb, ws, 'Summary');
}

// ═══════════════════════════════════════════════════════════════════
// SHEET 2 · Takeoff Detail  (one sheet per group)
// ═══════════════════════════════════════════════════════════════════

function buildTakeoffSheet(
  wb: XLSX.WorkBook,
  state: ProjectState,
  meta: ProjectMeta,
  sheetName: string,
  measurements: Measurement[],
): void {
  const ws: XLSX.WorkSheet = {};
  ws['!merges'] = [];
  ws['!rows']   = [];
  ws['!cols']   = TK_WIDTHS.map(w => ({ wch: w }));

  const currency = meta.currency ?? 'AED';
  let row = 1;

  // ── Title ─────────────────────────────────────────────────────────
  merge(ws, row, 1, row, TK_LAST);
  setCell(ws, row, 1, `${meta.projectName.toUpperCase()}  ·  ${sheetName.toUpperCase()}`, 's', {
    font: { bold: true, sz: 14, name: 'Arial', color: { rgb: C.HEADER_FG } },
    fill: { patternType: 'solid', fgColor: { rgb: C.HEADER_BG } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: mediumBorder(),
  });
  setRowHeight(ws, row, 28);
  row++;

  // ── Meta row ──────────────────────────────────────────────────────
  merge(ws, row, 1, row, TK_LAST);
  setCell(ws, row, 1,
    [
      `Rev: ${meta.revision ?? 'P01'}`,
      `Date: ${new Date().toLocaleDateString('en-GB')}`,
      `Prepared by: ${meta.preparedBy ?? '—'}`,
      ...(meta.drawingRefs ? [`Dwg Ref: ${meta.drawingRefs}`] : []),
    ].join('   |   '),
    's', {
    font: { sz: 9, name: 'Arial', italic: true, color: { rgb: C.BAND_FG } },
    fill: { patternType: 'solid', fgColor: { rgb: C.BAND_BG } },
    alignment: { horizontal: 'right', vertical: 'center' },
  });
  setRowHeight(ws, row, 14);
  row++;

  // ── Colour key ────────────────────────────────────────────────────
  writeColourKey(ws, row, TK_LAST); row++;
  spacer(ws, row, TK_LAST); row++;

  // ── Column headers ────────────────────────────────────────────────
  const hdrs = ['#', 'Description', 'Unit', 'Times', 'L', 'W', 'H', 'Total QTY', `Rate (${currency})`, `Cost (${currency})`, 'Remarks / Dwg Ref'];
  for (let c = 0; c < hdrs.length; c++) {
    setCell(ws, row, c + 1, hdrs[c], 's', {
      font: { bold: true, sz: 10, name: 'Arial', color: { rgb: C.COL_HDR_FG } },
      fill: { patternType: 'solid', fgColor: { rgb: C.COL_HDR_BG } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: thinBorder(),
    });
  }
  setRowHeight(ws, row, 30);
  row++;

  // ── Group measurements by type ────────────────────────────────────
  const subgroups = new Map<string, Measurement[]>();
  for (const m of measurements) {
    const key = m.type ?? 'General';
    if (!subgroups.has(key)) subgroups.set(key, []);
    subgroups.get(key)!.push(m);
  }

  // Assign section letters
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const sectionLetters = new Map<string, string>();
  let li = 0;
  for (const key of subgroups.keys()) {
    sectionLetters.set(key, alphabet[li % 26]);
    li++;
  }

  let sectionGrandQty  = 0;
  let sectionGrandCost = 0;

  for (const [typeName, items] of subgroups.entries()) {
    const letter = sectionLetters.get(typeName)!;

    // Section header
    merge(ws, row, 1, row, TK_LAST);
    setCell(ws, row, 1, `  ${letter}   ${typeName.toUpperCase()}`, 's', {
      font: { bold: true, sz: 10, name: 'Arial', color: { rgb: C.GROUP_FG } },
      fill: { patternType: 'solid', fgColor: { rgb: C.GROUP_BG } },
      alignment: { horizontal: 'left', vertical: 'center' },
      border: thinBorder(),
    });
    setRowHeight(ws, row, 18);
    row++;

    const groupDataStart = row;
    let   groupQty  = 0;
    let   groupCost = 0;
    let   itemNo    = 1;

    for (const m of items) {
      const dp   = m.qtyPrecision ?? 3;
      const qty  = rnd(m.quantity,  dp);
      const rate = rnd(m.unitRate,  2);
      const cost = rnd(qty * rate,  2);
      groupQty  += qty;
      groupCost += cost;

      const times = m.times ?? 1;
      const bg    = itemNo % 2 === 1 ? C.ROW_ODD : C.ROW_EVEN;
      const itemRef = `${letter}${itemNo}`;

      const base = (align: string): CellStyle => ({
        font: { sz: 10, name: 'Arial' },
        fill: { patternType: 'solid', fgColor: { rgb: bg } },
        alignment: { horizontal: align as any, vertical: 'center' },
        border: thinBorder(),
      });

      setCell(ws, row, TK_COLS.NUM,     itemRef,          's', base('center'));
      setCell(ws, row, TK_COLS.DESC,    m.description,    's', { ...base('left'), alignment: { horizontal: 'left', vertical: 'center', wrapText: true } });
      setCell(ws, row, TK_COLS.UNIT,    m.unit,           's', base('center'));
      setCell(ws, row, TK_COLS.TIMES,   times,            'n', base('center'));
      setCell(ws, row, TK_COLS.L,       m.L  ?? '',       m.L  != null ? 'n' : 's', base('right'), FMT_QTY2);
      setCell(ws, row, TK_COLS.W,       m.W  ?? '',       m.W  != null ? 'n' : 's', base('right'), FMT_QTY2);
      setCell(ws, row, TK_COLS.H,       m.H  ?? '',       m.H  != null ? 'n' : 's', base('right'), FMT_QTY2);
      setCell(ws, row, TK_COLS.QTY,     qty,              'n', base('right'), FMT_QTY3);
      setCell(ws, row, TK_COLS.RATE,    rate,             'n', {
        ...base('right'),
        fill: { patternType: 'solid', fgColor: { rgb: C.KEY_YELLOW } }, // yellow = fill-in
      }, FMT_CCY);
      setCell(ws, row, TK_COLS.COST,    cost,             'n', base('right'), FMT_CCY);
      setCell(ws, row, TK_COLS.REMARKS, m.remarks ?? '',  's', base('left'));
      setRowHeight(ws, row, 15);
      row++;

      // Spec sub-line
      if (m.spec) {
        merge(ws, row, TK_COLS.DESC, row, TK_COLS.REMARKS);
        setCell(ws, row, TK_COLS.DESC, m.spec, 's', {
          font: { sz: 9, italic: true, name: 'Arial', color: { rgb: '555555' } },
          fill: { patternType: 'solid', fgColor: { rgb: bg } },
          alignment: { horizontal: 'left', vertical: 'center', indent: 2 },
          border: thinBorder(),
        });
        for (let c = 1; c <= TK_LAST; c++) {
          if (c === TK_COLS.DESC) continue;
          const a = addr(row, c);
          ws[a] = { t: 'z', v: undefined, s: { fill: { patternType: 'solid', fgColor: { rgb: bg } }, border: thinBorder() } };
        }
        setRowHeight(ws, row, 12);
        row++;
      }

      itemNo++;
    }

    // Subtotal row
    merge(ws, row, 1, row, TK_COLS.QTY - 1);
    setCell(ws, row, 1, `Sub-total  ${letter}  —  ${typeName}`, 's', {
      font: { bold: true, sz: 10, name: 'Arial', color: { rgb: C.SUBTOTAL_FG } },
      fill: { patternType: 'solid', fgColor: { rgb: C.SUBTOTAL_BG } },
      alignment: { horizontal: 'right' }, border: thinBorder(),
    });
    const subtotalQtyRange  = `H${groupDataStart}:H${row - 1}`;
    const subtotalCostRange = `J${groupDataStart}:J${row - 1}`;
    setFormula(ws, row, TK_COLS.QTY,  `SUM(${subtotalQtyRange})`,  rnd(groupQty, 3),  {
      font: { bold: true, sz: 10, name: 'Arial', color: { rgb: C.SUBTOTAL_FG } },
      fill: { patternType: 'solid', fgColor: { rgb: C.SUBTOTAL_BG } },
      alignment: { horizontal: 'right' }, border: thinBorder(),
    }, FMT_QTY3);
    // blank filler for Rate column
    const a = addr(row, TK_COLS.RATE);
    ws[a] = { t: 'z', v: undefined, s: { fill: { patternType: 'solid', fgColor: { rgb: C.SUBTOTAL_BG } }, border: thinBorder() } };
    setFormula(ws, row, TK_COLS.COST, `SUM(${subtotalCostRange})`, rnd(groupCost, 2), {
      font: { bold: true, sz: 10, name: 'Arial', color: { rgb: C.SUBTOTAL_FG } },
      fill: { patternType: 'solid', fgColor: { rgb: C.SUBTOTAL_BG } },
      alignment: { horizontal: 'right' }, border: thinBorder(),
    }, FMT_CCY);
    const b = addr(row, TK_COLS.REMARKS);
    ws[b] = { t: 'z', v: undefined, s: { fill: { patternType: 'solid', fgColor: { rgb: C.SUBTOTAL_BG } }, border: thinBorder() } };
    setRowHeight(ws, row, 16);
    row++;

    sectionGrandQty  += groupQty;
    sectionGrandCost += groupCost;

    spacer(ws, row, TK_LAST); row++;
  }

  // ── Grand Total row ───────────────────────────────────────────────
  merge(ws, row, 1, row, TK_COLS.QTY - 1);
  setCell(ws, row, 1, `TOTAL  —  ${sheetName.toUpperCase()}`, 's', {
    font: { bold: true, sz: 11, name: 'Arial', color: { rgb: C.GRAND_FG } },
    fill: { patternType: 'solid', fgColor: { rgb: C.GRAND_BG } },
    alignment: { horizontal: 'right' }, border: mediumBorder(),
  });
  setCell(ws, row, TK_COLS.QTY, rnd(sectionGrandQty, 3), 'n', {
    font: { bold: true, sz: 11, name: 'Arial', color: { rgb: C.GRAND_FG } },
    fill: { patternType: 'solid', fgColor: { rgb: C.GRAND_BG } },
    alignment: { horizontal: 'right' }, border: mediumBorder(),
  }, FMT_QTY3);
  const gr = addr(row, TK_COLS.RATE);
  ws[gr] = { t: 'z', v: undefined, s: { fill: { patternType: 'solid', fgColor: { rgb: C.GRAND_BG } }, border: mediumBorder() } };
  setCell(ws, row, TK_COLS.COST, rnd(sectionGrandCost, 2), 'n', {
    font: { bold: true, sz: 11, name: 'Arial', color: { rgb: C.GRAND_FG } },
    fill: { patternType: 'solid', fgColor: { rgb: C.GRAND_BG } },
    alignment: { horizontal: 'right' }, border: mediumBorder(),
  }, FMT_CCY);
  const gn = addr(row, TK_COLS.REMARKS);
  ws[gn] = { t: 'z', v: undefined, s: { fill: { patternType: 'solid', fgColor: { rgb: C.GRAND_BG } }, border: mediumBorder() } };
  setRowHeight(ws, row, 22);

  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: row, c: TK_LAST } });
  const safeName = sheetName.replace(/[\\/:*?[\]]/g, '').substring(0, 31);
  XLSX.utils.book_append_sheet(wb, ws, safeName);
}

// ═══════════════════════════════════════════════════════════════════
// SHEET 3 · Material Summary  (consolidated by description + unit)
// ═══════════════════════════════════════════════════════════════════

function buildMaterialSummarySheet(
  wb: XLSX.WorkBook,
  state: ProjectState,
  meta: ProjectMeta,
): void {
  const ws: XLSX.WorkSheet = {};
  ws['!merges'] = [];
  ws['!rows']   = [];
  ws['!cols']   = MAT_WIDTHS.map(w => ({ wch: w }));

  const currency = meta.currency ?? 'AED';
  let row = 1;

  // Title
  merge(ws, row, 1, row, MAT_LAST);
  setCell(ws, row, 1, 'MATERIAL SUMMARY', 's', {
    font: { bold: true, sz: 14, name: 'Arial', color: { rgb: C.HEADER_FG } },
    fill: { patternType: 'solid', fgColor: { rgb: C.HEADER_BG } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: mediumBorder(),
  });
  setRowHeight(ws, row, 28);
  row++;

  // Meta row
  merge(ws, row, 1, row, MAT_LAST);
  setCell(ws, row, 1,
    `Project: ${meta.projectName}   |   Rev: ${meta.revision ?? 'P01'}   |   Date: ${new Date().toLocaleDateString('en-GB')}`,
    's', {
    font: { sz: 9, italic: true, name: 'Arial', color: { rgb: C.BAND_FG } },
    fill: { patternType: 'solid', fgColor: { rgb: C.BAND_BG } },
    alignment: { horizontal: 'right', vertical: 'center' },
  });
  setRowHeight(ws, row, 14);
  row++;

  spacer(ws, row, MAT_LAST); row++;

  // Headers
  const hdrs = ['#', 'Material / Description', 'Unit', 'Total Qty', `Unit Rate (${currency})`, `Total Cost (${currency})`];
  for (let c = 0; c < hdrs.length; c++) {
    setCell(ws, row, c + 1, hdrs[c], 's', {
      font: { bold: true, sz: 10, name: 'Arial', color: { rgb: C.COL_HDR_FG } },
      fill: { patternType: 'solid', fgColor: { rgb: C.COL_HDR_BG } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: thinBorder(),
    });
  }
  setRowHeight(ws, row, 28);
  row++;

  // Aggregate by description + unit
  const map = new Map<string, { qty: number; rate: number; unit: string; spec?: string }>();
  for (const m of state.measurements) {
    const key = `${m.description}||${m.unit}`;
    if (map.has(key)) {
      map.get(key)!.qty = rnd(map.get(key)!.qty + m.quantity, m.qtyPrecision ?? 3);
    } else {
      map.set(key, { qty: m.quantity, rate: m.unitRate, unit: m.unit, spec: m.spec });
    }
  }

  let i = 1;
  const dataStart = row;
  let runningTotal = 0;
  for (const [key, { qty, rate, unit, spec }] of map.entries()) {
    const desc  = key.split('||')[0];
    const bg    = i % 2 === 1 ? C.ROW_ODD : C.ROW_EVEN;
    const cost  = rnd(qty * rate, 2);
    runningTotal += cost;

    const base = (align: string): CellStyle => ({
      font: { sz: 10, name: 'Arial' },
      fill: { patternType: 'solid', fgColor: { rgb: bg } },
      alignment: { horizontal: align as any, vertical: 'center' },
      border: thinBorder(),
    });

    setCell(ws, row, MAT_COLS.NUM,  String(i).padStart(2, '0'), 's', base('center'));
    setCell(ws, row, MAT_COLS.DESC, desc,  's', { ...base('left'), alignment: { horizontal: 'left', vertical: 'center', wrapText: true } });
    setCell(ws, row, MAT_COLS.UNIT, unit,  's', base('center'));
    setCell(ws, row, MAT_COLS.QTY,  rnd(qty, 3),  'n', base('right'), FMT_QTY3);
    setCell(ws, row, MAT_COLS.RATE, rate,  'n', {
      ...base('right'),
      fill: { patternType: 'solid', fgColor: { rgb: C.KEY_YELLOW } }, // yellow = fill-in
    }, FMT_CCY);
    setCell(ws, row, MAT_COLS.COST, cost,  'n', base('right'), FMT_CCY);
    setRowHeight(ws, row, 15);
    row++;

    if (spec) {
      merge(ws, row, MAT_COLS.DESC, row, MAT_LAST);
      setCell(ws, row, MAT_COLS.DESC, spec, 's', {
        font: { sz: 9, italic: true, name: 'Arial', color: { rgb: '555555' } },
        fill: { patternType: 'solid', fgColor: { rgb: bg } },
        alignment: { horizontal: 'left', indent: 2 },
        border: thinBorder(),
      });
      for (let c = MAT_COLS.NUM; c <= MAT_LAST; c++) {
        if (c === MAT_COLS.DESC) continue;
        const a = addr(row, c);
        ws[a] = { t: 'z', v: undefined, s: { fill: { patternType: 'solid', fgColor: { rgb: bg } }, border: thinBorder() } };
      }
      setRowHeight(ws, row, 12);
      row++;
    }
    i++;
  }

  // Total row
  merge(ws, row, 1, row, MAT_COLS.RATE);
  setCell(ws, row, 1, 'TOTAL', 's', {
    font: { bold: true, sz: 11, name: 'Arial', color: { rgb: C.GRAND_FG } },
    fill: { patternType: 'solid', fgColor: { rgb: C.GRAND_BG } },
    alignment: { horizontal: 'right' }, border: mediumBorder(),
  });
  setFormula(ws, row, MAT_COLS.COST, `SUM(F${dataStart}:F${row - 1})`, rnd(runningTotal, 2), {
    font: { bold: true, sz: 11, name: 'Arial', color: { rgb: C.GRAND_FG } },
    fill: { patternType: 'solid', fgColor: { rgb: C.GRAND_BG } },
    alignment: { horizontal: 'right' }, border: mediumBorder(),
  }, FMT_CCY);
  setRowHeight(ws, row, 22);

  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: row, c: MAT_LAST } });
  XLSX.utils.book_append_sheet(wb, ws, 'Material Summary');
}

// ═══════════════════════════════════════════════════════════════════
// SHEET 4 · Notes & Assumptions  (auto-generated)
// ═══════════════════════════════════════════════════════════════════

function buildNotesSheet(wb: XLSX.WorkBook, meta: ProjectMeta, dateStr: string): void {
  const ws: XLSX.WorkSheet = {};
  ws['!merges'] = [];
  ws['!rows']   = [];
  ws['!cols']   = [{ wch: 5 }, { wch: 28 }, { wch: 72 }];

  let row = 1;

  // Title
  merge(ws, row, 1, row, 3);
  setCell(ws, row, 1, 'NOTES, ASSUMPTIONS & EXCLUSIONS', 's', {
    font: { bold: true, sz: 14, name: 'Arial', color: { rgb: C.HEADER_FG } },
    fill: { patternType: 'solid', fgColor: { rgb: C.HEADER_BG } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: mediumBorder(),
  });
  setRowHeight(ws, row, 28);
  row++;

  merge(ws, row, 1, row, 3);
  setCell(ws, row, 1, `Project: ${meta.projectName}   |   Rev: ${meta.revision ?? 'P01'}   |   Date: ${dateStr}`, 's', {
    font: { sz: 9, italic: true, name: 'Arial', color: { rgb: C.BAND_FG } },
    fill: { patternType: 'solid', fgColor: { rgb: C.BAND_BG } },
    alignment: { horizontal: 'right', vertical: 'center' },
  });
  setRowHeight(ws, row, 14);
  row++;
  spacer(ws, row, 3); row++;

  // Standard notes grouped by category
  const standardNotes: { category: string; items: [string, string][] }[] = [
    {
      category: 'GENERAL NOTES',
      items: [
        ['Drawing Basis',    'BOQ derived from issued-for-construction or shop drawings. All dimensions taken from drawing annotations only. Do not scale.'],
        ['Field Measurement','Field measurement required prior to fabrication and installation. Contractor to verify all quantities against latest approved drawings.'],
        ['Approved Samples', 'All finishes and hardware / ironmongery subject to formal client / LORJ approval before procurement.'],
        ['Coordination',     'All works to be in full coordination with MEP, structural, and other relevant IFC drawings and shop drawing approvals.'],
      ],
    },
    {
      category: 'MATERIAL NOTES',
      items: [
        ['MDF Grade',        'All MDF to be Moisture Resistant (MR) grade, minimum E1 formaldehyde emission class. No standard MDF permitted.'],
        ['Edge Treatment',   'PVC lipping to all exposed MDF edges. Colour and finish to match approved laminate sample. Minimum 0.4 mm thickness.'],
        ['No Sharp Edges',   'All corners and edges to be filleted 1–3 mm. No sharp corners or edges permitted on any cabinet or panel.'],
      ],
    },
    {
      category: 'EXCLUSIONS',
      items: [
        ['MEP Works',        'Electrical connections, gas supply, plumbing (water supply and drainage) are EXCLUDED. By MEP contractor.'],
        ['LED Lighting',     'Under-cabinet LED lighting noted as "By Others". EXCLUDED from this BOQ. Confirm with MEP contractor.'],
        ['Civil / Wall',     'Wall chasing, floor preparation, plastering, and wall tiling outside the joinery zone are EXCLUDED.'],
        ['Ceiling Works',    'All ceiling works are EXCLUDED from this BOQ.'],
        ['Preliminaries',    'Site preliminaries, scaffolding, hoisting, and general contractor overheads not included. Add separately.'],
      ],
    },
    {
      category: 'FINANCIAL NOTES',
      items: [
        ['Currency',         `All rates and amounts in ${meta.currency ?? 'AED'}.`],
        ['VAT',              `UAE Value Added Tax (VAT) at ${(((meta.vatRate ?? 0.05) * 100).toFixed(0))}% applied to the grand total.`],
        ['Provisional Sums', 'Items marked as provisional sums should be adjusted based on actual scope at final account stage.'],
        ['Rate Entry',       'All yellow-highlighted cells in the BOQ sheet are to be filled by the contractor / QS. Do not alter formulae in other cells.'],
      ],
    },
  ];

  // Merge with user-supplied notes
  const userNotesByCategory = new Map<string, string[]>();
  for (const n of (meta.notes ?? [])) {
    if (!userNotesByCategory.has(n.category)) userNotesByCategory.set(n.category, []);
    userNotesByCategory.get(n.category)!.push(n.text);
  }

  let globalIdx = 1;

  for (const group of standardNotes) {
    // Category header
    merge(ws, row, 1, row, 3);
    setCell(ws, row, 1, `  ${group.category}`, 's', {
      font: { bold: true, sz: 10, name: 'Arial', color: { rgb: C.GROUP_FG } },
      fill: { patternType: 'solid', fgColor: { rgb: C.GROUP_BG } },
      alignment: { horizontal: 'left', vertical: 'center' },
      border: thinBorder(),
    });
    setRowHeight(ws, row, 18);
    row++;

    for (const [label, text] of group.items) {
      setCell(ws, row, 1, String(globalIdx), 's', {
        font: { sz: 10, name: 'Arial', color: { rgb: C.GROUP_FG } },
        fill: { patternType: 'solid', fgColor: { rgb: C.ROW_ODD } },
        alignment: { horizontal: 'center', vertical: 'top' },
        border: thinBorder(),
      });
      setCell(ws, row, 2, label, 's', {
        font: { bold: true, sz: 10, name: 'Arial' },
        fill: { patternType: 'solid', fgColor: { rgb: C.NOTE_LABEL_BG } },
        alignment: { horizontal: 'left', vertical: 'top' },
        border: thinBorder(),
      });
      setCell(ws, row, 3, text, 's', {
        font: { sz: 10, name: 'Arial' },
        fill: { patternType: 'solid', fgColor: { rgb: C.ROW_EVEN } },
        alignment: { horizontal: 'left', vertical: 'top', wrapText: true },
        border: thinBorder(),
      });
      setRowHeight(ws, row, 28);
      row++;
      globalIdx++;
    }

    // User-supplied notes for this category (if any match)
    const extras = userNotesByCategory.get(group.category) ?? [];
    for (const text of extras) {
      setCell(ws, row, 1, String(globalIdx), 's', {
        font: { sz: 10, name: 'Arial', color: { rgb: C.GROUP_FG } },
        fill: { patternType: 'solid', fgColor: { rgb: C.ROW_ODD } },
        alignment: { horizontal: 'center', vertical: 'top' },
        border: thinBorder(),
      });
      setCell(ws, row, 2, 'Additional Note', 's', {
        font: { bold: true, sz: 10, name: 'Arial' },
        fill: { patternType: 'solid', fgColor: { rgb: C.NOTE_LABEL_BG } },
        alignment: { horizontal: 'left', vertical: 'top' },
        border: thinBorder(),
      });
      setCell(ws, row, 3, text, 's', {
        font: { sz: 10, name: 'Arial' },
        fill: { patternType: 'solid', fgColor: { rgb: C.ROW_EVEN } },
        alignment: { horizontal: 'left', vertical: 'top', wrapText: true },
        border: thinBorder(),
      });
      setRowHeight(ws, row, 28);
      row++;
      globalIdx++;
    }

    spacer(ws, row, 3); row++;
  }

  // Any user categories not matching standard ones
  for (const [cat, texts] of userNotesByCategory.entries()) {
    if (standardNotes.some(g => g.category === cat)) continue; // already handled
    merge(ws, row, 1, row, 3);
    setCell(ws, row, 1, `  ${cat.toUpperCase()}`, 's', {
      font: { bold: true, sz: 10, name: 'Arial', color: { rgb: C.GROUP_FG } },
      fill: { patternType: 'solid', fgColor: { rgb: C.GROUP_BG } },
      alignment: { horizontal: 'left', vertical: 'center' },
      border: thinBorder(),
    });
    setRowHeight(ws, row, 18);
    row++;
    for (const text of texts) {
      setCell(ws, row, 1, String(globalIdx), 's', { font: { sz: 10, name: 'Arial' }, alignment: { horizontal: 'center' }, border: thinBorder() });
      setCell(ws, row, 2, 'Note', 's', { font: { bold: true, sz: 10, name: 'Arial' }, fill: { patternType: 'solid', fgColor: { rgb: C.NOTE_LABEL_BG } }, alignment: { horizontal: 'left' }, border: thinBorder() });
      setCell(ws, row, 3, text, 's', { font: { sz: 10, name: 'Arial' }, alignment: { horizontal: 'left', wrapText: true }, border: thinBorder() });
      setRowHeight(ws, row, 28);
      row++;
      globalIdx++;
    }
    spacer(ws, row, 3); row++;
  }

  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: row, c: 3 } });
  XLSX.utils.book_append_sheet(wb, ws, 'Notes & Assumptions');
}
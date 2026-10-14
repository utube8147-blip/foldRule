// ─── lib/export/theme.ts ─────────────────────────────────────────────────────
//
//  One look for every sheet of the project workbook: the navy / gold design of
//  the original BOQ_Matrix, Materials_List and Cost_Breakdown sheets.
//
//  Layout convention shared by all sheets:
//    • column A is a narrow gold accent stripe; content starts in column B
//    • rows 1–4 are the banner (gold stripe, navy title, blue subtitle, gold stripe)
//    • mid-blue header rows, banded data rows, navy grand-total rows
//    • a gold stripe and a navy footer note close the sheet
// ─────────────────────────────────────────────────────────────────────────────

import type * as ExcelJS from 'exceljs';

export const Palette = {
  NAVY:       'FF0D1B2A',
  GOLD:       'FFB8962E',
  GOLD_LIGHT: 'FFC8A84B',
  MID_BLUE:   'FF1A3A5C',
  CHARCOAL:   'FF2C3E50',
  WHITE:      'FFFFFFFF',
  PALE_BLUE:  'FFEBF3FB',
  MID_GREY:   'FF6C7A8D',
  DARK_TEXT:  'FF1C1C1C',
  SUBGRP_BG:  'FFD9E1F2',
  BAND:       'FFF8F9FC',
  RULE:       'FFE3E8EF',
  GREEN_HL:   'FFE8F5E9',
  GREEN_TEXT: 'FF1A5C3A',
  AMBER_HL:   'FFFFF8E7',
  LIME_HL:    'FFE2EFDA',
  PEACH_HL:   'FFFCE4D6',
  LINK_BLUE:  'FF2A6496',
  LINK_BG:    'FFEBF3FA',
  WARN_TEXT:  'FF9A3412',
  REMARK:     'FF8A9BAE',
} as const;

export const FONT_FACE = 'Calibri';
export const QTY_FMT   = '#,##0.00';
export const QTY3_FMT  = '#,##0.000';
export const PCT_FMT   = '0.0#%';

export const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

export const font = (size = 10, bold = false, argb: string = Palette.DARK_TEXT, italic = false): Partial<ExcelJS.Font> =>
  ({ name: FONT_FACE, size, bold, italic, color: { argb } });

export const align = (horizontal: ExcelJS.Alignment['horizontal'] = 'left', wrapText = false): Partial<ExcelJS.Alignment> =>
  ({ horizontal, vertical: 'middle', wrapText });

export const side = (style: ExcelJS.BorderStyle = 'thin', argb: string = Palette.RULE): ExcelJS.Border =>
  ({ style, color: { argb } });

const box = (s: ExcelJS.Border): Partial<ExcelJS.Borders> => ({ top: s, bottom: s, left: s, right: s });

/** Column number → letters (1 → A, 27 → AA). */
export function col(n: number): string {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

/** Quote a sheet name for use in a formula. */
export const ref = (sheet: string, cell: string) => `'${sheet.replace(/'/g, "''")}'!${cell}`;

export interface SheetOptions {
  /** Widths of columns B, C, … (column A is the accent stripe). */
  widths: number[];
  landscape?: boolean;
  /** Freeze everything above this row. */
  freezeBelow?: number;
  tab?: string;
}

/** A new sheet in the house style. Returns the sheet and its last column number. */
export function addSheet(wb: ExcelJS.Workbook, name: string, o: SheetOptions): { ws: ExcelJS.Worksheet; last: number } {
  const ws = wb.addWorksheet(name, {
    views: [{ showGridLines: false, ...(o.freezeBelow ? { state: 'frozen', ySplit: o.freezeBelow - 1 } : {}) }],
    pageSetup: {
      orientation: o.landscape ? 'landscape' : 'portrait', paperSize: 9,
      fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
    properties: { tabColor: { argb: o.tab ?? Palette.NAVY } },
  });
  ws.getColumn(1).width = 2.5;
  o.widths.forEach((w, i) => { ws.getColumn(i + 2).width = w; });
  return { ws, last: o.widths.length + 1 };
}

function paint(ws: ExcelJS.Worksheet, r: number, last: number, argb: string, accent = true) {
  for (let c = 1; c <= last; c++) ws.getCell(r, c).fill = fill(argb);
  if (accent) ws.getCell(r, 1).fill = fill(Palette.GOLD);
}

export function stripe(ws: ExcelJS.Worksheet, r: number, last: number, height = 4): number {
  ws.getRow(r).height = height;
  paint(ws, r, last, Palette.GOLD);
  return r + 1;
}

/** Rows 1–4: gold stripe, navy title, blue subtitle, gold stripe. Returns the next free row. */
export function banner(ws: ExcelJS.Worksheet, last: number, title: string, subtitle: string): number {
  let r = stripe(ws, 1, last, 5);
  ws.getRow(r).height = 34;
  paint(ws, r, last, Palette.NAVY);
  ws.mergeCells(r, 2, r, last);
  const t = ws.getCell(r, 2);
  t.value = title; t.font = font(14, true, Palette.WHITE); t.alignment = align('center');
  t.border = { bottom: side('medium', Palette.GOLD) };
  r++;
  ws.getRow(r).height = 20;
  paint(ws, r, last, Palette.MID_BLUE);
  ws.mergeCells(r, 2, r, last);
  const s = ws.getCell(r, 2);
  s.value = subtitle; s.font = font(10, false, Palette.GOLD_LIGHT, true); s.alignment = align('center');
  r++;
  return stripe(ws, r, last, 3);
}

/** Pale-blue information line ("★ …"). */
export function note(ws: ExcelJS.Worksheet, r: number, last: number, text: string, warn = false): number {
  ws.getRow(r).height = Math.max(20, Math.ceil(text.length / 150) * 15);
  paint(ws, r, last, warn ? Palette.AMBER_HL : Palette.PALE_BLUE);
  ws.mergeCells(r, 2, r, last);
  const c = ws.getCell(r, 2);
  c.value = text;
  c.font = font(9, warn, warn ? Palette.WARN_TEXT : Palette.MID_GREY, !warn);
  c.alignment = align('left', true);
  return r + 1;
}

/** Navy section bar with a gold tag cell: "  F  │ WOODWORK ………… right note". */
export function sectionBar(ws: ExcelJS.Worksheet, r: number, last: number, tag: string, title: string, right = '', upper = true): number {
  ws.getRow(r).height = 28;
  const gold = side('medium', Palette.GOLD);
  for (let c = 1; c <= last; c++) {
    const cell = ws.getCell(r, c);
    cell.fill = fill(Palette.NAVY);
    cell.border = { top: gold, bottom: gold };
  }
  ws.getCell(r, 1).fill = fill(Palette.GOLD);
  const t = ws.getCell(r, 2);
  t.value = tag ? ` ${tag} ` : '';
  t.font = font(11, true, Palette.GOLD_LIGHT);
  t.fill = fill(Palette.MID_BLUE);
  t.alignment = align('center');
  t.border = { top: gold, bottom: gold, left: gold, right: side('thin', Palette.GOLD_LIGHT) };
  const endTitle = right ? Math.max(3, last - 2) : last;
  if (endTitle > 3) ws.mergeCells(r, 3, r, endTitle);
  const h = ws.getCell(r, 3);
  h.value = `  ${upper ? title.toUpperCase() : title}`;
  h.font = font(12, true, Palette.WHITE);
  h.alignment = align('left');
  if (right) {
    ws.mergeCells(r, endTitle + 1, r, last);
    const n = ws.getCell(r, endTitle + 1);
    n.value = right; n.font = font(10, false, Palette.GOLD_LIGHT, true); n.alignment = align('right');
  }
  return r + 1;
}

/** Mid-blue column headers. `right` = column numbers whose header is right-aligned. */
export function headerRow(ws: ExcelJS.Worksheet, r: number, labels: string[], opts: { height?: number; center?: number[]; right?: number[] } = {}): number {
  const lines = Math.max(...labels.map(l => l.split('\n').length));
  ws.getRow(r).height = opts.height ?? Math.max(28, lines * 14 + 8);
  const b = box(side('medium', Palette.GOLD_LIGHT));
  ws.getCell(r, 1).fill = fill(Palette.GOLD);
  labels.forEach((l, i) => {
    const c = ws.getCell(r, i + 2);
    c.value = l;
    c.font = font(10, true, Palette.WHITE);
    c.fill = fill(Palette.MID_BLUE);
    const h = opts.right?.includes(i + 2) ? 'right' : opts.center?.includes(i + 2) ? 'center' : 'left';
    c.alignment = align(h, true);
    c.border = b;
  });
  return r + 1;
}

/** Light-blue group / component row. */
export function groupRow(ws: ExcelJS.Worksheet, r: number, last: number): ExcelJS.Row {
  const row = ws.getRow(r);
  row.height = 22;
  paint(ws, r, last, Palette.SUBGRP_BG);
  for (let c = 2; c <= last; c++) {
    const cell = ws.getCell(r, c);
    cell.font = font(10, true, Palette.MID_BLUE);
    cell.alignment = align('left');
    cell.border = { bottom: side('thin', Palette.GOLD_LIGHT) };
  }
  return row;
}

/** Banded body row: white / very pale blue, hairline borders, gold accent in A. */
export function bodyRow(ws: ExcelJS.Worksheet, r: number, last: number, alt: boolean, height = 18): ExcelJS.Row {
  const row = ws.getRow(r);
  row.height = height;
  const b = box(side('thin', alt ? 'FFE3E8EF' : 'FFEEF2F7'));
  ws.getCell(r, 1).fill = fill(Palette.GOLD);
  for (let c = 2; c <= last; c++) {
    const cell = ws.getCell(r, c);
    cell.fill = fill(alt ? Palette.BAND : Palette.WHITE);
    cell.border = b;
    cell.font = font(10);
    cell.alignment = align('left');
  }
  return row;
}

/** Quantity cell (green, bold): a measured or calculated quantity. */
export function qtyCell(c: ExcelJS.Cell, value: ExcelJS.CellValue, fmt = QTY_FMT) {
  c.value = value; c.numFmt = fmt;
  c.font = font(10, true, Palette.GREEN_TEXT);
  c.fill = fill(Palette.GREEN_HL);
  c.alignment = align('right');
}

/** Rate / price cell: green when known, amber (to fill in) when zero. */
export function rateCell(c: ExcelJS.Cell, value: number | null, money: string) {
  c.value = value ?? null; c.numFmt = money;
  const known = !!value;
  c.font = font(10, known, known ? Palette.DARK_TEXT : 'FF9A6B00');
  c.fill = fill(known ? Palette.GREEN_HL : Palette.AMBER_HL);
  c.alignment = align('right');
}

/** Money result cell (formula), navy text. */
export function moneyCell(c: ExcelJS.Cell, value: ExcelJS.CellValue, money: string, bold = false) {
  c.value = value; c.numFmt = money;
  c.font = font(10, bold, Palette.NAVY);
  c.alignment = align('right');
}

/** Cell that pulls its value from another sheet (blue on pale blue). */
export function linkCell(c: ExcelJS.Cell, formula: string, fmt = QTY_FMT, result?: number) {
  c.value = result === undefined ? { formula } : { formula, result };
  c.numFmt = fmt;
  c.font = font(10, true, Palette.LINK_BLUE);
  c.fill = fill(Palette.LINK_BG);
  c.alignment = align('right');
}

export type TotalKind = 'sub' | 'line' | 'grand';

/**
 * A totals line: label in `labelCol` (merged leftwards from `labelFrom`), value in `valueCol`.
 * 'line' = plain, 'sub' = pale blue bold, 'grand' = navy with gold figures.
 */
export function totalRow(ws: ExcelJS.Worksheet, r: number, last: number, o: {
  label: string; value: ExcelJS.CellValue; valueCol: number; labelFrom?: number; kind?: TotalKind; fmt: string;
}): number {
  const kind = o.kind ?? 'line';
  const bg = kind === 'grand' ? Palette.NAVY : kind === 'sub' ? Palette.PALE_BLUE : Palette.WHITE;
  ws.getRow(r).height = kind === 'grand' ? 26 : 20;
  for (let c = 2; c <= last; c++) ws.getCell(r, c).fill = fill(bg);
  ws.getCell(r, 1).fill = fill(Palette.GOLD);
  const from = o.labelFrom ?? o.valueCol - 1;
  if (from < o.valueCol - 1) ws.mergeCells(r, from, r, o.valueCol - 1);
  const l = ws.getCell(r, from);
  l.value = o.label;
  l.font = font(kind === 'grand' ? 12 : 10, kind !== 'line', kind === 'grand' ? Palette.WHITE : Palette.NAVY);
  l.alignment = align('right');
  const v = ws.getCell(r, o.valueCol);
  v.value = o.value; v.numFmt = o.fmt;
  v.font = font(kind === 'grand' ? 12 : 10, kind !== 'line', kind === 'grand' ? Palette.GOLD_LIGHT : Palette.NAVY);
  v.alignment = align('right');
  if (kind === 'grand') v.border = box(side('medium', Palette.GOLD_LIGHT));
  else if (kind === 'sub') v.border = { top: side('thin', Palette.MID_BLUE) };
  return r + 1;
}

/** Gold stripe + navy footer note. Returns the next free row. */
export function footer(ws: ExcelJS.Worksheet, r: number, last: number, text: string): number {
  r = stripe(ws, r + 1, last, 4);
  ws.getRow(r).height = 20;
  paint(ws, r, last, Palette.NAVY, false);
  ws.mergeCells(r, 1, r, last);
  const c = ws.getCell(r, 1);
  c.value = text; c.font = font(8, false, Palette.MID_GREY, true); c.alignment = align('center', true);
  return r + 1;
}

/** Widen a column so the longest line of text fits, within limits. */
export function fitWidth(ws: ExcelJS.Worksheet, column: number, texts: Array<string | undefined>, min: number, max: number) {
  const longest = texts.reduce((m, t) => Math.max(m, ...String(t ?? '').split('\n').map(l => l.length)), 0);
  ws.getColumn(column).width = Math.min(max, Math.max(min, longest + 3));
}

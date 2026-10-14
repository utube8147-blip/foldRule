// ─── lib/export/studio/sheetModel.ts ─────────────────────────────────────────
//
//  A light, serialisable picture of a worksheet for the on-screen preview:
//  values, formulas, styles, merges, column widths and row heights.
//  Built from the ExcelJS workbook the export produces, so the preview is the
//  file — same cells, same colours.
// ─────────────────────────────────────────────────────────────────────────────

import type * as ExcelJS from 'exceljs';

export type Scalar = string | number | boolean | null;

export interface Border { w: 1 | 2; c: string }

export interface CellStyle {
  bg?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  size?: number;
  font?: string;
  h?: 'left' | 'center' | 'right';
  v?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  numFmt?: string;
  bt?: Border; bb?: Border; bl?: Border; br?: Border;
}

export interface CellModel {
  /** Typed-in value (for formula cells: the last known result, if any). */
  v: Scalar;
  /** Formula without the leading "=". */
  f?: string;
  s: CellStyle;
}

export interface Merge { r1: number; c1: number; r2: number; c2: number }

export interface SheetModel {
  name: string;
  tab?: string;
  nRows: number;
  nCols: number;
  /** Column widths in Excel character units (index 1 = A). 0 = hidden. */
  colWidths: number[];
  /** Row heights in points (index 1 = row 1). */
  rowHeights: number[];
  cells: Map<string, CellModel>;
  merges: Merge[];
}

export const key = (r: number, c: number) => `${r}:${c}`;

export function colName(n: number): string {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
export const addr = (r: number, c: number) => `${colName(c)}${r}`;

export function parseAddr(a: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(a.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]), c };
}

const hex = (argb?: string) => (argb && /^[0-9a-f]{8}$/i.test(argb) ? `#${argb.slice(2)}` : argb && /^[0-9a-f]{6}$/i.test(argb) ? `#${argb}` : undefined);

function border(b?: Partial<ExcelJS.Border>): Border | undefined {
  if (!b?.style) return undefined;
  return { w: b.style === 'medium' || b.style === 'thick' || b.style === 'double' ? 2 : 1, c: hex(b.color?.argb) ?? '#BBBBBB' };
}

export function styleOf(cell: ExcelJS.Cell): CellStyle {
  const s: CellStyle = {};
  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  if (fill?.type === 'pattern' && fill.pattern === 'solid') s.bg = hex(fill.fgColor?.argb);
  const f = cell.font;
  if (f) {
    if (f.color?.argb) s.color = hex(f.color.argb);
    if (f.bold) s.bold = true;
    if (f.italic) s.italic = true;
    if (f.size) s.size = f.size;
    if (f.name) s.font = f.name;
  }
  const a = cell.alignment;
  if (a) {
    if (a.horizontal === 'left' || a.horizontal === 'center' || a.horizontal === 'right') s.h = a.horizontal;
    if (a.vertical === 'top' || a.vertical === 'middle' || a.vertical === 'bottom') s.v = a.vertical;
    if (a.wrapText) s.wrap = true;
  }
  if (cell.numFmt) s.numFmt = cell.numFmt;
  const b = cell.border;
  if (b) { s.bt = border(b.top); s.bb = border(b.bottom); s.bl = border(b.left); s.br = border(b.right); }
  return s;
}

function scalarOf(v: ExcelJS.CellValue): { v: Scalar; f?: string } {
  if (v === null || v === undefined) return { v: null };
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return { v };
  if (v instanceof Date) return { v: toSerial(v) };
  if (typeof v === 'object') {
    if ('formula' in v && v.formula) {
      const r = (v as ExcelJS.CellFormulaValue).result;
      return { f: String(v.formula).replace(/^=/, ''), v: r === undefined || r === null || typeof r === 'object' ? null : (r as Scalar) };
    }
    if ('richText' in v) return { v: v.richText.map(t => t.text).join('') };
    if ('text' in v) return { v: String((v as ExcelJS.CellHyperlinkValue).text) };
    if ('error' in v) return { v: String((v as ExcelJS.CellErrorValue).error) };
  }
  return { v: String(v) };
}

/** Excel date serial (days since 1899-12-30), in local time as Excel shows it. */
export function toSerial(d: Date): number {
  return (d.getTime() - d.getTimezoneOffset() * 60000) / 86400000 + 25569;
}

export function sheetModel(ws: ExcelJS.Worksheet): SheetModel {
  const cells = new Map<string, CellModel>();
  let nRows = 0, nCols = 0;
  // Every row, not just rows with values: stripes and bars are colour only.
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      if (cell.isMerged && cell.master.address !== cell.address) return;
      const { v, f } = scalarOf(cell.value);
      const s = styleOf(cell);
      if (v === null && !f && !s.bg && !s.bt && !s.bb && !s.bl && !s.br) return;
      cells.set(key(r, c), { v, f, s });
      nRows = Math.max(nRows, r); nCols = Math.max(nCols, c);
    });
  }
  const merges: Merge[] = [];
  for (const m of (ws.model as unknown as { merges?: string[] }).merges ?? []) {
    const [a, b] = m.split(':');
    const p = parseAddr(a), q = parseAddr(b ?? a);
    if (p && q) { merges.push({ r1: p.r, c1: p.c, r2: q.r, c2: q.c }); nRows = Math.max(nRows, q.r); nCols = Math.max(nCols, q.c); }
  }
  nCols = Math.max(nCols, ws.columnCount);
  nRows = Math.max(nRows, ws.rowCount);
  const colWidths: number[] = [0];
  for (let c = 1; c <= nCols; c++) {
    const col = ws.getColumn(c);
    colWidths.push(col.hidden ? 0 : (col.width ?? 9));
  }
  const rowHeights: number[] = [0];
  for (let r = 1; r <= nRows; r++) rowHeights.push(ws.getRow(r).height ?? 15);
  return {
    name: ws.name,
    tab: hex((ws.properties as { tabColor?: { argb?: string } }).tabColor?.argb),
    nRows, nCols, colWidths, rowHeights, cells, merges,
  };
}

export function workbookModel(wb: ExcelJS.Workbook): SheetModel[] {
  return wb.worksheets.map(sheetModel);
}

export function cloneSheet(s: SheetModel): SheetModel {
  const cells = new Map<string, CellModel>();
  for (const [k, c] of s.cells) cells.set(k, { v: c.v, f: c.f, s: { ...c.s } });
  return { ...s, cells, merges: [...s.merges], colWidths: [...s.colWidths], rowHeights: [...s.rowHeights] };
}

/** Top-left cell of the merge a cell belongs to (or the cell itself). */
export function masterOf(s: SheetModel, r: number, c: number): { r: number; c: number } {
  const m = s.merges.find(m => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2);
  return m ? { r: m.r1, c: m.c1 } : { r, c };
}

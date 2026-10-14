// ─── lib/export/studio/edits.ts ──────────────────────────────────────────────
//
//  Changes made in the export preview, kept with the project and applied on top
//  of a freshly built workbook every time.
//
//  Each edit remembers what the generated cell held when it was made ("was").
//  If the takeoff changes and that cell now holds something else, the edit is
//  "stale": it is not applied silently but listed for the person to re-apply or
//  drop, so an edited rate never lands on the wrong row.
// ─────────────────────────────────────────────────────────────────────────────

import type * as ExcelJS from 'exceljs';
import type { ThemeSettings } from '../theme';
import { cloneSheet, key, parseAddr, type CellModel, type CellStyle, type Scalar, type SheetModel } from './sheetModel';
import { sheetsReferenced, type Values } from './recalc';

export interface CellEdit {
  sheet: string;
  addr: string;
  /** What was typed: "=F9*2" (formula), "12.5", "5%", "text", "" (clear). Absent = style only. */
  input?: string;
  /** Formatting changes only. */
  style?: Partial<CellStyle>;
  /** The generated cell when the edit was made (see snapshot()). */
  was: string;
  /** Apply even though the generated cell has changed since. */
  force?: boolean;
}

export interface ExportSettings {
  /** Sheets left out of the file (by name). New sheets are included by default. */
  exclude?: string[];
  theme?: ThemeSettings;
  edits?: CellEdit[];
  filename?: string;
  /** The details step has been seen (filled in or skipped). */
  detailsReviewed?: boolean;
}

export const snapshot = (cell?: CellModel) =>
  !cell ? '' : cell.f ? `=${cell.f}` : cell.v === null || cell.v === undefined ? '' : String(cell.v);

/** Typed text → formula or value, as Excel reads it. */
export function parseInput(input: string): { f?: string; v: Scalar } {
  const t = input.trim();
  if (t.startsWith('=') && t.length > 1) return { f: t.slice(1), v: null };
  if (t === '') return { v: null };
  const pct = /^([-+]?[\d,]*\.?\d+)\s*%$/.exec(t);
  if (pct) return { v: Number(pct[1].replace(/,/g, '')) / 100 };
  const num = t.replace(/,/g, '');
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(num)) return { v: Number(num) };
  if (/^true$/i.test(t)) return { v: true };
  if (/^false$/i.test(t)) return { v: false };
  return { v: input };
}

/** Add an edit, folding it into an earlier edit of the same cell. */
export function addEdit(edits: CellEdit[], e: CellEdit): CellEdit[] {
  const i = edits.findIndex(x => x.sheet === e.sheet && x.addr === e.addr);
  if (i < 0) return [...edits, e];
  const prev = edits[i];
  const merged: CellEdit = {
    ...prev,
    input: e.input !== undefined ? e.input : prev.input,
    style: e.style || prev.style ? { ...(prev.style ?? {}), ...(e.style ?? {}) } : undefined,
  };
  return edits.map((x, j) => (j === i ? merged : x));
}

export interface Applied {
  sheets: SheetModel[];
  applied: CellEdit[];
  stale: CellEdit[];
}

/** Lay edits over the generated sheets (which are not changed). */
export function applyEdits(base: SheetModel[], edits: CellEdit[] = []): Applied {
  const touched = new Map<string, SheetModel>();
  const applied: CellEdit[] = [], stale: CellEdit[] = [];
  for (const e of edits) {
    const orig = base.find(s => s.name === e.sheet);
    const at = parseAddr(e.addr);
    if (!orig || !at) { stale.push(e); continue; }
    const k = key(at.r, at.c);
    if (!e.force && snapshot(orig.cells.get(k)) !== e.was) { stale.push(e); continue; }
    let s = touched.get(orig.name);
    if (!s) { s = cloneSheet(orig); touched.set(orig.name, s); }
    const cell: CellModel = s.cells.get(k) ?? { v: null, s: {} };
    if (e.input !== undefined) {
      const p = parseInput(e.input);
      cell.f = p.f; cell.v = p.v;
    }
    if (e.style) cell.s = { ...cell.s, ...e.style };
    s.cells.set(k, cell);
    s.nRows = Math.max(s.nRows, at.r); s.nCols = Math.max(s.nCols, at.c);
    applied.push(e);
  }
  return { sheets: base.map(s => touched.get(s.name) ?? s), applied, stale };
}

const argb = (h?: string) => (h ? `FF${h.replace('#', '').toUpperCase()}` : undefined);

function excelValue(v: Scalar): ExcelJS.CellValue {
  if (typeof v === 'string' && /^#(REF|VALUE|DIV\/0|NAME\?|N\/A|NUM|NULL|CYCLE|ERROR)!?$/.test(v)) return { error: v as ExcelJS.CellErrorValue['error'] };
  return v;
}

/** Write the edits into the real workbook, store every formula's result, and drop left-out sheets. */
export function finishWorkbook(wb: ExcelJS.Workbook, sheets: SheetModel[], applied: CellEdit[], values: Values, exclude: Set<string>) {
  for (const e of applied) {
    const ws = wb.getWorksheet(e.sheet);
    if (!ws) continue;
    const cell = ws.getCell(e.addr);
    if (e.input !== undefined) {
      const p = parseInput(e.input);
      cell.value = p.f ? { formula: p.f } : p.v;
    }
    if (e.style) {
      const st = e.style;
      if ('bg' in st) cell.fill = st.bg ? { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(st.bg)! } } : { type: 'pattern', pattern: 'none' };
      if ('color' in st || 'bold' in st || 'italic' in st || 'size' in st || 'font' in st) {
        cell.font = {
          ...(cell.font ?? {}),
          ...('color' in st ? { color: { argb: argb(st.color) } } : {}),
          ...('bold' in st ? { bold: !!st.bold } : {}),
          ...('italic' in st ? { italic: !!st.italic } : {}),
          ...(st.size ? { size: st.size } : {}),
          ...(st.font ? { name: st.font } : {}),
        };
      }
      if ('h' in st || 'wrap' in st || 'v' in st) {
        cell.alignment = { ...(cell.alignment ?? {}), ...('h' in st ? { horizontal: st.h } : {}), ...('v' in st ? { vertical: st.v } : {}), ...('wrap' in st ? { wrapText: !!st.wrap } : {}) };
      }
      if ('numFmt' in st) cell.numFmt = st.numFmt ?? 'General';
    }
  }

  // Results, so the file shows numbers even where nothing recalculates (previews, phones);
  // links into a left-out sheet become plain values.
  for (const s of sheets) {
    if (exclude.has(s.name)) continue;
    const ws = wb.getWorksheet(s.name);
    if (!ws) continue;
    const computed = values.get(s.name);
    for (const [k, c] of s.cells) {
      if (!c.f) continue;
      const [r, col] = k.split(':').map(Number);
      const result = computed?.get(k) ?? null;
      const cell = ws.getCell(r, col);
      const readsLeftOut = exclude.size > 0 && sheetsReferenced(c.f, s.name).some(n => exclude.has(n) || [...exclude].some(x => x.toLowerCase() === n.toLowerCase()));
      if (readsLeftOut) cell.value = excelValue(result);
      else cell.value = result === null || typeof result === 'object' ? { formula: c.f } : { formula: c.f, result: excelValue(result) as number | string | boolean } as ExcelJS.CellFormulaValue;
    }
  }
  for (const name of exclude) {
    const ws = wb.getWorksheet(name);
    if (ws && wb.worksheets.length > 1) wb.removeWorksheet(ws.id);
  }
}

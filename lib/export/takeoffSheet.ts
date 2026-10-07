// ─── lib/export/takeoffSheet.ts ──────────────────────────────────────────────
//
//  Builds the "Takeoff" worksheet directly from the user's measurements.
//  This is the primary, always-present sheet of every export: one row per
//  measurement, grouped under their group headers, with live Excel formulas
//  for amounts, group subtotals, VAT and grand total.
// ─────────────────────────────────────────────────────────────────────────────

import { excelMoneyFormat } from '@/lib/takeoff/currency';
import type * as ExcelJS from 'exceljs';
import type { TakeoffRow, Material } from '@/types';

export interface TakeoffExportDrawing {
  id:          string;
  name:        string;
  pageScales?: Record<number, number>;
  scaleFactor?: number;
}

export interface TakeoffExportInput {
  projectName:    string;
  projectNumber?: string;
  location?:      string;
  documentTitle?: string;
  documentDate?:  string;
  revision?:      string;
  currency?:      string;
  vatPercent?:    number;
  drawings:       TakeoffExportDrawing[];
  measurements:   TakeoffRow[];
  materials:      Material[];
  /** Build-up from measured work to the tender sum, and the buying list. */
  estimate?: {
    lines: Array<{ label: string; percent?: number | null; amount: number; total?: boolean; note?: string }>;
    provisional?: Array<{ name: string; amount: number }>;
    order: Array<{ code: string; name: string; net: number; unit: string; wastePercent: number; orderQty: number; buyUnit: string; covers: number; price: number; cost: number; supplier?: string }>;
  };
  /** Who changed what, and when. */
  auditLog?: Array<{ at: string; by: string; what: string; target: string; from?: string; to?: string }>;
  /** Value engineering: alternatives priced against the designed materials. */
  valueEngineering?: {
    pending: number;
    lines: Array<{ designed: string; alternative: string; unit: string; quantity: number; designedRate: number; designedCost: number; alternativeRate: number; alternativeCost: number; status: string; note?: string }>;
  };
  /** One entry per accepted drawing revision: what it did to the quantities. */
  revisionChanges?: Array<{
    record: { at: string; from: { name: string }; to: { name: string } };
    cost: number;
    lines: Array<{ description: string; group?: string; unit: string; before: number; after: number; diff: number; rate: number; cost: number; status: string }>;
  }>;
}

const COLS = [
  { key: 'item',     header: 'Item',        width: 8  },
  { key: 'desc',     header: 'Description', width: 44 },
  { key: 'drawing',  header: 'Drawing',     width: 24 },
  { key: 'page',     header: 'Page',        width: 7  },
  { key: 'type',     header: 'Type',        width: 11 },
  { key: 'qty',      header: 'Quantity',    width: 13 },
  { key: 'unit',     header: 'Unit',        width: 9  },
  { key: 'rate',     header: 'Rate',        width: 13 },
  { key: 'amount',   header: 'Amount',      width: 16 },
  { key: 'notes',    header: 'Notes',       width: 40 },
] as const;

const C = {
  qty:    6, // F
  rate:   8, // H
  amount: 9, // I
};
const L = (n: number) => String.fromCharCode(64 + n);

const INK       = 'FF1F2328';
const MUTED     = 'FF5B6470';
const RULE      = 'FFD0D4DA';
const GROUP_BG  = 'FFEEF1F4';
const HEAD_BG   = 'FF26303B';
const ACCENT_BG = 'FFFFF4D6';

function rateFor(row: TakeoffRow, materials: Map<string, Material>): number {
  if (row.unitRate) return row.unitRate;
  const mat = row.materialId ? materials.get(row.materialId) : undefined;
  return mat?.unitRate ?? 0;
}

/** Orders rows as: [group header, ...its children], ..., then ungrouped rows. */
export function orderRowsForExport(measurements: TakeoffRow[]): { row: TakeoffRow; level: 0 | 1 }[] {
  const byId    = new Map(measurements.map(m => [m.id, m]));
  const headers = measurements.filter(m => m.isGroupHeader);
  const used    = new Set<string>();
  const out: { row: TakeoffRow; level: 0 | 1 }[] = [];

  for (const h of headers) {
    out.push({ row: h, level: 0 });
    used.add(h.id);
    const childIds = new Set(h.childIds ?? []);
    const children = measurements.filter(m =>
      !m.isGroupHeader && (m.parentId === h.id || childIds.has(m.id)));
    for (const c of children) {
      if (used.has(c.id)) continue;
      out.push({ row: c, level: 1 });
      used.add(c.id);
    }
  }
  for (const m of measurements) {
    if (used.has(m.id) || m.isGroupHeader) continue;
    // Orphaned child whose header is gone → treat as standalone.
    if (m.parentId && byId.has(m.parentId)) continue;
    out.push({ row: m, level: 0 });
  }
  return out;
}

export function addTakeoffSheet(workbook: ExcelJS.Workbook, input: TakeoffExportInput): ExcelJS.Worksheet {
  const ws = workbook.addWorksheet('Takeoff', {
    views: [{ state: 'frozen', ySplit: 6 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  ws.columns = [
    ...COLS.map(c => ({ key: c.key, width: c.width })),
    { key: 'top', width: 3, hidden: true },
  ];

  const currency   = input.currency || '';
  const moneyFmt   = excelMoneyFormat(currency);
  const qtyFmt     = '#,##0.00';
  const drawings   = new Map(input.drawings.map(d => [d.id, d]));
  const materials  = new Map(input.materials.map(m => [m.id, m]));

  // ── Title block ───────────────────────────────────────────────────────────
  ws.mergeCells('A1:J1');
  const title = ws.getCell('A1');
  title.value = input.documentTitle || `${input.projectName} — Quantity takeoff`;
  title.font  = { bold: true, size: 15, color: { argb: INK } };

  const meta = [
    input.projectNumber ? `Project no. ${input.projectNumber}` : '',
    input.location ?? '',
    input.revision ? `Rev ${input.revision}` : '',
    input.documentDate ?? new Date().toISOString().slice(0, 10),
  ].filter(Boolean).join('   |   ');
  ws.mergeCells('A2:J2');
  ws.getCell('A2').value = meta;
  ws.getCell('A2').font  = { size: 10, color: { argb: MUTED } };

  const uncalibrated = input.measurements.some(m => {
    if (m.isGroupHeader || !m.points?.length) return false;
    const d = drawings.get(m.drawingId);
    const page = m.pageNumber ?? 1;
    const s = d?.pageScales?.[page] ?? (d && !d.pageScales && d.scaleFactor !== 1 ? d.scaleFactor : undefined);
    return !(s && s > 0);
  });
  if (uncalibrated) {
    ws.mergeCells('A3:J3');
    const w = ws.getCell('A3');
    w.value = 'Warning: some quantities were measured on pages without a calibrated scale and are in drawing units.';
    w.font  = { size: 10, bold: true, color: { argb: 'FF9A3412' } };
    w.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT_BG } };
  }

  // ── Header row ────────────────────────────────────────────────────────────
  const HEADER_ROW = 6;
  const header = ws.getRow(HEADER_ROW);
  COLS.forEach((c, i) => { header.getCell(i + 1).value = c.header; });
  header.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } };
  header.alignment = { vertical: 'middle' };
  header.height    = 20;
  [C.qty, C.rate, C.amount, 4].forEach(ci => { header.getCell(ci).alignment = { horizontal: 'right', vertical: 'middle' }; });

  // ── Body ──────────────────────────────────────────────────────────────────
  const ordered = orderRowsForExport(input.measurements);
  let r = HEADER_ROW + 1;
  let groupNo = 0;
  let childNo = 0;
  let looseNo = 0;
  const topLevelAmountCells: string[] = [];
  const markTopLevel = (rowNo: number) => {
    topLevelAmountCells.push(`${L(C.amount)}${rowNo}`);
    ws.getRow(rowNo).getCell(11).value = 1;
  };
  let openGroup: { headerRow: number; firstChild: number } | null = null;

  const closeGroup = () => {
    if (!openGroup) return;
    const hr = ws.getRow(openGroup.headerRow);
    const last = r - 1;
    hr.getCell(C.amount).value = last >= openGroup.firstChild
      ? { formula: `SUM(${L(C.amount)}${openGroup.firstChild}:${L(C.amount)}${last})` }
      : 0;
    openGroup = null;
  };

  for (const { row: m, level } of ordered) {
    const row = ws.getRow(r);
    const d   = drawings.get(m.drawingId);

    if (m.isGroupHeader) {
      closeGroup();
      groupNo += 1; childNo = 0;
      row.getCell(1).value = String(groupNo);
      row.getCell(2).value = m.groupName || m.description || m.label || 'Group';
      row.getCell(3).value = d?.name ?? '';
      row.getCell(10).value = m.notes || '';
      row.font = { bold: true, color: { argb: INK } };
      for (let ci = 1; ci <= COLS.length; ci++) {
        row.getCell(ci).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GROUP_BG } };
      }
      row.getCell(C.amount).numFmt = moneyFmt;
      markTopLevel(r);
      openGroup = { headerRow: r, firstChild: r + 1 };
      r += 1;
      continue;
    }

    if (level === 0) { closeGroup(); looseNo += 1; }
    else childNo += 1;

    row.getCell(1).value = level === 1 ? `${groupNo}.${childNo}` : `M${looseNo}`;
    row.getCell(2).value = (level === 1 ? '    ' : '') + (m.description || m.label || 'Untitled');
    row.getCell(3).value = d?.name ?? '';
    row.getCell(4).value = m.points?.length ? (m.pageNumber ?? 1) : '';
    row.getCell(5).value = m.type;
    row.getCell(C.qty).value  = Number.isFinite(m.quantity) ? Number(m.quantity) : 0;
    row.getCell(C.qty).numFmt = qtyFmt;
    row.getCell(7).value = m.unit || '';
    row.getCell(C.rate).value  = rateFor(m, materials);
    row.getCell(C.rate).numFmt = moneyFmt;
    row.getCell(C.amount).value  = { formula: `${L(C.qty)}${r}*${L(C.rate)}${r}` };
    row.getCell(C.amount).numFmt = moneyFmt;
    row.getCell(10).value = [m.notes, m.isOverridden ? '(manual quantity)' : ''].filter(Boolean).join(' ');
    row.font = { color: { argb: INK } };
    row.getCell(4).alignment = { horizontal: 'right' };
    if (level === 0) markTopLevel(r);
    r += 1;
  }
  closeGroup();

  if (ordered.length === 0) {
    ws.mergeCells(`A${r}:J${r}`);
    ws.getCell(`A${r}`).value = 'No measurements yet.';
    ws.getCell(`A${r}`).font  = { italic: true, color: { argb: MUTED } };
    r += 1;
  }

  // Thin rule under each body row
  for (let i = HEADER_ROW + 1; i < r; i++) {
    for (let ci = 1; ci <= COLS.length; ci++) {
      ws.getRow(i).getCell(ci).border = { bottom: { style: 'hair', color: { argb: RULE } } };
    }
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  r += 1;
  const vat = Math.max(0, Number(input.vatPercent) || 0);
  const subtotalRow = r;
  const totalLine = (label: string, value: ExcelJS.CellValue, bold = false) => {
    const row = ws.getRow(r);
    row.getCell(C.rate).value = label;
    row.getCell(C.rate).alignment = { horizontal: 'right' };
    row.getCell(C.amount).value = value;
    row.getCell(C.amount).numFmt = moneyFmt;
    row.font = { bold, color: { argb: INK } };
    r += 1;
  };
  // Column K flags top-level rows (group headers + ungrouped items) so the
  // subtotal never double-counts children already inside a group subtotal.
  totalLine('Subtotal', topLevelAmountCells.length
    ? { formula: `SUMIF(K${HEADER_ROW + 1}:K${subtotalRow - 2},1,${L(C.amount)}${HEADER_ROW + 1}:${L(C.amount)}${subtotalRow - 2})` }
    : 0, true);
  if (vat > 0) {
    totalLine(`VAT ${vat}%`, { formula: `${L(C.amount)}${subtotalRow}*${vat}/100` });
    totalLine('Total', { formula: `${L(C.amount)}${subtotalRow}+${L(C.amount)}${subtotalRow + 1}` }, true);
  } else {
    totalLine('Total', { formula: `${L(C.amount)}${subtotalRow}` }, true);
  }
  ws.getRow(r - 1).getCell(C.amount).border = { top: { style: 'thin' }, bottom: { style: 'double' } };

  // Footer credit
  r += 1;
  ws.mergeCells(`A${r}:J${r}`);
  ws.getCell(`A${r}`).value = `Prepared with Foldrule · ${new Date().toISOString().slice(0, 10)}`;
  ws.getCell(`A${r}`).font  = { size: 9, color: { argb: MUTED } };

  return ws;
}

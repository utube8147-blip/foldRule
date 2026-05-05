// boqExportExcelJS.ts
import * as ExcelJS from 'exceljs';

// ═══════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ═══════════════════════════════════════════════════════════════════

export interface ProjectMeta {
  projectName: string;
  client?: string;
  location?: string;
  refNo?: string;
  drawingRefs?: string;
  mainContractor?: string;
  consultant?: string;
  preparedBy?: string;
  revision?: string;
  vatRate?: number;
  currency?: string;
  notes?: NoteItem[];
}

export interface NoteItem {
  category: string;
  text: string;
}

export interface Measurement {
  description: string;
  spec?: string;
  type?: string;
  group?: string;
  unit: string;
  quantity: number;
  unitRate: number;
  times?: number;
  L?: number | null;
  W?: number | null;
  H?: number | null;
  remarks?: string;
  qtyPrecision?: number;
}

export interface ProjectState {
  projectName: string;
  meta?: ProjectMeta;
  measurements: Measurement[];
}

// ═══════════════════════════════════════════════════════════════════
// COLOR PALETTE - Professional Al-Waha Standard
// ═══════════════════════════════════════════════════════════════════

const Colors = {
  // Primary brand colors
  PRIMARY_DARK: 'FF1F3864',      // Deep navy blue
  PRIMARY_MEDIUM: 'FF2E75B6',    // Medium corporate blue
  PRIMARY_LIGHT: 'FFD6DCE4',     // Light blue-grey
  
  // Accent colors
  ACCENT_GOLD: 'FFC5A059',        // Gold accent for headers
  ACCENT_RED: 'FFC00000',         // Warning/alert red
  
  // Backgrounds
  BG_HEADER: 'FF1F3864',
  BG_SUBHEADER: 'FF2E75B6',
  BG_SECTION: 'FFE8EDF4',         // Soft blue-grey for section headers
  BG_SUBTOTAL: 'FFE2E8F0',        // Subtle grey-blue
  BG_GRAND: 'FF1F3864',
  BG_VAT: 'FFE8EDF4',
  BG_TOTAL_INC: 'FF1F3864',
  
  // Row alternation
  ROW_ODD: 'FFFFFFFF',            // White
  ROW_EVEN: 'FFF7F9FC',           // Very light blue-grey
  
  // Input cells (yellow highlight)
  INPUT_HIGHLIGHT: 'FFFFFFCC',    // Soft yellow for editable cells
  
  // Text colors
  TEXT_DARK: 'FF1A1A2E',
  TEXT_MEDIUM: 'FF4A4A6A',
  TEXT_LIGHT: 'FF6B6B8D',
  TEXT_WHITE: 'FFFFFFFF',
  TEXT_GOLD: 'FFC5A059',
  
  // Borders
  BORDER_LIGHT: 'FFD0D5E0',
  BORDER_MEDIUM: 'FF2E75B6',
  BORDER_DARK: 'FF1F3864',
};

// ═══════════════════════════════════════════════════════════════════
// STYLE FACTORIES
// ═══════════════════════════════════════════════════════════════════

function createTitleStyle(): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 16, bold: true, color: { argb: Colors.TEXT_WHITE } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: Colors.BG_HEADER } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: {
      top: { style: 'medium', color: { argb: Colors.BORDER_MEDIUM } },
      bottom: { style: 'medium', color: { argb: Colors.BORDER_MEDIUM } },
      left: { style: 'medium', color: { argb: Colors.BORDER_MEDIUM } },
      right: { style: 'medium', color: { argb: Colors.BORDER_MEDIUM } },
    },
  };
}

function createSubtitleStyle(): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 11, bold: true, color: { argb: Colors.TEXT_WHITE } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: Colors.BG_SUBHEADER } },
    alignment: { horizontal: 'center', vertical: 'middle' },
  };
}

function createHeaderStyle(): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 10, bold: true, color: { argb: Colors.TEXT_WHITE } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: Colors.BG_SUBHEADER } },
    alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    border: {
      top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
    },
  };
}

function createSectionHeaderStyle(): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 11, bold: true, color: { argb: Colors.PRIMARY_DARK } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: Colors.BG_SECTION } },
    alignment: { horizontal: 'left', vertical: 'middle' },
    border: {
      top: { style: 'thin', color: { argb: Colors.BORDER_MEDIUM } },
      bottom: { style: 'thin', color: { argb: Colors.BORDER_MEDIUM } },
      left: { style: 'thin', color: { argb: Colors.BORDER_MEDIUM } },
      right: { style: 'thin', color: { argb: Colors.BORDER_MEDIUM } },
    },
  };
}

function createDataStyle(isOdd: boolean, isInput: boolean = false): Partial<ExcelJS.Style> {
  const baseStyle: Partial<ExcelJS.Style> = {
    font: { name: 'Segoe UI', size: 10, color: { argb: Colors.TEXT_DARK } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: isInput ? Colors.INPUT_HIGHLIGHT : (isOdd ? Colors.ROW_ODD : Colors.ROW_EVEN) } },
    alignment: { vertical: 'middle' },
    border: {
      top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
    },
  };
  return baseStyle;
}

function createSpecStyle(isOdd: boolean): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 9, italic: true, color: { argb: Colors.TEXT_LIGHT } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: isOdd ? Colors.ROW_ODD : Colors.ROW_EVEN } },
    alignment: { horizontal: 'left', vertical: 'middle', indent: 2 },
    border: {
      top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
    },
  };
}

function createSubtotalStyle(): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 10, bold: true, color: { argb: Colors.PRIMARY_DARK } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: Colors.BG_SUBTOTAL } },
    alignment: { horizontal: 'right', vertical: 'middle' },
    border: {
      top: { style: 'thin', color: { argb: Colors.BORDER_MEDIUM } },
      bottom: { style: 'thin', color: { argb: Colors.BORDER_MEDIUM } },
      left: { style: 'thin', color: { argb: Colors.BORDER_MEDIUM } },
      right: { style: 'thin', color: { argb: Colors.BORDER_MEDIUM } },
    },
  };
}

function createGrandTotalStyle(): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 11, bold: true, color: { argb: Colors.TEXT_WHITE } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: Colors.BG_GRAND } },
    alignment: { horizontal: 'right', vertical: 'middle' },
    border: {
      top: { style: 'medium', color: { argb: Colors.BORDER_DARK } },
      bottom: { style: 'medium', color: { argb: Colors.BORDER_DARK } },
      left: { style: 'medium', color: { argb: Colors.BORDER_DARK } },
      right: { style: 'medium', color: { argb: Colors.BORDER_DARK } },
    },
  };
}

function createVatStyle(): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 10, bold: true, color: { argb: Colors.PRIMARY_DARK } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: Colors.BG_VAT } },
    alignment: { horizontal: 'right', vertical: 'middle' },
    border: {
      top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
    },
  };
}

function createTotalIncStyle(): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 12, bold: true, color: { argb: Colors.TEXT_WHITE } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: Colors.BG_TOTAL_INC } },
    alignment: { horizontal: 'right', vertical: 'middle' },
    border: {
      top: { style: 'medium', color: { argb: Colors.BORDER_DARK } },
      bottom: { style: 'medium', color: { argb: Colors.BORDER_DARK } },
      left: { style: 'medium', color: { argb: Colors.BORDER_DARK } },
      right: { style: 'medium', color: { argb: Colors.BORDER_DARK } },
    },
  };
}

function createInfoLabelStyle(): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 10, bold: true, color: { argb: Colors.PRIMARY_DARK } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: Colors.BG_SECTION } },
    alignment: { horizontal: 'left', vertical: 'middle' },
    border: {
      top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
    },
  };
}

function createInfoValueStyle(): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 10, color: { argb: Colors.TEXT_MEDIUM } },
    alignment: { horizontal: 'left', vertical: 'middle' },
    border: {
      top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
    },
  };
}

function createNoteCategoryStyle(): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 11, bold: true, color: { argb: Colors.TEXT_WHITE } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: Colors.BG_SUBHEADER } },
    alignment: { horizontal: 'left', vertical: 'middle' },
  };
}

function createNoteLabelStyle(): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 10, bold: true, color: { argb: Colors.PRIMARY_DARK } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: Colors.BG_SUBTOTAL } },
    alignment: { horizontal: 'left', vertical: 'top' },
    border: {
      top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
    },
  };
}

function createNoteTextStyle(): Partial<ExcelJS.Style> {
  return {
    font: { name: 'Segoe UI', size: 10, color: { argb: Colors.TEXT_MEDIUM } },
    alignment: { horizontal: 'left', vertical: 'top', wrapText: true },
    border: {
      top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

function rnd(value: number, dp: number): number {
  const factor = Math.pow(10, dp);
  return Math.round(value * factor) / factor;
}

function setColumnWidths(worksheet: ExcelJS.Worksheet, widths: number[]): void {
  worksheet.columns = widths.map(w => ({ width: w }));
}

async function createColorKeyRow(worksheet: ExcelJS.Worksheet, rowIndex: number): Promise<number> {
  const row = worksheet.getRow(rowIndex);
  row.height = 16;
  
  const keys = [
    { color: Colors.INPUT_HIGHLIGHT, text: '■ Yellow = cells to fill in (take-off / rate)' },
    { color: Colors.BG_SUBHEADER, text: '■ Blue header = section', textColor: Colors.TEXT_WHITE },
    { color: Colors.BG_SECTION, text: '■ Grey = sub-total', textColor: Colors.PRIMARY_DARK },
    { color: Colors.ACCENT_RED, text: '■ Red = grand total / alert', textColor: Colors.TEXT_WHITE },
  ];
  
  let colIndex = 1;
  for (const key of keys) {
    const cell = row.getCell(colIndex);
    cell.value = key.text;
    cell.font = { name: 'Segoe UI', size: 8, color: { argb: key.textColor || Colors.TEXT_DARK } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: key.color } };
    cell.alignment = { horizontal: 'left', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
      right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } },
    };
    colIndex++;
  }
  
  return rowIndex + 1;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN EXPORT FUNCTION
// ═══════════════════════════════════════════════════════════════════

export async function exportToExcel(state: ProjectState): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BOQ Export System';
  workbook.lastModifiedBy = state.meta?.preparedBy || 'Quantity Surveyor';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.properties.date1904 = false;
  
  const meta = state.meta ?? { projectName: state.projectName };
  const dateStr = new Date().toISOString().split('T')[0];
  const safeName = state.projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const filename = `takeoff-${safeName}-${dateStr}.xlsx`;
  
  // Build sheets
  await buildSummarySheet(workbook, state, meta);
  
  // Group measurements by group
  const groups = new Map<string, Measurement[]>();
  for (const m of state.measurements) {
    const key = m.group ?? 'Takeoff';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  
  for (const [groupName, measurements] of groups.entries()) {
    await buildTakeoffSheet(workbook, state, meta, groupName, measurements);
  }
  
  await buildMaterialSummarySheet(workbook, state, meta);
  await buildNotesSheet(workbook, meta);
  
  // Write file
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ═══════════════════════════════════════════════════════════════════
// SUMMARY SHEET
// ═══════════════════════════════════════════════════════════════════

async function buildSummarySheet(workbook: ExcelJS.Workbook, state: ProjectState, meta: ProjectMeta): Promise<void> {
  const sheet = workbook.addWorksheet('Summary');
  setColumnWidths(sheet, [5, 40, 15, 12, 8, 13, 15, 28]);
  
  const vatRate = meta.vatRate ?? 0.05;
  const currency = meta.currency ?? 'AED';
  let rowIndex = 1;
  
  // Title
  const titleRow = sheet.getRow(rowIndex);
  titleRow.height = 32;
  const titleCell = titleRow.getCell(1);
  titleCell.value = meta.projectName.toUpperCase();
  titleCell.style = createTitleStyle();
  sheet.mergeCells(rowIndex, 1, rowIndex, 8);
  rowIndex++;
  
  // Subtitle
  const subtitleRow = sheet.getRow(rowIndex);
  subtitleRow.height = 22;
  const subtitleCell = subtitleRow.getCell(1);
  subtitleCell.value = 'BILL OF QUANTITIES - QUANTITY TAKE-OFF SUMMARY';
  subtitleCell.style = createSubtitleStyle();
  sheet.mergeCells(rowIndex, 1, rowIndex, 8);
  rowIndex++;
  
  // Spacer
  rowIndex++;
  
  // Project Info Block
  const infoItems: [string, string][] = [
    ['PROJECT', meta.projectName],
    ['CLIENT', meta.client ?? '—'],
    ['LOCATION', meta.location ?? '—'],
    ['REFERENCE NO', meta.refNo ?? '—'],
    ['DRAWING REF', meta.drawingRefs ?? '—'],
    ['MAIN CONTRACTOR', meta.mainContractor ?? '—'],
    ['DESIGN CONSULTANT', meta.consultant ?? '—'],
    ['PREPARED BY', meta.preparedBy ?? '—'],
    ['DATE', new Date().toLocaleDateString('en-GB')],
    ['REVISION', meta.revision ?? 'P01'],
    ['CURRENCY', currency],
    ['VAT RATE', `${(vatRate * 100).toFixed(0)}%`],
  ];
  
  for (const [label, value] of infoItems) {
    const labelCell = sheet.getCell(rowIndex, 1);
    labelCell.value = label;
    labelCell.style = createInfoLabelStyle();
    
    const valueCell = sheet.getCell(rowIndex, 2);
    valueCell.value = value;
    valueCell.style = createInfoValueStyle();
    sheet.mergeCells(rowIndex, 2, rowIndex, 4);
    
    // Fill remaining cells
    for (let c = 5; c <= 8; c++) {
      const cell = sheet.getCell(rowIndex, c);
      cell.value = '';
      cell.style = { border: { top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } } } };
    }
    
    sheet.getRow(rowIndex).height = 16;
    rowIndex++;
  }
  
  rowIndex++;
  rowIndex = await createColorKeyRow(sheet, rowIndex);
  rowIndex++;
  
  // Column Headers
  const headers = ['#', 'Description', 'Type', 'Quantity', 'Unit', `Unit Rate (${currency})`, `Total Cost (${currency})`, 'Remarks / Drawing Ref'];
  const headerRow = sheet.getRow(rowIndex);
  headerRow.height = 30;
  for (let c = 0; c < headers.length; c++) {
    const cell = headerRow.getCell(c + 1);
    cell.value = headers[c];
    cell.style = createHeaderStyle();
  }
  rowIndex++;
  
  // Measurement rows
  let grandTotal = 0;
  const sectionLetters = new Map<string, string>();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let letterIdx = 0;
  const sectionCounters = new Map<string, number>();
  
  for (const m of state.measurements) {
    const type = m.type ?? 'General';
    if (!sectionLetters.has(type)) {
      sectionLetters.set(type, alphabet[letterIdx % 26]);
      letterIdx++;
      sectionCounters.set(type, 0);
    }
  }
  
  for (const m of state.measurements) {
    const type = m.type ?? 'General';
    const letter = sectionLetters.get(type)!;
    const counter = (sectionCounters.get(type) ?? 0) + 1;
    sectionCounters.set(type, counter);
    const itemNo = `${letter}${counter}`;
    
    const dp = m.qtyPrecision ?? 3;
    const qty = rnd(m.quantity, dp);
    const rate = rnd(m.unitRate, 2);
    const cost = rnd(qty * rate, 2);
    grandTotal += cost;
    
    const isOdd = counter % 2 === 1;
    
    const row = sheet.getRow(rowIndex);
    row.height = 16;
    
    row.getCell(1).value = itemNo;
    row.getCell(1).style = createDataStyle(isOdd, false);
    row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    
    row.getCell(2).value = m.description;
    row.getCell(2).style = createDataStyle(isOdd, false);
    row.getCell(2).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    
    row.getCell(3).value = type;
    row.getCell(3).style = createDataStyle(isOdd, false);
    row.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
    
    row.getCell(4).value = qty;
    row.getCell(4).style = createDataStyle(isOdd, false);
    row.getCell(4).alignment = { horizontal: 'right', vertical: 'middle' };
    row.getCell(4).numFmt = '#,##0.000';
    
    row.getCell(5).value = m.unit;
    row.getCell(5).style = createDataStyle(isOdd, false);
    row.getCell(5).alignment = { horizontal: 'center', vertical: 'middle' };
    
    row.getCell(6).value = rate;
    row.getCell(6).style = createDataStyle(isOdd, false);
    row.getCell(6).alignment = { horizontal: 'right', vertical: 'middle' };
    row.getCell(6).numFmt = '#,##0.00';
    
    row.getCell(7).value = cost;
    row.getCell(7).style = createDataStyle(isOdd, false);
    row.getCell(7).alignment = { horizontal: 'right', vertical: 'middle' };
    row.getCell(7).numFmt = '#,##0.00';
    
    row.getCell(8).value = m.remarks ?? '';
    row.getCell(8).style = createDataStyle(isOdd, false);
    row.getCell(8).alignment = { horizontal: 'left', vertical: 'middle' };
    
    rowIndex++;
    
    // Spec sub-line
    if (m.spec) {
      const specRow = sheet.getRow(rowIndex);
      specRow.height = 14;
      const specCell = specRow.getCell(2);
      specCell.value = m.spec;
      specCell.style = createSpecStyle(isOdd);
      sheet.mergeCells(rowIndex, 2, rowIndex, 8);
      
      // Clear other cells in this row
      for (let c = 1; c <= 8; c++) {
        if (c === 2) continue;
        const cell = specRow.getCell(c);
        cell.value = '';
        cell.style = { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: isOdd ? Colors.ROW_ODD : Colors.ROW_EVEN } }, border: { top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } } } };
      }
      rowIndex++;
    }
  }
  
  // Totals block
  rowIndex++;
  
  const vat = rnd(grandTotal * vatRate, 2);
  const totalIncl = rnd(grandTotal + vat, 2);
  
  // Grand Total
  const grandRow = sheet.getRow(rowIndex);
  grandRow.height = 22;
  const grandLabelCell = grandRow.getCell(1);
  grandLabelCell.value = 'GRAND TOTAL (excl. VAT)';
  grandLabelCell.style = createGrandTotalStyle();
  sheet.mergeCells(rowIndex, 1, rowIndex, 6);
  const grandValueCell = grandRow.getCell(7);
  grandValueCell.value = grandTotal;
  grandValueCell.style = createGrandTotalStyle();
  grandValueCell.numFmt = '#,##0.00';
  rowIndex++;
  
  // VAT
  const vatRow = sheet.getRow(rowIndex);
  vatRow.height = 18;
  const vatLabelCell = vatRow.getCell(1);
  vatLabelCell.value = `VAT @ ${(vatRate * 100).toFixed(0)}%`;
  vatLabelCell.style = createVatStyle();
  sheet.mergeCells(rowIndex, 1, rowIndex, 6);
  const vatValueCell = vatRow.getCell(7);
  vatValueCell.value = vat;
  vatValueCell.style = createVatStyle();
  vatValueCell.numFmt = '#,##0.00';
  rowIndex++;
  
  // Total Incl VAT
  const totalRow = sheet.getRow(rowIndex);
  totalRow.height = 24;
  const totalLabelCell = totalRow.getCell(1);
  totalLabelCell.value = 'TOTAL (incl. VAT)';
  totalLabelCell.style = createTotalIncStyle();
  sheet.mergeCells(rowIndex, 1, rowIndex, 6);
  const totalValueCell = totalRow.getCell(7);
  totalValueCell.value = totalIncl;
  totalValueCell.style = createTotalIncStyle();
  totalValueCell.numFmt = '#,##0.00';
}

// ═══════════════════════════════════════════════════════════════════
// TAKEOFF SHEET
// ═══════════════════════════════════════════════════════════════════

async function buildTakeoffSheet(
  workbook: ExcelJS.Workbook,
  state: ProjectState,
  meta: ProjectMeta,
  sheetName: string,
  measurements: Measurement[],
): Promise<void> {
  const sheet = workbook.addWorksheet(sheetName.substring(0, 31));
  setColumnWidths(sheet, [6, 42, 8, 7, 10, 10, 10, 13, 13, 15, 32]);
  
  const currency = meta.currency ?? 'AED';
  let rowIndex = 1;
  
  // Title
  const titleRow = sheet.getRow(rowIndex);
  titleRow.height = 32;
  const titleCell = titleRow.getCell(1);
  titleCell.value = `${meta.projectName.toUpperCase()} · ${sheetName.toUpperCase()}`;
  titleCell.style = createTitleStyle();
  sheet.mergeCells(rowIndex, 1, rowIndex, 11);
  rowIndex++;
  
  // Meta row
  const metaRow = sheet.getRow(rowIndex);
  metaRow.height = 18;
  const metaCell = metaRow.getCell(1);
  metaCell.value = `Rev: ${meta.revision ?? 'P01'} | Date: ${new Date().toLocaleDateString('en-GB')} | Prepared by: ${meta.preparedBy ?? '—'}${meta.drawingRefs ? ` | Dwg Ref: ${meta.drawingRefs}` : ''}`;
  metaCell.style = createSubtitleStyle();
  sheet.mergeCells(rowIndex, 1, rowIndex, 11);
  rowIndex++;
  
  // Color key
  rowIndex = await createColorKeyRow(sheet, rowIndex);
  rowIndex++;
  
  // Column Headers
  const headers = ['#', 'Description', 'Unit', 'Times', 'L (m)', 'W (m)', 'H (m)', 'Total QTY', `Rate (${currency})`, `Cost (${currency})`, 'Remarks / Dwg Ref'];
  const headerRow = sheet.getRow(rowIndex);
  headerRow.height = 32;
  for (let c = 0; c < headers.length; c++) {
    const cell = headerRow.getCell(c + 1);
    cell.value = headers[c];
    cell.style = createHeaderStyle();
  }
  rowIndex++;
  
  // Group measurements by type
  const subgroups = new Map<string, Measurement[]>();
  for (const m of measurements) {
    const key = m.type ?? 'General';
    if (!subgroups.has(key)) subgroups.set(key, []);
    subgroups.get(key)!.push(m);
  }
  
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const sectionLetters = new Map<string, string>();
  let li = 0;
  for (const key of subgroups.keys()) {
    sectionLetters.set(key, alphabet[li % 26]);
    li++;
  }
  
  for (const [typeName, items] of subgroups.entries()) {
    const letter = sectionLetters.get(typeName)!;
    
    // Section header
    const sectionRow = sheet.getRow(rowIndex);
    sectionRow.height = 22;
    const sectionCell = sectionRow.getCell(1);
    sectionCell.value = `  ${letter}   ${typeName.toUpperCase()}`;
    sectionCell.style = createSectionHeaderStyle();
    sheet.mergeCells(rowIndex, 1, rowIndex, 11);
    rowIndex++;
    
    let itemNo = 1;
    
    for (const m of items) {
      const dp = m.qtyPrecision ?? 3;
      const qty = rnd(m.quantity, dp);
      const rate = rnd(m.unitRate, 2);
      const cost = rnd(qty * rate, 2);
      const times = m.times ?? 1;
      const isOdd = itemNo % 2 === 1;
      const itemRef = `${letter}${itemNo}`;
      
      const row = sheet.getRow(rowIndex);
      row.height = 18;
      
      row.getCell(1).value = itemRef;
      row.getCell(1).style = createDataStyle(isOdd, false);
      row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
      
      row.getCell(2).value = m.description;
      row.getCell(2).style = createDataStyle(isOdd, false);
      row.getCell(2).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      
      row.getCell(3).value = m.unit;
      row.getCell(3).style = createDataStyle(isOdd, false);
      row.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
      
      row.getCell(4).value = times;
      row.getCell(4).style = createDataStyle(isOdd, false);
      row.getCell(4).alignment = { horizontal: 'center', vertical: 'middle' };
      
      row.getCell(5).value = m.L ?? '';
      row.getCell(5).style = createDataStyle(isOdd, false);
      row.getCell(5).alignment = { horizontal: 'right', vertical: 'middle' };
      if (m.L !== null) row.getCell(5).numFmt = '#,##0.00';
      
      row.getCell(6).value = m.W ?? '';
      row.getCell(6).style = createDataStyle(isOdd, false);
      row.getCell(6).alignment = { horizontal: 'right', vertical: 'middle' };
      if (m.W !== null) row.getCell(6).numFmt = '#,##0.00';
      
      row.getCell(7).value = m.H ?? '';
      row.getCell(7).style = createDataStyle(isOdd, false);
      row.getCell(7).alignment = { horizontal: 'right', vertical: 'middle' };
      if (m.H !== null) row.getCell(7).numFmt = '#,##0.00';
      
      row.getCell(8).value = qty;
      row.getCell(8).style = createDataStyle(isOdd, false);
      row.getCell(8).alignment = { horizontal: 'right', vertical: 'middle' };
      row.getCell(8).numFmt = '#,##0.000';
      
      row.getCell(9).value = rate;
      row.getCell(9).style = createDataStyle(isOdd, true);
      row.getCell(9).alignment = { horizontal: 'right', vertical: 'middle' };
      row.getCell(9).numFmt = '#,##0.00';
      
      row.getCell(10).value = cost;
      row.getCell(10).style = createDataStyle(isOdd, false);
      row.getCell(10).alignment = { horizontal: 'right', vertical: 'middle' };
      row.getCell(10).numFmt = '#,##0.00';
      
      row.getCell(11).value = m.remarks ?? '';
      row.getCell(11).style = createDataStyle(isOdd, false);
      row.getCell(11).alignment = { horizontal: 'left', vertical: 'middle' };
      
      rowIndex++;
      
      // Spec sub-line
      if (m.spec) {
        const specRow = sheet.getRow(rowIndex);
        specRow.height = 14;
        const specCell = specRow.getCell(2);
        specCell.value = m.spec;
        specCell.style = createSpecStyle(isOdd);
        sheet.mergeCells(rowIndex, 2, rowIndex, 11);
        
        for (let c = 1; c <= 11; c++) {
          if (c === 2) continue;
          const cell = specRow.getCell(c);
          cell.value = '';
          cell.style = { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: isOdd ? Colors.ROW_ODD : Colors.ROW_EVEN } }, border: { top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } } } };
        }
        rowIndex++;
      }
      
      itemNo++;
    }
    
    // Subtotal row
    const subtotalRow = sheet.getRow(rowIndex);
    subtotalRow.height = 18;
    const subtotalCell = subtotalRow.getCell(1);
    subtotalCell.value = `Sub-total ${letter} — ${typeName}`;
    subtotalCell.style = createSubtotalStyle();
    sheet.mergeCells(rowIndex, 1, rowIndex, 7);
    rowIndex++;
  }
}

// ═══════════════════════════════════════════════════════════════════
// MATERIAL SUMMARY SHEET
// ═══════════════════════════════════════════════════════════════════

async function buildMaterialSummarySheet(workbook: ExcelJS.Workbook, state: ProjectState, meta: ProjectMeta): Promise<void> {
  const sheet = workbook.addWorksheet('Material Summary');
  setColumnWidths(sheet, [6, 46, 10, 14, 14, 14]);
  
  const currency = meta.currency ?? 'AED';
  let rowIndex = 1;
  
  // Title
  const titleRow = sheet.getRow(rowIndex);
  titleRow.height = 32;
  const titleCell = titleRow.getCell(1);
  titleCell.value = 'MATERIAL SUMMARY';
  titleCell.style = createTitleStyle();
  sheet.mergeCells(rowIndex, 1, rowIndex, 6);
  rowIndex++;
  
  // Meta row
  const metaRow = sheet.getRow(rowIndex);
  metaRow.height = 18;
  const metaCell = metaRow.getCell(1);
  metaCell.value = `Project: ${meta.projectName} | Rev: ${meta.revision ?? 'P01'} | Date: ${new Date().toLocaleDateString('en-GB')}`;
  metaCell.style = createSubtitleStyle();
  sheet.mergeCells(rowIndex, 1, rowIndex, 6);
  rowIndex++;
  
  rowIndex++;
  
  // Headers
  const headers = ['#', 'Material / Description', 'Unit', 'Total Qty', `Unit Rate (${currency})`, `Total Cost (${currency})`];
  const headerRow = sheet.getRow(rowIndex);
  headerRow.height = 28;
  for (let c = 0; c < headers.length; c++) {
    const cell = headerRow.getCell(c + 1);
    cell.value = headers[c];
    cell.style = createHeaderStyle();
  }
  rowIndex++;
  
  // Aggregate materials
  const materialMap = new Map<string, { qty: number; rate: number; unit: string; spec?: string }>();
  for (const m of state.measurements) {
    const key = `${m.description}||${m.unit}`;
    if (materialMap.has(key)) {
      const existing = materialMap.get(key)!;
      existing.qty = rnd(existing.qty + m.quantity, m.qtyPrecision ?? 3);
    } else {
      materialMap.set(key, { qty: m.quantity, rate: m.unitRate, unit: m.unit, spec: m.spec });
    }
  }
  
  let i = 1;
  let runningTotal = 0;
  
  for (const [key, { qty, rate, unit, spec }] of materialMap.entries()) {
    const desc = key.split('||')[0];
    const isOdd = i % 2 === 1;
    const cost = rnd(qty * rate, 2);
    runningTotal += cost;
    
    const row = sheet.getRow(rowIndex);
    row.height = 18;
    
    row.getCell(1).value = String(i).padStart(2, '0');
    row.getCell(1).style = createDataStyle(isOdd, false);
    row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    
    row.getCell(2).value = desc;
    row.getCell(2).style = createDataStyle(isOdd, false);
    row.getCell(2).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    
    row.getCell(3).value = unit;
    row.getCell(3).style = createDataStyle(isOdd, false);
    row.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
    
    row.getCell(4).value = rnd(qty, 3);
    row.getCell(4).style = createDataStyle(isOdd, false);
    row.getCell(4).alignment = { horizontal: 'right', vertical: 'middle' };
    row.getCell(4).numFmt = '#,##0.000';
    
    row.getCell(5).value = rate;
    row.getCell(5).style = createDataStyle(isOdd, true);
    row.getCell(5).alignment = { horizontal: 'right', vertical: 'middle' };
    row.getCell(5).numFmt = '#,##0.00';
    
    row.getCell(6).value = cost;
    row.getCell(6).style = createDataStyle(isOdd, false);
    row.getCell(6).alignment = { horizontal: 'right', vertical: 'middle' };
    row.getCell(6).numFmt = '#,##0.00';
    
    rowIndex++;
    
    // Spec sub-line
    if (spec) {
      const specRow = sheet.getRow(rowIndex);
      specRow.height = 14;
      const specCell = specRow.getCell(2);
      specCell.value = spec;
      specCell.style = createSpecStyle(isOdd);
      sheet.mergeCells(rowIndex, 2, rowIndex, 6);
      
      for (let c = 1; c <= 6; c++) {
        if (c === 2) continue;
        const cell = specRow.getCell(c);
        cell.value = '';
        cell.style = { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: isOdd ? Colors.ROW_ODD : Colors.ROW_EVEN } }, border: { top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } } } };
      }
      rowIndex++;
    }
    
    i++;
  }
  
  // Total row
  const totalRow = sheet.getRow(rowIndex);
  totalRow.height = 24;
  const totalLabelCell = totalRow.getCell(1);
  totalLabelCell.value = 'TOTAL';
  totalLabelCell.style = createGrandTotalStyle();
  sheet.mergeCells(rowIndex, 1, rowIndex, 5);
  const totalValueCell = totalRow.getCell(6);
  totalValueCell.value = runningTotal;
  totalValueCell.style = createGrandTotalStyle();
  totalValueCell.numFmt = '#,##0.00';
}

// ═══════════════════════════════════════════════════════════════════
// NOTES & ASSUMPTIONS SHEET
// ═══════════════════════════════════════════════════════════════════

async function buildNotesSheet(workbook: ExcelJS.Workbook, meta: ProjectMeta): Promise<void> {
  const sheet = workbook.addWorksheet('Notes & Assumptions');
  sheet.columns = [{ width: 6 }, { width: 28 }, { width: 72 }];
  
  let rowIndex = 1;
  
  // Title
  const titleRow = sheet.getRow(rowIndex);
  titleRow.height = 32;
  const titleCell = titleRow.getCell(1);
  titleCell.value = 'NOTES, ASSUMPTIONS & EXCLUSIONS';
  titleCell.style = createTitleStyle();
  sheet.mergeCells(rowIndex, 1, rowIndex, 3);
  rowIndex++;
  
  // Meta row
  const metaRow = sheet.getRow(rowIndex);
  metaRow.height = 18;
  const metaCell = metaRow.getCell(1);
  metaCell.value = `Project: ${meta.projectName} | Rev: ${meta.revision ?? 'P01'} | Date: ${new Date().toLocaleDateString('en-GB')}`;
  metaCell.style = createSubtitleStyle();
  sheet.mergeCells(rowIndex, 1, rowIndex, 3);
  rowIndex++;
  
  rowIndex++;
  
  // Standard notes
  const standardNotes: { category: string; items: [string, string][] }[] = [
    {
      category: 'GENERAL NOTES',
      items: [
        ['Drawing Basis', 'BOQ derived from issued-for-construction or shop drawings. All dimensions taken from drawing annotations only. Do not scale.'],
        ['Field Measurement', 'Field measurement required prior to fabrication and installation. Contractor to verify all quantities against latest approved drawings.'],
        ['Approved Samples', 'All finishes and hardware / ironmongery subject to formal client / LORJ approval before procurement.'],
        ['Coordination', 'All works to be in full coordination with MEP, structural, and other relevant IFC drawings and shop drawing approvals.'],
      ],
    },
    {
      category: 'MATERIAL NOTES',
      items: [
        ['MDF Grade', 'All MDF to be Moisture Resistant (MR) grade, minimum E1 formaldehyde emission class. No standard MDF permitted.'],
        ['Edge Treatment', 'PVC lipping to all exposed MDF edges. Colour and finish to match approved laminate sample. Minimum 0.4 mm thickness.'],
        ['No Sharp Edges', 'All corners and edges to be filleted 1–3 mm. No sharp corners or edges permitted on any cabinet or panel.'],
        ['Back Panel Specification', '6mm back panel is NOT acceptable. 9mm melamine MR MDF to be used as per drawing review notes.'],
      ],
    },
    {
      category: 'EXCLUSIONS',
      items: [
        ['MEP Works', 'Electrical connections, gas supply, plumbing (water supply and drainage) are EXCLUDED. By MEP contractor.'],
        ['LED Lighting', 'Under-cabinet LED lighting noted as "By Others". EXCLUDED from this BOQ. Confirm with MEP contractor.'],
        ['Civil / Wall Works', 'Wall chasing, floor preparation, plastering, and wall tiling outside the joinery zone are EXCLUDED.'],
        ['Ceiling Works', 'All ceiling works are EXCLUDED from this BOQ.'],
        ['Preliminaries', 'Site preliminaries, scaffolding, hoisting, and general contractor overheads not included. Add separately.'],
      ],
    },
    {
      category: 'FINANCIAL NOTES',
      items: [
        ['Currency', `All rates and amounts in ${meta.currency ?? 'AED'}.`],
        ['VAT', `UAE Value Added Tax (VAT) at ${((meta.vatRate ?? 0.05) * 100).toFixed(0)}% applied to the grand total.`],
        ['Provisional Sums', 'Items marked as provisional sums should be adjusted based on actual scope at final account stage.'],
        ['Rate Entry', 'All yellow-highlighted cells in the BOQ sheet are to be filled by the contractor / QS. Do not alter formulae in other cells.'],
      ],
    },
  ];
  
  let noteIndex = 1;
  
  for (const group of standardNotes) {
    // Category header
    const catRow = sheet.getRow(rowIndex);
    catRow.height = 22;
    const catCell = catRow.getCell(1);
    catCell.value = `  ${group.category}`;
    catCell.style = createNoteCategoryStyle();
    sheet.mergeCells(rowIndex, 1, rowIndex, 3);
    rowIndex++;
    
    for (const [label, text] of group.items) {
      const indexCell = sheet.getCell(rowIndex, 1);
      indexCell.value = noteIndex;
      indexCell.style = { font: { size: 10, color: { argb: Colors.PRIMARY_DARK } }, alignment: { horizontal: 'center', vertical: 'top' }, border: { top: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, bottom: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, left: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } }, right: { style: 'thin', color: { argb: Colors.BORDER_LIGHT } } } };
      
      const labelCell = sheet.getCell(rowIndex, 2);
      labelCell.value = label;
      labelCell.style = createNoteLabelStyle();
      
      const textCell = sheet.getCell(rowIndex, 3);
      textCell.value = text;
      textCell.style = createNoteTextStyle();
      
      sheet.getRow(rowIndex).height = 28;
      rowIndex++;
      noteIndex++;
    }
    
    rowIndex++;
  }
}
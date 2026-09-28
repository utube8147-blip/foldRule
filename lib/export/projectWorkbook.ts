// ─── lib/export/projectWorkbook.ts ───────────────────────────────────────────
//  Server-side entry point: project data → Excel workbook.
//    1. "Takeoff" sheet — always; built from the user's measurements.
//    2. Summary / BOQ matrix / Materials / Cost breakdown — only when the
//       project has a material library (those sheets are driven by it).
// ─────────────────────────────────────────────────────────────────────────────

import * as ExcelJS from 'exceljs';
import { addTakeoffSheet, type TakeoffExportInput } from './takeoffSheet';
import { contextToBOQData } from './boqMapping';
import { buildWorkbook, type BOQData } from './excelExport';

export async function buildProjectWorkbook(input: TakeoffExportInput): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator  = 'Foldrule';
  workbook.created  = new Date();
  workbook.modified = new Date();

  addTakeoffSheet(workbook, input);

  if (input.materials.length > 0) {
    const boq = contextToBOQData({
      projectName:     input.projectName,
      projectLocation: input.location,
      documentTitle:   input.documentTitle,
      documentDate:    input.documentDate,
      revision:        input.revision,
      currency:        input.currency,
      vatPercent:      input.vatPercent,
      measurements:    input.measurements,
      materials:       input.materials,
    }) as unknown as BOQData;
    await buildWorkbook(boq, workbook);
  }

  return workbook;
}

/** Safe download filename: ASCII, no quotes/newlines/path separators, .xlsx. */
export function safeXlsxFilename(requested: unknown, projectName: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const base = typeof requested === 'string' && requested.trim()
    ? requested.trim().replace(/\.xlsx$/i, '')
    : `BOQ_${projectName}_${date}`;
  const clean = base
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 120) || `BOQ_export_${date}`;
  return `${clean}.xlsx`;
}

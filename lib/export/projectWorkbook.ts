// ─── lib/export/projectWorkbook.ts ───────────────────────────────────────────
//  Server-side entry point: project data → Excel workbook.
//    1. "Takeoff" sheet — always; built from the user's measurements.
//    2. Summary / BOQ matrix / Materials / Cost breakdown — only when some
//       measurements use materials, and only with the materials actually used
//       (the bank holds the whole catalogue, most of it unused per project).
// ─────────────────────────────────────────────────────────────────────────────

import { addVeSheet } from './veSheet';
import { addEstimateSheets } from './estimateSheets';
import { addRevisionSheet } from './revisionSheet';
import { addBillSheet } from './billSheet';
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
  addBillSheet(workbook, input);
  addRevisionSheet(workbook, input);
  addVeSheet(workbook, input);
  addEstimateSheets(workbook, input);

  const usedIds = new Set(input.measurements.map(m => m.materialId).filter(Boolean) as string[]);
  const usedMaterials = input.materials.filter(m => usedIds.has(m.id));

  if (usedMaterials.length > 0) {
    const boq = contextToBOQData({
      projectName:     input.projectName,
      projectLocation: input.location,
      documentTitle:   input.documentTitle,
      documentDate:    input.documentDate,
      revision:        input.revision,
      currency:        input.currency,
      vatPercent:      input.vatPercent,
      measurements:    input.measurements,
      materials:       usedMaterials,
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

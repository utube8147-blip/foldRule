// ─── lib/export/projectWorkbook.ts ───────────────────────────────────────────
//  Server-side entry point: project data → Excel workbook.
//
//    Summary             cover, drawings, bill by section, estimate build-up
//    Takeoff             every measurement, priced
//    Bill of Quantities  priced bill by work section
//    BOQ_Matrix          rows × materials            ┐ only when measurements
//    Materials           what to order, and its cost  │ use materials
//    Cost_Breakdown      material / labour / equip.   ┘
//    Revision changes · Value engineering · Change log   (when there is data)
//
//  Sheets are linked by formulas: Materials ← BOQ_Matrix, Cost_Breakdown ←
//  Materials, Summary ← Takeoff + Bill. All share the theme in ./theme.ts.
// ─────────────────────────────────────────────────────────────────────────────

import * as ExcelJS from 'exceljs';
import { addTakeoffSheet, TAKEOFF } from './takeoffSheet';
import { addBillSheet, BILL } from './billSheet';
import { addMatrixSheet, MATRIX } from './matrixSheet';
import { addMaterialsSheet, MATERIALS } from './materialsSheet';
import { addCostSheet, COST } from './costSheet';
import { addRevisionSheet } from './revisionSheet';
import { addVeSheet } from './veSheet';
import { addChangeLogSheet } from './changeLogSheet';
import { createSummarySheet, fillSummarySheet } from './summarySheet';
import { buildWorkbookModel } from './workbookModel';
import type { TakeoffExportInput } from './exportTypes';
import { withTheme, type ThemeSettings } from './theme';

export type { TakeoffExportInput } from './exportTypes';

export interface BuildOptions {
  /** Colours and font. Default: the original navy / gold. */
  theme?: ThemeSettings;
  /** Which sheets the Summary's "In this workbook" list names (all by default). */
  listSheet?: (name: string) => boolean;
}

export async function buildProjectWorkbook(input: TakeoffExportInput, options: BuildOptions = {}): Promise<ExcelJS.Workbook> {
  return withTheme(options.theme, () => buildSync(input, options.listSheet ?? (() => true)));
}

/** Every sheet builder is synchronous, so a theme set around this call cannot leak into another build. */
function buildSync(input: TakeoffExportInput, listSheet: (name: string) => boolean): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator  = 'Foldrule';
  workbook.title    = `${input.projectName} — Bill of quantities`;
  workbook.created  = new Date();
  workbook.modified = new Date();

  const model = buildWorkbookModel(input);
  const guide: Array<{ name: string; about: string }> = [];

  const summary = createSummarySheet(workbook);
  const takeoff = addTakeoffSheet(workbook, input, model);
  guide.push({ name: TAKEOFF, about: 'Every measurement with its drawing, page, material, quantity, rate and amount.' });
  const bill = addBillSheet(workbook, input, takeoff);
  if (bill) guide.push({ name: BILL, about: 'The priced bill, item by item under its work section, carried to a summary.' });

  if (model.columns.length > 0) {
    const matrix = addMatrixSheet(workbook, input, model, takeoff);
    const materials = addMaterialsSheet(workbook, input, model, matrix);
    addCostSheet(workbook, input, model, materials, takeoff);
    guide.push(
      { name: MATRIX, about: 'Each measured row against the material it uses; columns total each material.' },
      { name: MATERIALS, about: 'What to order: net quantity, waste, sheet / pack size, order quantity, price and purchase cost.' },
      { name: COST, about: 'Material, labour and equipment rates × quantity, with VAT and a check against the Takeoff.' },
    );
  }

  if (addRevisionSheet(workbook, input)) guide.push({ name: 'Revision changes', about: 'What each accepted drawing revision changed, and its cost.' });
  if (addVeSheet(workbook, input)) guide.push({ name: 'Value engineering', about: 'Alternative materials and the saving each would make.' });
  if (addChangeLogSheet(workbook, input)) guide.push({ name: 'Change log', about: 'Who changed which quantity, rate or setting, and when.' });

  fillSummarySheet(summary, input, { takeoff, bill, sheets: guide.filter(g => listSheet(g.name)) });
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

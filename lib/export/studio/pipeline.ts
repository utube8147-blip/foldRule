// ─── lib/export/studio/pipeline.ts ───────────────────────────────────────────
//
//  One path from project to file, used by the export page and by quick export:
//    build (theme) → grid model → edits → recalculate → write edits, results,
//    drop left-out sheets → .xlsx
// ─────────────────────────────────────────────────────────────────────────────

import { buildProjectWorkbook } from '../projectWorkbook';
import type { TakeoffExportInput } from '../exportTypes';
import { workbookModel, type SheetModel } from './sheetModel';
import { recalc, type Values } from './recalc';
import { applyEdits, finishWorkbook, type CellEdit, type ExportSettings } from './edits';

export interface StudioState {
  sheets: SheetModel[];
  values: Values;
  applied: CellEdit[];
  stale: CellEdit[];
}

const excluded = (s: ExportSettings) => new Set(s.exclude ?? []);

/** The generated workbook as grid models (theme applied, no edits). */
export async function buildBase(input: TakeoffExportInput, settings: ExportSettings): Promise<SheetModel[]> {
  const ex = excluded(settings);
  const wb = await buildProjectWorkbook(input, { theme: settings.theme, listSheet: n => !ex.has(n) });
  return workbookModel(wb);
}

/** Edits laid over the base, then every formula worked out. */
export function studioState(base: SheetModel[], edits: CellEdit[] | undefined): StudioState {
  const a = applyEdits(base, edits);
  return { ...a, values: recalc(a.sheets) };
}

/** The finished file. */
export async function exportXlsx(input: TakeoffExportInput, settings: ExportSettings): Promise<Blob> {
  const ex = excluded(settings);
  const wb = await buildProjectWorkbook(input, { theme: settings.theme, listSheet: n => !ex.has(n) });
  const st = studioState(workbookModel(wb), settings.edits);
  finishWorkbook(wb, st.sheets, st.applied, st.values, ex);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

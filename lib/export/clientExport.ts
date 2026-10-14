'use client';

import { markExported } from '@/components/features/onboarding/GettingStarted';
import { veSummary } from '@/lib/takeoff/valueEngineering';
import { buildUp } from '@/lib/takeoff/estimate';
import { orderSchedule } from '@/lib/takeoff/materialRate';
import { revisionChanges as revisionChanges_ } from '@/lib/takeoff/revisions';
import type { Material } from '@/types';
import { billedRows } from '@/lib/takeoff/timesing';
import type { ProjectState } from '@/context/TakeoffContext';
import { downloadBlob, toStoredState } from '@/lib/storage/projectDb';
import { payloadToInput, type ExportPayload } from './exportInput';
import type { TakeoffExportInput } from './exportTypes';
import type { ExportSettings } from './studio/edits';

/** The project as the workbook needs it: billed (timesed) rows, revisions, VE, estimate. No PDFs. */
export function buildExportPayload(ps: ProjectState): ExportPayload {
  const stored = toStoredState(ps);
  // Timesing is applied here, so the workbook shows billed quantities.
  const billed = billedRows(stored.measurements, stored.drawings);
  const revisionChanges = (ps.revisionLog ?? []).filter(r => !r.reverted).map(r =>
    revisionChanges_(r, ps.measurements, ps.drawings, ps.materials as Material[]));
  const ve = veSummary(ps.veProposals ?? [], ps.measurements, ps.drawings, ps.materials as Material[]);
  // Same rate rule as the workbook: the row's own rate, else its material's.
  const mats = new Map((ps.materials as Material[]).map(m => [m.id, m]));
  const units = ps.totalUnits && ps.totalUnits > 0 ? ps.totalUnits : 1;
  const measured = billed.reduce((s, m) => s + (m.isGroupHeader ? 0
    : m.quantity * (m.unitRate || (m.materialId ? mats.get(m.materialId)?.unitRate ?? 0 : 0))), 0) * units;
  return {
    ...stored,
    measurements: billed.map(({ presetData: _p, ...m }) => m),
    revisionChanges,
    valueEngineering: { pending: ve.pending, lines: ve.lines.map(({ proposal, ...l }) => ({ ...l, status: proposal.status, note: proposal.note })) },
    // Keys let the Summary sheet rebuild the build-up as live formulas.
    estimate: {
      lines: buildUp(measured, ps.markups, ps.vatPercent),
      provisional: (ps.markups?.provisional ?? []).map(p => ({ name: p.name, amount: p.amount })),
      order: orderSchedule(billed, ps.materials as Material[]),
    },
  };
}

export const projectExportInput = (ps: ProjectState): TakeoffExportInput => payloadToInput(buildExportPayload(ps));

export function exportFilename(ps: ProjectState, requested?: string): string {
  const base = (requested || ps.exportSettings?.filename || `${ps.projectName}-takeoff`).trim().replace(/\.xlsx$/i, '');
  const clean = base.normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(0, 120) || 'takeoff';
  return `${clean}.xlsx`;
}

/**
 * Build the project's workbook in the browser — with the sheets, colours and cell edits
 * saved on the export page — and download it. Returns the filename that was saved.
 */
export async function exportProjectToExcel(ps: ProjectState, filename?: string, settings?: ExportSettings): Promise<string> {
  const { exportXlsx } = await import('./studio/pipeline');
  const blob = await exportXlsx(projectExportInput(ps), settings ?? ps.exportSettings ?? {});
  const name = exportFilename(ps, filename);
  downloadBlob(blob, name);
  markExported();
  return name;
}

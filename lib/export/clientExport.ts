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

/**
 * Send the project's takeoff to /api/export and download the resulting .xlsx.
 * Returns the filename that was saved.
 */
export async function exportProjectToExcel(ps: ProjectState, filename?: string): Promise<string> {
  const saved = await exportProjectToExcelInner(ps, filename);
  markExported();
  return saved;
}

async function exportProjectToExcelInner(ps: ProjectState, filename?: string): Promise<string> {
  const stored = toStoredState(ps);
  const project = {
    ...stored,
    // Strip preset payloads and point arrays' extra fields — the export only
    // needs identity, quantities and grouping.
    // Timesing is applied here, so the workbook shows billed quantities.
    measurements: billedRows(stored.measurements, stored.drawings).map(({ presetData: _p, ...m }) => m),
  };

  const revisionChanges = (ps.revisionLog ?? []).filter(r => !r.reverted).map(r =>
    revisionChanges_(r, ps.measurements, ps.drawings, ps.materials as Material[]));
  const ve = veSummary(ps.veProposals ?? [], ps.measurements, ps.drawings, ps.materials as Material[]);
  const valueEngineering = {
    pending: ve.pending,
    lines: ve.lines.map(({ proposal, ...l }) => ({ ...l, status: proposal.status, note: proposal.note })),
  };
  // Build-up to the tender sum, and what to buy.
  const billed = billedRows(stored.measurements, stored.drawings);
  // Same rate rule as the workbook: the row's own rate, else its material's.
  const mats = new Map((ps.materials as Material[]).map(m => [m.id, m]));
  const measured = billed.reduce((s, m) => s + (m.isGroupHeader ? 0
    : m.quantity * (m.unitRate || (m.materialId ? mats.get(m.materialId)?.unitRate ?? 0 : 0))), 0) * (ps.totalUnits && ps.totalUnits > 0 ? ps.totalUnits : 1);
  const estimate = {
    // Keys let the Summary sheet rebuild the build-up as live formulas.
    lines: buildUp(measured, ps.markups, ps.vatPercent),
    provisional: (ps.markups?.provisional ?? []).map(p => ({ name: p.name, amount: p.amount })),
    order: orderSchedule(billed, ps.materials as Material[]),
  };
  Object.assign(project, { revisionChanges, valueEngineering, estimate, revisionLog: undefined, veProposals: undefined, markups: undefined });

  const res = await fetch('/api/export', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ filename, project }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const detail = Array.isArray(err.details) ? ` (${err.details.join('; ')})` : '';
    throw new Error(`${err.error || `HTTP ${res.status}`}${detail}`);
  }

  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match       = disposition.match(/filename="([^"]+)"/);
  const finalName   = match?.[1] ?? `BOQ_${new Date().toISOString().slice(0, 10)}.xlsx`;
  downloadBlob(await res.blob(), finalName);
  return finalName;
}

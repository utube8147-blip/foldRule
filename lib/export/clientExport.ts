'use client';

import type { ProjectState } from '@/context/TakeoffContext';
import { downloadBlob, toStoredState } from '@/lib/storage/projectDb';

/**
 * Send the project's takeoff to /api/export and download the resulting .xlsx.
 * Returns the filename that was saved.
 */
export async function exportProjectToExcel(ps: ProjectState, filename?: string): Promise<string> {
  const stored = toStoredState(ps);
  const project = {
    ...stored,
    // Strip preset payloads and point arrays' extra fields — the export only
    // needs identity, quantities and grouping.
    measurements: stored.measurements.map(({ presetData: _p, ...m }) => m),
  };

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

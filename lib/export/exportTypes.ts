// What the server receives to build the project workbook (validated in app/api/export/route.ts).

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
  phase?:         string;
  /** Project / unit type shown on the cover (e.g. "D01", "Type A"). */
  projectType?:   string;
  /** Number of identical units the takeoff is for (each quantity is per unit). Default 1. */
  totalUnits?:    number;
  documentTitle?: string;
  documentDate?:  string;
  revision?:      string;
  currency?:      string;
  vatPercent?:    number;
  stakeholders?:  { mainContractor?: string; designConsultant?: string; supervision?: string };
  drawingReferences?: string[];
  assumptions?:   Array<{ category: string; content: string }>;
  exclusions?:    Array<{ item: string; reason: string }>;
  drawings:       TakeoffExportDrawing[];
  measurements:   TakeoffRow[];
  materials:      Material[];
  /** Build-up from measured work to the tender sum, and the buying list. */
  estimate?: {
    lines: Array<{ key?: string; label: string; percent?: number | null; amount: number; total?: boolean; note?: string }>;
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

export const unitsOf = (input: Pick<TakeoffExportInput, 'totalUnits'>) =>
  Number.isFinite(input.totalUnits) && (input.totalUnits as number) > 0 ? (input.totalUnits as number) : 1;

/** "RAK Doors · Ras Al Khaimah · Rev B · 2026-10-13" */
export function projectLine(input: TakeoffExportInput): string {
  return [
    input.projectName,
    input.projectNumber ? `No. ${input.projectNumber}` : '',
    input.location ?? '',
    input.revision ? `Rev ${input.revision}` : '',
    input.documentDate ?? new Date().toISOString().slice(0, 10),
  ].filter(Boolean).join('   ·   ');
}

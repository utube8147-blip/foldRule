// app/api/export/route.ts
//
// POST { filename?: string, project: ExportProject } → .xlsx download
//
// The client sends the project's takeoff data (no PDF blobs). The route
// validates it, builds the workbook, and streams it back.
//
// GET returns the sample BOQ workbook — lab builds only (useful when working
// on the sheet builders in lib/export/xl).

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { buildProjectWorkbook, safeXlsxFilename } from '@/lib/export/projectWorkbook';
import { buildWorkbook } from '@/lib/export/excelExport';
import { LABS_ENABLED } from '@/lib/config/labs';
import type { TakeoffRow, Material } from '@/types';

export const runtime = 'nodejs';

const MAX_BODY_BYTES   = 10 * 1024 * 1024;
const MAX_MEASUREMENTS = 50_000;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const num = z.coerce.number().finite().catch(0);

const MeasurementSchema = z.object({
  id:            z.string(),
  drawingId:     z.string().catch(''),
  pageNumber:    z.number().int().positive().optional().catch(undefined),
  description:   z.string().catch(''),
  label:         z.string().optional().catch(undefined),
  type:          z.string().catch('Length'),
  quantity:      num,
  unit:          z.string().catch(''),
  unitRate:      num,
  notes:         z.string().catch(''),
  points:        z.array(z.object({ x: z.number(), y: z.number() }).passthrough()).catch([]),
  isOverridden:  z.boolean().catch(false),
  isGroupHeader: z.boolean().optional().catch(false),
  groupName:     z.string().optional().catch(undefined),
  parentId:      z.string().optional().catch(undefined),
  childIds:      z.array(z.string()).catch([]),
  materialId:    z.string().optional().catch(undefined),
  color:         z.string().catch('#999999'),
  isVisible:     z.boolean().catch(true),
}).passthrough();

const MaterialSchema = z.object({
  id:            z.string(),
  name:          z.string().catch(''),
  code:          z.string().catch(''),
  category:      z.string().catch(''),
  unit:          z.string().catch(''),
  unitRate:      num,
  materialCost:  num,
  laborCost:     num,
  equipmentCost: num,
}).passthrough();

const ProjectSchema = z.object({
  projectName:     z.string().max(200).catch('Project'),
  projectNumber:   z.string().max(100).optional().catch(undefined),
  projectLocation: z.string().max(200).optional().catch(undefined),
  documentTitle:   z.string().max(200).optional().catch(undefined),
  documentDate:    z.string().max(40).optional().catch(undefined),
  revision:        z.string().max(40).optional().catch(undefined),
  currency:        z.string().max(10).optional().catch(undefined),
  vatPercent:      z.coerce.number().min(0).max(100).optional().catch(undefined),
  drawings: z.array(z.object({
    id:          z.string(),
    name:        z.string().catch(''),
    scaleFactor: z.number().optional().catch(undefined),
    pageScales:  z.record(z.string(), z.number()).optional().catch(undefined),
  }).passthrough()).max(500).catch([]),
  measurements: z.array(MeasurementSchema).max(MAX_MEASUREMENTS),
  materials:    z.array(MaterialSchema).max(5_000).catch([]),
});

const BodySchema = z.object({
  filename: z.string().max(200).optional(),
  project:  ProjectSchema,
});

function xlsxResponse(buffer: Buffer, filename: string): NextResponse {
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type':        XLSX_MIME,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      String(buffer.byteLength),
      'Cache-Control':       'no-store',
    },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Project is too large to export in one request' }, { status: 413 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid export data', details: parsed.error.issues.slice(0, 5).map(i => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    );
  }

  const { project, filename } = parsed.data;
  try {
    const workbook = await buildProjectWorkbook({
      projectName:   project.projectName,
      projectNumber: project.projectNumber,
      location:      project.projectLocation,
      documentTitle: project.documentTitle,
      documentDate:  project.documentDate,
      revision:      project.revision,
      currency:      project.currency,
      vatPercent:    project.vatPercent,
      drawings:      project.drawings.map(d => ({
        id: d.id, name: d.name, scaleFactor: d.scaleFactor,
        pageScales: d.pageScales
          ? Object.fromEntries(Object.entries(d.pageScales).map(([k, v]) => [Number(k), v]))
          : undefined,
      })),
      measurements:  project.measurements as unknown as TakeoffRow[],
      materials:     project.materials as unknown as Material[],
    });
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return xlsxResponse(buffer, safeXlsxFilename(filename, project.projectName));
  } catch (error) {
    console.error('[export] failed to build workbook', error);
    return NextResponse.json({ error: 'Failed to generate the Excel file' }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  if (!LABS_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  try {
    const workbook = await buildWorkbook();
    const buffer   = Buffer.from(await workbook.xlsx.writeBuffer());
    return xlsxResponse(buffer, safeXlsxFilename(undefined, 'sample'));
  } catch (error) {
    console.error('[export] sample workbook failed', error);
    return NextResponse.json({ error: 'Failed to generate the sample file' }, { status: 500 });
  }
}

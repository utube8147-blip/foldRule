// app/api/export/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { BOQData, buildWorkbook } from '@/lib/excelExport';

function toNodeBuffer(ab: ArrayBuffer | Buffer): Buffer {
  return Buffer.isBuffer(ab) ? ab : Buffer.from(ab);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    // ── Pull the user-supplied filename first ──────────────────────────────
    const userFilename = typeof body.filename === 'string' && body.filename.trim()
      ? body.filename.trim()
      : null;

    const customData: BOQData | undefined = body.data as BOQData | undefined;

    // If data payload is present, validate it
    if (body.data !== undefined && (!customData || !customData.project_info)) {
      return NextResponse.json(
        { error: 'Invalid request data: missing project_info' },
        { status: 400 }
      );
    }

    const workbook = await buildWorkbook(customData);
    const buffer = toNodeBuffer(await workbook.xlsx.writeBuffer());

    // ── Filename resolution: user input → project name → fallback ─────────
    const dateStr = new Date().toISOString().split('T')[0];

    let filename: string;
    if (userFilename) {
      // Ensure it ends with .xlsx
      filename = userFilename.endsWith('.xlsx') ? userFilename : `${userFilename}.xlsx`;
    } else if (customData?.project_info?.name) {
      const projectName = customData.project_info.name as string;
      const safeName = projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      filename = `BOQ_${safeName}_${dateStr}.xlsx`;
    } else {
      filename = `BOQ_export_${dateStr}.xlsx`;
    }

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.byteLength),
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[v0] Export POST error:', errorMessage, error);
    return NextResponse.json(
      { error: 'Failed to generate export', details: errorMessage },
      { status: 500 }
    );
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const workbook = await buildWorkbook();
    const buffer = toNodeBuffer(await workbook.xlsx.writeBuffer());

    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `BOQ_export_${dateStr}.xlsx`;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.byteLength),
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[v0] Export GET error:', errorMessage, error);
    return NextResponse.json(
      { error: 'Failed to generate export', details: errorMessage },
      { status: 500 }
    );
  }
}
// app/api/export/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { BOQData, buildWorkbook } from '@/lib/excelExport';

function toNodeBuffer(ab: ArrayBuffer | Buffer): Buffer {
  return Buffer.isBuffer(ab) ? ab : Buffer.from(ab);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const customData: BOQData | undefined = body.data ?? undefined;

    const workbook = await buildWorkbook(customData);
    const buffer = toNodeBuffer(await workbook.xlsx.writeBuffer());

    const dateStr = new Date().toISOString().split('T')[0];
    const projectName = customData?.project_info?.name ?? 'export';
    const safeName = projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const filename = `BOQ_${safeName}_${dateStr}.xlsx`;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.byteLength),
      },
    });
  } catch (error) {
    console.error('Export error:', error);
    return NextResponse.json(
      { error: 'Failed to generate export', details: String(error) },
      { status: 500 }
    );
  }
}

export async function GET() {
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
    console.error('Export error:', error);
    return NextResponse.json(
      { error: 'Failed to generate export' },
      { status: 500 }
    );
  }
}
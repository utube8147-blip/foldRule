// POST { project, currency, items: RfqItem[] } → .xlsx "request for prices" sheet:
// materials and quantities with blank price columns, to send to a supplier and import back.

import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { rfqTable, RFQ_HEADERS } from '@/lib/takeoff/rateSheet';

export const runtime = 'nodejs';

const num = z.coerce.number().finite().optional().catch(undefined);
const Body = z.object({
  project: z.string().max(200).catch('Project'),
  currency: z.string().max(8).catch(''),
  items: z.array(z.object({
    id: z.string(), code: z.string().catch(''), name: z.string().catch(''), unit: z.string().catch(''),
    quantity: num, materialCost: num, laborCost: num, equipmentCost: num, supplier: z.string().optional().catch(undefined),
  })).max(20000),
});

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  const { project, currency, items } = parsed.data;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Price request', { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.addRow([`Request for prices: ${project}`]).font = { bold: true, size: 14 };
  ws.addRow([`Please fill in the yellow columns${currency ? ` in ${currency}` : ''}, per unit shown. Either the three rates or just the total rate. Do not change the Ref column.`]).font = { italic: true, color: { argb: 'FF666666' } };
  ws.addRow([]);
  const table = rfqTable(items);
  const head = ws.addRow(table[0].map((h, i) => (i >= 5 && i <= 8 && currency ? `${h} (${currency})` : h)));
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2328' } }; c.alignment = { vertical: 'middle', wrapText: true }; });
  table.slice(1).forEach(r => {
    const row = ws.addRow(r);
    const n = row.number;
    // Total follows the breakdown unless typed over.
    if (!r[8]) row.getCell(9).value = { formula: `IF(SUM(F${n}:H${n})>0,SUM(F${n}:H${n}),"")` };
    for (const c of [6, 7, 8, 9]) {
      row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF6D6' } };
      row.getCell(c).numFmt = '#,##0.00';
    }
    row.getCell(5).numFmt = '#,##0.00';
    row.getCell(1).font = { color: { argb: 'FFAAAAAA' }, size: 8 };
  });
  [14, 14, 46, 8, 12, 15, 15, 15, 15, 30].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  void RFQ_HEADERS;

  const buf = await wb.xlsx.writeBuffer();
  const name = `${project.replace(/[^\w\- ]+/g, '').trim() || 'project'}-price-request.xlsx`;
  return new NextResponse(buf as ArrayBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${name}"`,
    },
  });
}

// POST (multipart, field "file": .xlsx or .csv price list) → { lines: RateLine[] }
// Reads a supplier quote / rate sheet so the material bank can match it to its materials.

import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { parseCsv, readRateTable, type Cell, type RateLine } from '@/lib/takeoff/rateSheet';

export const runtime = 'nodejs';
const MAX_BYTES = 8 * 1024 * 1024;

const cellValue = (v: ExcelJS.CellValue): Cell => {
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map(t => t.text).join('');
    if ('text' in v) return String(v.text);
  }
  return String(v);
};

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file was sent.' }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'That file is too large (8 MB at most).' }, { status: 413 });
    const buf = await file.arrayBuffer();
    let lines: RateLine[] = [];
    if (/\.(csv|txt)$/i.test(file.name)) {
      lines = readRateTable(parseCsv(new TextDecoder().decode(buf)));
    } else if (/\.xlsx$/i.test(file.name)) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      // The first sheet that reads as a price list wins.
      for (const ws of wb.worksheets) {
        const rows: Cell[][] = [];
        ws.eachRow({ includeEmpty: true }, row => {
          const cells: Cell[] = [];
          row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cellValue(cell.value); });
          rows.push(cells);
        });
        lines = readRateTable(rows);
        if (lines.length) break;
      }
    } else {
      return NextResponse.json({ error: 'Use an Excel (.xlsx) or CSV file. An old .xls file can be saved as .xlsx from Excel first.' }, { status: 415 });
    }
    if (!lines.length) {
      return NextResponse.json({ error: 'No price list was found in that file. It needs a heading row with a description or code column and a rate or price column.' }, { status: 422 });
    }
    return NextResponse.json({ lines: lines.slice(0, 20000) });
  } catch {
    return NextResponse.json({ error: 'That file could not be read.' }, { status: 400 });
  }
}

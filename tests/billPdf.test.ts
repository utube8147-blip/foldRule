import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { buildBillPdf, wrapText } from '@/lib/export/billPdf';
import type { Material, TakeoffRow } from '@/types';

const row = (id: string, o: Partial<TakeoffRow> = {}): TakeoffRow =>
  ({ id, drawingId: 'd', description: `Item ${id}`, type: 'Area', quantity: 10, unit: 'm²', unitRate: 25, notes: '', points: [], isOverridden: false, childIds: [], color: '#fff', isVisible: true, ...o } as TakeoffRow);

describe('bill as a PDF', () => {
  it('wraps long descriptions to the column', async () => {
    const doc = await PDFDocument.create(); const f = await doc.embedFont(StandardFonts.Helvetica);
    const lines = wrapText('Concrete block wall 150 mm thick in cement and sand mortar including all cutting and waste', f, 9, 150);
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(f.widthOfTextAtSize(l, 9)).toBeLessThanOrEqual(150);
  });

  it('makes a readable PDF, and runs onto more pages for a long bill', async () => {
    const mats: Material[] = [];
    const small = await PDFDocument.load(await buildBillPdf({ projectName: 'Villa', currency: 'AED', vatPercent: 5, markups: { profitPercent: 10 }, measurements: [row('1', { description: 'Ceramic floor tiles' })], materials: mats }));
    expect(small.getPageCount()).toBe(2);
    expect(small.getTitle()).toBe('Villa - Bill of Quantities');
    const many = Array.from({ length: 140 }, (_, i) => row(String(i), { description: `Plaster to walls, area ${i}` }));
    const big = await PDFDocument.load(await buildBillPdf({ projectName: 'Tower', measurements: many, materials: mats }));
    expect(big.getPageCount()).toBeGreaterThan(3);
  });

  it('does not fail on Arabic or other text the standard fonts cannot draw', async () => {
    await expect(buildBillPdf({ projectName: 'فيلا العين', measurements: [row('1', { description: 'بلاط — tiles' })], materials: [] })).resolves.toBeInstanceOf(Uint8Array);
  });
});

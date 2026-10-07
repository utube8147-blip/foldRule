import { describe, it, expect } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import type { TakeoffRow } from '@/types';
import { buildMarkedUpPdf, pageMapper, latin1 } from '@/lib/export/markupPdf';

const row = (o: Partial<TakeoffRow>): TakeoffRow => ({
  id: 'x', childIds: [], drawingId: 'd', description: '', type: 'Length', quantity: 0, unit: 'm', unitRate: 0,
  notes: '', points: [], isOverridden: false, color: '#EF9F27', isVisible: true, ...o,
});

describe('marked-up PDF', () => {
  const box = { x: 10, y: 20, width: 200, height: 100 };
  it('maps the viewer corners to the right corners of the page at every rotation', () => {
    const tl = { x: 0, y: 0 }, br = { x: 1, y: 1 };
    expect(pageMapper(box, 0).toPdf(tl)).toEqual({ x: 10, y: 120 });
    expect(pageMapper(box, 0).toPdf(br)).toEqual({ x: 210, y: 20 });
    expect(pageMapper(box, 90).toPdf(tl)).toEqual({ x: 10, y: 20 });
    expect(pageMapper(box, 90).toPdf(br)).toEqual({ x: 210, y: 120 });
    expect(pageMapper(box, 180).toPdf(tl)).toEqual({ x: 210, y: 20 });
    expect(pageMapper(box, 270).toPdf(tl)).toEqual({ x: 210, y: 120 });
    expect(pageMapper(box, 90).viewW).toBe(100);
  });

  it('keeps Latin text and replaces what the standard fonts cannot show', () => {
    expect(latin1('Wall A – m² café')).toBe('Wall A ? m² café');
  });

  it('keeps the drawing pages, adds a legend page, and survives every kind of row', async () => {
    const src = await PDFDocument.create();
    src.addPage([600, 400]);
    src.addPage([600, 400]).setRotation(degrees(90));
    const out = await buildMarkedUpPdf({
      pdfBytes: await src.save(), projectName: 'Villa', drawing: { id: 'd', name: 'A-101.pdf', pageTimes: { 2: 12 } },
      measurements: [
        row({ id: 'a', type: 'Polygon', unit: 'sq m', quantity: 12.5, label: 'Room 1',
          points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.1, y: 0.5 }],
          holes: [[{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.2 }, { x: 0.3, y: 0.3 }, { x: 0.2, y: 0.3 }]] }),
        row({ id: 'r', type: 'Rectangle', unit: 'sq m', quantity: 4, points: [{ x: 0.6, y: 0.6 }, { x: 0.8, y: 0.8 }] }),
        row({ id: 'l', quantity: 7.2, label: 'جدار', pageNumber: 2, points: [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.2 }] }),
        row({ id: 'h', isGroupHeader: true, groupName: 'Doors', childIds: ['c'], type: 'Count', unit: 'EA' }),
        row({ id: 'c', parentId: 'h', type: 'Count', unit: 'EA', quantity: 1, points: [{ x: 0.3, y: 0.7 }] }),
        row({ id: 'gone', pageNumber: 9, quantity: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }),
        row({ id: 'other', drawingId: 'e', quantity: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }),
      ],
    });
    const back = await PDFDocument.load(out);
    expect(back.getPageCount()).toBe(3);
    expect(back.getPage(2).getSize().width).toBeCloseTo(841.89, 1);
  });
});

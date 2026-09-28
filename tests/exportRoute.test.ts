import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/export/route';

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/export', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}));

describe('POST /api/export', () => {
  it('rejects a request with no project data', async () => {
    const res = await post({ filename: 'x' });
    expect(res.status).toBe(400);
  });

  it('returns an xlsx with a safe filename', async () => {
    const res = await post({
      filename: 'my "file"',
      project: {
        projectName: 'House',
        drawings: [{ id: 'd1', name: 'A.pdf', pageScales: { '1': 0.01 } }],
        materials: [],
        measurements: [{
          id: 'a', drawingId: 'd1', pageNumber: 1, description: 'Wall', type: 'Length',
          quantity: 4, unit: 'm', unitRate: 10, notes: '', points: [], isOverridden: false,
          childIds: [], color: '#000', isVisible: true,
        }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/spreadsheetml/);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="my_file.xlsx"');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x50); expect(buf[1]).toBe(0x4b); // "PK" zip header
  });
});

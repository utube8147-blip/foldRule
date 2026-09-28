// Social preview image (1200×630) for links shared on LinkedIn, WhatsApp, X, etc.
import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BRAND } from '@/lib/brand';

// Rendered at build time; Archivo comes from the @fontsource/archivo package.
const fontFile = (w: 400 | 700) =>
  readFile(join(process.cwd(), 'node_modules/@fontsource/archivo/files', `archivo-latin-${w}-normal.woff`));

export const alt = `${BRAND.name} — ${BRAND.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const C = BRAND.colors;
const TICKS = [[30,19,30,14.5],[38,19,38,14.5],[46,19,46,14.5],[34,19,34,16.5],[42,19,42,16.5],
  [30,41,30,36.5],[38,41,38,36.5],[34,41,34,38.5],[23,47,18.5,47],[23,51.5,20.5,51.5]];

export default async function OpengraphImage() {
  const [regular, bold] = await Promise.all([fontFile(400), fontFile(700)]);
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: C.graphite, padding: 80, fontFamily: 'Archivo' }}>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', flexGrow: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
            <svg width="120" height="120" viewBox="0 0 64 64">
              <rect x="12" y="8" width="11" height="48" rx="2" fill={C.rule} />
              <rect x="12" y="8" width="42" height="11" rx="2" fill={C.rule} />
              <rect x="12" y="30" width="31" height="11" rx="2" fill={C.rule} />
              {TICKS.map(([a, b, c, d], i) => <line key={i} x1={a} y1={b} x2={c} y2={d} stroke={C.graphite} strokeWidth="1.4" />)}
              <circle cx="17.5" cy="13.5" r="2.4" fill={C.graphite} />
              <circle cx="17.5" cy="35.5" r="2.4" fill={C.graphite} />
            </svg>
            <div style={{ fontSize: 96, fontWeight: 700, color: '#F4F5F6', letterSpacing: -2 }}>{BRAND.wordmark}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ fontSize: 60, fontWeight: 700, color: C.rule, lineHeight: 1.1 }}>{BRAND.tagline}</div>
            <div style={{ fontSize: 30, color: '#C3C9CF', lineHeight: 1.4, maxWidth: 960 }}>
              Measure PDF drawings, set the scale per page, and export a priced BOQ to Excel.
            </div>
          </div>
          <div style={{ display: 'flex', height: 14 }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} style={{ flexGrow: 1, background: i % 2 === 0 ? C.rule : C.paper }} />
            ))}
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Archivo', data: regular, weight: 400, style: 'normal' },
        { name: 'Archivo', data: bold,    weight: 700, style: 'normal' },
      ],
    },
  );
}

// Marked-up drawing: the original PDF with every measurement drawn on it in its
// colour and labelled with its quantity, followed by a legend page. Sent with the
// bill as evidence of what was measured.

import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, degrees } from 'pdf-lib';
import type { Drawing, TakeoffRow } from '@/types';
import { rowOutline } from '@/lib/takeoff/rowOutline';
import { timesIndex, timesLabel } from '@/lib/takeoff/timesing';

type Pt = { x: number; y: number };
const COUNT_TYPES = new Set(['Count', 'Point']);

function colour(hex: string | undefined) {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  const n = parseInt(m ? m[1] : 'EF9F27', 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
/** The standard PDF fonts only cover Latin-1; anything else is shown as "?". */
export const latin1 = (s: string) => (s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
const fmtQty = (n: number, type: string) => (COUNT_TYPES.has(type) ? String(Math.round(n)) : n.toFixed(2));

/**
 * Maps a point stored on a row (0–1 across the page as seen in the viewer, y down)
 * to PDF user space, allowing for the page's crop box and rotation.
 */
export function pageMapper(box: { x: number; y: number; width: number; height: number }, rotation: number) {
  const rot = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  const { x, y, width: w, height: h } = box;
  const toPdf = (p: Pt): Pt =>
      rot === 90  ? { x: x + p.y * w,       y: y + p.x * h }
    : rot === 180 ? { x: x + (1 - p.x) * w, y: y + p.y * h }
    : rot === 270 ? { x: x + (1 - p.y) * w, y: y + (1 - p.x) * h }
    :               { x: x + p.x * w,       y: y + (1 - p.y) * h };
  const sideways = rot === 90 || rot === 270;
  return { toPdf, rot, viewW: sideways ? h : w, viewH: sideways ? w : h };
}

const signedArea = (r: Pt[]) => r.reduce((t, p, i) => { const q = r[(i + 1) % r.length]; return t + p.x * q.y - q.x * p.y; }, 0) / 2;
const svgRing = (r: Pt[]) => r.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${(-p.y).toFixed(2)}`).join(' ') + ' Z';
const centroid = (r: Pt[]): Pt => ({ x: r.reduce((t, p) => t + p.x, 0) / r.length, y: r.reduce((t, p) => t + p.y, 0) / r.length });

function midOfLine(pts: Pt[]): Pt {
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  let half = lens.reduce((t, l) => t + l, 0) / 2;
  for (let i = 0; i < lens.length; i++) {
    if (half <= lens[i] && lens[i] > 0) {
      const f = half / lens[i];
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f };
    }
    half -= lens[i];
  }
  return pts[0];
}

function drawLabel(page: PDFPage, font: PDFFont, text: string, at: Pt, rot: number, size: number, ink: ReturnType<typeof rgb>) {
  const a = (rot * Math.PI) / 180;
  const ex = { x: Math.cos(a), y: Math.sin(a) }, ey = { x: -Math.sin(a), y: Math.cos(a) };
  const tw = font.widthOfTextAtSize(text, size), pad = size * 0.3;
  const o = { x: at.x - ex.x * tw / 2 - ey.x * size * 0.35, y: at.y - ex.y * tw / 2 - ey.y * size * 0.35 };
  page.drawRectangle({
    x: o.x - ex.x * pad - ey.x * (pad + size * 0.2), y: o.y - ex.y * pad - ey.y * (pad + size * 0.2),
    width: tw + pad * 2, height: size + pad * 2, rotate: degrees(rot),
    color: rgb(1, 1, 1), opacity: 0.85, borderColor: ink, borderWidth: 0.4,
  });
  page.drawText(text, { x: o.x, y: o.y, size, font, color: rgb(0.1, 0.1, 0.1), rotate: degrees(rot) });
}

export interface MarkupInput {
  pdfBytes: ArrayBuffer | Uint8Array;
  drawing: Pick<Drawing, 'id' | 'name' | 'pageTimes'>;
  /** Every row of the project (groups are needed to resolve names and timesing). */
  measurements: TakeoffRow[];
  projectName: string;
  labels?: boolean;
}

export async function buildMarkedUpPdf({ pdfBytes, drawing, measurements, projectName, labels = true }: MarkupInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const times = timesIndex(measurements, [drawing]);
  const mine = measurements.filter(m => m.drawingId === drawing.id && m.isVisible !== false && !m.isGroupHeader && m.points?.length);

  for (const m of mine) {
    const page = pages[(m.pageNumber ?? 1) - 1];
    if (!page) continue;
    const map = pageMapper(page.getCropBox(), page.getRotation().angle);
    const ink = colour(m.color);
    const unitPt = Math.min(map.viewW, map.viewH);
    const stroke = Math.max(1.2, unitPt / 500);
    const labelSize = Math.min(10, Math.max(6.5, unitPt / 130));
    const full = latin1(m.label || m.description || '');
    const name = full.length > 32 ? `${full.slice(0, 30).trimEnd()}...` : full;
    const t = times(m).total;
    const text = `${name ? `${name}: ` : ''}${fmtQty(m.quantity, m.type)} ${latin1(m.unit)}${t !== 1 ? ` ${timesLabel(t)}` : ''}`;

    if (COUNT_TYPES.has(m.type)) {
      const r = Math.max(2.5, unitPt / 220);
      for (const p of m.points) {
        if (!Number.isFinite(p.x) || p.x < 0) continue;
        const c = map.toPdf(p);
        page.drawCircle({ x: c.x, y: c.y, size: r, color: ink, opacity: 0.85, borderColor: rgb(1, 1, 1), borderWidth: stroke * 0.6 });
      }
      continue;
    }

    // Curves are followed properly (an arc is stored as just three points).
    const outline = rowOutline(m, map.viewW, map.viewH);
    if (outline.pts.length < 2) continue;
    const ring = outline.pts.map(map.toPdf);

    if (outline.closed && ring.length >= 3) {
      // Outer ring one way round, cut-outs the other, so the cut-outs stay empty.
      const outer = signedArea(ring) < 0 ? [...ring].reverse() : ring;
      const holes = (m.holes ?? []).filter(h => h.length >= 3).map(h => h.map(map.toPdf)).map(h => (signedArea(h) > 0 ? [...h].reverse() : h));
      page.drawSvgPath([outer, ...holes].map(svgRing).join(' '), {
        x: 0, y: 0, color: ink, opacity: 0.25, borderColor: ink, borderWidth: stroke, borderOpacity: 0.95,
      });
      if (labels) drawLabel(page, font, text, centroid(outer), map.rot, labelSize, ink);
    } else {
      for (let i = 1; i < ring.length; i++) {
        page.drawLine({ start: ring[i - 1], end: ring[i], thickness: stroke * 1.8, color: ink, opacity: 0.9 });
      }
      if (labels) drawLabel(page, font, text, midOfLine(ring), map.rot, labelSize, ink);
    }
  }

  // ── Legend ────────────────────────────────────────────────────────────────
  const byId = new Map(measurements.map(m => [m.id, m]));
  const headerOf = (m: TakeoffRow) => {
    const p = m.parentId ? byId.get(m.parentId) : undefined;
    return p?.isGroupHeader ? p : measurements.find(h => h.isGroupHeader && !!m.groupId && h.groupId === m.groupId);
  };
  type Line = { name: string; color?: string; unit: string; type: string; qty: number; billed: number; pages: Set<number> };
  const lines = new Map<string, Line>();
  for (const m of mine) {
    const h = headerOf(m);
    const key = h ? `${h.id}|${m.unit}` : m.id;
    const l = lines.get(key) ?? {
      name: h ? (h.groupName || h.label || h.description || 'Group') : (m.label || m.description || 'Untitled'),
      color: m.color, unit: m.unit, type: m.type, qty: 0, billed: 0, pages: new Set<number>(),
    };
    l.qty += m.quantity || 0;
    l.billed += (m.quantity || 0) * times(m).total;
    l.pages.add(m.pageNumber ?? 1);
    lines.set(key, l);
  }

  const W = 841.89, H = 595.28, M = 40, ROW = 16;
  const cols = [M + 22, M + 380, M + 470, M + 560, M + 650];
  let page: PDFPage | null = null, y = 0;
  const right = (p: PDFPage, s: string, x: number, yy: number, f = font) => p.drawText(s, { x: x - f.widthOfTextAtSize(s, 9), y: yy, size: 9, font: f, color: rgb(0.1, 0.1, 0.1) });
  const newPage = () => {
    page = doc.addPage([W, H]);
    page.drawText('Measurement legend', { x: M, y: H - M - 6, size: 16, font: bold, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(latin1(`${projectName}  |  ${drawing.name}  |  ${new Date().toISOString().slice(0, 10)}`), { x: M, y: H - M - 24, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
    y = H - M - 52;
    page.drawText('Item', { x: cols[0], y, size: 9, font: bold });
    right(page, 'Measured', cols[2], y, bold); right(page, 'Billed', cols[3], y, bold);
    page.drawText('Unit', { x: cols[3] + 12, y, size: 9, font: bold });
    page.drawText('Pages', { x: cols[4], y, size: 9, font: bold });
    page.drawLine({ start: { x: M, y: y - 5 }, end: { x: W - M, y: y - 5 }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) });
    y -= ROW + 4;
  };
  newPage();
  if (!lines.size) page!.drawText('No measurements on this drawing yet.', { x: M, y, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
  for (const l of lines.values()) {
    if (y < M + ROW) newPage();
    const p = page!;
    p.drawRectangle({ x: M, y: y - 2, width: 14, height: 10, color: colour(l.color), opacity: 0.6, borderColor: colour(l.color), borderWidth: 0.8 });
    let name = latin1(l.name);
    while (name.length > 6 && font.widthOfTextAtSize(name, 9) > cols[1] - cols[0] - 10) name = `${name.replace(/\.\.\.$/, '').slice(0, -1).trimEnd()}...`;
    p.drawText(name, { x: cols[0], y, size: 9, font, color: rgb(0.1, 0.1, 0.1) });
    right(p, fmtQty(l.qty, l.type), cols[2], y);
    right(p, fmtQty(l.billed, l.type), cols[3], y);
    p.drawText(latin1(l.unit), { x: cols[3] + 12, y, size: 9, font, color: rgb(0.1, 0.1, 0.1) });
    p.drawText([...l.pages].sort((a, b) => a - b).join(', '), { x: cols[4], y, size: 9, font, color: rgb(0.1, 0.1, 0.1) });
    p.drawLine({ start: { x: M, y: y - 5 }, end: { x: W - M, y: y - 5 }, thickness: 0.3, color: rgb(0.8, 0.8, 0.8) });
    y -= ROW;
  }
  const timesed = Object.entries(drawing.pageTimes ?? {}).filter(([, v]) => v > 0 && v !== 1);
  if (timesed.length) {
    if (y < M + ROW) newPage();
    page!.drawText(`Timesing: ${timesed.map(([p, v]) => `page ${p} x ${v}`).join(', ')}. "Billed" includes it.`, { x: M, y: y - 6, size: 8, font, color: rgb(0.35, 0.35, 0.35) });
  }
  return doc.save();
}

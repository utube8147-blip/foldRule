// The priced bill as a PDF to hand over or print: a cover block, the estimate summary
// (measured work → tender sum → VAT), then the Bill of Quantities by section with a
// collection at the end. A4 portrait, page numbers, nothing that needs Excel to read.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Material, TakeoffRow } from '@/types';
import { buildBill } from '@/lib/takeoff/pomi';
import { buildUp, type Markups } from '@/lib/takeoff/estimate';
import { formatMoney } from '@/lib/takeoff/currency';
import { latin1 as toLatin1 } from './markupPdf';

/** Dashes and curly quotes have plain equivalents the standard fonts can draw; anything else unknown becomes "?". */
const latin1 = (s: string) => toLatin1((s ?? '').replace(/[\u2013\u2014\u2212]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\u2026/g, '...').replace(/\u00A0/g, ' '));

export interface BillPdfInput {
  projectName: string;
  projectNumber?: string;
  location?: string;
  documentTitle?: string;
  documentDate?: string;
  revision?: string;
  preparedBy?: string;
  currency?: string;
  vatPercent?: number;
  markups?: Markups;
  /** Rows as billed (multipliers already applied). */
  measurements: TakeoffRow[];
  materials: Material[];
}

const W = 595.28, H = 841.89, M = 42;
const INK = rgb(0.12, 0.14, 0.16), MUTED = rgb(0.42, 0.45, 0.5), RULE = rgb(0.8, 0.82, 0.85), BAND = rgb(0.95, 0.96, 0.97), GOLD = rgb(0.72, 0.55, 0.05);

/** Break text into lines that fit a width. */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of latin1(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

export async function buildBillPdf(input: BillPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(latin1(`${input.projectName} - Bill of Quantities`));
  doc.setCreator('Foldrule');
  const cur = input.currency || undefined;
  const money = (n: number) => latin1(formatMoney(n, cur));
  const qty = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

  let page!: PDFPage;
  let y = 0;
  const pages: PDFPage[] = [];
  const newPage = () => { page = doc.addPage([W, H]); pages.push(page); y = H - M; };
  const need = (h: number) => { if (y - h < M + 24) { newPage(); return true; } return false; };
  const text = (s: string, x: number, yy: number, size = 9, f = font, color = INK) => page.drawText(latin1(s), { x, y: yy, size, font: f, color });
  const right = (s: string, xRight: number, yy: number, size = 9, f = font, color = INK) => {
    const t = latin1(s); page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y: yy, size, font: f, color });
  };
  const rule = (yy: number, color = RULE, thickness = 0.6) => page.drawLine({ start: { x: M, y: yy }, end: { x: W - M, y: yy }, thickness, color });

  // ── Cover block ──
  newPage();
  text('BILL OF QUANTITIES', M, y - 6, 9, bold, GOLD);
  y -= 30;
  for (const l of wrapText(input.documentTitle || input.projectName, bold, 20, W - 2 * M)) { text(l, M, y, 20, bold); y -= 24; }
  if (input.documentTitle && input.documentTitle !== input.projectName) { text(input.projectName, M, y, 11, font, MUTED); y -= 16; }
  y -= 6; rule(y); y -= 16;
  const facts: [string, string | undefined][] = [
    ['Project no.', input.projectNumber], ['Location', input.location], ['Date', input.documentDate || new Date().toISOString().slice(0, 10)],
    ['Revision', input.revision], ['Prepared by', input.preparedBy], ['Currency', input.currency],
  ];
  let col = 0;
  for (const [k, v] of facts.filter(f => f[1])) {
    const x = M + (col % 3) * ((W - 2 * M) / 3);
    text(k.toUpperCase(), x, y, 7, bold, MUTED); text(String(v), x, y - 11, 10);
    if (++col % 3 === 0) y -= 30;
  }
  if (col % 3) y -= 30;
  y -= 4;

  // ── Estimate summary ──
  const sections = buildBill(input.measurements, input.materials);
  const sectionTotal = (s: typeof sections[number]) => s.items.reduce((t, i) => t + i.quantity * i.rate, 0);
  const measured = sections.reduce((t, s) => t + sectionTotal(s), 0);
  const lines = buildUp(measured, input.markups, input.vatPercent);
  text('ESTIMATE SUMMARY', M, y, 9, bold, GOLD); y -= 7; rule(y, INK, 1); y -= 17;
  for (const l of lines) {
    if (!l.total && l.amount === 0 && l.key !== 'measured' && l.key !== 'vat') continue;      // nothing added: leave the line out
    const h = 18;
    if (l.total) page.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: h, color: BAND });
    const f = l.total ? bold : font;
    text(l.label, M + 6, y, l.key === 'total' ? 11 : 9.5, f);
    if (l.percent !== undefined && !l.total) right(`${l.percent}%`, W - M - 130, y, 9, font, MUTED);
    right(money(l.amount), W - M - 6, y, l.key === 'total' ? 11 : 9.5, f);
    y -= h;
  }
  for (const p of input.markups?.provisional ?? []) {
    if (!(p.amount > 0)) continue;
    text(`Provisional sum: ${p.name || 'unnamed'}`, M + 6, y, 8, font, MUTED); right(money(p.amount), W - M - 6, y, 8, font, MUTED); y -= 12;
  }
  const unpriced = sections.reduce((n, s) => n + s.items.filter(i => !(i.rate > 0)).length, 0);
  if (unpriced) { y -= 6; text(`${unpriced} bill item${unpriced === 1 ? ' has' : 's have'} no rate and ${unpriced === 1 ? 'is' : 'are'} not included in these totals.`, M, y, 8.5, bold, rgb(0.7, 0.2, 0.1)); y -= 12; }

  // ── Bill ──
  const X = { ref: M, desc: M + 30, qty: W - M - 215, unit: W - M - 205, rate: W - M - 95, amt: W - M };
  const descW = X.qty - 50 - X.desc;
  const tableHead = () => {
    page.drawRectangle({ x: M, y: y - 5, width: W - 2 * M, height: 16, color: INK });
    const c = rgb(1, 1, 1);
    text('ITEM', X.ref + 4, y, 7, bold, c); text('DESCRIPTION', X.desc, y, 7, bold, c); right('QUANTITY', X.qty, y, 7, bold, c);
    text('UNIT', X.unit + 6, y, 7, bold, c); right('RATE', X.rate, y, 7, bold, c); right('AMOUNT', X.amt - 4, y, 7, bold, c);
    y -= 20;
  };
  newPage();
  text('BILL OF QUANTITIES', M, y - 6, 9, bold, GOLD); y -= 24;
  tableHead();
  for (const s of sections) {
    if (!s.items.length) continue;
    if (need(46)) tableHead();
    page.drawRectangle({ x: M, y: y - 5, width: W - 2 * M, height: 16, color: BAND });
    text(s.code ? `SECTION ${s.code}` : 'UNCLASSIFIED', X.ref + 4, y, 8, bold); text(s.title.toUpperCase(), X.desc + 50, y, 8, bold);
    y -= 20;
    for (const it of s.items) {
      const dl = wrapText(it.description, font, 9, descW);
      if (need(dl.length * 11 + 6)) tableHead();
      text(it.ref, X.ref + 4, y, 9, font, MUTED);
      dl.forEach((l, i) => text(l, X.desc, y - i * 11, 9));
      right(qty(it.quantity), X.qty, y); text(it.unit, X.unit + 6, y, 9, font, MUTED);
      if (it.rate > 0) { right(money(it.rate).replace(/^[A-Z]{3}\s/, ''), X.rate, y); right(money(it.quantity * it.rate).replace(/^[A-Z]{3}\s/, ''), X.amt - 4, y); }
      else right('rate to be set', X.amt - 4, y, 8, font, rgb(0.7, 0.2, 0.1));
      y -= dl.length * 11 + 5;
      page.drawLine({ start: { x: M, y: y + 9 }, end: { x: W - M, y: y + 9 }, thickness: 0.3, color: RULE });
    }
    if (need(20)) tableHead();
    right(`Section ${s.code || '-'} carried to collection`, X.rate, y - 4, 8.5, bold); right(money(sectionTotal(s)), X.amt - 4, y - 4, 9, bold);
    y -= 28;
  }

  // ── Collection ──
  if (need(60 + sections.length * 14)) { /* fresh page */ }
  text('COLLECTION', M, y, 9, bold, GOLD); y -= 7; rule(y, INK, 1); y -= 16;
  for (const s of sections) {
    if (!s.items.length) continue;
    text(s.code ? `${s.code}  ${s.title}` : s.title, M + 6, y, 9); right(money(sectionTotal(s)), W - M - 6, y, 9); y -= 14;
  }
  rule(y + 8);
  text('Measured work, to the estimate summary', M + 6, y - 8, 9.5, bold); right(money(measured), W - M - 6, y - 8, 9.5, bold);

  // ── Footers ──
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: M - 6 }, end: { x: W - M, y: M - 6 }, thickness: 0.4, color: RULE });
    p.drawText(latin1(`${input.projectName}${input.revision ? ` · ${input.revision}` : ''}`), { x: M, y: M - 18, size: 7.5, font, color: MUTED });
    const t = `Page ${i + 1} of ${pages.length}`;
    p.drawText(t, { x: W - M - font.widthOfTextAtSize(t, 7.5), y: M - 18, size: 7.5, font, color: MUTED });
  });
  return doc.save();
}

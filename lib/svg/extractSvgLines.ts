// ─── lib/extractSvgLines.ts ───────────────────────────────────────────────────
//
//  Parse raw SVG text and return line segments in PDF-pixel coordinates.
//  Shared between SnapEnginePage and useViewerSvgSnap.
//
//  Handles: <line>, <polyline>, <polygon>, <rect>
//  Respects ancestor transform attributes via CTM accumulation.
//  Drops segments shorter than 0.5 PDF-px.
//
// ─────────────────────────────────────────────────────────────────────────────

import type { SvgLine } from '@/hooks/snapEngine/useSvgSnapPoints';

// ── Internal matrix helpers ───────────────────────────────────────────────────

function numA(el: Element, n: string, fb = 0): number {
  const v = parseFloat(el.getAttribute(n) ?? '');
  return isNaN(v) ? fb : v;
}
function identMat() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
function mulMat(m1: any, m2: any) {
  return {
    a: m1.a * m2.a + m1.c * m2.b, b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d, d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}
function applyMat(m: any, x: number, y: number) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}
function parseTfm(t: string | null): any {
  if (!t) return identMat();
  const re = /(matrix|translate|scale|rotate)\(([^)]*)\)/g;
  const mats: any[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const args = m[2].trim().split(/[\s,]+/).map(parseFloat);
    let mat = identMat();
    if (m[1] === 'matrix')
      mat = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
    else if (m[1] === 'translate')
      mat = { ...identMat(), e: args[0] ?? 0, f: args[1] ?? 0 };
    else if (m[1] === 'scale') {
      const s = args[0] ?? 1, sy = args[1] ?? s;
      mat = { a: s, b: 0, c: 0, d: sy, e: 0, f: 0 };
    } else if (m[1] === 'rotate') {
      const a = (args[0] ?? 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      mat = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
    }
    mats.push(mat);
  }
  return mats.reduce((acc, mx) => mulMat(acc, mx), identMat());
}
function getCTM(el: Element, root: Element): any {
  const mats: any[] = [];
  let node: Element | null = el;
  while (node && node !== root.parentElement) {
    const t = node.getAttribute('transform');
    if (t) mats.unshift(parseTfm(t));
    node = node.parentElement;
  }
  return mats.reduce((acc, mx) => mulMat(acc, mx), identMat());
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse raw SVG text and return line segments normalised to PDF-pixel coords.
 *
 * @param svgText  Raw SVG markup string.
 * @param pdfW     Width of the PDF canvas in pixels.
 * @param pdfH     Height of the PDF canvas in pixels.
 */
export function extractSvgLines(svgText: string, pdfW: number, pdfH: number): SvgLine[] {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(svgText, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return [];
  const svgEl = doc.querySelector('svg');
  if (!svgEl) return [];

  let sx = 1, sy = 1, tx = 0, ty = 0;
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const [minX, minY, vbW, vbH] = vb.trim().split(/[\s,]+/).map(parseFloat);
    if (vbW > 0 && vbH > 0) { sx = pdfW / vbW; sy = pdfH / vbH; tx = -minX * sx; ty = -minY * sy; }
  } else {
    const wa = parseFloat(svgEl.getAttribute('width')  ?? '0') || pdfW;
    const ha = parseFloat(svgEl.getAttribute('height') ?? '0') || pdfH;
    sx = pdfW / wa; sy = pdfH / ha;
  }

  const toCanvas = (x: number, y: number, ctm: any) => {
    const p = applyMat(ctm, x, y);
    return { x: p.x * sx + tx, y: p.y * sy + ty };
  };

  const lines: SvgLine[] = [];

  const pushLine = (ax: number, ay: number, bx: number, by: number, ctm: any) => {
    const a = toCanvas(ax, ay, ctm), b = toCanvas(bx, by, ctm);
    if (Math.hypot(a.x - b.x, a.y - b.y) < 0.5) return;
    lines.push(({ nx1: a.x / pdfW, ny1: a.y / pdfH, nx2: b.x / pdfW, ny2: b.y / pdfH } as unknown) as SvgLine);
  };

  svgEl.querySelectorAll('line,polyline,polygon,rect').forEach(el => {
    const tag = el.tagName.toLowerCase();
    const ctm = getCTM(el, svgEl);

    if (tag === 'line') {
      pushLine(numA(el, 'x1'), numA(el, 'y1'), numA(el, 'x2'), numA(el, 'y2'), ctm);
    } else if (tag === 'polyline' || tag === 'polygon') {
      const raw  = el.getAttribute('points') ?? '';
      const nums = raw.trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
      for (let i = 0; i + 3 < nums.length; i += 2)
        pushLine(nums[i], nums[i + 1], nums[i + 2], nums[i + 3], ctm);
      if (tag === 'polygon' && nums.length >= 4)
        pushLine(nums[nums.length - 2], nums[nums.length - 1], nums[0], nums[1], ctm);
    } else if (tag === 'rect') {
      const x = numA(el, 'x'), y = numA(el, 'y'), w = numA(el, 'width'), h = numA(el, 'height');
      if (w > 0 && h > 0) {
        pushLine(x,     y,     x + w, y,     ctm);
        pushLine(x + w, y,     x + w, y + h, ctm);
        pushLine(x + w, y + h, x,     y + h, ctm);
        pushLine(x,     y + h, x,     y,     ctm);
      }
    }
  });

  return lines;
}

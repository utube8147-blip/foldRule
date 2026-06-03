'use client';

// ── Constants ─────────────────────────────────────────────────────────────────

export const COLORS = [
  '#60a5fa','#34d399','#fbbf24','#f87171','#a78bfa',
  '#f472b6','#22d3ee','#a3e635','#fb923c','#818cf8',
];

export const WALL_LUMA           = 120;
export const STROKE_NEIGHBOR_MIN = 2;
export const DILATE_R            = 2;
export const ERODE_R             = 1;
export const FILL_GROW           = 3;
export const PDF_SCALE           = 3;
export const SVG_SCALE           = 3;

// ── Shared types ──────────────────────────────────────────────────────────────

export interface Fill {
  id: number;
  label: string;
  color: string;
  opacity: number;
  areaPx: number;
  perimPx: number;
  polygon: [number, number][];
  groupId?: number;
  svgMode?: boolean;
  svgPathD?: string;
  svgBBox?: { x: number; y: number; w: number; h: number };
}

export type LoadStage = 'idle' | 'loading' | 'ready';

export interface SelectRect {
  x1: number; y1: number; x2: number; y2: number;
  sx: number; sy: number; sw: number; sh: number;
}

export interface SvgShape {
  el: SVGGraphicsElement;
  pathD: string;
  bbox: DOMRect;
  transform: DOMMatrix;
  area: number;
}

export interface SvgOverlayFill {
  id: number;
  pathD: string;
  color: string;
  opacity: number;
  selected: boolean;
  inGroup: boolean;
  hidden: boolean;
}

// ── Async yield helpers ───────────────────────────────────────────────────────

export const yieldFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
export const yieldMacro = () => new Promise<void>(r => setTimeout(r, 0));

// ── Formatting helpers ────────────────────────────────────────────────────────

export function hexToRgb(hex: string) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ] as const;
}

export function fmtArea(px: number, pxPerM: number | null): string {
  if (!pxPerM) return `${px.toLocaleString()} px²`;
  const m2 = px / (pxPerM * pxPerM);
  return m2 >= 1 ? `${m2.toFixed(2)} m²` : `${(m2 * 1e6).toFixed(0)} mm²`;
}

export function fmtPerim(px: number, pxPerM: number | null): string {
  if (!pxPerM) return `${px.toLocaleString()} px`;
  const m = px / pxPerM;
  return m >= 1 ? `${m.toFixed(2)} m` : `${(m * 100).toFixed(1)} cm`;
}

// ── Mask / morphology helpers ─────────────────────────────────────────────────

export function buildWallMask(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < 20) continue;
    const luma = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    if (luma < WALL_LUMA) dark[i] = 1;
  }
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!dark[y * w + x]) continue;
      let n = 0;
      if (x > 0   && dark[y * w + x - 1])               n++;
      if (x < w-1 && dark[y * w + x + 1])               n++;
      if (y > 0   && dark[(y - 1) * w + x])             n++;
      if (y < h-1 && dark[(y + 1) * w + x])             n++;
      if (x > 0   && y > 0   && dark[(y-1)*w + x-1])    n++;
      if (x < w-1 && y > 0   && dark[(y-1)*w + x+1])    n++;
      if (x > 0   && y < h-1 && dark[(y+1)*w + x-1])    n++;
      if (x < w-1 && y < h-1 && dark[(y+1)*w + x+1])    n++;
      if (n >= STROKE_NEIGHBOR_MIN) mask[y * w + x] = 1;
    }
  }
  return mask;
}

export function dilateMaskFast(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < r && x < w; x++) if (src[y * w + x]) count++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && src[y * w + add]) count++;
      if (count > 0) horiz[y * w + x] = 1;
      const rem = x - r; if (rem >= 0 && src[y * w + rem]) count--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < r && y < h; y++) if (horiz[y * w + x]) count++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && horiz[add * w + x]) count++;
      if (count > 0) out[y * w + x] = 1;
      const rem = y - r; if (rem >= 0 && horiz[rem * w + x]) count--;
    }
  }
  return out;
}

export function erodeMaskFast(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const horiz = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let zeros = 0;
    for (let x = 0; x < r && x < w; x++) if (!src[y * w + x]) zeros++;
    for (let x = 0; x < w; x++) {
      const add = x + r; if (add < w && !src[y * w + add]) zeros++;
      if (zeros === 0) horiz[y * w + x] = 1;
      const rem = x - r; if (rem >= 0 && !src[y * w + rem]) zeros--;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let zeros = 0;
    for (let y = 0; y < r && y < h; y++) if (!horiz[y * w + x]) zeros++;
    for (let y = 0; y < h; y++) {
      const add = y + r; if (add < h && !horiz[add * w + x]) zeros++;
      if (zeros === 0) out[y * w + x] = 1;
      const rem = y - r; if (rem >= 0 && !horiz[rem * w + x]) zeros--;
    }
  }
  return out;
}

export function scanlineFill(mask: Uint8Array, w: number, h: number, sx: number, sy: number): Uint8Array | null {
  if (sx < 0 || sx >= w || sy < 0 || sy >= h || mask[sy * w + sx]) return null;
  const filled  = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
  const stack   = new Int32Array(w * h);
  let top = 0;
  stack[top++] = sy * w + sx;
  visited[sy * w + sx] = 1;
  while (top > 0) {
    const idx = stack[--top];
    const cy  = (idx / w) | 0;
    const cx  = idx % w;
    let left = cx;
    while (left > 0 && !mask[cy * w + left - 1] && !visited[cy * w + left - 1]) left--;
    let right = cx;
    while (right < w - 1 && !mask[cy * w + right + 1] && !visited[cy * w + right + 1]) right++;
    for (let x = left; x <= right; x++) { filled[cy * w + x] = 1; visited[cy * w + x] = 1; }
    const up = (cy - 1) * w, dn = (cy + 1) * w;
    for (let x = left; x <= right; x++) {
      if (cy > 0   && !mask[up + x] && !visited[up + x]) { visited[up + x] = 1; stack[top++] = up + x; }
      if (cy < h-1 && !mask[dn + x] && !visited[dn + x]) { visited[dn + x] = 1; stack[top++] = dn + x; }
    }
  }
  let count = 0;
  for (let i = 0; i < filled.length; i++) if (filled[i]) count++;
  return count > 4 ? filled : null;
}

export function multiSeedFill(mask: Uint8Array, w: number, h: number, cx: number, cy: number): Uint8Array | null {
  const OFFSETS: [number, number][] = [
    [0,0],[1,0],[-1,0],[0,1],[0,-1],
    [2,0],[-2,0],[0,2],[0,-2],
    [1,1],[-1,1],[1,-1],[-1,-1],
  ];
  let merged: Uint8Array | null = null;
  let mergedDilated: Uint8Array | null = null;
  for (const [dx, dy] of OFFSETS) {
    const f = scanlineFill(mask, w, h, cx + dx, cy + dy);
    if (!f) continue;
    if (!merged) {
      merged = f;
      mergedDilated = dilateMaskFast(f, w, h, FILL_GROW + 2);
    } else {
      let overlaps = false;
      for (let i = 0; i < f.length; i++) { if (f[i] && mergedDilated![i]) { overlaps = true; break; } }
      if (overlaps) {
        for (let i = 0; i < merged.length; i++) if (f[i]) merged[i] = 1;
        mergedDilated = dilateMaskFast(merged, w, h, FILL_GROW + 2);
      }
    }
  }
  return merged;
}

export function paintFill(
  filled: Uint8Array, fillData: ImageData,
  r: number, g: number, b: number, opacity: number,
): number {
  let count = 0;
  const newA = opacity;
  const d = fillData.data;
  for (let i = 0; i < filled.length; i++) {
    if (!filled[i]) continue;
    count++;
    const di = i * 4;
    const existA = d[di + 3] / 255;
    const outA = newA + existA * (1 - newA);
    if (outA > 0) {
      d[di]   = ((r * newA + d[di]   * existA * (1 - newA)) / outA) | 0;
      d[di+1] = ((g * newA + d[di+1] * existA * (1 - newA)) / outA) | 0;
      d[di+2] = ((b * newA + d[di+2] * existA * (1 - newA)) / outA) | 0;
      d[di+3] = (outA * 255) | 0;
    }
  }
  return count;
}

export function closeHoles(filled: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (i >= 0 && i < w * h && !filled[i] && !outside[i]) { outside[i] = 1; stack.push(i); }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i / w) | 0;
    if (x > 0)   push(i - 1);
    if (x < w-1) push(i + 1);
    if (y > 0)   push(i - w);
    if (y < h-1) push(i + w);
  }
  const closed = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) closed[i] = filled[i] || (!outside[i] ? 1 : 0);
  return closed;
}

export function outerShape(filled: Uint8Array, w: number, h: number): Uint8Array {
  const eroded   = erodeMaskFast(filled, w, h, 2);
  const restored = dilateMaskFast(eroded, w, h, 2);
  return restored;
}

export function maskArea(mask: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
  return c;
}

// ── Marching squares contour ──────────────────────────────────────────────────

export function marchingSquaresContour(mask: Uint8Array, w: number, h: number): [number, number][] {
  const W = w + 2, H = h + 2;
  const field = new Uint8Array(W * H);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) field[(y + 1) * W + (x + 1)] = 1;
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (field[y * W + x]) { startX = x; startY = y; break outer; }
  if (startX === -1) return [];
  const dx8 = [ 1, 1, 0,-1,-1,-1, 0, 1];
  const dy8 = [ 0, 1, 1, 1, 0,-1,-1,-1];
  const contour: [number, number][] = [];
  let cx = startX, cy = startY;
  let prevX = startX - 1, prevY = startY;
  let steps = 0;
  const maxSteps = W * H * 2;
  do {
    contour.push([cx - 1, cy - 1]);
    const fromDx = cx - prevX, fromDy = cy - prevY;
    let startDir = 0;
    for (let d = 0; d < 8; d++)
      if (dx8[d] === -fromDx && dy8[d] === -fromDy) { startDir = d; break; }
    let moved = false;
    for (let t = 0; t < 8; t++) {
      const d = (startDir + t) % 8;
      const nx = cx + dx8[d], ny = cy + dy8[d];
      if (nx >= 0 && nx < W && ny >= 0 && ny < H && field[ny * W + nx]) {
        prevX = cx; prevY = cy; cx = nx; cy = ny; moved = true; break;
      }
    }
    if (!moved) break;
    if (++steps > maxSteps) break;
  } while (!(cx === startX && cy === startY));
  return contour;
}

export function rdpSimplify(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length <= 3) return pts;
  const distToLine = (p: [number,number], a: [number,number], b: [number,number]) => {
    const [ax, ay] = a, [bx, by] = b, [px, py] = p;
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px-ax)*(bx-ax) + (py-ay)*(by-ay)) / len2));
    return Math.hypot(px - (ax + t*(bx-ax)), py - (ay + t*(by-ay)));
  };
  const keep = new Set<number>([0, pts.length - 1]);
  const rec = (lo: number, hi: number) => {
    if (hi - lo < 2) return;
    let maxD = 0, idx = lo;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToLine(pts[i], pts[lo], pts[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) { keep.add(idx); rec(lo, idx); rec(idx, hi); }
  };
  rec(0, pts.length - 1);
  return [...keep].sort((a, b) => a - b).map(i => pts[i]);
}

export function adaptiveRdp(pts: [number,number][]): [number,number][] {
  if (pts.length < 4) return pts;
  let perim = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    perim += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  // Lower epsilon = more corner points preserved. Reduced from [1.5, 6] to [0.5, 3] for better corner visibility
  const eps = Math.max(0.5, Math.min(3, perim / 400));
  return rdpSimplify(pts, eps);
}

export function polygonPerim(pts: [number,number][]): number {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    p += Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
  }
  return Math.round(p);
}

export function buildPolygonFromMask(mask: Uint8Array, w: number, h: number): [number,number][] {
  const outer = outerShape(mask, w, h);
  const raw   = marchingSquaresContour(outer, w, h);
  if (raw.length === 0) {
    let minX=w, minY=h, maxX=0, maxY=0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return [[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY]];
  }
  return adaptiveRdp(raw);
}

// ── Rect-select region finder ─────────────────────────────────────────────────

export function findRegionsInRect(
  mask: Uint8Array, w: number, h: number,
  rx1: number, ry1: number, rx2: number, ry2: number,
): Array<{ seed: [number,number]; filled: Uint8Array }> {
  const x1 = Math.max(0, Math.min(rx1, rx2));
  const y1 = Math.max(0, Math.min(ry1, ry2));
  const x2 = Math.min(w-1, Math.max(rx1, rx2));
  const y2 = Math.min(h-1, Math.max(ry1, ry2));
  const discovered: Array<{ seed: [number,number]; filled: Uint8Array }> = [];
  const seen = new Uint8Array(w * h);
  const step = Math.max(4, Math.round(Math.min(x2-x1, y2-y1) / 40));
  for (let sy = y1; sy <= y2; sy += step) {
    for (let sx = x1; sx <= x2; sx += step) {
      if (mask[sy*w+sx] || seen[sy*w+sx]) continue;
      const filled = multiSeedFill(mask, w, h, sx, sy);
      if (!filled) continue;
      let overlaps = false;
      for (let ty = y1; ty <= y2 && !overlaps; ty++)
        for (let tx = x1; tx <= x2 && !overlaps; tx++)
          if (filled[ty*w+tx]) overlaps = true;
      if (!overlaps) continue;
      for (let i = 0; i < filled.length; i++) if (filled[i]) seen[i] = 1;
      discovered.push({ seed: [sx, sy], filled });
    }
  }
  return discovered;
}

// ── SVG path utilities ────────────────────────────────────────────────────────

export function scaleSvgPath(d: string, s: number): string {
  return d.replace(/([MmLlHhVvCcSsQqTtAaZz])\s*/g, ' $1 ')
    .replace(/[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/g, (n) => String(parseFloat(n) * s));
}

export function svgElToAbsPath(el: SVGGraphicsElement, svgScale: number): string | null {
  const tag = el.tagName.toLowerCase();
  try {
    if (tag === 'rect') {
      const r = el as SVGRectElement;
      const x = r.x.baseVal.value * svgScale, y = r.y.baseVal.value * svgScale;
      const w = r.width.baseVal.value * svgScale, h = r.height.baseVal.value * svgScale;
      if (w <= 0 || h <= 0) return null;
      return `M${x},${y} H${x+w} V${y+h} H${x} Z`;
    }
    if (tag === 'circle') {
      const c = el as SVGCircleElement;
      const cx = c.cx.baseVal.value * svgScale, cy = c.cy.baseVal.value * svgScale;
      const r  = c.r.baseVal.value * svgScale;
      if (r <= 0) return null;
      return `M${cx-r},${cy} A${r},${r} 0 1 0 ${cx+r},${cy} A${r},${r} 0 1 0 ${cx-r},${cy} Z`;
    }
    if (tag === 'ellipse') {
      const e = el as SVGEllipseElement;
      const cx = e.cx.baseVal.value * svgScale, cy = e.cy.baseVal.value * svgScale;
      const rx = e.rx.baseVal.value * svgScale, ry = e.ry.baseVal.value * svgScale;
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx-rx},${cy} A${rx},${ry} 0 1 0 ${cx+rx},${cy} A${rx},${ry} 0 1 0 ${cx-rx},${cy} Z`;
    }
    if (tag === 'line') {
      const l = el as SVGLineElement;
      const x1 = l.x1.baseVal.value * svgScale, y1 = l.y1.baseVal.value * svgScale;
      const x2 = l.x2.baseVal.value * svgScale, y2 = l.y2.baseVal.value * svgScale;
      return `M${x1},${y1} L${x2},${y2}`;
    }
    if (tag === 'polyline' || tag === 'polygon') {
      const pts = (el as SVGPolylineElement).points;
      if (!pts || pts.length === 0) return null;
      let d = '';
      for (let i = 0; i < pts.length; i++) {
        const p = pts.getItem(i);
        d += (i === 0 ? 'M' : 'L') + (p.x * svgScale) + ',' + (p.y * svgScale) + ' ';
      }
      if (tag === 'polygon') d += 'Z';
      return d.trim();
    }
    if (tag === 'path') {
      const d = (el as SVGPathElement).getAttribute('d');
      if (!d) return null;
      return scaleSvgPath(d, svgScale);
    }
  } catch { return null; }
  return null;
}

export function extractSvgShapes(svgDoc: Document, scale: number): SvgShape[] {
  const SHAPE_TAGS = ['path','rect','polygon','polyline','circle','ellipse','line'];
  const shapes: SvgShape[] = [];
  const svgEl = svgDoc.querySelector('svg');
  if (!svgEl) return shapes;
  svgDoc.querySelectorAll(SHAPE_TAGS.join(',')).forEach(el => {
    const gEl = el as SVGGraphicsElement;
    const pathD = svgElToAbsPath(gEl, scale);
    if (!pathD) return;
    let bbox: DOMRect;
    try {
      const raw = gEl.getBBox();
      bbox = new DOMRect(raw.x * scale, raw.y * scale, raw.width * scale, raw.height * scale);
    } catch { return; }
    if (bbox.width < 2 || bbox.height < 2) return;
    shapes.push({ el: gEl, pathD, bbox, transform: new DOMMatrix(), area: bbox.width * bbox.height });
  });
  shapes.sort((a, b) => a.area - b.area);
  return shapes;
}

export function pointInPath2D(pathD: string, px: number, py: number, canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return ctx.isPointInPath(new Path2D(pathD), px, py, 'nonzero');
}

export function measureSvgPath(
  pathD: string,
  canvasW: number,
  canvasH: number,
): { areaPx: number; perimPx: number; polygon: [number,number][] } {
  const oc = document.createElement('canvas');
  oc.width  = canvasW;
  oc.height = canvasH;
  const ctx = oc.getContext('2d')!;
  ctx.fill(new Path2D(pathD));
  const id   = ctx.getImageData(0, 0, canvasW, canvasH);
  const mask = new Uint8Array(canvasW * canvasH);
  for (let i = 0; i < mask.length; i++) if (id.data[i * 4 + 3] > 10) mask[i] = 1;
  const areaPx  = maskArea(mask);
  const polygon = buildPolygonFromMask(mask, canvasW, canvasH);
  const perimPx = polygonPerim(polygon);
  return { areaPx, perimPx, polygon };
}

// ── Shared canvas mask builder ────────────────────────────────────────────────

export function buildMaskAsync(
  bc: HTMLCanvasElement,
  fc: HTMLCanvasElement,
  pc: HTMLCanvasElement | null,
  setLoadProgress: (s: string) => void,
  onDone: (mask: Uint8Array, fillData: ImageData, basePixels: Uint8ClampedArray) => void,
): void {
  const ctx = bc.getContext('2d')!;
  const id  = ctx.getImageData(0, 0, bc.width, bc.height);
  const w   = bc.width, h = bc.height;
  const step = (label: string, fn: () => void, next: () => void) => {
    setLoadProgress(label); setTimeout(() => { fn(); next(); }, 0);
  };
  step('Classifying stroke connectivity…', () => {}, () => {
    const raw = buildWallMask(id.data, w, h);
    step('Dilating mask…', () => {}, () => {
      const dilated = dilateMaskFast(raw, w, h, DILATE_R);
      step('Eroding mask…', () => {}, () => {
        const mask       = erodeMaskFast(dilated, w, h, ERODE_R);
        const fillData   = new ImageData(w, h);
        const basePixels = new Uint8ClampedArray(id.data);
        fc.width = w; fc.height = h;
        if (pc) { pc.width = w; pc.height = h; pc.getContext('2d')!.clearRect(0, 0, w, h); }
        onDone(mask, fillData, basePixels);
      });
    });
  });
}

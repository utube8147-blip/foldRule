// hooks/useSnapEngine/extractAllVectors.ts
//
// Extracts EVERY drawn element from a PDF page as structured vector data:
//   • Text glyphs  — each character with position, size, font
//   • Line segments — start/end x,y in normalised [0,1] coords
//   • Curves       — flattened to polyline points
//   • Filled shapes — polygon point arrays
//   • Rectangles   — as 4-point polygons
//
// WHITE SPACE FILTERING:
//   Elements whose stroke + fill are both white (or near-white, or fully
//   transparent) are skipped — these are background fills, not content.
//
// All coordinates are normalised to [0,1] relative to the page viewport
// so the output is zoom/scale independent.
//
// Usage:
//   const result = await extractAllVectors(pdfPage);
//   result.glyphs   → VectorGlyph[]
//   result.paths    → VectorPath[]
//   result.text     → VectorTextRun[]  (whole text items, not per-glyph)
//
// ─────────────────────────────────────────────────────────────────────────────

import type { PDFPageProxy } from 'pdfjs-dist';

// ─── Output types ─────────────────────────────────────────────────────────────

export interface VectorPoint {
  nx: number;  // normalised x [0,1]
  ny: number;  // normalised y [0,1]
  /** Raw PDF user-space coordinates (before normalisation) */
  x:  number;
  y:  number;
}

export type PathKind = 'line' | 'polyline' | 'curve' | 'rect' | 'polygon';

export interface VectorPath {
  kind:        PathKind;
  points:      VectorPoint[];   // 2 points for line, 4 for rect, N for polygon/polyline
  /** Stroke color as CSS hex string e.g. "#1a1a1a", or null if no stroke */
  strokeColor: string | null;
  /** Fill color as CSS hex string e.g. "#e0e0e0", or null if not filled */
  fillColor:   string | null;
  strokeWidth: number;          // PDF points
  isFilled:    boolean;
  isStroked:   boolean;
  /** Bounding box in normalised coords */
  bbox: { nx0: number; ny0: number; nx1: number; ny1: number };
}

export interface VectorGlyph {
  /** The character(s) rendered */
  char:        string;
  /** Glyph origin in normalised coords */
  nx:          number;
  ny:          number;
  /** Raw PDF coordinates */
  x:           number;
  y:           number;
  /** Font size in PDF points */
  fontSize:    number;
  /** Normalised font size (fontSize / pageHeight) */
  nFontSize:   number;
  /** Fill color (text color) as CSS hex */
  color:       string;
  fontName:    string;
  /** Glyph width in PDF points */
  width:       number;
  /** Normalised glyph width */
  nWidth:      number;
}

export interface VectorTextRun {
  /** Full string for this text item */
  text:       string;
  nx:         number;   // left edge, normalised
  ny:         number;   // baseline, normalised
  x:          number;
  y:          number;
  fontSize:   number;
  nFontSize:  number;
  color:      string;
  fontName:   string;
  /** Approximate bounding box */
  bbox: { nx0: number; ny0: number; nx1: number; ny1: number };
}

export interface ExtractAllVectorsResult {
  /** Individual characters with position */
  glyphs:    VectorGlyph[];
  /** All stroked/filled paths */
  paths:     VectorPath[];
  /** Text runs (whole items from PDF text layer) */
  textRuns:  VectorTextRun[];
  /** Page dimensions in PDF user-space units */
  pageWidth:  number;
  pageHeight: number;
  /** Total element counts before whitespace filtering */
  raw: {
    pathsTotal:   number;
    glyphsTotal:  number;
    skippedWhite: number;
  };
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
  const toHex = (v: number) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Clamp polyfill (Math.clamp not standard everywhere)
if (typeof (Math as any).clamp === 'undefined') {
  (Math as any).clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
}

function isWhiteOrTransparent(color: string | null, alpha = 1): boolean {
  if (!color || alpha <= 0) return true;
  // Pure white or near-white (all channels > 240/255 ≈ 0.94)
  if (color === '#ffffff' || color === '#fff') return true;
  const m = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return false;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return r >= 240 && g >= 240 && b >= 240;
}

function colorFromState(state: GraphicsState, useStroke: boolean): string | null {
  const c = useStroke ? state.strokeColor : state.fillColor;
  if (!c) return null;
  return rgbToHex(c[0], c[1], c[2]);
}

// ─── Graphics state machine ───────────────────────────────────────────────────

interface RGBColor { 0: number; 1: number; 2: number }

interface GraphicsState {
  ctm:         number[];     // current transformation matrix [a,b,c,d,e,f]
  strokeColor: RGBColor | null;
  fillColor:   RGBColor | null;
  strokeAlpha: number;
  fillAlpha:   number;
  lineWidth:   number;
  fontName:    string;
  fontSize:    number;
}

function defaultState(): GraphicsState {
  return {
    ctm:         [1, 0, 0, 1, 0, 0],
    strokeColor: [0, 0, 0],
    fillColor:   [0, 0, 0],
    strokeAlpha: 1,
    fillAlpha:   1,
    lineWidth:   1,
    fontName:    'unknown',
    fontSize:    12,
  };
}

function cloneState(s: GraphicsState): GraphicsState {
  return {
    ...s,
    ctm:         [...s.ctm],
    strokeColor: s.strokeColor
      ? (Array.isArray(s.strokeColor)
          ? ([...(s.strokeColor as any)] as unknown as RGBColor)
          : ({...(s.strokeColor as any)} as unknown as RGBColor))
      : null,
    fillColor: s.fillColor
      ? (Array.isArray(s.fillColor)
          ? ([...(s.fillColor as any)] as unknown as RGBColor)
          : ({...(s.fillColor as any)} as unknown as RGBColor))
      : null,
  };
}

/** Apply CTM to a PDF user-space point → canvas/page space */
function applyCtm(ctm: number[], x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = ctm;
  return [a * x + c * y + e, b * x + d * y + f];
}

/** Multiply two 6-element CTMs */
function multiplyCtm(m1: number[], m2: number[]): number[] {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

// ─── Bezier → polyline flattening ─────────────────────────────────────────────

function flattenCubic(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  tolerance = 0.5,
): Array<[number, number]> {
  // Recursively subdivide until flat enough
  const dx = x3 - x0, dy = y3 - y0;
  const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
  const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
  if ((d1 + d2) * (d1 + d2) <= tolerance * (dx * dx + dy * dy)) {
    return [[x3, y3]];
  }
  // De Casteljau midpoint split
  const mx01  = (x0 + x1) / 2,   my01  = (y0 + y1) / 2;
  const mx12  = (x1 + x2) / 2,   my12  = (y1 + y2) / 2;
  const mx23  = (x2 + x3) / 2,   my23  = (y2 + y3) / 2;
  const mx012 = (mx01 + mx12) / 2, my012 = (my01 + my12) / 2;
  const mx123 = (mx12 + mx23) / 2, my123 = (my12 + my23) / 2;
  const mx    = (mx012 + mx123) / 2, my = (my012 + my123) / 2;
  return [
    ...flattenCubic(x0, y0, mx01, my01, mx012, my012, mx, my, tolerance),
    ...flattenCubic(mx, my, mx123, my123, mx23, my23, x3, y3, tolerance),
  ];
}

// ─── Bounding box helper ──────────────────────────────────────────────────────

function bbox(points: VectorPoint[]): { nx0: number; ny0: number; nx1: number; ny1: number } {
  let nx0 = Infinity, ny0 = Infinity, nx1 = -Infinity, ny1 = -Infinity;
  for (const p of points) {
    if (p.nx < nx0) nx0 = p.nx;
    if (p.ny < ny0) ny0 = p.ny;
    if (p.nx > nx1) nx1 = p.nx;
    if (p.ny > ny1) ny1 = p.ny;
  }
  return { nx0, ny0, nx1, ny1 };
}

// ─── Main extractor ───────────────────────────────────────────────────────────

export async function extractAllVectors(
  page: PDFPageProxy,
): Promise<ExtractAllVectorsResult> {

  const viewport  = page.getViewport({ scale: 1 });
  const pageW     = viewport.width;
  const pageH     = viewport.height;

  // PDF y-axis is bottom-up; we flip to top-down for screen coords
  const norm = (x: number, y: number): VectorPoint => ({
    nx: x / pageW,
    ny: 1 - y / pageH,   // flip Y
    x,
    y,
  });

  // ── Fetch operator list ───────────────────────────────────────────────────
  const opList = await page.getOperatorList();
  const ops    = opList.fnArray;
  const args   = opList.argsArray;

  // ── Fetch text content (for text runs) ───────────────────────────────────
  const textContent = await page.getTextContent();

  // ── State ─────────────────────────────────────────────────────────────────
  const stateStack: GraphicsState[] = [];
  let state = defaultState();

  // Current path being built
  let pathPoints:   Array<[number, number]> = [];
  let subpathStart: [number, number] | null = null;
  let currentPoint: [number, number] | null = null;

  const paths:    VectorPath[]    = [];
  const glyphs:   VectorGlyph[]   = [];

  let rawPathsTotal  = 0;
  let rawGlyphsTotal = 0;
  let skippedWhite   = 0;

  // ── Helper: flush current subpath as VectorPath ───────────────────────────
  function flushPath(
    points:    Array<[number, number]>,
    isFilled:  boolean,
    isStroked: boolean,
    closePath: boolean,
  ) {
    if (points.length < 2) return;
    rawPathsTotal++;

    const strokeColor = isStroked ? colorFromState(state, true)  : null;
    const fillColor   = isFilled  ? colorFromState(state, false) : null;

    // Skip if both stroke and fill are white/transparent
    const strokeWhite = isWhiteOrTransparent(strokeColor, state.strokeAlpha);
    const fillWhite   = isWhiteOrTransparent(fillColor,   state.fillAlpha);
    if (strokeWhite && fillWhite) { skippedWhite++; return; }
    // Skip if stroke is white and there's no fill
    if (!isFilled && strokeWhite) { skippedWhite++; return; }

    if (closePath && points.length > 2) {
      points.push(points[0]); // close the loop
    }

    const vPoints = points.map(([x, y]) => {
      const [px, py] = applyCtm(state.ctm, x, y);
      return norm(px, py);
    });

    const kind: PathKind =
      points.length === 2 ? 'line' :
      isFilled            ? 'polygon' :
                            'polyline';

    paths.push({
      kind,
      points:      vPoints,
      strokeColor: strokeWhite ? null : strokeColor,
      fillColor:   fillWhite   ? null : fillColor,
      strokeWidth: state.lineWidth,
      isFilled,
      isStroked,
      bbox:        bbox(vPoints),
    });
  }

  // ── PDF.js operator constants (from pdf.js source) ────────────────────────
  // We check op names via the OPS object if available, otherwise use numbers
  // The safest way is to import OPS from pdfjs-dist
  let OPS: Record<string, number>;
  try {
    const pdfjs = await import('pdfjs-dist');
    OPS = (pdfjs as any).OPS ?? {};
  } catch {
    OPS = {};
  }

  // Fallback numeric op codes (stable across pdf.js versions)
  const OP = {
    // Graphics state
    save:              OPS.save              ?? 14,
    restore:           OPS.restore           ?? 15,
    transform:         OPS.transform         ?? 12,
    setLineWidth:      OPS.setLineWidth      ?? 27,
    // Color
    setStrokeColorN:   OPS.setStrokeColorN   ?? 69,
    setFillColorN:     OPS.setFillColorN     ?? 70,
    setStrokeColor:    OPS.setStrokeColor    ?? 65,
    setFillColor:      OPS.setFillColor      ?? 66,
    setStrokeRGBColor: OPS.setStrokeRGBColor ?? 67,
    setFillRGBColor:   OPS.setFillRGBColor   ?? 68,
    setStrokeGray:     OPS.setStrokeGray     ?? 61,
    setFillGray:       OPS.setFillGray       ?? 62,
    // Path construction
    moveTo:            OPS.moveTo            ?? 17,
    lineTo:            OPS.lineTo            ?? 18,
    curveTo:           OPS.curveTo           ?? 19,
    curveTo2:          OPS.curveTo2          ?? 20,
    curveTo3:          OPS.curveTo3          ?? 21,
    closePath:         OPS.closePath         ?? 22,
    rectangle:         OPS.rectangle         ?? 23,
    // Path painting
    stroke:            OPS.stroke            ?? 24,
    closeStroke:       OPS.closeStroke       ?? 25,
    fill:              OPS.fill              ?? 26,
    eoFill:            OPS.eoFill            ?? 37,
    fillStroke:        OPS.fillStroke        ?? 38,
    eoFillStroke:      OPS.eoFillStroke      ?? 39,
    closeFillStroke:   OPS.closeFillStroke   ?? 40,
    endPath:           OPS.endPath           ?? 41,
    // Text
    setFont:           OPS.setFont           ?? 77,
    showText:          OPS.showText          ?? 79,
    showSpacedText:    OPS.showSpacedText     ?? 80,
    nextLine:          OPS.nextLine          ?? 90,
    setTextMatrix:     OPS.setTextMatrix     ?? 88,
    // Alpha
    setGState:         OPS.setGState         ?? 57,
  } as const;

  // Text matrix state
  let textMatrix: number[] = [1, 0, 0, 1, 0, 0];

  // ── Walk operator list ────────────────────────────────────────────────────
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const a  = args[i] as any[];

    // ── Graphics state ──────────────────────────────────────────────────────
    if (op === OP.save) {
      stateStack.push(cloneState(state));

    } else if (op === OP.restore) {
      if (stateStack.length > 0) state = stateStack.pop()!;

    } else if (op === OP.transform) {
      // cm operator: concatenate matrix
      state.ctm = multiplyCtm(state.ctm, a as number[]);

    } else if (op === OP.setLineWidth) {
      state.lineWidth = a[0] as number;

    // ── Color operators ─────────────────────────────────────────────────────
    } else if (op === OP.setStrokeRGBColor) {
      state.strokeColor = [a[0], a[1], a[2]];

    } else if (op === OP.setFillRGBColor) {
      state.fillColor = [a[0], a[1], a[2]];

    } else if (op === OP.setStrokeGray) {
      const g = a[0] as number;
      state.strokeColor = [g, g, g];

    } else if (op === OP.setFillGray) {
      const g = a[0] as number;
      state.fillColor = [g, g, g];

    } else if (op === OP.setStrokeColor || op === OP.setStrokeColorN) {
      if (a.length >= 3) state.strokeColor = [a[0], a[1], a[2]];
      else if (a.length === 1) { const g = a[0]; state.strokeColor = [g, g, g]; }

    } else if (op === OP.setFillColor || op === OP.setFillColorN) {
      if (a.length >= 3) state.fillColor = [a[0], a[1], a[2]];
      else if (a.length === 1) { const g = a[0]; state.fillColor = [g, g, g]; }

    } else if (op === OP.setGState) {
      // Extended graphics state — extract alpha values
      const gstate = a[1] as Record<string, unknown> | undefined;
      if (gstate) {
        if (typeof gstate.ca === 'number') state.fillAlpha   = gstate.ca;
        if (typeof gstate.CA === 'number') state.strokeAlpha = gstate.CA;
      }

    // ── Path construction ───────────────────────────────────────────────────
    } else if (op === OP.moveTo) {
      currentPoint  = [a[0], a[1]];
      subpathStart  = [a[0], a[1]];
      pathPoints    = [[a[0], a[1]]];

    } else if (op === OP.lineTo) {
      if (currentPoint) {
        if (pathPoints.length === 0) pathPoints.push(currentPoint);
        pathPoints.push([a[0], a[1]]);
        currentPoint = [a[0], a[1]];
      }

    } else if (op === OP.curveTo) {
      // Cubic bezier: x1,y1,x2,y2,x3,y3
      if (currentPoint) {
        const flat = flattenCubic(
          currentPoint[0], currentPoint[1],
          a[0], a[1], a[2], a[3], a[4], a[5],
        );
        pathPoints.push(...flat);
        currentPoint = [a[4], a[5]];
      }

    } else if (op === OP.curveTo2) {
      // v operator: current point = cp1
      if (currentPoint) {
        const flat = flattenCubic(
          currentPoint[0], currentPoint[1],
          currentPoint[0], currentPoint[1],
          a[0], a[1], a[2], a[3],
        );
        pathPoints.push(...flat);
        currentPoint = [a[2], a[3]];
      }

    } else if (op === OP.curveTo3) {
      // y operator: cp2 = end point
      if (currentPoint) {
        const flat = flattenCubic(
          currentPoint[0], currentPoint[1],
          a[0], a[1], a[2], a[3], a[2], a[3],
        );
        pathPoints.push(...flat);
        currentPoint = [a[2], a[3]];
      }

    } else if (op === OP.closePath) {
      if (subpathStart && currentPoint) {
        pathPoints.push(subpathStart);
        currentPoint = subpathStart;
      }

    } else if (op === OP.rectangle) {
      // x, y, w, h — builds closed rect path
      const [rx, ry, rw, rh] = a as number[];
      pathPoints = [
        [rx,      ry],
        [rx + rw, ry],
        [rx + rw, ry + rh],
        [rx,      ry + rh],
        [rx,      ry],
      ];
      currentPoint = [rx, ry];
      subpathStart = [rx, ry];

    // ── Path painting ───────────────────────────────────────────────────────
    } else if (op === OP.stroke) {
      flushPath(pathPoints, false, true, false);
      pathPoints = []; currentPoint = null;

    } else if (op === OP.closeStroke) {
      flushPath(pathPoints, false, true, true);
      pathPoints = []; currentPoint = null;

    } else if (op === OP.fill || op === OP.eoFill) {
      flushPath(pathPoints, true, false, true);
      pathPoints = []; currentPoint = null;

    } else if (op === OP.fillStroke || op === OP.eoFillStroke) {
      flushPath(pathPoints, true, true, true);
      pathPoints = []; currentPoint = null;

    } else if (op === OP.closeFillStroke) {
      flushPath(pathPoints, true, true, true);
      pathPoints = []; currentPoint = null;

    } else if (op === OP.endPath) {
      // n operator: clipping path, discard without painting
      pathPoints = []; currentPoint = null;

    // ── Text ────────────────────────────────────────────────────────────────
    } else if (op === OP.setFont) {
      state.fontName = String(a[0] ?? 'unknown');
      state.fontSize = Number(a[1] ?? 12);

    } else if (op === OP.setTextMatrix) {
      // Tm operator: set text + line matrix
      textMatrix = a as number[];

    } else if (op === OP.showText || op === OP.showSpacedText) {
      // Extract individual glyphs from the glyph array
      // PDF.js represents showText args as arrays of glyph objects
      rawGlyphsTotal++;
      const textColor = colorFromState(state, false) ?? '#000000';
      if (isWhiteOrTransparent(textColor, state.fillAlpha)) {
        skippedWhite++;
        continue;
      }

      // Text position from text matrix + CTM
      const combinedMatrix = multiplyCtm(state.ctm, textMatrix);
      const [tx, ty] = applyCtm(combinedMatrix, 0, 0);
      const nFontSize = state.fontSize / pageH;

      // showText args[0] is an array of glyph objects { unicode, width } or spacing numbers
      const items = Array.isArray(a[0]) ? a[0] : [];
      let xOffset = 0;

      for (const item of items) {
        if (typeof item === 'number') {
          // Kerning/spacing adjustment (in thousandths of text space unit)
          xOffset -= (item / 1000) * state.fontSize;
          continue;
        }

        if (item && typeof item === 'object') {
          const ch    = (item.unicode as string) ?? '';
          const gw    = (item.width   as number) ?? 0;

          if (ch && ch.trim().length > 0) {
            // Compute glyph position accounting for xOffset in text space
            const [gx, gy] = applyCtm(combinedMatrix, xOffset, 0);
            const pt        = norm(gx, gy);
            const nw        = (gw * state.fontSize) / pageW;

            glyphs.push({
              char:     ch,
              nx:       pt.nx,
              ny:       pt.ny,
              x:        gx,
              y:        gy,
              fontSize: state.fontSize,
              nFontSize,
              color:    textColor,
              fontName: state.fontName,
              width:    gw * state.fontSize,
              nWidth:   nw,
            });
          }

          xOffset += (gw * state.fontSize);
        }
      }
    }
  }

  // ── Text runs from text content layer ────────────────────────────────────
  // This gives us cleaner text runs (whole words/phrases) with accurate
  // bounding boxes from PDF.js's own text extraction pipeline.
  const textRuns: VectorTextRun[] = [];

  for (const item of textContent.items as any[]) {
    if (!item.str || !item.str.trim()) continue;

    const tx = item.transform[4] as number;
    const ty = item.transform[5] as number;
    const fs = Math.abs(item.transform[3] as number) || item.height || 12;

    const pt      = norm(tx, ty);
    const nFs     = fs / pageH;
    const approxW = (item.width as number) ?? (item.str.length * fs * 0.6);
    const nW      = approxW / pageW;
    const nH      = fs / pageH;

    // Color from fill state at time of text — approximate with black default
    // (text layer doesn't carry color; use black as safe default)
    const color = '#1a1a1a';

    textRuns.push({
      text:      item.str as string,
      nx:        pt.nx,
      ny:        pt.ny,
      x:         tx,
      y:         ty,
      fontSize:  fs,
      nFontSize: nFs,
      color,
      fontName:  (item.fontName as string) ?? 'unknown',
      bbox: {
        nx0: pt.nx,
        ny0: pt.ny - nH,
        nx1: pt.nx + nW,
        ny1: pt.ny,
      },
    });
  }

  console.log(
    `[extractAllVectors] paths=${paths.length}/${rawPathsTotal} glyphs=${glyphs.length}/${rawGlyphsTotal} textRuns=${textRuns.length} skipped=${skippedWhite}`,
  );

  return {
    glyphs,
    paths,
    textRuns,
    pageWidth:  pageW,
    pageHeight: pageH,
    raw: {
      pathsTotal:   rawPathsTotal,
      glyphsTotal:  rawGlyphsTotal,
      skippedWhite,
    },
  };
}

// ─── JSON export helper ───────────────────────────────────────────────────────
// Serialises the result to a clean JSON structure suitable for saving,
// sending to a server, or importing into CAD/GIS tools.

export function vectorsToJson(result: ExtractAllVectorsResult): string {
  return JSON.stringify({
    meta: {
      pageWidth:    result.pageWidth,
      pageHeight:   result.pageHeight,
      totalPaths:   result.paths.length,
      totalGlyphs:  result.glyphs.length,
      totalTextRuns:result.textRuns.length,
      skippedWhite: result.raw.skippedWhite,
    },
    paths:    result.paths.map(p => ({
      kind:        p.kind,
      strokeColor: p.strokeColor,
      fillColor:   p.fillColor,
      strokeWidth: p.strokeWidth,
      isFilled:    p.isFilled,
      isStroked:   p.isStroked,
      bbox:        p.bbox,
      // Emit normalised points only for a compact output
      points: p.points.map(pt => ({ nx: +pt.nx.toFixed(6), ny: +pt.ny.toFixed(6) })),
    })),
    textRuns: result.textRuns.map(t => ({
      text:      t.text,
      nx:        +t.nx.toFixed(6),
      ny:        +t.ny.toFixed(6),
      fontSize:  +t.nFontSize.toFixed(6),
      fontName:  t.fontName,
      bbox:      {
        nx0: +t.bbox.nx0.toFixed(6),
        ny0: +t.bbox.ny0.toFixed(6),
        nx1: +t.bbox.nx1.toFixed(6),
        ny1: +t.bbox.ny1.toFixed(6),
      },
    })),
    glyphs: result.glyphs.map(g => ({
      char:     g.char,
      nx:       +g.nx.toFixed(6),
      ny:       +g.ny.toFixed(6),
      fontSize: +g.nFontSize.toFixed(6),
      color:    g.color,
    })),
  }, null, 2);
}

// ─── SVG export helper ────────────────────────────────────────────────────────
// Renders the extracted vectors back as a standalone SVG for visual debugging.
// Open in browser to verify coordinates look right.

export function vectorsToSvg(
  result: ExtractAllVectorsResult,
  svgWidth  = 800,
  svgHeight?: number,
): string {
  const aspect = result.pageHeight / result.pageWidth;
  const H      = svgHeight ?? Math.round(svgWidth * aspect);
  const W      = svgWidth;

  const pathEls = result.paths.map(p => {
    const pts = p.points.map(pt => `${(pt.nx * W).toFixed(2)},${(pt.ny * H).toFixed(2)}`).join(' ');
    const d   = p.points.map((pt, i) =>
      `${i === 0 ? 'M' : 'L'}${(pt.nx * W).toFixed(2)} ${(pt.ny * H).toFixed(2)}`
    ).join(' ') + (p.isFilled ? ' Z' : '');

    const stroke = p.strokeColor ?? 'none';
    const fill   = p.fillColor   ?? 'none';
    const sw     = Math.max(0.5, p.strokeWidth * (W / result.pageWidth));

    return `<path d="${d}" stroke="${stroke}" fill="${fill}" stroke-width="${sw.toFixed(2)}" />`;
  });

  const textEls = result.textRuns.map(t => {
    const x  = (t.nx * W).toFixed(2);
    const y  = (t.ny * H).toFixed(2);
    const fs = Math.max(6, t.nFontSize * H).toFixed(2);
    const txt = t.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<text x="${x}" y="${y}" font-size="${fs}" fill="${t.color}" font-family="monospace">${txt}</text>`;
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<rect width="${W}" height="${H}" fill="white"/>`,
    ...pathEls,
    ...textEls,
    '</svg>',
  ].join('\n');
}
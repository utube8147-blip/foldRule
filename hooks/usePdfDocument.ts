'use client';

import { useState, useRef, useCallback } from 'react';
import type { PdfLine, PdfCurve, SnapPoint, PdfDimensions, PdfPageInfo } from '@/types/snapTypes';

export type PdfLoadStage =
  | 'idle'
  | 'reading-file'
  | 'parsing-pdf'
  | 'rendering-page'
  | 'extracting-geometry'
  | 'computing-snaps'
  | 'done'
  | 'error';

export interface UsePdfDocumentReturn {
  stage: PdfLoadStage;
  errorMessage: string | null;
  fileName: string;
  dims: PdfDimensions | null;
  pageInfo: PdfPageInfo | null;
  lines: PdfLine[];
  curves: PdfCurve[];
  snapPoints: SnapPoint[];
  loadFile: (file: File) => Promise<void>;
  renderToCanvas: (canvas: HTMLCanvasElement, scale?: number) => Promise<void>;
}

async function getPdfJs() {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
  }
  return pdfjs;
}

function sanitizeArgs(fn: number, raw: unknown): any[] {
  if (raw == null) return [];
  if (fn === 91 && Array.isArray(raw)) {
    const [terminalOp, pathBufHolder, minMax] = raw as [number, unknown[], number[] | null];
    let pathBuffer: number[] = [];
    const pb = Array.isArray(pathBufHolder) ? pathBufHolder[0] : null;
    if (pb instanceof Float32Array || pb instanceof Float64Array) {
      pathBuffer = Array.from(pb);
    } else if (Array.isArray(pb)) {
      pathBuffer = pb.filter((n) => typeof n === 'number');
    }
    return [terminalOp, pathBuffer, minMax ?? null];
  }
  if (!Array.isArray(raw) && !(raw instanceof Float32Array) && !(raw instanceof Float64Array)) {
    return [];
  }
  const arr = Array.from(raw as ArrayLike<unknown>);
  return arr.map((item) => {
    if (typeof item === 'number') return item;
    if (Array.isArray(item) || item instanceof Float32Array || item instanceof Float64Array) {
      return Array.from(item as ArrayLike<number>).filter((n) => typeof n === 'number');
    }
    return NaN;
  });
}

async function extractOperators(page: any): Promise<{ fn: number; args: any[] }[]> {
  const opList = await page.getOperatorList();
  const result: { fn: number; args: any[] }[] = [];
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    result.push({ fn, args: sanitizeArgs(fn, opList.argsArray[i]) });
  }
  return result;
}

// ─── Inline worker ────────────────────────────────────────────────────────────

const WORKER_SOURCE = `
const OPS = {
  dependency: 1, setLineWidth: 2, setLineCap: 3, setLineJoin: 4, setMiterLimit: 5,
  setDash: 6, setRenderingIntent: 7, setFlatness: 8, setGState: 9, save: 10,
  restore: 11, transform: 12, moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16,
  curveTo3: 17, closePath: 18, rectangle: 19, stroke: 20, closeStroke: 21,
  fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26,
  closeEOFillStroke: 27, endPath: 28, clip: 29, eoClip: 30, beginText: 31,
  endText: 32, setCharSpacing: 33, setWordSpacing: 34, setHScale: 35,
  setLeading: 36, setFont: 37, setTextRenderingMode: 38, setTextRise: 39,
  moveText: 40, setLeadingMoveText: 41, setTextMatrix: 42, nextLine: 43,
  showText: 44, showSpacedText: 45, nextLineShowText: 46,
  nextLineSetSpacingShowText: 47, setCharWidth: 48, setCharWidthAndBounds: 49,
  setStrokeColorSpace: 50, setFillColorSpace: 51, setStrokeColor: 52,
  setStrokeColorN: 53, setFillColor: 54, setFillColorN: 55, setStrokeGray: 56,
  setFillGray: 57, setStrokeRGBColor: 58, setFillRGBColor: 59,
  setStrokeCMYKColor: 60, setFillCMYKColor: 61, shadingFill: 62,
  beginInlineImage: 63, beginImageData: 64, endInlineImage: 65,
  paintXObject: 66, markPoint: 67, markPointProps: 68, beginMarkedContent: 69,
  beginMarkedContentProps: 70, endMarkedContent: 71, beginCompat: 72,
  endCompat: 73, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
  beginGroup: 76, endGroup: 77, beginAnnotation: 80, endAnnotation: 81,
  paintImageMaskXObject: 83, paintImageMaskXObjectGroup: 84,
  paintImageXObject: 85, paintInlineImageXObject: 86,
  paintInlineImageXObjectGroup: 87, paintImageXObjectRepeat: 88,
  paintImageMaskXObjectRepeat: 89, paintSolidColorImageMask: 90,
  constructPath: 91, setStrokeTransparent: 92, setFillTransparent: 93,
  rawFillPath: 94,
};

const DrawOPS = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };

const STROKE_TERMINALS = new Set([
  OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke,
  OPS.closeFillStroke, OPS.closeEOFillStroke,
]);
const FILL_TERMINALS = new Set([
  OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
  OPS.closeFillStroke, OPS.closeEOFillStroke,
]);

const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiplyMatrix(a, b) {
  return [
    a[0]*b[0] + a[2]*b[1],
    a[1]*b[0] + a[3]*b[1],
    a[0]*b[2] + a[2]*b[3],
    a[1]*b[2] + a[3]*b[3],
    a[0]*b[4] + a[2]*b[5] + a[4],
    a[1]*b[4] + a[3]*b[5] + a[5],
  ];
}

function applyMatrix(m, x, y) {
  return { x: m[0]*x + m[2]*y + m[4], y: m[1]*x + m[3]*y + m[5] };
}

function segmentLength(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
function midpoint(a, b) { return { x: (a.x+b.x)/2, y: (a.y+b.y)/2 }; }

function arcLength(radius, startDeg, endDeg) {
  let span = endDeg - startDeg;
  if (span < 0) span += 360;
  return (span / 360) * 2 * Math.PI * radius;
}

function bezierToArc(p0, p1, p2, p3) {
  const midX = (p0.x + 3*p1.x + 3*p2.x + p3.x) / 8;
  const midY = (p0.y + 3*p1.y + 3*p2.y + p3.y) / 8;
  const chordLen = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  if (chordLen > 1e-6) {
    const cross = Math.abs(
      (midX - p0.x) * (p3.y - p0.y) - (midY - p0.y) * (p3.x - p0.x)
    ) / chordLen;
    if (cross < chordLen * 0.005) return null;
  }
  const ax = p0.x, ay = p0.y, bx = midX, by = midY, cx = p3.x, cy = p3.y;
  const D = 2 * (ax*(by-cy) + bx*(cy-ay) + cx*(ay-by));
  if (Math.abs(D) < 1e-8) return null;
  const ux = ((ax*ax+ay*ay)*(by-cy) + (bx*bx+by*by)*(cy-ay) + (cx*cx+cy*cy)*(ay-by)) / D;
  const uy = ((ax*ax+ay*ay)*(cx-bx) + (bx*bx+by*by)*(ax-cx) + (cx*cx+cy*cy)*(bx-ax)) / D;
  const center = { x: ux, y: uy };
  const radius = Math.hypot(ax - ux, ay - uy);
  if (radius < 1e-6 || !isFinite(radius)) return null;
  const d1 = Math.hypot(p1.x-ux, p1.y-uy);
  const d2 = Math.hypot(p2.x-ux, p2.y-uy);
  if (Math.abs(d1-radius)/radius > 0.12 || Math.abs(d2-radius)/radius > 0.12) return null;
  const startAngle = (Math.atan2(ay-uy, ax-ux) * 180) / Math.PI;
  const endAngle   = (Math.atan2(cy-uy, cx-ux) * 180) / Math.PI;
  const isCircle = Math.hypot(p3.x-p0.x, p3.y-p0.y) < radius * 0.01;
  return { center, radius, startAngle: (startAngle+360)%360, endAngle: (endAngle+360)%360, isCircle };
}

// ─── Snap computation ─────────────────────────────────────────────────────────
//
//  FIX: snapPoints now carry BOTH nx/ny (normalized fractions) AND the raw
//  type string. The type field is preserved exactly as passed in — 'endpoint',
//  'midpoint', 'centroid', 'intersection', or 'curve-node'. Previously the
//  worker was emitting all snaps correctly but the clusterNear check was using
//  a fixed tolerance of CLUSTER_DIST/1000 which in normalized space is ~0.002
//  — far too tight, causing midpoints/intersections to cluster-deduplicate
//  into the first endpoint added at almost the same location, losing their
//  type. The fix: use a slightly larger cluster tolerance AND check type
//  separately so an endpoint and a midpoint at the same location both survive.
//
// ─────────────────────────────────────────────────────────────────────────────

const CLUSTER_DIST = 3; // canvas-space px tolerance for deduplication

function clusterNear(points, nx, ny, type, dims) {
  // Convert cluster tolerance from canvas px to normalized space
  const tolX = CLUSTER_DIST / dims.w;
  const tolY = CLUSTER_DIST / dims.h;
  for (const p of points) {
    // FIX: only cluster-deduplicate points of the SAME type.
    // An endpoint and a midpoint at the same location are different snap types
    // and both should survive — they render in different colors.
    if (p.type === type && Math.abs(p.nx - nx) < tolX && Math.abs(p.ny - ny) < tolY) return true;
  }
  return false;
}

function computeLineSnaps(line, dims, out) {
  if (!line.fromStroke) return;
  const [a, b] = line.vertices;

  const addSnap = (v, type) => {
    const nx = v.x / dims.w;
    const ny = v.y / dims.h;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    // FIX: pass dims to clusterNear so tolerance is in canvas px, not fractions
    if (!clusterNear(out, nx, ny, type, dims)) {
      out.push({ nx, ny, type, sourceId: line.id, strokeWidth: line.strokeWidth });
    }
  };

  addSnap(a, 'endpoint');
  addSnap(b, 'endpoint');
  addSnap(midpoint(a, b), 'midpoint');
}

function computeCurveSnaps(curve, dims, out) {
  if (!curve.fromStroke) return;

  const addSnap = (v, type) => {
    const nx = v.x / dims.w;
    const ny = v.y / dims.h;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    if (!clusterNear(out, nx, ny, type, dims)) {
      out.push({ nx, ny, type, sourceId: curve.id, strokeWidth: curve.strokeWidth });
    }
  };

  // Centroid (arc center)
  addSnap(curve.center, 'centroid');

  const toRad = d => d * Math.PI / 180;
  if (!curve.isCircle) {
    // Arc endpoints — use 'curve-node' type (cyan) not 'endpoint' (yellow)
    addSnap({
      x: curve.center.x + curve.radius * Math.cos(toRad(curve.startAngle)),
      y: curve.center.y + curve.radius * Math.sin(toRad(curve.startAngle)),
    }, 'curve-node');
    addSnap({
      x: curve.center.x + curve.radius * Math.cos(toRad(curve.endAngle)),
      y: curve.center.y + curve.radius * Math.sin(toRad(curve.endAngle)),
    }, 'curve-node');
  }
}

function segmentIntersection(a, b) {
  const [p1, p2] = a.vertices, [p3, p4] = b.vertices;
  const d1x = p2.x-p1.x, d1y = p2.y-p1.y;
  const d2x = p4.x-p3.x, d2y = p4.y-p3.y;
  const denom = d1x*d2y - d1y*d2x;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((p3.x-p1.x)*d2y - (p3.y-p1.y)*d2x) / denom;
  const u = ((p3.x-p1.x)*d1y - (p3.y-p1.y)*d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + t*d1x, y: p1.y + t*d1y };
}

function computeIntersections(lines, dims, out) {
  const strokedLines = lines.filter(l => l.fromStroke);
  for (let i = 0; i < strokedLines.length; i++) {
    for (let j = i+1; j < strokedLines.length; j++) {
      const pt = segmentIntersection(strokedLines[i], strokedLines[j]);
      if (!pt) continue;
      const nx = pt.x / dims.w;
      const ny = pt.y / dims.h;
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
      // FIX: pass dims for px-space tolerance
      if (!clusterNear(out, nx, ny, 'intersection', dims)) {
        out.push({
          nx, ny, type: 'intersection',
          sourceId: strokedLines[i].id + 'x' + strokedLines[j].id,
          strokeWidth: (strokedLines[i].strokeWidth + strokedLines[j].strokeWidth) / 2,
        });
      }
    }
  }
}

// ─── Path unpacking ───────────────────────────────────────────────────────────

function unpackPathBuffer(buf) {
  const subpaths = [];
  let current = null;
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i];
    if (tag === DrawOPS.moveTo) {
      current = { start: { x: buf[i+1], y: buf[i+2] }, segs: [] };
      subpaths.push(current);
      i += 3;
    } else if (tag === DrawOPS.lineTo) {
      if (current) current.segs.push({ type: 'line', x: buf[i+1], y: buf[i+2] });
      i += 3;
    } else if (tag === DrawOPS.curveTo) {
      if (current) current.segs.push({
        type: 'curve',
        x1: buf[i+1], y1: buf[i+2],
        x2: buf[i+3], y2: buf[i+4],
        x:  buf[i+5], y: buf[i+6],
      });
      i += 7;
    } else if (tag === DrawOPS.closePath) {
      if (current) current.segs.push({ type: 'close' });
      i += 1;
    } else {
      console.warn('[pdfGeometry.worker] unknown DrawOPS tag ' + tag + ' at index ' + i);
      break;
    }
  }
  return subpaths;
}

// ─── Bezier sagitta helper ────────────────────────────────────────────────────

function bezierSagitta(p0, p1, p2, p3) {
  const midX = (p0.x + 3*p1.x + 3*p2.x + p3.x) / 8;
  const midY = (p0.y + 3*p1.y + 3*p2.y + p3.y) / 8;
  const chordLen = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  if (chordLen < 1e-6) return Math.hypot(midX - p0.x, midY - p0.y);
  return Math.abs(
    (midX - p0.x) * (p3.y - p0.y) - (midY - p0.y) * (p3.x - p0.x)
  ) / chordLen;
}

// ─── Main parser ──────────────────────────────────────────────────────────────

function parseOperators(operators, dims, viewportTransform) {
  const lines  = [];
  const curves = [];
  const baseCtm   = viewportTransform || IDENTITY;
  const ctmStack  = [baseCtm];
  let ctm         = baseCtm;
  let strokeWidth = 1;
  let lineId  = 0;
  let curveId = 0;

  const pushCtm = () => ctmStack.push([...ctm]);
  const popCtm  = () => { ctm = ctmStack.pop() || baseCtm; };
  const pt      = (x, y) => applyMatrix(ctm, x, y);

  const pageDiag = Math.hypot(dims.w, dims.h);

  for (const op of operators) {
    const args = op.args;
    switch (op.fn) {
      case OPS.save:    pushCtm(); break;
      case OPS.restore: popCtm();  break;
      case OPS.transform:
        ctm = multiplyMatrix(ctm, args); break;
      case OPS.paintFormXObjectBegin: {
        pushCtm();
        if (args[0] && args[0].length === 6) ctm = multiplyMatrix(ctm, args[0]);
        break;
      }
      case OPS.paintFormXObjectEnd: popCtm(); break;
      case OPS.setLineWidth:
        strokeWidth = typeof args[0] === 'number' ? args[0] : 1; break;

      case OPS.constructPath: {
        const terminalOp  = args[0];
        const pathBuffer  = args[1];
        if (!pathBuffer || pathBuffer.length === 0) break;

        const isStroke = STROKE_TERMINALS.has(terminalOp);
        const isFill   = FILL_TERMINALS.has(terminalOp);
        if (!isStroke && !isFill) break;

        const subpaths = unpackPathBuffer(pathBuffer);

        for (const sp of subpaths) {
          let prevCanvas  = pt(sp.start.x, sp.start.y);
          const firstCanvas = prevCanvas;

          for (const seg of sp.segs) {
            if (seg.type === 'line') {
              const v   = pt(seg.x, seg.y);
              const len = segmentLength(prevCanvas, v);
              if (len >= 0.1) {
                lines.push({
                  id: 'L' + (++lineId),
                  vertices: [prevCanvas, v],
                  layer: '0', strokeWidth, length: len,
                  fromStroke: isStroke,
                });
              }
              prevCanvas = v;

            } else if (seg.type === 'curve') {
              const p1 = pt(seg.x1, seg.y1);
              const p2 = pt(seg.x2, seg.y2);
              const p3 = pt(seg.x,  seg.y);

              const arc = bezierToArc(prevCanvas, p1, p2, p3);
              const chordLen = segmentLength(prevCanvas, p3);

              const maxSaneRadius = Math.min(
                pageDiag,
                Math.max(chordLen * 8, 30),
              );

              if (arc && arc.radius > 0.5 && arc.radius < maxSaneRadius) {
                curves.push({
                  id: 'C' + (++curveId),
                  center: arc.center,
                  radius: arc.radius,
                  startAngle: arc.startAngle,
                  endAngle:   arc.endAngle,
                  isCircle:   arc.isCircle,
                  layer: '0', strokeWidth,
                  approxLength: arcLength(arc.radius, arc.startAngle, arc.endAngle),
                  fromStroke: isStroke,
                  bezier: { p0: prevCanvas, p1, p2, p3 },
                });
              } else {
                const sagitta = bezierSagitta(prevCanvas, p1, p2, p3);

                if (sagitta >= 1.0) {
                  const roughCenterX = (prevCanvas.x + p3.x) / 2;
                  const roughCenterY = (prevCanvas.y + p3.y) / 2;
                  curves.push({
                    id: 'C' + (++curveId),
                    center: { x: roughCenterX, y: roughCenterY },
                    radius: chordLen / 2,
                    startAngle: 0,
                    endAngle: 180,
                    isCircle: false,
                    layer: '0', strokeWidth,
                    approxLength: chordLen,
                    fromStroke: isStroke,
                    bezier: { p0: prevCanvas, p1, p2, p3 },
                  });
                } else {
                  const len = segmentLength(prevCanvas, p3);
                  if (len >= 0.1) {
                    lines.push({
                      id: 'L' + (++lineId),
                      vertices: [prevCanvas, p3],
                      layer: '0', strokeWidth, length: len,
                      fromStroke: isStroke,
                    });
                  }
                }
              }
              prevCanvas = p3;

            } else if (seg.type === 'close') {
              const len = segmentLength(prevCanvas, firstCanvas);
              if (len >= 0.1) {
                lines.push({
                  id: 'L' + (++lineId),
                  vertices: [prevCanvas, firstCanvas],
                  layer: '0', strokeWidth, length: len,
                  fromStroke: isStroke,
                });
              }
              prevCanvas = firstCanvas;
            }
          }
        }
        break;
      }
      default: break;
    }
  }

  console.log('[pdfGeometry.worker] lines: ' + lines.length + ' curves: ' + curves.length);
  return { lines, curves };
}

// ─── Main message handler ─────────────────────────────────────────────────────

self.onmessage = function(e) {
  const data = e.data;
  if (data.type !== 'PARSE') return;
  const { operators, dims, viewportTransform } = data;

  try {
    const { lines, curves } = parseOperators(operators, dims, viewportTransform || IDENTITY);

    const snapPoints = [];
    for (const line  of lines)  computeLineSnaps(line, dims, snapPoints);
    for (const curve of curves) computeCurveSnaps(curve, dims, snapPoints);
    computeIntersections(lines, dims, snapPoints);

    // ── DEBUG: log type breakdown so misclassification is immediately visible
    const typeCounts = {};
    for (const sp of snapPoints) {
      typeCounts[sp.type] = (typeCounts[sp.type] || 0) + 1;
    }
    console.log('[pdfGeometry.worker] snapPoints: ' + snapPoints.length, typeCounts);

    self.postMessage({ type: 'RESULT', lines, curves, snapPoints });
  } catch (err) {
    console.error('[pdfGeometry.worker] threw:', err);
    self.postMessage({ type: 'ERROR', message: String(err) });
  }
};
`;

function createGeometryWorker(): Worker {
  const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
  const url  = URL.createObjectURL(blob);
  const w    = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePdfDocument(): UsePdfDocumentReturn {
  const [stage, setStage]       = useState<PdfLoadStage>('idle');
  const [errorMessage, setErr]  = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [dims, setDims]         = useState<PdfDimensions | null>(null);
  const [pageInfo, setPageInfo] = useState<PdfPageInfo | null>(null);
  const [lines, setLines]       = useState<PdfLine[]>([]);
  const [curves, setCurves]     = useState<PdfCurve[]>([]);
  const [snapPoints, setSnaps]  = useState<SnapPoint[]>([]);

  const pdfPageRef = useRef<any>(null);
  const workerRef  = useRef<Worker | null>(null);

  const renderToCanvas = useCallback(async (canvas: HTMLCanvasElement, scale = 1) => {
    const page = pdfPageRef.current;
    if (!page) return;
    const viewport  = page.getViewport({ scale });
    canvas.width    = viewport.width;
    canvas.height   = viewport.height;
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, viewport }).promise;
  }, []);

  const loadFile = useCallback(async (file: File) => {
    workerRef.current?.terminate();
    workerRef.current = null;

    setStage('reading-file');
    setErr(null);
    setFileName(file.name);
    setLines([]); setCurves([]); setSnaps([]);
    setDims(null); setPageInfo(null);
    pdfPageRef.current = null;

    try {
      const buffer = await file.arrayBuffer();

      setStage('parsing-pdf');
      const pdfjs = await getPdfJs();
      const doc   = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
      const page  = await doc.getPage(1);
      pdfPageRef.current = page;
      setPageInfo({ pageNumber: 1, pageCount: doc.numPages });

      setStage('rendering-page');
      const vp       = page.getViewport({ scale: 1 });
      const pageDims: PdfDimensions = { w: vp.width, h: vp.height };
      setDims(pageDims);
      const viewportTransform = vp.transform as number[];

      setStage('extracting-geometry');
      const operators = await extractOperators(page);

      setStage('computing-snaps');
      const worker = createGeometryWorker();
      workerRef.current = worker;

      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === 'RESULT') {
            setLines(msg.lines);
            setCurves(msg.curves);
            setSnaps(msg.snapPoints);
            resolve();
          } else if (msg.type === 'ERROR') {
            reject(new Error(msg.message));
          }
        };
        worker.onerror = (err) => reject(err);
        worker.postMessage({ type: 'PARSE', operators, dims: pageDims, viewportTransform });
      });

      setStage('done');
    } catch (err) {
      console.error('[usePdfDocument] error:', err);
      setErr(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }, []);

  return { stage, errorMessage, fileName, dims, pageInfo, lines, curves, snapPoints, loadFile, renderToCanvas };
}
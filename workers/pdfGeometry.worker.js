// PDF geometry worker: operator list → lines, curves and snap points.
// Loaded by hooks/snapEngine/usePdfDocument.ts via new URL(..., import.meta.url)
// so it is bundled, minified and cached like any other asset.
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
  // Check that the curve really is circular by testing points ON the curve
  // (t = ¼ and ¾). The control points can't be used for this: for a circular
  // arc they lie outside the circle (≈14% for a quarter arc), which made every
  // real circle fail this check before.
  const bez = (t) => {
    const u = 1 - t;
    return {
      x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
      y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y,
    };
  };
  const q1 = bez(0.25), q3 = bez(0.75);
  const e1 = Math.abs(Math.hypot(q1.x-ux, q1.y-uy) - radius) / radius;
  const e3 = Math.abs(Math.hypot(q3.x-ux, q3.y-uy) - radius) / radius;
  if (e1 > 0.02 || e3 > 0.02) return null;
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

  // Centroid (arc center) — only for curves that really are circular arcs.
  if (!curve.approximate) addSnap(curve.center, 'centroid');

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

// ─── Circles drawn as straight segments ──────────────────────────────────────
// CAD exports often draw circles and arcs as many short lines instead of
// curves, so they never get a centre snap. For a polyline of 8+ points, fit a
// circle (least squares) and accept it when every vertex lies within 3% of
// the radius and the points sweep at least 45°. Returns { center, radius } or null.
function fitPolylineCircle(pts, pageDiag) {
  const n = pts.length;
  if (n < 8) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  // Kåsa fit in centred coordinates: u² + v² + D·u + E·v + F = 0
  let suu = 0, svv = 0, suv = 0, su = 0, sv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    const uu = u * u, vv = v * v;
    suu += uu; svv += vv; suv += u * v; su += u; sv += v;
    suuu += uu * u; svvv += vv * v; suvv += u * vv; svuu += v * uu;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;               // collinear
  const bu = 0.5 * (suuu + suvv), bv = 0.5 * (svvv + svuu);
  const uc = (bu * svv - bv * suv) / det;
  const vc = (bv * suu - bu * suv) / det;
  const cx = uc + mx, cy = vc + my;
  let r = 0;
  for (const p of pts) r += Math.hypot(p.x - cx, p.y - cy);
  r /= n;
  if (!(r > 2) || r > pageDiag / 2) return null;
  for (const p of pts) {
    if (Math.abs(Math.hypot(p.x - cx, p.y - cy) - r) > r * 0.03) return null;
  }
  // Angular coverage: 360° minus the biggest gap between consecutive vertices.
  const angles = pts.map(p => Math.atan2(p.y - cy, p.x - cx)).sort((a, b) => a - b);
  let maxGap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) maxGap = Math.max(maxGap, angles[i] - angles[i - 1]);
  const sweep = 2 * Math.PI - maxGap;
  if (sweep < Math.PI / 4) return null;
  return { center: { x: cx, y: cy }, radius: r, sweepDeg: sweep * 180 / Math.PI };
}

// ─── Full circles (for the circle tool's one-click markers) ──────────────────
// Joins the pieces of each circle — the 4 Béziers of a PDF circle, or a
// segmented polyline — and keeps the ones covering at least 300°.
function collectFullCircles(curves, polyCircles) {
  const groups = [];   // { x, y, r, span }
  const add = (x, y, r, span) => {
    const tol = Math.max(1, r * 0.02);
    for (const g of groups) {
      if (Math.abs(g.x - x) < tol && Math.abs(g.y - y) < tol && Math.abs(g.r - r) < tol) {
        g.span += span; return;
      }
    }
    groups.push({ x, y, r, span });
  };
  for (const c of curves) {
    if (!c.fromStroke || c.approximate || !(c.radius > 2)) continue;
    let span = c.isCircle ? 360 : ((c.endAngle - c.startAngle) % 360 + 360) % 360;
    if (!c.isCircle) span = Math.min(span, 360 - span);   // direction-independent
    add(c.center.x, c.center.y, c.radius, span);
  }
  for (const pc of polyCircles) add(pc.center.x, pc.center.y, pc.radius, pc.sweepDeg || 0);
  return groups.filter(g => g.span >= 300);
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
  const polyCircles = [];
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
          // Vertices of an all-straight subpath, for circle detection.
          const polyPts = [firstCanvas];
          let allLines  = true;

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
              if (len >= 0.1) polyPts.push(v);

            } else if (seg.type === 'curve') {
              allLines = false;
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
                    // Not a circular arc: its "center" is only the chord midpoint,
                    // so it must not become a centre snap.
                    approximate: true,
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
          if (allLines && isStroke && polyPts.length >= 8) {
            // Drop a repeated closing vertex so it isn't counted twice.
            const last = polyPts[polyPts.length - 1];
            if (Math.hypot(last.x - firstCanvas.x, last.y - firstCanvas.y) < 0.1) polyPts.pop();
            const fit = fitPolylineCircle(polyPts, pageDiag);
            if (fit) polyCircles.push({ center: fit.center, radius: fit.radius, sweepDeg: fit.sweepDeg, strokeWidth });
          }
        }
        break;
      }
      default: break;
    }
  }


  return { lines, curves, polyCircles };
}

// ─── Main message handler ─────────────────────────────────────────────────────

self.onmessage = function(e) {
  const data = e.data;
  if (data.type !== 'PARSE') return;
  const { operators, dims, viewportTransform } = data;

  try {
    const { lines, curves, polyCircles } = parseOperators(operators, dims, viewportTransform || IDENTITY);

    const snapPoints = [];
    // Centres of circles / arcs drawn as straight segments (see fitPolylineCircle).
    for (let i = 0; i < polyCircles.length; i++) {
      const c = polyCircles[i];
      const nx = c.center.x / dims.w, ny = c.center.y / dims.h;
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
      if (!clusterNear(snapPoints, nx, ny, 'centroid', dims)) {
        snapPoints.push({ nx, ny, type: 'centroid', sourceId: 'PC' + i, strokeWidth: c.strokeWidth });
      }
    }
    for (const line  of lines)  computeLineSnaps(line, dims, snapPoints);
    for (const curve of curves) computeCurveSnaps(curve, dims, snapPoints);
    computeIntersections(lines, dims, snapPoints);

    // ── DEBUG: log type breakdown so misclassification is immediately visible
    const typeCounts = {};
    for (const sp of snapPoints) {
      typeCounts[sp.type] = (typeCounts[sp.type] || 0) + 1;
    }


    const circles = collectFullCircles(curves, polyCircles).map(c => ({
      nx: c.x / dims.w, ny: c.y / dims.h, nrx: c.r / dims.w, nry: c.r / dims.h, r: c.r,
    })).filter(c => c.nx >= 0 && c.nx <= 1 && c.ny >= 0 && c.ny <= 1);

    self.postMessage({ type: 'RESULT', lines, curves, snapPoints, circles });
  } catch (err) {
    console.error('[pdfGeometry.worker] threw:', err);
    self.postMessage({ type: 'ERROR', message: String(err) });
  }
};

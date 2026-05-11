// hooks/useSnapEngine/extractVectorWalls.ts
import * as pdfjsLib from 'pdfjs-dist';

export interface VectorWall {
  // Normalised coords [0,1] — same convention as raster path
  nx1: number; ny1: number;
  nx2: number; ny2: number;
  // Canvas-pixel coords at current viewport scale
  x1: number; y1: number;
  x2: number; y2: number;
  thicknessPx: number;
  thicknessNorm: number;   // thickness as fraction of page height
  angle: 0 | 90 | 'diagonal';
  isFilled: boolean;       // true = filled rect, false = stroked line
  length: number;          // canvas pixels
}

// Current transformation matrix — tracks cm operators
type CTM = [number, number, number, number, number, number]; // [a,b,c,d,e,f]

function applyTransform(ctm: CTM, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = ctm;
  return [a * x + c * y + e, b * x + d * y + f];
}

function multiplyTransform(m1: CTM, m2: CTM): CTM {
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

const IDENTITY_CTM: CTM = [1, 0, 0, 1, 0, 0];
const ANGLE_TOLERANCE_DEG = 4;
const MIN_WALL_LENGTH_NORM = 0.02; // at least 2% of page dimension
const MIN_ASPECT_RATIO = 4;        // filled rect must be 4:1 to count as wall

export async function extractVectorWalls(
  page: pdfjsLib.PDFPageProxy,
  viewport: pdfjsLib.PageViewport,
): Promise<VectorWall[]> {
  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;
  const OPS = pdfjsLib.OPS;

  const pageW = viewport.width;
  const pageH = viewport.height;
  const walls: VectorWall[] = [];

  // State machine
  let ctmStack: CTM[] = [IDENTITY_CTM];
  let currentCTM: CTM = IDENTITY_CTM;
  let currentLineWidth = 1;
  let subpathStart: [number, number] | null = null;
  let currentPoint: [number, number] | null = null;
  let pendingStroke = false;
  let pendingFill = false;
  // Accumulate path segments between m/S pairs
  let segments: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

  const toViewport = (x: number, y: number): [number, number] => {
    // Apply current CTM, then viewport transform
    const [tx, ty] = applyTransform(currentCTM, x, y);
    return viewport.convertToViewportPoint(tx, ty) as [number, number];
  };

  const classifyAngle = (dx: number, dy: number): 0 | 90 | 'diagonal' => {
    const deg = Math.abs(Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI);
    if (deg < ANGLE_TOLERANCE_DEG) return 0;
    if (Math.abs(deg - 90) < ANGLE_TOLERANCE_DEG) return 90;
    return 'diagonal';
  };

  const pushWall = (
    vx1: number, vy1: number, vx2: number, vy2: number,
    thicknessPx: number, isFilled: boolean,
  ) => {
    const dx = vx2 - vx1;
    const dy = vy2 - vy1;
    const length = Math.hypot(dx, dy);
    const angle = classifyAngle(dx, dy);
    const nx1 = vx1 / pageW, ny1 = vy1 / pageH;
    const nx2 = vx2 / pageW, ny2 = vy2 / pageH;
    const normLen = Math.hypot(nx2 - nx1, ny2 - ny1);

    if (normLen < MIN_WALL_LENGTH_NORM) return;

    walls.push({
      nx1, ny1, nx2, ny2,
      x1: vx1, y1: vy1, x2: vx2, y2: vy2,
      thicknessPx,
      thicknessNorm: thicknessPx / pageH,
      angle,
      isFilled,
      length,
    });
  };

  const flushPath = (filled: boolean) => {
    for (const seg of segments) {
      const thicknessPx = filled ? 0 : currentLineWidth * viewport.scale;
      pushWall(seg.x1, seg.y1, seg.x2, seg.y2, thicknessPx, filled);
    }
    segments = [];
    currentPoint = null;
    subpathStart = null;
    pendingStroke = false;
    pendingFill = false;
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];

    switch (fn) {
      // ── Transform matrix ─────────────────────────────────────────────────
      case OPS.save:
        ctmStack.push(currentCTM);
        break;
      case OPS.restore:
        currentCTM = ctmStack.pop() ?? IDENTITY_CTM;
        break;
      case OPS.transform:
        currentCTM = multiplyTransform(
          currentCTM,
          [args[0], args[1], args[2], args[3], args[4], args[5]],
        );
        break;

      // ── Graphics state ───────────────────────────────────────────────────
      case OPS.setLineWidth:
        currentLineWidth = args[0];
        break;

      // ── Path construction ────────────────────────────────────────────────
      case OPS.moveTo: {
        const [vx, vy] = toViewport(args[0], args[1]);
        subpathStart = [vx, vy];
        currentPoint = [vx, vy];
        break;
      }
      case OPS.lineTo: {
        if (!currentPoint) break;
        const [vx, vy] = toViewport(args[0], args[1]);
        segments.push({ x1: currentPoint[0], y1: currentPoint[1], x2: vx, y2: vy });
        currentPoint = [vx, vy];
        break;
      }
      case OPS.closePath: {
        if (currentPoint && subpathStart) {
          segments.push({
            x1: currentPoint[0], y1: currentPoint[1],
            x2: subpathStart[0], y2: subpathStart[1],
          });
          currentPoint = subpathStart;
        }
        break;
      }

      // ── Rectangle shorthand ──────────────────────────────────────────────
      case OPS.rectangle: {
        const [rx, ry, rw, rh] = args;
        const [vx, vy] = toViewport(rx, ry);
        const [vx2, vy2] = toViewport(rx + rw, ry + rh);
        const absW = Math.abs(vx2 - vx);
        const absH = Math.abs(vy2 - vy);
        const minDim = Math.min(absW, absH);
        const maxDim = Math.max(absW, absH);

        if (maxDim / (minDim || 1) >= MIN_ASPECT_RATIO) {
          // Treat as wall — extract centerline
          const isHoriz = absW >= absH;
          const cx1 = isHoriz ? vx  : (vx + vx2) / 2;
          const cy1 = isHoriz ? (vy + vy2) / 2 : vy;
          const cx2 = isHoriz ? vx2 : (vx + vx2) / 2;
          const cy2 = isHoriz ? (vy + vy2) / 2 : vy2;
          pushWall(cx1, cy1, cx2, cy2, minDim, true);
        }
        // Don't push into segments — rectangle is self-contained
        break;
      }

      // ── Path painting ────────────────────────────────────────────────────
      case OPS.stroke:
      case OPS.closeStroke:
        flushPath(false);
        break;
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
        flushPath(true);
        break;
      case OPS.endPath:
        segments = [];
        currentPoint = null;
        break;
    }
  }

  return walls;
}
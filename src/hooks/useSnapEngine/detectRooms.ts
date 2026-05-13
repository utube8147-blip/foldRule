// hooks/useSnapEngine/detectRooms.ts
//
// Pipeline:
//  1. CubiCasa5k v6 → structural elements (walls, doors, windows) only
//  2. Floor-plan segmentation model → room polygons (with class labels)
//  3. Floor Plan All Objects model  → fixtures (toilet, sink, shower, stairs, beds, sofa etc.)
//  4. Floorplan Cabinet Detection   → toilet, tub, sink, twin_sink detail
//  5. OCR          → read text inside each room polygon from the PDF canvas
//                    to get the architect's own label (BEDROOM, KITCHEN, etc.)
//  6. Workflow     → general-segmentation fallback if room model finds no rooms
//  7. Fallback     → area-heuristic labels if OCR and workflow both fail
//  8. Repeat grouping → cluster visually-similar structural elements and let
//                        the user pick the correct label for each group
//
// OCR is done by cropping the PDF canvas to each room's bounding box,
// upscaling 3x, converting to greyscale + high-contrast, then running
// Tesseract on the crop. This reads what the architect actually wrote.
// ─────────────────────────────────────────────────────────────────────────────

import type { WallLineNorm } from '@/types/viewerTypes';

export interface DetectedRoom {
  polygon:    Array<{ nx: number; ny: number }>;
  areaNorm:   number;
  label:      string;
  centroid:   { nx: number; ny: number };
  id:         string;
  type:       'room' | 'structural';
  confidence?: number;
  source?:    string;
  groupId?:   string;   // set when element belongs to a RepeatGroup
}

export interface DetectionSummary {
  structural: number;
  rooms:      number;
  inferred:   number;
  endpoints:  Record<string, 'ok' | 'failed' | 'skipped'>;
  durationMs: number;
}

// ─── Repeat-group types (for user relabelling UI) ──────────────────────────

export interface RepeatGroup {
  id:           string;          // stable group identifier e.g. "group-0"
  currentLabel: string;          // model's best guess e.g. "DOOR", "WINDOW"
  members:      DetectedRoom[];  // every detection in this group
  sampleMember: DetectedRoom;    // one representative element to show the user
  avgWidth:     number;          // normalised avg bounding-box width
  avgHeight:    number;          // normalised avg bounding-box height
  count:        number;          // total elements in this group
}

// Returned by buildElementReviewState().
// Pass groups to your UI. When the user picks a label call relabel().
export interface ElementReviewState {
  groups:  RepeatGroup[];
  // Applies the new label to every member of the group.
  // Returns a new detections array — treat it as immutable.
  relabel: (groupId: string, newLabel: string, detections: DetectedRoom[]) => DetectedRoom[];
}

// ─── Endpoint configuration ────────────────────────────────────────────────

interface EndpointConfig {
  id:       string;
  category: 'structural' | 'room';
  baseUrl:  'serverless' | 'detect' | 'segment' | 'classify';
}

interface WorkflowConfig {
  workspaceSlug: string;
  workflowId:    string;
  classes:       string;
}

const WORKFLOW: WorkflowConfig = {
  workspaceSlug: 'safnass-workspace',
  workflowId:    'general-segmentation-api-11',
  classes:       'door, window, wall, room, corridor, bathroom, kitchen, bedroom, living room, dining room, office, hallway, storage, garage, balcony, pillar, column, toilet, sink, bathtub, shower, stairs, elevator',
};

const ENDPOINTS: EndpointConfig[] = [
  // CubiCasa v6 (latest): walls, doors, windows
  { id: 'cubicasa5k-2-qpmsa/6',                                category: 'structural', baseUrl: 'serverless' },

  // Room segmentation: room polygons with class labels
  // { id: 'floor-plan-segmentation-gvpsn/1',                     category: 'room',       baseUrl: 'serverless' },

  // Fixtures: toilet, sink, shower, stairs, wardrobe, fridge, beds, sofa, washing machine etc.
  { id: 'floor-plan-rendering-l4ax8/floor-plan-all-objects/1', category: 'room',       baseUrl: 'serverless' },

  // Cabinet/fixture detail: toilet, tub, sink, twin_sink
  { id: 'cabinet-detection/floorplan-cabinet-detection/1',     category: 'room',       baseUrl: 'serverless' },
];

const MIN_CONFIDENCE    = 0.20;  // match Roboflow dashboard default
const NMS_IOU_THRESHOLD = 0.55;  // match Roboflow dashboard default
export const SCALE      = 0.45;

// ─── Proxy helpers ──────────────────────────────────────────────────────────

const PROXY = '/api/roboflow';

async function proxyModel(
  base64:  string,
  config:  EndpointConfig,
  signal?: AbortSignal,
): Promise<RoboflowResponse> {
  console.log(`[detectRooms] → proxy model: ${config.id}`);

  const res = await fetch(PROXY, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      type:       'model',
      id:         config.id,
      baseUrl:    config.baseUrl,
      base64,
      confidence: MIN_CONFIDENCE,
      overlap:    NMS_IOU_THRESHOLD,
    }),
    signal,
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Proxy ${res.status} [${config.id}]: ${msg}`);
  }

  const data: RoboflowResponse = await res.json();
  console.log(`[detectRooms] ✅ ${config.id}: ${data.predictions?.length ?? 0} predictions`);
  return data;
}

async function proxyWorkflow(
  base64:  string,
  cfg:     WorkflowConfig,
  signal?: AbortSignal,
): Promise<WorkflowPrediction[]> {
  console.log(`[detectRooms] → proxy workflow: ${cfg.workflowId}`);

  const res = await fetch(PROXY, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      type:          'workflow',
      workspaceSlug: cfg.workspaceSlug,
      workflowId:    cfg.workflowId,
      base64,
      classes:       cfg.classes,
    }),
    signal,
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Proxy workflow ${res.status} [${cfg.workflowId}]: ${msg}`);
  }

  const data: WorkflowResponse = await res.json();
  console.log(`[detectRooms] ✅ workflow raw:`, data);
  const preds = extractWorkflowPredictions(data);
  console.log(`[detectRooms] ✅ workflow extracted: ${preds.length} predictions`, preds.map(p => p.class));
  return preds;
}

// ─── Roboflow types ─────────────────────────────────────────────────────────

interface RoboflowPoint { x: number; y: number }

interface RoboflowPrediction {
  class:         string;
  x:             number;
  y:             number;
  width:         number;
  height:        number;
  confidence:    number;
  points?:       RoboflowPoint[];
  class_id?:     number;
  detection_id?: string;
}

interface RoboflowResponse {
  predictions: RoboflowPrediction[];
  image?:      { width: number; height: number };
  time?:       number;
  inference_id?: string;
}

interface WorkflowPrediction {
  class:      string;
  confidence: number;
  x?:         number;
  y?:         number;
  width?:     number;
  height?:    number;
  points?:    RoboflowPoint[];
  [key: string]: unknown;
}

interface WorkflowOutput {
  predictions?: WorkflowPrediction[] | { predictions?: WorkflowPrediction[] } | Record<string, unknown>;
  [key: string]: unknown;
}

interface WorkflowResponse {
  outputs?: WorkflowOutput[];
  [key: string]: unknown;
}

// ─── Flatten workflow outputs ───────────────────────────────────────────────

function extractWorkflowPredictions(data: WorkflowResponse): WorkflowPrediction[] {
  const results: WorkflowPrediction[] = [];

  for (const output of data.outputs ?? []) {
    console.log('[detectRooms] workflow output keys:', Object.keys(output));

    const predsValue = output.predictions;

    // Case 1: flat array
    if (Array.isArray(predsValue)) {
      console.log('[detectRooms] workflow: flat array, length', predsValue.length);
      results.push(...(predsValue as WorkflowPrediction[]));
      continue;
    }

    // Case 2: nested object { predictions: [...] }
    if (predsValue && typeof predsValue === 'object') {
      const nested = predsValue as Record<string, unknown>;
      console.log('[detectRooms] workflow predictions object keys:', Object.keys(nested));
      if (Array.isArray(nested.predictions)) {
        console.log('[detectRooms] workflow: nested .predictions array, length', (nested.predictions as unknown[]).length);
        results.push(...(nested.predictions as WorkflowPrediction[]));
        continue;
      }
    }

    // Case 3: scan other top-level keys
    for (const [key, val] of Object.entries(output)) {
      if (key === 'predictions') continue;
      if (
        Array.isArray(val) &&
        val.length > 0 &&
        typeof val[0] === 'object' &&
        val[0] !== null &&
        'class' in val[0]
      ) {
        console.log(`[detectRooms] workflow: found predictions under key "${key}", length`, val.length);
        results.push(...(val as WorkflowPrediction[]));
      }
    }
  }

  return results;
}

// ─── Class classifiers ──────────────────────────────────────────────────────

const ROOM_KEYWORDS = [
  // Spaces / rooms
  'room', 'office', 'conference', 'meeting', 'kitchen', 'bedroom',
  'bathroom', 'living', 'dining', 'corridor', 'hallway', 'storage',
  'garage', 'balcony', 'lobby', 'foyer', 'study', 'den', 'library',
  'waiting', 'reception', 'breakroom', 'cafeteria', 'classroom',
  'open', 'plan', 'space', 'area', 'lounge', 'pantry', 'utility',
  'laundry', 'closet', 'wardrobe', 'nursery', 'gym', 'toilet', 'wc',
  'zone', 'hall', 'guest', 'dining_area', 'living_room',
  // Fixtures / fittings
  'sink', 'wash', 'basin', 'tub', 'bathtub', 'shower', 'bath',
  'bed', 'sofa', 'couch', 'fridge', 'refrigerator', 'dishwasher',
  'oven', 'stove', 'washing', 'machine', 'television', 'tv',
  'cabinet', 'stairs', 'stair', 'table', 'dinner',
  'twin_sink', 'double_sink',
];

const STRUCTURAL_KEYWORDS = ['wall', 'window', 'door', 'column', 'pillar', 'stair'];

const LABEL_MAP: Record<string, string> = {
  // ── Rooms ──────────────────────────────────────────────────────────────
  OFFICE: 'OFFICE', CONFERENCE: 'CONFERENCE ROOM', MEETING: 'MEETING ROOM',
  KITCHEN: 'KITCHEN', BATHROOM: 'BATHROOM', TOILET: 'BATHROOM', WC: 'BATHROOM',
  BEDROOM: 'BEDROOM', BED: 'BEDROOM', LIVING: 'LIVING ROOM', LIVING_ROOM: 'LIVING ROOM',
  LOUNGE: 'LIVING ROOM', DINING: 'DINING ROOM', DINING_AREA: 'DINING ROOM',
  DINING_ROOM: 'DINING ROOM', CORRIDOR: 'CORRIDOR', HALLWAY: 'CORRIDOR',
  HALL: 'CORRIDOR', PASSAGE: 'CORRIDOR', STORAGE: 'STORAGE', CLOSET: 'STORAGE',
  LOBBY: 'LOBBY', FOYER: 'LOBBY', ENTRY: 'LOBBY', ENTRANCE: 'LOBBY',
  OPEN: 'OPEN PLAN', GARAGE: 'GARAGE', LAUNDRY: 'LAUNDRY',
  UTILITY: 'UTILITY', BALCONY: 'BALCONY', TERRACE: 'BALCONY', STUDY: 'STUDY',
  LIBRARY: 'LIBRARY', NURSERY: 'NURSERY', GYM: 'GYM', PANTRY: 'PANTRY',
  RECEPTION: 'RECEPTION', GUEST: 'GUEST ROOM', ZONE: 'ROOM',
  // ── Room abbreviations ─────────────────────────────────────────────────
  'BED RM': 'BEDROOM', 'BD RM': 'BEDROOM', 'BR': 'BEDROOM',
  'LR': 'LIVING ROOM', 'DR': 'DINING ROOM', 'KIT': 'KITCHEN',
  'BATH': 'BATHROOM', 'LAV': 'BATHROOM', 'PWD': 'BATHROOM',
  'COR': 'CORRIDOR', 'CORR': 'CORRIDOR', 'STOR': 'STORAGE',
  'GAR': 'GARAGE', 'UTIL': 'UTILITY', 'MECH': 'MECHANICAL',
  // ── Fixtures ───────────────────────────────────────────────────────────
  SINK: 'SINK', 'WASH BASIN': 'SINK', BASIN: 'SINK',
  'WASHBASIN CABINET': 'SINK', 'WASH_BASIN': 'SINK',
  TUB: 'BATHTUB', BATHTUB: 'BATHTUB', 'BATH TUB': 'BATHTUB',
  SHOWER: 'SHOWER',
  'SINGLE BED': 'SINGLE BED', 'DOUBLE BED': 'DOUBLE BED',
  'SOFA 1P': 'SOFA', 'SOFA 2P': 'SOFA', 'SOFA 3P': 'SOFA',
  'SOFA_1P': 'SOFA', 'SOFA_2P': 'SOFA', 'SOFA_3P': 'SOFA',
  'CORNER SOFA': 'SOFA',
  REFRIGERATOR: 'REFRIGERATOR', FRIDGE: 'REFRIGERATOR',
  DISHWASHER: 'DISHWASHER',
  'OVEN STOVE': 'OVEN/STOVE', STOVE: 'OVEN/STOVE', OVEN: 'OVEN/STOVE',
  'WASHING MACHINE': 'WASHING MACHINE',
  TELEVISION: 'TELEVISION', TV: 'TELEVISION',
  'DINNER TABLE': 'DINING TABLE', 'DINING TABLE': 'DINING TABLE',
  'STUDY TABLE': 'DESK', TABLE: 'TABLE',
  WARDROBE: 'WARDROBE',
  'DOUBLE DOOR': 'DOOR', 'SINGLE DOOR': 'DOOR', 'DOOR WINDOW': 'DOOR',
  STAIRS: 'STAIRS', STAIR: 'STAIRS',
  'TWIN SINK': 'TWIN SINK', 'TWIN_SINK': 'TWIN SINK',
  'SMALL SINK': 'SINK', 'LARGE SINK': 'SINK',
  'SMALL SOFA': 'SOFA', 'LARGE SOFA': 'SOFA',
};

function isRoomClass(c: string) {
  const l = c.toLowerCase();
  return ROOM_KEYWORDS.some(k => l.includes(k));
}

function isStructuralClass(c: string) {
  const l = c.toLowerCase();
  return STRUCTURAL_KEYWORDS.some(k => l.includes(k));
}

function normaliseLabel(raw: string, type: 'room' | 'structural'): string {
  if (type === 'structural') return raw.toUpperCase();
  const up = raw.toUpperCase().trim().replace(/\s+/g, ' ');
  if (LABEL_MAP[up]) return LABEL_MAP[up];
  for (const [key, value] of Object.entries(LABEL_MAP))
    if (up.includes(key)) return value;
  return up;
}

// ─── OCR helpers ────────────────────────────────────────────────────────────

const OCR_CROP_SCALE = 3.0;
const OCR_MIN_CHARS  = 2;
const OCR_TIMEOUT_MS = 3000;

let tesseractWorker: any = null;

async function getTesseractWorker(): Promise<any> {
  if (tesseractWorker) return tesseractWorker;
  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng', 1, { logger: () => {} });
    await worker.setParameters({
      tessedit_char_whitelist:
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz 0123456789/.-',
      tessedit_pageseg_mode: '7',
    });
    tesseractWorker = worker;
    return worker;
  } catch (err) {
    console.warn('[detectRooms] Tesseract load failed:', err);
    return null;
  }
}

function cropAndEnhance(
  source:  HTMLCanvasElement | OffscreenCanvas,
  nx0: number, ny0: number,
  nx1: number, ny1: number,
  padding = 0.015,
): OffscreenCanvas | null {
  const sw = source.width;
  const sh = source.height;

  const x0 = Math.max(0, (nx0 - padding) * sw);
  const y0 = Math.max(0, (ny0 - padding) * sh);
  const x1 = Math.min(sw, (nx1 + padding) * sw);
  const y1 = Math.min(sh, (ny1 + padding) * sh);

  const cropW = x1 - x0;
  const cropH = y1 - y0;
  if (cropW < 10 || cropH < 10) return null;

  const outW = Math.round(cropW * OCR_CROP_SCALE);
  const outH = Math.round(cropH * OCR_CROP_SCALE);

  try {
    const oc  = new OffscreenCanvas(outW, outH);
    const ctx = oc.getContext('2d')!;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(source as CanvasImageSource, x0, y0, cropW, cropH, 0, 0, outW, outH);

    const imgData = ctx.getImageData(0, 0, outW, outH);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const grey = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const out  = grey < 160 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = out;
    }
    ctx.putImageData(imgData, 0, 0);
    return oc;
  } catch {
    return null;
  }
}

async function ocrRoomLabel(
  source:  HTMLCanvasElement | OffscreenCanvas,
  nx0: number, ny0: number,
  nx1: number, ny1: number,
): Promise<string | null> {
  const worker = await getTesseractWorker();
  if (!worker) return null;

  const crop = cropAndEnhance(source, nx0, ny0, nx1, ny1);
  if (!crop) return null;

  try {
    const blob = await crop.convertToBlob({ type: 'image/png' });
    const url  = URL.createObjectURL(blob);

    const result = await Promise.race([
      worker.recognize(url),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('OCR timeout')), OCR_TIMEOUT_MS),
      ),
    ]) as any;

    URL.revokeObjectURL(url);

    const raw = (result?.data?.text ?? '').trim().toUpperCase();
    if (!raw || raw.length < OCR_MIN_CHARS) return null;
    if ((result?.data?.confidence ?? 0) < 40) return null;

    const cleaned = raw
      .replace(/[^A-Z0-9 /.'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned.length < OCR_MIN_CHARS) return null;

    const mapped = normaliseLabel(cleaned, 'room');
    console.log(`[detectRooms] OCR: "${raw}" → "${mapped}"`);
    return mapped;
  } catch (err) {
    console.warn('[detectRooms] OCR failed for crop:', err);
    return null;
  }
}

// ─── Prediction → DetectedRoom ──────────────────────────────────────────────

function predToRoom(
  pred:   RoboflowPrediction | WorkflowPrediction,
  imgW:   number,
  imgH:   number,
  type:   'room' | 'structural',
  source: string,
): DetectedRoom {
  const x      = (pred as RoboflowPrediction).x      ?? 0;
  const y      = (pred as RoboflowPrediction).y      ?? 0;
  const width  = (pred as RoboflowPrediction).width  ?? 0;
  const height = (pred as RoboflowPrediction).height ?? 0;

  let polygon: Array<{ nx: number; ny: number }>;

  if (pred.points && pred.points.length >= 3) {
    polygon = pred.points.map(p => ({
      nx: Math.max(0, Math.min(1, p.x / imgW)),
      ny: Math.max(0, Math.min(1, p.y / imgH)),
    }));
  } else {
    const x0 = Math.max(0, Math.min(1, (x - width  / 2) / imgW));
    const y0 = Math.max(0, Math.min(1, (y - height / 2) / imgH));
    const x1 = Math.max(0, Math.min(1, (x + width  / 2) / imgW));
    const y1 = Math.max(0, Math.min(1, (y + height / 2) / imgH));
    polygon = [{ nx: x0, ny: y0 }, { nx: x1, ny: y0 }, { nx: x1, ny: y1 }, { nx: x0, ny: y1 }];
  }

  const xs   = polygon.map(p => p.nx);
  const ys   = polygon.map(p => p.ny);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  return {
    polygon,
    areaNorm:   (maxX - minX) * (maxY - minY),
    label:      normaliseLabel(pred.class, type),
    centroid:   { nx: (minX + maxX) / 2, ny: (minY + maxY) / 2 },
    id:         `${source}-${pred.class}-${Math.round(x)}-${Math.round(y)}`,
    type,
    confidence: pred.confidence,
    source,
  };
}

// ─── OCR pass over room polygons ─────────────────────────────────────────────

const GENERIC_LABELS = new Set(['ROOM', 'SPACE', 'AREA', 'ZONE', 'INTERIOR']);

async function classifyRoomsWithOCR(
  rooms:   DetectedRoom[],
  canvas:  HTMLCanvasElement | OffscreenCanvas,
  signal?: AbortSignal,
): Promise<DetectedRoom[]> {
  const result: DetectedRoom[] = [];

  for (const room of rooms) {
    if (signal?.aborted) break;

    if (room.type === 'structural') {
      result.push(room);
      continue;
    }

    const xs   = room.polygon.map(p => p.nx);
    const ys   = room.polygon.map(p => p.ny);
    const nx0  = Math.min(...xs);
    const ny0  = Math.min(...ys);
    const nx1  = Math.max(...xs);
    const ny1  = Math.max(...ys);

    const areaNorm = (nx1 - nx0) * (ny1 - ny0);
    if (areaNorm < 0.003) {
      result.push(room);
      continue;
    }

    const needsOCR = GENERIC_LABELS.has(room.label.toUpperCase());

    if (!needsOCR) {
      result.push({ ...room, source: `${room.source}+model-label` });
      continue;
    }

    const ocrLabel = await ocrRoomLabel(canvas, nx0, ny0, nx1, ny1);

    if (ocrLabel && ocrLabel.length >= OCR_MIN_CHARS) {
      result.push({ ...room, label: ocrLabel, source: `${room.source}+ocr` });
    } else {
      result.push({ ...room, label: areaHeuristicLabel(room.areaNorm), source: `${room.source}+heuristic` });
    }
  }

  return result;
}

// ─── NMS ────────────────────────────────────────────────────────────────────

function boundingBox(r: DetectedRoom): [number, number, number, number] {
  const xs = r.polygon.map(p => p.nx);
  const ys = r.polygon.map(p => p.ny);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function iou(a: DetectedRoom, b: DetectedRoom): number {
  const [ax0, ay0, ax1, ay1] = boundingBox(a);
  const [bx0, by0, bx1, by1] = boundingBox(b);
  const ix0 = Math.max(ax0, bx0), iy0 = Math.max(ay0, by0);
  const ix1 = Math.min(ax1, bx1), iy1 = Math.min(ay1, by1);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  const union = a.areaNorm + b.areaNorm - inter;
  return union <= 0 ? 0 : inter / union;
}

function nms(detections: DetectedRoom[], threshold = NMS_IOU_THRESHOLD): DetectedRoom[] {
  const sorted     = [...detections].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const kept: DetectedRoom[] = [];
  const suppressed = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    if (suppressed.has(i)) continue;
    kept.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++)
      if (!suppressed.has(j) && iou(sorted[i], sorted[j]) > threshold) suppressed.add(j);
  }
  return kept;
}

// ─── Repeat-group detection ──────────────────────────────────────────────────
//
// After detectRooms() returns, call buildElementReviewState(detections) to
// cluster structural elements that repeat with similar sizes. Show each group
// to the user with its sampleMember highlighted on the canvas, then call
// relabel() when they confirm or correct the label.
//
// Example usage in your component / hook:
//
//   const detections = await detectRooms(...);
//   const { groups, relabel } = buildElementReviewState(detections);
//
//   // groups is sorted by count descending — show the most common first
//   for (const group of groups) {
//     // highlight group.members on canvas, show group.currentLabel
//     // when user picks a label:
//     detections = relabel(group.id, 'WINDOW', detections);
//   }

const REPEAT_SIZE_TOLERANCE = 0.25; // allow ±25% size variance within a group
const REPEAT_MIN_MEMBERS    = 2;    // ignore singleton detections

export function buildElementReviewState(detections: DetectedRoom[]): ElementReviewState {
  const structural = detections.filter(d => d.type === 'structural');
  const groups: RepeatGroup[] = [];

  for (const det of structural) {
    const [x0, y0, x1, y1] = boundingBox(det);
    const w = x1 - x0;
    const h = y1 - y0;

    // Find an existing group with same label and similar bounding-box size
    const existing = groups.find(g => {
      if (g.currentLabel !== det.label) return false;
      const dw = Math.abs(g.avgWidth  - w) / (g.avgWidth  || 1);
      const dh = Math.abs(g.avgHeight - h) / (g.avgHeight || 1);
      return dw < REPEAT_SIZE_TOLERANCE && dh < REPEAT_SIZE_TOLERANCE;
    });

    if (existing) {
      existing.members.push(det);
      existing.count++;
      // Update running averages
      existing.avgWidth  = existing.members.reduce((s, m) => {
        const [mx0,,mx1] = boundingBox(m); return s + (mx1 - mx0);
      }, 0) / existing.members.length;
      existing.avgHeight = existing.members.reduce((s, m) => {
        const [,my0,,my1] = boundingBox(m); return s + (my1 - my0);
      }, 0) / existing.members.length;
    } else {
      groups.push({
        id:           `group-${groups.length}`,
        currentLabel: det.label,
        members:      [det],
        sampleMember: det,
        avgWidth:     w,
        avgHeight:    h,
        count:        1,
      });
    }
  }

  // Keep only repeating groups, sorted most-common first
  const repeatingGroups = groups
    .filter(g => g.count >= REPEAT_MIN_MEMBERS)
    .sort((a, b) => b.count - a.count);

  console.log(
    '[detectRooms] 🔁 Repeat groups:',
    repeatingGroups.map(g => `${g.currentLabel} ×${g.count}`),
  );

  // Stamp groupId onto every member so the canvas renderer can highlight them
  for (const group of repeatingGroups) {
    for (const member of group.members) {
      member.groupId = group.id;
    }
  }

  // ── relabel ────────────────────────────────────────────────────────────
  // Applies newLabel to every member of the group.
  // Returns a new array — does NOT mutate the original detections array.
  function relabel(
    groupId:         string,
    newLabel:        string,
    currentDetections: DetectedRoom[],
  ): DetectedRoom[] {
    const group = repeatingGroups.find(g => g.id === groupId);
    if (!group) {
      console.warn(`[detectRooms] relabel: group "${groupId}" not found`);
      return currentDetections;
    }

    const memberIds = new Set(group.members.map(m => m.id));
    const updated   = currentDetections.map(d =>
      memberIds.has(d.id)
        ? { ...d, label: newLabel.toUpperCase(), source: `${d.source ?? ''}+user-relabelled` }
        : d,
    );

    // Keep group state in sync for subsequent calls
    group.currentLabel = newLabel.toUpperCase();
    for (const m of group.members) m.label = newLabel.toUpperCase();

    console.log(
      `[detectRooms] ✏️  Relabelled group "${groupId}" (×${group.count}) → "${newLabel.toUpperCase()}"`,
    );
    return updated;
  }

  return { groups: repeatingGroups, relabel };
}

// ─── Main export ────────────────────────────────────────────────────────────

export async function detectRooms(
  _wallLines:      WallLineNorm[],
  _dims:           { w: number; h: number },
  signal?:         AbortSignal,
  _wallThickness?: number,
  canvas?:         HTMLCanvasElement | OffscreenCanvas | null,
  _apiKey?:        string,
): Promise<DetectedRoom[]> {

  if (!canvas) {
    console.warn('[detectRooms] Missing canvas');
    return [];
  }

  const t0     = Date.now();
  const base64 = await canvasToBase64(canvas);
  if (signal?.aborted) return [];

  const endpointStatus: Record<string, 'ok' | 'failed' | 'skipped'> = {};

  const structuralEndpoints = ENDPOINTS.filter(e => e.category === 'structural');
  const roomEndpoints       = ENDPOINTS.filter(e => e.category === 'room');

  // ── Fire all models + workflow in parallel ─────────────────────────────
  const [structuralResults, roomModelResults, workflowPreds] = await Promise.all([

    // Structural model (CubiCasa v6): walls, doors, windows
    Promise.all(
      structuralEndpoints.map(async (config) => {
        try {
          const result = await proxyModel(base64, config, signal);
          endpointStatus[config.id] = 'ok';
          return { config, data: result };
        } catch (e: any) {
          endpointStatus[config.id] = 'failed';
          console.warn(`[detectRooms] structural ${config.id} failed:`, e.message);
          return { config, data: { predictions: [] as RoboflowPrediction[] } };
        }
      }),
    ),

    // Room + fixture models
    Promise.all(
      roomEndpoints.map(async (config) => {
        try {
          const result = await proxyModel(base64, config, signal);
          endpointStatus[config.id] = 'ok';
          console.log(
            `[detectRooms] room model ${config.id} classes:`,
            result.predictions?.map(p => `${p.class}(${p.confidence.toFixed(2)})`),
          );
          return { config, data: result };
        } catch (e: any) {
          endpointStatus[config.id] = 'failed';
          console.warn(`[detectRooms] room model ${config.id} failed:`, e.message);
          return { config, data: { predictions: [] as RoboflowPrediction[] } };
        }
      }),
    ),

    // Workflow: general-segmentation fallback
    (async (): Promise<WorkflowPrediction[]> => {
      try {
        const preds = await proxyWorkflow(base64, WORKFLOW, signal);
        endpointStatus[WORKFLOW.workflowId] = 'ok';
        return preds;
      } catch (e: any) {
        endpointStatus[WORKFLOW.workflowId] = 'failed';
        console.warn(`[detectRooms] workflow failed:`, e.message);
        return [];
      }
    })(),
  ]);

  if (signal?.aborted) return [];

  // ─── Image dimensions ─────────────────────────────────────────────────
  const imgW = structuralResults[0]?.data.image?.width  ?? canvas.width;
  const imgH = structuralResults[0]?.data.image?.height ?? canvas.height;

  // ─── Structural predictions (CubiCasa v6) ─────────────────────────────
  const allCubiCasaPreds   = structuralResults.flatMap(r => r.data.predictions ?? []);
  const cubiCasaStructural = allCubiCasaPreds
    .filter(p => p.confidence >= MIN_CONFIDENCE && isStructuralClass(p.class))
    .map(p => predToRoom(p, imgW, imgH, 'structural', 'cubicasa'));

  const cubiCasaRooms = allCubiCasaPreds
    .filter(p => p.confidence >= MIN_CONFIDENCE && !isStructuralClass(p.class))
    .map(p => predToRoom(p, imgW, imgH, 'room', 'cubicasa'));

  console.log(
    `[detectRooms] CubiCasa: ${cubiCasaStructural.length} structural, ${cubiCasaRooms.length} bonus room polygons`,
  );

  // ─── Room + fixture model predictions ─────────────────────────────────
  const allRoomModelPreds = roomModelResults.flatMap(r => r.data.predictions ?? []);

  const roomsFromModel: DetectedRoom[] = allRoomModelPreds
    .filter(p => p.confidence >= MIN_CONFIDENCE && !isStructuralClass(p.class))
    .map(p => predToRoom(p, imgW, imgH, 'room', 'room-model'));

  const structuralFromRoomModel: DetectedRoom[] = allRoomModelPreds
    .filter(p => p.confidence >= MIN_CONFIDENCE && isStructuralClass(p.class))
    .map(p => predToRoom(p, imgW, imgH, 'structural', 'room-model'));

  console.log(
    `[detectRooms] Room/fixture models: ${roomsFromModel.length} room/fixture polygons, ${structuralFromRoomModel.length} structural`,
  );

  // ─── Workflow predictions ──────────────────────────────────────────────
  const roomsFromWorkflow: DetectedRoom[] = workflowPreds
    .filter(p => p.confidence >= MIN_CONFIDENCE && !isStructuralClass(p.class))
    .map(p => predToRoom(p, imgW, imgH, 'room', 'workflow'));

  const structuralFromWorkflow: DetectedRoom[] = workflowPreds
    .filter(p => p.confidence >= MIN_CONFIDENCE && isStructuralClass(p.class))
    .map(p => predToRoom(p, imgW, imgH, 'structural', 'workflow'));

  console.log(
    `[detectRooms] Workflow: ${roomsFromWorkflow.length} room polygons, ${structuralFromWorkflow.length} structural`,
  );

  if (signal?.aborted) return [];

  // ─── Room source priority ──────────────────────────────────────────────
  let candidateRooms: DetectedRoom[];

  if (roomsFromModel.length > 0) {
    console.log(`[detectRooms] Using room/fixture models: ${roomsFromModel.length} detections`);
    candidateRooms = roomsFromModel;
  } else if (roomsFromWorkflow.length > 0) {
    console.log(`[detectRooms] Using workflow rooms: ${roomsFromWorkflow.length} rooms`);
    candidateRooms = roomsFromWorkflow;
  } else if (cubiCasaRooms.length > 0) {
    console.log(`[detectRooms] Using CubiCasa bonus rooms: ${cubiCasaRooms.length} rooms`);
    candidateRooms = cubiCasaRooms;
  } else {
    console.warn('[detectRooms] ⚠️  No room polygons from any model — all sources exhausted');
    candidateRooms = [];
  }

  // ─── OCR refinement ───────────────────────────────────────────────────
  let finalRooms: DetectedRoom[];
  if (candidateRooms.length > 0) {
    console.log(`[detectRooms] Running OCR refinement on ${candidateRooms.length} polygons`);
    finalRooms = await classifyRoomsWithOCR(candidateRooms, canvas, signal);
    console.log('[detectRooms] OCR refinement complete');
  } else {
    finalRooms = [];
  }

  if (signal?.aborted) return [];

  // ─── Merge & NMS ──────────────────────────────────────────────────────
  const allStructural = nms([
    ...cubiCasaStructural,
    ...structuralFromRoomModel,
    ...structuralFromWorkflow,
  ]);
  const allRooms = nms(finalRooms);
  const all      = [...allStructural, ...allRooms];

  const summary: DetectionSummary = {
    structural: allStructural.length,
    rooms:      allRooms.length,
    inferred:   allRooms.filter(r => r.source?.includes('heuristic')).length,
    endpoints:  endpointStatus,
    durationMs: Date.now() - t0,
  };
  console.log('[detectRooms] 📊 Summary:', summary);

  const typeSummary = all.reduce((acc, d) => {
    acc[d.label] = (acc[d.label] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log('[detectRooms] Detected types:', typeSummary);

  return all;
}

// ─── Canvas → base64 ────────────────────────────────────────────────────────

async function canvasToBase64(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): Promise<string> {
  if (canvas instanceof HTMLCanvasElement) {
    return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
  }
  const blob   = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  const buffer = await blob.arrayBuffer();
  const bytes  = new Uint8Array(buffer);
  let binary   = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

// ─── Label helpers ───────────────────────────────────────────────────────────

export function areaHeuristicLabel(areaNorm: number): string {
  if (areaNorm > 0.18) return 'OPEN PLAN';
  if (areaNorm > 0.10) return 'BOARDROOM';
  if (areaNorm > 0.06) return 'MEETING ROOM';
  if (areaNorm > 0.03) return 'OFFICE';
  if (areaNorm > 0.018) return 'SMALL OFFICE';
  if (areaNorm > 0.010) return 'BREAKOUT';
  if (areaNorm > 0.005) return 'CORRIDOR';
  if (areaNorm > 0.003) return 'LOBBY';
  return 'STORAGE';
}

export function areaRelativeLabel(areaNorm: number, largestAreaNorm: number): string {
  if (largestAreaNorm < 0.01) return areaHeuristicLabel(areaNorm);
  const ratio = areaNorm / largestAreaNorm;
  if (ratio > 0.80) return 'OPEN PLAN';
  if (ratio > 0.45) return 'BOARDROOM';
  if (ratio > 0.25) return 'MEETING ROOM';
  if (ratio > 0.12) return 'OFFICE';
  if (ratio > 0.06) return 'SMALL OFFICE';
  if (ratio > 0.03) return 'BREAKOUT';
  if (ratio > 0.01) return 'CORRIDOR';
  if (ratio > 0.005) return 'LOBBY';
  return 'STORAGE';
}

export function buildRelativeLabelFn(
  rooms: Array<{ areaNorm: number }>,
): (areaNorm: number) => string {
  const largest = rooms.reduce((max, r) => Math.max(max, r.areaNorm), 0);
  return (areaNorm: number) => areaRelativeLabel(areaNorm, largest);
}
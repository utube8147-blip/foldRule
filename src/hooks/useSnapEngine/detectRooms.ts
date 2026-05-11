// hooks/useSnapEngine/detectRooms.ts

import type { WallLineNorm } from '@/types/viewerTypes';

export interface DetectedRoom {
  polygon: Array<{ nx: number; ny: number }>;
  areaNorm: number;
  label: string;
  centroid: { nx: number; ny: number };
  id: string;
}

export const SCALE = 0.45;

/** Minimum confidence threshold */
const MIN_CONFIDENCE = 0.1;

/** Roboflow model endpoint */
const ROBOFLOW_URL = 'https://serverless.roboflow.com/cubicasa5k-2-qpmsa/3';

async function canvasToBase64(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): Promise<string> {
  if (canvas instanceof HTMLCanvasElement) {
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    return dataUrl.split(',')[1];
  }

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

interface RoboflowPrediction {
  class: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

interface RoboflowResponse {
  predictions: RoboflowPrediction[];
  image?: { width: number; height: number };
}

async function callRoboflow(
  base64: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<RoboflowResponse> {
  const url = `${ROBOFLOW_URL}?api_key=${encodeURIComponent(apiKey)}`;
  
  console.log('[detectRooms] Calling Roboflow API...');
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: base64,
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Roboflow API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  console.log(`[detectRooms] Received ${data.predictions?.length || 0} predictions`);
  
  return data;
}

function predictionToRoom(
  pred: RoboflowPrediction,
  imgW: number,
  imgH: number,
): DetectedRoom {
  // Convert bbox to polygon (4 corners)
  const x0 = (pred.x - pred.width / 2) / imgW;
  const y0 = (pred.y - pred.height / 2) / imgH;
  const x1 = (pred.x + pred.width / 2) / imgW;
  const y1 = (pred.y + pred.height / 2) / imgH;

  const nx0 = Math.max(0, Math.min(1, x0));
  const ny0 = Math.max(0, Math.min(1, y0));
  const nx1 = Math.max(0, Math.min(1, x1));
  const ny1 = Math.max(0, Math.min(1, y1));

  const polygon = [
    { nx: nx0, ny: ny0 },
    { nx: nx1, ny: ny0 },
    { nx: nx1, ny: ny1 },
    { nx: nx0, ny: ny1 },
  ];

  const areaNorm = (nx1 - nx0) * (ny1 - ny0);
  const centroid = { nx: (nx0 + nx1) / 2, ny: (ny0 + ny1) / 2 };
  
  // Use uppercase class name as label
  const label = pred.class.toUpperCase();
  const id = `${pred.class}-${Math.round(pred.x)}-${Math.round(pred.y)}`;

  return { polygon, areaNorm, label, centroid, id };
}

// Main export function
export async function detectRooms(
  wallLines: WallLineNorm[],
  dims: { w: number; h: number },
  signal?: AbortSignal,
  _wallThickness?: number,
  canvas?: HTMLCanvasElement | OffscreenCanvas | null,
  apiKey?: string,
): Promise<DetectedRoom[]> {

  console.log('[detectRooms] Starting detection...');
  
  if (!canvas) {
    console.warn('[detectRooms] No canvas provided');
    return [];
  }

  if (!apiKey) {
    console.warn('[detectRooms] No API key provided');
    return [];
  }

  try {
    const base64 = await canvasToBase64(canvas);
    if (signal?.aborted) return [];

    const data = await callRoboflow(base64, apiKey, signal);
    if (signal?.aborted) return [];

    const imgW = data.image?.width ?? canvas.width;
    const imgH = data.image?.height ?? canvas.height;
    
    const predictions = data.predictions ?? [];
    
    if (predictions.length === 0) {
      console.warn('[detectRooms] No predictions received');
      return [];
    }
    
    const allDetections = predictions
      .filter(p => p.confidence >= MIN_CONFIDENCE)
      .map(p => predictionToRoom(p, imgW, imgH));
    
    console.log(`[detectRooms] Returning ${allDetections.length} predictions`);
    return allDetections;
  } catch (error) {
    console.error('[detectRooms] Error:', error);
    return [];
  }
}

// Helper functions
export function areaHeuristicLabel(areaNorm: number): string {
  if (areaNorm > 0.18) return 'Open Plan';
  if (areaNorm > 0.10) return 'Boardroom';
  if (areaNorm > 0.06) return 'Meeting Room';
  if (areaNorm > 0.03) return 'Office';
  if (areaNorm > 0.018) return 'Small Office';
  if (areaNorm > 0.010) return 'Breakout';
  if (areaNorm > 0.005) return 'Corridor';
  if (areaNorm > 0.003) return 'Lobby';
  return 'Storage';
}

export function areaRelativeLabel(areaNorm: number, largestAreaNorm: number): string {
  if (largestAreaNorm < 0.01) return areaHeuristicLabel(areaNorm);
  const ratio = areaNorm / largestAreaNorm;
  if (ratio > 0.80) return 'Open Plan';
  if (ratio > 0.45) return 'Boardroom';
  if (ratio > 0.25) return 'Meeting Room';
  if (ratio > 0.12) return 'Office';
  if (ratio > 0.06) return 'Small Office';
  if (ratio > 0.03) return 'Breakout';
  if (ratio > 0.01) return 'Corridor';
  if (ratio > 0.005) return 'Lobby';
  return 'Storage';
}

export function buildRelativeLabelFn(
  rooms: Array<{ areaNorm: number }>,
): (areaNorm: number) => string {
  const largest = rooms.reduce((max, r) => Math.max(max, r.areaNorm), 0);
  return (areaNorm: number) => areaRelativeLabel(areaNorm, largest);
}
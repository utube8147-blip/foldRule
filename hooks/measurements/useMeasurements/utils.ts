import { TakeoffRow } from '@/types';
import { PdfDimensions } from '@/types/viewerTypes';

/**
 * Convert normalized coordinates (0-1) to canvas coordinates
 */
export function toCanvas(
  normX: number,
  normY: number,
  dims: PdfDimensions | null
): { x: number; y: number } {
  if (!dims) return { x: normX, y: normY };
  return { x: normX * dims.w, y: normY * dims.h };
}

/**
 * Convert canvas coordinates to normalized coordinates (0-1)
 */
export function toNorm(
  canvasX: number,
  canvasY: number,
  dims: PdfDimensions | null
): { x: number; y: number } {
  if (!dims) return { x: canvasX, y: canvasY };
  return { x: canvasX / dims.w, y: canvasY / dims.h };
}

/**
 * Calculate distance between two points
 */
export function calculateDistance(
  p1: { x: number; y: number },
  p2: { x: number; y: number }
): number {
  return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

/**
 * Calculate area using Shoelace formula
 */
export function calculatePolygonArea(points: { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(area) / 2;
}

/**
 * Recalculate measurement quantity based on updated points
 */
export function recalculateMeasurementQuantity(
  measurement: TakeoffRow,
  updatedPoints: { x: number; y: number }[],
  toCanvasFunc: (normX: number, normY: number) => { x: number; y: number },
  zoom: number,
  scaleFactor: number
): { quantity: number; unit: string } {
  switch (measurement.type) {
    case 'Length': {
      let len = 0;
      for (let i = 1; i < updatedPoints.length; i++) {
        const p1 = toCanvasFunc(updatedPoints[i - 1].x, updatedPoints[i - 1].y);
        const p2 = toCanvasFunc(updatedPoints[i].x, updatedPoints[i].y);
        len += calculateDistance(p1, p2);
      }
      const quantity = (len / zoom) * scaleFactor;
      return { quantity, unit: 'm' };
    }

    case 'Polygon': {
      const canvasPoints = updatedPoints.map(pt =>
        toCanvasFunc(pt.x, pt.y)
      );
      // Cut-outs are deducted.
      const holes = (measurement.holes ?? []).reduce(
        (t, h) => t + calculatePolygonArea(h.map(pt => toCanvasFunc(pt.x, pt.y))), 0);
      const area = Math.max(0, calculatePolygonArea(canvasPoints) - holes);
      const quantity = (area / (zoom * zoom)) * (scaleFactor * scaleFactor);
      return { quantity, unit: 'sq m' };
    }

    case 'Rectangle': {
      if (updatedPoints.length !== 4) {
        const p1 = toCanvasFunc(updatedPoints[0].x, updatedPoints[0].y);
        const p2 = toCanvasFunc(updatedPoints[2].x, updatedPoints[2].y);
        const r4 = [
          { x: p1.x, y: p1.y },
          { x: p2.x, y: p1.y },
          { x: p2.x, y: p2.y },
          { x: p1.x, y: p2.y },
        ];
        const area = calculatePolygonArea(r4);
        const quantity = (area / (zoom * zoom)) * (scaleFactor * scaleFactor);
        return { quantity, unit: 'sq m' };
      }
      const canvasPoints = updatedPoints.map(pt =>
        toCanvasFunc(pt.x, pt.y)
      );
      const area = calculatePolygonArea(canvasPoints);
      const quantity = (area / (zoom * zoom)) * (scaleFactor * scaleFactor);
      return { quantity, unit: 'sq m' };
    }

    case 'Count':
    case 'Point':
      return { quantity: measurement.quantity, unit: measurement.unit };

    default:
      return { quantity: measurement.quantity, unit: measurement.unit };
  }
}

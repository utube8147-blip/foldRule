// hooks/detectPillars.ts
//
// PILLAR / COLUMN DETECTION - Pure geometry-based detection
// Detects pillars and columns in floor plans without requiring calibration

import type { SvgArea, Vec2 } from './useSvgInteraction';

// ─── Constants ────────────────────────────────────────────────────────────────

// Geometry thresholds (scale-invariant)
export const PILLAR_CONFIG = {
  MIN_EDGES: 3,           // Any polygon with 3-8 edges
  MAX_EDGES: 8,           
  MIN_COMPACTNESS: 0.4,   // Even lower - catch more pillars
  MAX_AREA_FRAC: 0.05,    // 5% of canvas - larger threshold
  MIN_SOLIDITY: 0.5,      // Lower threshold
  MAX_CONNECTIONS: 3,     // Allow up to 3 connections
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Face {
  id: number;
  points: Vec2[];
  area: number;
  perimeter: number;
  isOuter: boolean;
  connections?: number[];  // Make optional for compatibility
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

export function computeBounds(pts: Vec2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function dist(a: Vec2, b: Vec2) { 
  return Math.hypot(b.x - a.x, b.y - a.y); 
}

export function calculatePerimeter(pts: Vec2[]): number {
  let perimeter = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    perimeter += dist(pts[i], pts[j]);
  }
  return perimeter;
}

export function calculateCompactness(area: number, perimeter: number): number {
  if (perimeter === 0) return 0;
  return (4 * Math.PI * area) / (perimeter * perimeter);
}

export function calculatePolygonArea(points: Vec2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return Math.abs(area) / 2;
}

export function calculateSolidity(points: Vec2[]): number {
  if (points.length < 3) return 0;
  const bounds = computeBounds(points);
  const convexArea = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
  const actualArea = calculatePolygonArea(points);
  return convexArea > 0 ? actualArea / convexArea : 0;
}

export function isConvexPolygon(points: Vec2[]): boolean {
  if (points.length < 3) return false;
  let prevSign = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const p3 = points[(i + 2) % points.length];
    const cross = (p2.x - p1.x) * (p3.y - p2.y) - (p2.y - p1.y) * (p3.x - p2.x);
    const sign = Math.sign(cross);
    if (sign !== 0) {
      if (prevSign === 0) prevSign = sign;
      else if (sign !== prevSign) return false;
    }
  }
  return true;
}

export function doFacesShareEdge(face1: Face, face2: Face, tolerance: number = 2): boolean {
  for (let i = 0; i < face1.points.length; i++) {
    const a1 = face1.points[i];
    const a2 = face1.points[(i + 1) % face1.points.length];
    for (let j = 0; j < face2.points.length; j++) {
      const b1 = face2.points[j];
      const b2 = face2.points[(j + 1) % face2.points.length];
      const d1 = dist(a1, b1);
      const d2 = dist(a1, b2);
      const d3 = dist(a2, b1);
      const d4 = dist(a2, b2);
      if (d1 < tolerance || d2 < tolerance || d3 < tolerance || d4 < tolerance) {
        const cross = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
        if (Math.abs(cross) < tolerance) return true;
      }
    }
  }
  return false;
}

// ─── Main pillar detection function ──────────────────────────────────────────

export function isPillar(face: Face, totalArea: number): boolean {
  const points = face.points;
  const edgeCount = points.length;
  const compactness = calculateCompactness(face.area, face.perimeter);
  const solidity = calculateSolidity(points);
  const isConvex = isConvexPolygon(points);
  const maxPillarArea = totalArea * PILLAR_CONFIG.MAX_AREA_FRAC;
  
  // Size check - must be small
  const isSmallEnough = face.area < maxPillarArea;
  
  // Shape check - must be convex with reasonable edges
  const hasValidShape = edgeCount >= PILLAR_CONFIG.MIN_EDGES &&
                        edgeCount <= PILLAR_CONFIG.MAX_EDGES &&
                        isConvex;
  
  // Compactness check - must be relatively compact
  const isCompact = compactness > PILLAR_CONFIG.MIN_COMPACTNESS;
  
  // Solidity check - must be solid (no holes)
  const isSolid = solidity > PILLAR_CONFIG.MIN_SOLIDITY;
  
  // Connection check - pillars shouldn't connect to many rooms
  const connectionCount = face.connections?.length ?? 0;
  const hasLimitedConnections = connectionCount <= PILLAR_CONFIG.MAX_CONNECTIONS;
  
  // Log for debugging
  if (isSmallEnough && hasValidShape) {
    console.log(`[PillarCheck] edges=${edgeCount}, area=${face.area.toFixed(0)}/${maxPillarArea.toFixed(0)}, compactness=${compactness.toFixed(3)}, convex=${isConvex}, connections=${connectionCount}`);
  }
  
  return isSmallEnough && hasValidShape && isCompact && isSolid && hasLimitedConnections;
}

// ─── Simplified detection for use in detectRooms ─────────────────────────────

export function isPillarByGeometry(
  points: Vec2[],
  area: number,
  perimeter: number,
  totalArea: number,
  connectionCount: number = 0
): boolean {
  const edgeCount = points.length;
  const compactness = calculateCompactness(area, perimeter);
  const solidity = calculateSolidity(points);
  const isConvex = isConvexPolygon(points);
  const maxPillarArea = totalArea * PILLAR_CONFIG.MAX_AREA_FRAC;
  
  return edgeCount >= PILLAR_CONFIG.MIN_EDGES &&
         edgeCount <= PILLAR_CONFIG.MAX_EDGES &&
         area < maxPillarArea &&
         isConvex &&
         compactness > PILLAR_CONFIG.MIN_COMPACTNESS &&
         solidity > PILLAR_CONFIG.MIN_SOLIDITY &&
         connectionCount <= PILLAR_CONFIG.MAX_CONNECTIONS;
}
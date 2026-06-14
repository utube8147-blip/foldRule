'use client';
// ─── hooks/perimeterOffset/usePerimeterOffset.ts ──────────────────────────────
//
//  FIXES IN THIS REVISION
//  ──────────────────────
//  FIX 1 (previous): isValidOpenSource now handles group headers via
//         getEffectivePoints() instead of row.points (always [] on headers).
//
//  FIX 2 (this revision): CHILD ROWS EXCLUDED FROM OPEN/CLOSED SOURCE
//         isValidOpenSource and isValidSource now immediately return false
//         for any row that has a `parentId` set. Child rows are segments of
//         a group; the group header (the full stitched path) is the correct
//         unit to offset. Without this, each individual line/arc child of a
//         polyarc group passes isValidOpenSource independently, appearing as
//         separate eligible shapes in the canvas overlay and hit-testing —
//         making it impossible to select the full compound path.
//
//         Combined with Viewer.tsx also skipping parentId rows when building
//         offsetEligiblePolygons / findOffsetHit, the full stitched group
//         header is now the only eligible shape for multi-segment open paths.
//
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback } from 'react';
import { TakeoffRow } from '@/types';
import type { PdfDimensions } from '@/types/viewerTypes';
import {
  computePerimeterOffset,
  computeOpenPathOffset,
  openPathBufferAreaMetres2,
  openPathOffsetLengthMetres,
  polygonAreaMetres2,
  polygonPerimeterMetres,
  isEffectivelyClosed,
  isInwardCollapseRisk,
  computeInscribedCircleRadius,
  getEffectivePoints,
  tessellatePoints,
  type OffsetDirection,
  type JoinStyle,
  type OpenPathDirection,
  type OpenEndStyle,
} from './perimeterOffsetGeometry';

export { isEffectivelyClosed } from './perimeterOffsetGeometry';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OffsetOutputType =
  | 'area'
  | 'length'
  | 'donut'
  | 'donut-both'
  | 'perimeter-both';

export type OpenOutputType =
  | 'parallel-length'
  | 'buffer-area'
  | 'one-side-area';

export interface CommitOffsetParams {
  sourceMeasurement: TakeoffRow;
  offsetMetres:      number;
  direction:         OffsetDirection;
  outputType:        OffsetOutputType;
  label:             string;
  joinStyle?:        JoinStyle;
  outwardMetres?:    number;
  inwardMetres?:     number;
}

export interface CommitOpenPathParams {
  sourceMeasurement: TakeoffRow;
  offsetMetres:      number;
  direction:         OpenPathDirection;
  outputType:        OpenOutputType;
  label:             string;
  joinStyle?:        JoinStyle;
  endStyle?:         OpenEndStyle;
}

export interface CommitOffsetResult {
  error:   string | null;
  warning: string | null;
}

interface UsePerimeterOffsetParams {
  measurements:            TakeoffRow[];
  batchCommitMeasurements: (rows: TakeoffRow[]) => void;
  updateMeasurement:       (id: string, updates: Partial<TakeoffRow>) => void;
  pdfDimensionsRef:        React.RefObject<PdfDimensions | null>;
  scaleRef:                React.RefObject<number>;
  scaleFactor:             number;
  activeDrawingId:         string | null;
}

export interface UsePerimeterOffsetReturn {
  commitOffset:         (params: CommitOffsetParams) => CommitOffsetResult;
  batchCommitOffsets:   (params: CommitOffsetParams[], options?: BatchCommitOptions) => CommitOffsetResult;
  commitOpenPathOffset: (params: CommitOpenPathParams) => CommitOffsetResult;
  previewOffset:        (source: TakeoffRow, offsetMetres: number, direction: OffsetDirection) => Array<{ x: number; y: number }>[] | null;
  previewOpenOffset:    (
    source:       TakeoffRow,
    offsetMetres: number,
    direction:    OpenPathDirection,
    joinStyle?:   JoinStyle,
    endStyle?:    OpenEndStyle,
  ) => Array<{ x: number; y: number }>[] | null;
  isValidSource:        (row: TakeoffRow) => boolean;
  isValidOpenSource:    (row: TakeoffRow) => boolean;
  isEffectivelyClosed:  (row: TakeoffRow) => boolean;
  getCollapseRadius:    (row: TakeoffRow) => number;
}

export interface BatchCommitOptions {
  cumulative?: boolean;
}

// ─── Sentinel helpers ─────────────────────────────────────────────────────────

const SENTINEL_IDS = new Set(['__arc_break__', '__radius_break__']);
function isSentinelPoint(p: any): boolean {
  return p?.segmentId != null && SENTINEL_IDS.has(p.segmentId);
}
function countRealPoints(points: any[]): number {
  return points.filter((p: any) => !isSentinelPoint(p)).length;
}

// ─── usePerimeterOffset ───────────────────────────────────────────────────────

export function usePerimeterOffset({
  measurements,
  batchCommitMeasurements,
  updateMeasurement,
  pdfDimensionsRef,
  scaleRef,
  scaleFactor,
  activeDrawingId,
}: UsePerimeterOffsetParams): UsePerimeterOffsetReturn {

  // ── isValidSource (closed shapes) ─────────────────────────────────────────
  //
  //  FIX 2: reject child rows immediately. Children are segments of a group;
  //  only the group header (stitched via getEffectivePoints) should be
  //  offset-eligible as a whole.
  const isValidSource = useCallback((row: TakeoffRow): boolean => {
    if (!row) return false;
    if (row.type === 'Count' || row.type === 'Point') return false;

    // FIX 2: child rows are never independently eligible
    if ((row as any).parentId) return false;

    if (row.type === 'Polygon' || row.type === 'Rectangle' || row.type === 'Area') {
      return (row.points?.length ?? 0) >= 3;
    }

    if (row.type === 'Length') {
      if (row.isGroupHeader) {
        if (!row.childIds?.length) return false;
        const effectivePts = getEffectivePoints(row, measurements);
        if (!effectivePts || effectivePts.length < 2) return false;
        if (countRealPoints(effectivePts) < 3) return false;
        return isEffectivelyClosed(row, measurements);
      }

      if ((row as any).arcRadius != null) {
        const isFullCircle = Math.abs(((row as any).sweepAngle ?? 0) - 2 * Math.PI) < 0.01;
        if (isFullCircle) return true;
        return isEffectivelyClosed(row, measurements);
      }

      const rawPts = row.points ?? [];
      if (countRealPoints(rawPts) < 3) return false;
      return isEffectivelyClosed(row, measurements);
    }

    return false;
  }, [measurements]);

  // ── isValidOpenSource (open linear paths) ─────────────────────────────────
  //
  //  FIX 2: reject child rows immediately — same reasoning as isValidSource.
  //  Without this, each line/arc child of a polyarc group is independently
  //  eligible, making the full compound path impossible to select as a unit.
  //
  //  A group header is a valid OPEN source when:
  //    • row.type === 'Length'
  //    • no parentId (not a child segment)
  //    • it has childIds
  //    • its stitched effective points have >= 2 real points
  //    • it is NOT effectively closed
  //
  //  A standalone (non-header, non-child) row is a valid OPEN source when:
  //    • row.type === 'Length'
  //    • no parentId
  //    • it has >= 2 real points
  //    • it is NOT effectively closed
  const isValidOpenSource = useCallback((row: TakeoffRow): boolean => {
    if (!row) return false;
    if (row.type !== 'Length') return false;

    // FIX 2: child rows are never independently eligible
    if ((row as any).parentId) return false;

    if (row.isGroupHeader) {
      if (!row.childIds?.length) return false;
      const effectivePts = getEffectivePoints(row, measurements);
      if (!effectivePts || effectivePts.length < 2) return false;
      if (countRealPoints(effectivePts) < 2) return false;
      return !isEffectivelyClosed(row, measurements);
    }

    const rawPts    = row.points ?? [];
    const realCount = countRealPoints(rawPts);
    if (realCount < 2) return false;

    return !isEffectivelyClosed(row, measurements);
  }, [measurements]);

  // ── isClosedWrapper ────────────────────────────────────────────────────────
  const isClosedWithMeasurements = useCallback((row: TakeoffRow): boolean => {
    return isEffectivelyClosed(row, measurements);
  }, [measurements]);

  // ── getCollapseRadius ──────────────────────────────────────────────────────
  const getCollapseRadius = useCallback((row: TakeoffRow): number => {
    const dim = pdfDimensionsRef.current;
    if (!dim) return 0;
    return computeInscribedCircleRadius(
      row, dim, scaleRef.current, scaleFactor, measurements,
    );
  }, [pdfDimensionsRef, scaleRef, scaleFactor, measurements]);

  // ── _runOffset (closed path) ───────────────────────────────────────────────
  const _runOffset = useCallback((
    source:       TakeoffRow,
    offsetMetres: number,
    direction:    OffsetDirection,
    joinStyle:    JoinStyle = 'miter',
  ): Array<{ x: number; y: number }>[] | null => {
    const dim = pdfDimensionsRef.current;
    if (!dim) return null;
    const results = computePerimeterOffset(
      source, offsetMetres, direction,
      dim, scaleRef.current, scaleFactor, measurements, joinStyle,
    );
    return results.length > 0 ? results : null;
  }, [pdfDimensionsRef, scaleRef, scaleFactor, measurements]);

  // ── _runOpenOffset ─────────────────────────────────────────────────────────
  const _runOpenOffset = useCallback((
    source:       TakeoffRow,
    offsetMetres: number,
    direction:    OpenPathDirection,
    joinStyle:    JoinStyle    = 'miter',
    endStyle:     OpenEndStyle = 'square',
  ): Array<{ x: number; y: number }>[] | null => {
    const dim = pdfDimensionsRef.current;
    if (!dim) return null;
    const results = computeOpenPathOffset(
      source, offsetMetres, direction,
      dim, scaleRef.current, scaleFactor, measurements, joinStyle, endStyle,
    );
    return results.length > 0 ? results : null;
  }, [pdfDimensionsRef, scaleRef, scaleFactor, measurements]);

  // ── previewOffset (closed) ─────────────────────────────────────────────────
  const previewOffset = useCallback((
    sourceMeasurement: TakeoffRow,
    offsetMetres:      number,
    direction:         OffsetDirection,
  ): Array<{ x: number; y: number }>[] | null => {
    if (!isValidSource(sourceMeasurement)) return null;
    if (offsetMetres <= 0)                 return null;
    return _runOffset(sourceMeasurement, offsetMetres, direction);
  }, [isValidSource, _runOffset]);

  // ── previewOpenOffset ──────────────────────────────────────────────────────
  const previewOpenOffset = useCallback((
    sourceMeasurement: TakeoffRow,
    offsetMetres:      number,
    direction:         OpenPathDirection,
    joinStyle:         JoinStyle    = 'miter',
    endStyle:          OpenEndStyle = 'square',
  ): Array<{ x: number; y: number }>[] | null => {
    if (!isValidOpenSource(sourceMeasurement)) return null;
    if (offsetMetres <= 0)                     return null;
    return _runOpenOffset(sourceMeasurement, offsetMetres, direction, joinStyle, endStyle);
  }, [isValidOpenSource, _runOpenOffset]);

  // ── _computeSourceAreaMetres2 ──────────────────────────────────────────────
  const _computeSourceAreaMetres2 = useCallback((sourceMeasurement: TakeoffRow): number => {
    const dim = pdfDimensionsRef.current;
    if (!dim) return 0;
    return polygonAreaMetres2(
      sourceMeasurement, dim, scaleRef.current, scaleFactor, measurements,
    );
  }, [pdfDimensionsRef, scaleRef, scaleFactor, measurements]);

  // ── _buildChildren ─────────────────────────────────────────────────────────
  const _buildChildren = useCallback((
    sourceMeasurement: TakeoffRow,
    resultPolygons:    Array<{ x: number; y: number }>[],
    outputType:        OffsetOutputType,
    label:             string,
    offsetMetres:      number,
    direction:         OffsetDirection,
    groupId:           string,
    cachedSourceArea?: number,
  ): TakeoffRow[] => {
    const dim       = pdfDimensionsRef.current!;
    const drawingId = activeDrawingId ?? '';
    const color     = sourceMeasurement.color;

    return resultPolygons.map((poly, i) => {
      const suffix  = resultPolygons.length > 1 ? ` ${i + 1}` : '';
      const desc    = `${label}${suffix}`;

      const first = poly[0];
      const last  = poly[poly.length - 1];
      const isAlreadyClosed =
        poly.length >= 2 &&
        Math.abs(first.x - last.x) < 1e-9 &&
        Math.abs(first.y - last.y) < 1e-9;
      const closedPoly = isAlreadyClosed ? poly : [...poly, { x: first.x, y: first.y }];

      const offsetPolyRow = { type: 'Polygon', points: poly, isGroupHeader: false };
      const srcLabel      = sourceMeasurement.label ?? sourceMeasurement.description;

      let quantity: number;
      let unit:     string;
      let type:     TakeoffRow['type'];
      let notes:    string;

      if (outputType === 'area') {
        quantity = +polygonAreaMetres2(offsetPolyRow, dim, scaleRef.current, scaleFactor, measurements).toFixed(4);
        unit     = 'sq m';
        type     = 'Polygon';
        notes    = `Offset ${direction} ${offsetMetres}m from "${srcLabel}"`;

      } else if (outputType === 'donut' || outputType === 'donut-both') {
        const offsetArea = polygonAreaMetres2(offsetPolyRow, dim, scaleRef.current, scaleFactor, measurements);
        const sourceArea = cachedSourceArea ?? _computeSourceAreaMetres2(sourceMeasurement);
        const ringArea   = Math.abs(Math.abs(offsetArea) - Math.abs(sourceArea));
        quantity = +ringArea.toFixed(4);
        unit     = 'sq m';
        type     = 'Polygon';
        notes    = `Ring area ${direction} ${offsetMetres}m from "${srcLabel}" (donut)`;

      } else {
        quantity = +polygonPerimeterMetres(offsetPolyRow, dim, scaleRef.current, scaleFactor, measurements).toFixed(4);
        unit     = 'm';
        type     = 'Length';
        notes    = `Perimeter offset ${direction} ${offsetMetres}m from "${srcLabel}"`;
      }

      return {
        id:           crypto.randomUUID(),
        drawingId,
        description:  desc,
        label:        desc,
        type,
        quantity,
        unit,
        unitRate:     0,
        notes,
        points:       closedPoly,
        isOverridden: false,
        color,
        isVisible:    true,
        parentId:     groupId,
        childIds:     [],
        derivedFrom: {
          sourceId:        sourceMeasurement.id,
          offsetDistance:  offsetMetres,
          offsetDirection: direction,
        },
      } as TakeoffRow & { derivedFrom: any };
    });
  }, [pdfDimensionsRef, scaleRef, scaleFactor, measurements, activeDrawingId, _computeSourceAreaMetres2]);

  // ── _buildOpenPathChildren ─────────────────────────────────────────────────
  const _buildOpenPathChildren = useCallback((
    sourceMeasurement: TakeoffRow,
    resultPolygons:    Array<{ x: number; y: number }>[],
    outputType:        OpenOutputType,
    label:             string,
    offsetMetres:      number,
    direction:         OpenPathDirection,
    groupId:           string,
  ): TakeoffRow[] => {
    const dim       = pdfDimensionsRef.current!;
    const drawingId = activeDrawingId ?? '';
    const color     = sourceMeasurement.color;
    const srcLabel  = sourceMeasurement.label ?? sourceMeasurement.description;

    return resultPolygons.map((poly, i) => {
      const suffix = resultPolygons.length > 1 ? ` ${i + 1}` : '';
      const desc   = `${label}${suffix}`;

      const first           = poly[0];
      const last            = poly[poly.length - 1];
      const isAlreadyClosed =
        poly.length >= 2 &&
        Math.abs(first.x - last.x) < 1e-9 &&
        Math.abs(first.y - last.y) < 1e-9;
      const closedPoly      = isAlreadyClosed ? poly : [...poly, { x: first.x, y: first.y }];
      const offsetPolyRow   = { type: 'Polygon', points: poly, isGroupHeader: false };

      let quantity: number;
      let unit:     string;
      let type:     TakeoffRow['type'];
      let notes:    string;

      if (outputType === 'parallel-length') {
        quantity = +openPathOffsetLengthMetres(
          sourceMeasurement, offsetMetres, direction,
          dim, scaleRef.current, scaleFactor, measurements,
        ).toFixed(4);
        unit  = 'm';
        type  = 'Length';
        notes = `Parallel offset ${direction} ${offsetMetres}m from "${srcLabel}"`;

      } else {
        quantity = +polygonAreaMetres2(
          offsetPolyRow, dim, scaleRef.current, scaleFactor, measurements,
        ).toFixed(4);
        unit  = 'sq m';
        type  = 'Polygon';
        notes = outputType === 'buffer-area'
          ? `Buffer corridor ±${offsetMetres}m from "${srcLabel}"`
          : `One-side area ${direction} ${offsetMetres}m from "${srcLabel}"`;
      }

      return {
        id:           crypto.randomUUID(),
        drawingId,
        description:  desc,
        label:        desc,
        type,
        quantity,
        unit,
        unitRate:     0,
        notes,
        points:       closedPoly,
        isOverridden: false,
        color,
        isVisible:    true,
        parentId:     groupId,
        childIds:     [],
        derivedFrom: {
          sourceId:        sourceMeasurement.id,
          offsetDistance:  offsetMetres,
          offsetDirection: direction,
        },
      } as TakeoffRow & { derivedFrom: any };
    });
  }, [pdfDimensionsRef, scaleRef, scaleFactor, measurements, activeDrawingId]);

  // ── _promoteToGroup ────────────────────────────────────────────────────────
  const _promoteToGroup = useCallback((sourceMeasurement: TakeoffRow): { originalChild: TakeoffRow } => {
    const groupId         = sourceMeasurement.id;
    const originalChildId = crypto.randomUUID();
    const originalChild: TakeoffRow = {
      ...sourceMeasurement,
      id:            originalChildId,
      parentId:      groupId,
      isGroupHeader: false,
      childIds:      [],
      description:   sourceMeasurement.label ?? sourceMeasurement.description,
      label:         sourceMeasurement.label ?? sourceMeasurement.description,
    };
    return { originalChild };
  }, []);

  // ── _applyChildrenToTree ───────────────────────────────────────────────────
  const _applyChildrenToTree = useCallback((
    source:            TakeoffRow,
    allOffsetChildren: TakeoffRow[],
  ): null => {
    const sourceIsAlreadyGroupHeader =
      source.isGroupHeader && (source.childIds?.length ?? 0) > 0;
    const sourceIsChild = !!source.parentId;

    if (sourceIsAlreadyGroupHeader) {
      const existingChildIds = source.childIds ?? [];
      updateMeasurement(source.id, {
        childIds: [...existingChildIds, ...allOffsetChildren.map(r => r.id)],
        quantity: (source.quantity ?? 0) + allOffsetChildren.reduce((s, r) => s + r.quantity, 0),
      });
      batchCommitMeasurements(allOffsetChildren);
    } else if (sourceIsChild) {
      const parent = measurements.find(m => m.id === source.parentId);
      updateMeasurement(source.parentId!, {
        childIds: [...(parent?.childIds ?? []), ...allOffsetChildren.map(r => r.id)],
      });
      batchCommitMeasurements(allOffsetChildren);
    } else {
      const { originalChild } = _promoteToGroup(source);
      const allChildren       = [originalChild, ...allOffsetChildren];
      const totalQty          = allChildren.reduce((s, r) => s + r.quantity, 0);

      updateMeasurement(source.id, {
        isGroupHeader: true,
        isExpanded:    true,
        childIds:      allChildren.map(c => c.id),
        quantity:      totalQty,
        points:        [],
        notes:         `${allChildren.length} shapes`,
      });
      batchCommitMeasurements(allChildren);
    }

    return null;
  }, [measurements, batchCommitMeasurements, updateMeasurement, _promoteToGroup]);

  // ── commitOffset ───────────────────────────────────────────────────────────
  const commitOffset = useCallback((params: CommitOffsetParams): CommitOffsetResult => {
    const {
      sourceMeasurement, offsetMetres, direction, outputType, label,
      joinStyle = 'miter',
      outwardMetres, inwardMetres,
    } = params;

    if (!isValidSource(sourceMeasurement))
      return { error: 'Select a closed polygon or closed linear/arc/polyarc path to offset.', warning: null };
    if (offsetMetres <= 0 && !outwardMetres && !inwardMetres)
      return { error: 'Offset distance must be greater than zero.', warning: null };

    const dim = pdfDimensionsRef.current;
    if (!dim) return { error: 'PDF dimensions not available.', warning: null };

    let warning: string | null = null;
    const isInward = direction === 'inward' || outputType === 'donut-both' || outputType === 'perimeter-both';
    if (isInward) {
      const inDist  = inwardMetres ?? offsetMetres;
      const radius  = computeInscribedCircleRadius(
        sourceMeasurement, dim, scaleRef.current, scaleFactor, measurements,
      );
      if (inDist > radius * 0.95 && radius > 0) {
        warning = `Inward offset ${inDist.toFixed(3)}m may collapse the shape (max safe ≈${radius.toFixed(3)}m)`;
      }
    }

    const groupId = sourceMeasurement.id;

    if (outputType === 'perimeter-both') {
      const outDist = outwardMetres ?? offsetMetres;
      const inDist  = inwardMetres  ?? offsetMetres;

      const outwardPolys = outDist > 0 ? _runOffset(sourceMeasurement, outDist, 'outward', joinStyle) : null;
      const inwardPolys  = inDist  > 0 ? _runOffset(sourceMeasurement, inDist,  'inward',  joinStyle) : null;

      const hasOutward = outwardPolys && outwardPolys.length > 0;
      const hasInward  = inwardPolys  && inwardPolys.length  > 0;

      if (!hasOutward && !hasInward)
        return { error: 'Offset collapsed the shape — try a smaller distance.', warning };

      const allOffsetChildren: TakeoffRow[] = [];

      if (hasOutward) {
        allOffsetChildren.push(
          ..._buildChildren(
            sourceMeasurement, outwardPolys!, 'length', `${label} (outward)`,
            outDist, 'outward', groupId,
          ),
        );
      }
      if (hasInward) {
        allOffsetChildren.push(
          ..._buildChildren(
            sourceMeasurement, inwardPolys!, 'length', `${label} (inward)`,
            inDist, 'inward', groupId,
          ),
        );
      }

      _applyChildrenToTree(sourceMeasurement, allOffsetChildren);
      return { error: null, warning };
    }

    if (outputType === 'donut-both') {
      const outDist = outwardMetres ?? offsetMetres;
      const inDist  = inwardMetres  ?? offsetMetres;

      const outwardPolys = outDist > 0 ? _runOffset(sourceMeasurement, outDist, 'outward', joinStyle) : null;
      const inwardPolys  = inDist  > 0 ? _runOffset(sourceMeasurement, inDist,  'inward',  joinStyle) : null;

      const hasOutward = outwardPolys && outwardPolys.length > 0;
      const hasInward  = inwardPolys  && inwardPolys.length  > 0;

      if (!hasOutward && !hasInward)
        return { error: 'Offset collapsed the shape — try a smaller distance.', warning };

      const sourceArea = _computeSourceAreaMetres2(sourceMeasurement);
      const allOffsetChildren: TakeoffRow[] = [];

      if (hasOutward) {
        allOffsetChildren.push(
          ..._buildChildren(
            sourceMeasurement, outwardPolys!, 'donut', `${label} (outward)`,
            outDist, 'outward', groupId, sourceArea,
          ),
        );
      }
      if (hasInward) {
        allOffsetChildren.push(
          ..._buildChildren(
            sourceMeasurement, inwardPolys!, 'donut', `${label} (inward)`,
            inDist, 'inward', groupId, sourceArea,
          ),
        );
      }

      _applyChildrenToTree(sourceMeasurement, allOffsetChildren);
      return { error: null, warning };
    }

    const resultPolygons = _runOffset(sourceMeasurement, offsetMetres, direction, joinStyle);
    if (!resultPolygons || resultPolygons.length === 0)
      return { error: 'Offset collapsed the shape — try a smaller distance.', warning };

    const sourceArea = (outputType === 'donut')
      ? _computeSourceAreaMetres2(sourceMeasurement)
      : undefined;

    const rowsToCommit = _buildChildren(
      sourceMeasurement, resultPolygons, outputType, label,
      offsetMetres, direction, groupId, sourceArea,
    );

    _applyChildrenToTree(sourceMeasurement, rowsToCommit);
    return { error: null, warning };
  }, [
    isValidSource, _runOffset, _buildChildren, _applyChildrenToTree,
    _computeSourceAreaMetres2, pdfDimensionsRef, scaleRef, scaleFactor, measurements,
  ]);

  // ── batchCommitOffsets ─────────────────────────────────────────────────────
  const batchCommitOffsets = useCallback((
    paramsList:  CommitOffsetParams[],
    options:     BatchCommitOptions = {},
  ): CommitOffsetResult => {
    if (paramsList.length === 0) return { error: null, warning: null };

    const source = paramsList[0].sourceMeasurement;
    if (!isValidSource(source))
      return { error: 'Select a closed polygon or closed linear/arc/polyarc path to offset.', warning: null };

    const dim = pdfDimensionsRef.current;
    if (!dim) return { error: 'PDF dimensions not available.', warning: null };

    let resolvedParams = paramsList;
    if (options.cumulative) {
      const cumulativeByDir: Record<string, number> = {};
      resolvedParams = paramsList.map(p => {
        const key = p.direction;
        const prev = cumulativeByDir[key] ?? 0;
        const abs  = prev + p.offsetMetres;
        cumulativeByDir[key] = abs;
        return { ...p, offsetMetres: abs };
      });
    }

    let warning: string | null = null;
    const hasInward = resolvedParams.some(
      p => p.direction === 'inward' || p.outputType === 'donut-both' || p.outputType === 'perimeter-both',
    );
    if (hasInward) {
      const radius = computeInscribedCircleRadius(
        source, dim, scaleRef.current, scaleFactor, measurements,
      );
      const maxInward = Math.max(
        ...resolvedParams
          .filter(p => p.direction === 'inward')
          .map(p => p.inwardMetres ?? p.offsetMetres),
      );
      if (maxInward > radius * 0.95 && radius > 0) {
        warning = `One or more inward offsets may collapse (max safe ≈${radius.toFixed(3)}m)`;
      }
    }

    const needsSourceArea = resolvedParams.some(
      p => p.outputType === 'donut' || p.outputType === 'donut-both',
    );
    const cachedSourceArea = needsSourceArea ? _computeSourceAreaMetres2(source) : undefined;

    const ringResults: Array<{
      params:    CommitOffsetParams;
      polygons:  Array<{ x: number; y: number }>[];
      direction: OffsetDirection;
    }> = [];

    for (const p of resolvedParams) {
      if (p.offsetMetres <= 0) continue;
      const js = p.joinStyle ?? 'miter';

      if (p.outputType === 'donut-both' || p.outputType === 'perimeter-both') {
        const outDist  = p.outwardMetres ?? p.offsetMetres;
        const inDist   = p.inwardMetres  ?? p.offsetMetres;
        const outPolys = outDist > 0 ? _runOffset(source, outDist, 'outward', js) : null;
        const inPolys  = inDist  > 0 ? _runOffset(source, inDist,  'inward',  js) : null;
        if (outPolys && outPolys.length > 0)
          ringResults.push({ params: { ...p, label: `${p.label} (outward)`, direction: 'outward' }, polygons: outPolys, direction: 'outward' });
        if (inPolys && inPolys.length > 0)
          ringResults.push({ params: { ...p, label: `${p.label} (inward)`, direction: 'inward' }, polygons: inPolys, direction: 'inward' });
      } else {
        const polys = _runOffset(source, p.offsetMetres, p.direction, js);
        if (polys && polys.length > 0)
          ringResults.push({ params: p, polygons: polys, direction: p.direction });
      }
    }

    if (ringResults.length === 0)
      return { error: 'All offsets collapsed the shape — try smaller distances.', warning };

    const groupId = source.id;

    const allOffsetChildren: TakeoffRow[] = ringResults.flatMap(({ params: p, polygons }) => {
      const useSourceArea =
        (p.outputType === 'donut' || p.outputType === 'donut-both')
          ? cachedSourceArea
          : undefined;
      const effectiveOutputType: OffsetOutputType =
        p.outputType === 'perimeter-both' ? 'length' : p.outputType;
      return _buildChildren(
        source, polygons, effectiveOutputType, p.label,
        p.offsetMetres, p.direction, groupId, useSourceArea,
      );
    });

    _applyChildrenToTree(source, allOffsetChildren);
    return { error: null, warning };
  }, [
    isValidSource, _runOffset, _buildChildren, _applyChildrenToTree,
    _computeSourceAreaMetres2, pdfDimensionsRef, scaleRef, scaleFactor, measurements,
  ]);

  // ── commitOpenPathOffset ───────────────────────────────────────────────────
  const commitOpenPathOffset = useCallback((params: CommitOpenPathParams): CommitOffsetResult => {
    const {
      sourceMeasurement, offsetMetres, direction, outputType, label,
      joinStyle = 'miter', endStyle = 'square',
    } = params;

    if (!isValidOpenSource(sourceMeasurement))
      return { error: 'Select an open linear path to offset.', warning: null };
    if (offsetMetres <= 0)
      return { error: 'Offset distance must be greater than zero.', warning: null };

    const dim = pdfDimensionsRef.current;
    if (!dim) return { error: 'PDF dimensions not available.', warning: null };

    const resultPolygons = _runOpenOffset(
      sourceMeasurement, offsetMetres, direction,
      joinStyle,
      endStyle,
    );
    if (!resultPolygons || resultPolygons.length === 0)
      return { error: 'Could not compute open-path offset — try adjusting the distance.', warning: null };

    const groupId      = sourceMeasurement.id;
    const rowsToCommit = _buildOpenPathChildren(
      sourceMeasurement, resultPolygons, outputType, label,
      offsetMetres, direction, groupId,
    );

    _applyChildrenToTree(sourceMeasurement, rowsToCommit);
    return { error: null, warning: null };
  }, [
    isValidOpenSource, _runOpenOffset, _buildOpenPathChildren,
    _applyChildrenToTree, pdfDimensionsRef,
  ]);

  return {
    commitOffset,
    batchCommitOffsets,
    commitOpenPathOffset,
    previewOffset,
    previewOpenOffset,
    isValidSource,
    isValidOpenSource,
    isEffectivelyClosed: isClosedWithMeasurements,
    getCollapseRadius,
  };
}
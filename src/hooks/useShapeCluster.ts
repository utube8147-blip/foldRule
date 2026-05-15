'use client';

// hooks/useShapeCluster.ts
//
// Detects REPEATED ARCHITECTURAL SYMBOLS: pillars, windows, sanitary ware,
// furniture — NOT rooms, NOT walls, NOT legend boxes.
//
// Three passes:
//   Pass A — Small closed polygons  (pillars, columns, fixtures)
//   Pass C — Short line-fragment clusters (window casements, door arcs)
//
// Post-step: merge clusters that share the same label + similar size
//            (fixes the "Pillar ×4 / Pillar ×8 / Pillar ×2" split)

import { useMemo } from 'react';
import type { SvgElement, SvgArea, SvgLine } from './useSvgInteraction';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface NormBounds {
  minNX: number; minNY: number;
  maxNX: number; maxNY: number;
}

export interface ShapeCluster {
  id:             string;
  members:        string[];        // SvgElement ids
  type:           'area' | 'compound';
  label:          string;          // "Pillar" | "Window" | "Door" | "Toilet" | …
  count:          number;          // number of instances
  bounds:         NormBounds;      // union bbox of ALL instances
  repBounds:      NormBounds;      // first-instance bbox
  instanceBounds: NormBounds[];    // one bbox per instance
}

export interface UseShapeClusterResult {
  clusters:  ShapeCluster[];
  byElement: Map<string, string>;  // elementId → clusterId
  noise:     string[];
}

export interface UseShapeClusterOptions {
  clusterAreas?:      boolean;   // default true
  clusterCompound?:   boolean;   // default true
  compoundProximity?: number;    // default 0.025  (was 0.015 — increased for wall-inset windows)
  minClusterSize?:    number;    // default 2
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const ROOM_AREA_THRESHOLD    = 0.002;   // > this → room fill, not symbol
const MAX_POLY_POINTS        = 20;      // > this → complex outline, not symbol
const MAX_BBOX_DIAG          = 0.12;    // > this → too large to be a symbol
const MIN_ASPECT             = 0.05;    // degenerate → wall segment
const MAX_ASPECT             = 20.0;    // degenerate → wall segment
const MAX_FRAGMENT_LENGTH    = 0.04;    // compound pass: ignore long lines (walls)
const MIN_COMPOUND_FRAGMENTS = 4;       // compound pass: min strokes per symbol

// FIX: was 1 — too coarse; 0.123 and 0.187 both rounded to 0.1 causing
//      false bucket collisions (door fingerprint == pillar fingerprint) AND
//      split clusters (rotated windows getting different hashes).
const FP_ROUND               = 2;

const MERGE_DIAG_TOLERANCE   = 0.10;   // post-merge: 10% size tolerance

// Legend / title-block exclusion zones (normalised 0–1 page coords)
const LEGEND_BOTTOM  = 0.85;
const LEGEND_TOP     = 0.04;
const LEGEND_LEFT    = 0.04;
const LEGEND_RIGHT   = 0.96;

// Door geometry thresholds — used in both label guesser and singleton rescue
const DOOR_DIAG_MIN  = 0.025;
const DOOR_DIAG_MAX  = 0.10;
const DOOR_ASPECT_MIN = 0.7;
const DOOR_ASPECT_MAX = 1.4;
const DOOR_MAX_POINTS = 8;

// Pillar geometry thresholds — tightened so door swings don't match
const PILLAR_DIAG_MAX    = 0.025;   // was implicit <0.04 — now explicit and tighter
const PILLAR_ASPECT_MIN  = 0.6;
const PILLAR_ASPECT_MAX  = 1.67;
const PILLAR_MAX_POINTS  = 6;

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function rnd(n: number, dp = FP_ROUND): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function lineBbox(l: SvgLine): NormBounds {
  return {
    minNX: Math.min(l.nx1, l.nx2), minNY: Math.min(l.ny1, l.ny2),
    maxNX: Math.max(l.nx1, l.nx2), maxNY: Math.max(l.ny1, l.ny2),
  };
}

export function mergeBounds(bs: NormBounds[]): NormBounds {
  return bs.reduce((acc, b) => ({
    minNX: Math.min(acc.minNX, b.minNX), minNY: Math.min(acc.minNY, b.minNY),
    maxNX: Math.max(acc.maxNX, b.maxNX), maxNY: Math.max(acc.maxNY, b.maxNY),
  }));
}

export function bboxDiag(b: NormBounds): number {
  return Math.hypot(b.maxNX - b.minNX, b.maxNY - b.minNY);
}

export function bboxAspect(b: NormBounds): number {
  const h = b.maxNY - b.minNY;
  return h === 0 ? 999 : (b.maxNX - b.minNX) / h;
}

function centroid(b: NormBounds) {
  return { x: (b.minNX + b.maxNX) / 2, y: (b.minNY + b.maxNY) / 2 };
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

// ─── Legend exclusion ─────────────────────────────────────────────────────────

function isInLegendRegion(b: NormBounds): boolean {
  const cx = (b.minNX + b.maxNX) / 2;
  const cy = (b.minNY + b.maxNY) / 2;
  return cy > LEGEND_BOTTOM || cy < LEGEND_TOP ||
         cx < LEGEND_LEFT   || cx > LEGEND_RIGHT;
}

// ─── Symbol admission filter ──────────────────────────────────────────────────

const STRUCTURAL_LABELS = [
  'room', 'wall', 'slab', 'floor', 'ceiling', 'stair', 'ramp',
  'roof', 'void', 'lift', 'shaft', 'duct', 'core', 'corridor',
];

function isNotSymbol(area: SvgArea): boolean {
  if (area.areaN > ROOM_AREA_THRESHOLD)            return true;
  if (area.points.length > MAX_POLY_POINTS)        return true;
  if (bboxDiag(area.bounds) > MAX_BBOX_DIAG)       return true;
  if (isInLegendRegion(area.bounds))               return true;
  const aspect = bboxAspect(area.bounds);
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT)  return true;
  const lbl = (area.label ?? '').toLowerCase();
  if (STRUCTURAL_LABELS.some(s => lbl.includes(s))) return true;
  return false;
}

// ─── Polygon normalisation + fingerprint ─────────────────────────────────────

function normalisePoly(pts: Array<{ nx: number; ny: number }>) {
  if (pts.length < 3) return [];
  const cx = pts.reduce((s, p) => s + p.nx, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.ny, 0) / pts.length;
  const centered = pts.map(p => ({ x: p.nx - cx, y: p.ny - cy }));

  let xx = 0, yy = 0, xy = 0;
  for (const p of centered) { xx += p.x * p.x; yy += p.y * p.y; xy += p.x * p.y; }
  xx /= centered.length; yy /= centered.length; xy /= centered.length;
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  const rotated = centered.map(p => ({
    x: p.x * cos - p.y * sin,
    y: p.x * sin + p.y * cos,
  }));

  const span = Math.max(
    Math.max(...rotated.map(p => p.x)) - Math.min(...rotated.map(p => p.x)),
    Math.max(...rotated.map(p => p.y)) - Math.min(...rotated.map(p => p.y)),
  );
  if (span === 0) return rotated;
  return rotated.map(p => ({ x: p.x / span, y: p.y / span }));
}

function fingerprintPoly(area: SvgArea): string {
  const norm = normalisePoly(area.points);
  if (norm.length < 3) return '';

  const edges: number[] = [];
  for (let i = 0; i < norm.length; i++) {
    const j = (i + 1) % norm.length;
    edges.push(rnd(Math.hypot(norm[j].x - norm[i].x, norm[j].y - norm[i].y)));
  }
  edges.sort((a, b) => a - b);

  const angles: number[] = [];
  for (let i = 0; i < norm.length; i++) {
    const prev = norm[(i - 1 + norm.length) % norm.length];
    const curr = norm[i];
    const next = norm[(i + 1) % norm.length];
    const ax = prev.x - curr.x, ay = prev.y - curr.y;
    const bx = next.x - curr.x, by = next.y - curr.y;
    angles.push(rnd(Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by))));
  }
  angles.sort((a, b) => a - b);

  const nv = norm.length;

  // REMOVED: diagBkt (size) and aspect (orientation) — shape only
  return `P:n${nv}|e:${edges.join(',')}|a:${angles.join(',')}`;
}

// ─── Compound fingerprint ─────────────────────────────────────────────────────

function groupFragments(
  lines: SvgLine[],
  prox:  number,
): Array<{ memberIds: string[]; bounds: NormBounds }> {
  const used   = new Set<number>();
  const result: Array<{ memberIds: string[]; bounds: NormBounds }> = [];

  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    const group = [i];
    const queue = [i];
    used.add(i);

    while (queue.length) {
      const cur = queue.shift()!;
      const cc  = centroid(lineBbox(lines[cur]));
      for (let j = 0; j < lines.length; j++) {
        if (used.has(j)) continue;
        const jc = centroid(lineBbox(lines[j]));
        if (Math.hypot(jc.x - cc.x, jc.y - cc.y) < prox) {
          used.add(j); group.push(j); queue.push(j);
        }
      }
    }

    if (group.length >= MIN_COMPOUND_FRAGMENTS) {
      result.push({
        memberIds: group.map(idx => lines[idx].id),
        bounds:    mergeBounds(group.map(idx => lineBbox(lines[idx]))),
      });
    }
  }
  return result;
}

function fingerprintCompound(bounds: NormBounds, fragmentCount: number): string {
  const aspect   = rnd(bboxAspect(bounds));
  // FIX: was rnd(..., 1) — now uses FP_ROUND (2dp) for tighter size buckets
  const diagBkt  = rnd(bboxDiag(bounds));
  const countBkt = Math.round(fragmentCount / 2) * 2;
  return `C:ar${aspect}|d${diagBkt}|n${countBkt}`;
}

// ─── Label guesser ────────────────────────────────────────────────────────────

function guessLabel(
  area:        SvgArea | null,
  memberCount: number,
  type:        'area' | 'compound',
  bounds?:     NormBounds,
): string {
  if (area) {
    const lbl = (area.label ?? '').toLowerCase();
    if (lbl.includes('pillar') || lbl.includes('column') || lbl.includes('col')) return 'Pillar';
    if (lbl.includes('window'))                                                    return 'Window';
    if (lbl.includes('door'))                                                      return 'Door';
    if (lbl.includes('toilet') || lbl.includes('wc'))                             return 'Toilet';
    if (lbl.includes('sink') || lbl.includes('basin') || lbl.includes('wash'))    return 'Basin';
    if (lbl.includes('bath'))                                                      return 'Bath';
    if (lbl.includes('desk') || lbl.includes('table'))                            return 'Furniture';
    if (lbl.includes('chair') || lbl.includes('seat'))                            return 'Chair';
    if (lbl.includes('urinal'))                                                    return 'Urinal';
    if (lbl.includes('shower'))                                                    return 'Shower';

    // Geometry heuristics for unlabelled areas
    const aspect = bboxAspect(area.bounds);
    const diag   = bboxDiag(area.bounds);
    const n      = area.points.length;

    // FIX: Check door BEFORE pillar — door swings are larger square-ish polys.
    // Old code checked pillar first with loose diag (<0.04), which swallowed doors.
    // Order matters: door range starts where pillar range ends (PILLAR_DIAG_MAX).
    if (
      n >= 3 && n <= DOOR_MAX_POINTS &&
      diag >= DOOR_DIAG_MIN && diag < DOOR_DIAG_MAX &&
      aspect >= DOOR_ASPECT_MIN && aspect <= DOOR_ASPECT_MAX
    ) {
      return 'Door';
    }

    // FIX: Pillar threshold tightened (diag < PILLAR_DIAG_MAX = 0.025, was implicit 0.04).
    // This prevents door swings from being labelled as pillars.
    if (
      n <= PILLAR_MAX_POINTS &&
      aspect >= PILLAR_ASPECT_MIN && aspect <= PILLAR_ASPECT_MAX &&
      diag < PILLAR_DIAG_MAX
    ) {
      return 'Pillar';
    }

    if (n <= 6 && (aspect < 0.3 || aspect > 3.3))  return 'Window';
    if (n >= 6 && n <= 14 && diag < 0.06)           return 'Fixture';
  }

  if (type === 'compound' && bounds) {
    const aspect = bboxAspect(bounds);
    const diag   = bboxDiag(bounds);
    if (memberCount <= 6 && aspect > 0.5 && aspect < 2.0 && diag < 0.05) return 'Door';
    if (memberCount <= 8 && (aspect < 0.35 || aspect > 2.8) && diag < 0.08) return 'Window';
    if (memberCount > 12)  return 'Sanitary';
    if (memberCount > 6)   return 'Fixture';
    return 'Symbol';
  }

  return 'Symbol';
}

// ─── Geometry check helpers (used in singleton rescue) ───────────────────────

function looksLikeDoor(area: SvgArea): boolean {
  const aspect = bboxAspect(area.bounds);
  const diag   = bboxDiag(area.bounds);
  const n      = area.points.length;
  return (
    n >= 3 && n <= DOOR_MAX_POINTS &&
    diag >= DOOR_DIAG_MIN && diag < DOOR_DIAG_MAX &&
    aspect >= DOOR_ASPECT_MIN && aspect <= DOOR_ASPECT_MAX
  );
}

// ─── Post-merge ───────────────────────────────────────────────────────────────

function postMergeClusters(clusters: ShapeCluster[]): ShapeCluster[] {
  const merged: ShapeCluster[] = [];
  const used = new Set<string>();

  for (const c of clusters) {
    if (used.has(c.id)) continue;

    const medDiag = median(c.instanceBounds.map(bboxDiag));

    const siblings = clusters.filter(o =>
      !used.has(o.id) &&
      o.id    !== c.id &&
      o.label === c.label &&
      o.type  === c.type &&
      Math.abs(median(o.instanceBounds.map(bboxDiag)) - medDiag) / (medDiag || 1) < MERGE_DIAG_TOLERANCE,
    );

    const family       = [c, ...siblings];
    const allMembers   = family.flatMap(f => f.members);
    const allInstances = family.flatMap(f => f.instanceBounds);
    const allBounds    = mergeBounds(allInstances);

    merged.push({
      id:             c.id,
      type:           c.type,
      label:          c.label,
      members:        allMembers,
      count:          allInstances.length,
      bounds:         allBounds,
      repBounds:      allInstances[0],
      instanceBounds: allInstances,
    });

    family.forEach(f => used.add(f.id));
  }

  return merged;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useShapeCluster(
  elements: SvgElement[],
  options:  UseShapeClusterOptions = {},
): UseShapeClusterResult {
  const {
    clusterAreas      = true,
    clusterCompound   = true,
    compoundProximity = 0.025,   // FIX: was 0.015 — increased for wall-inset windows
    minClusterSize    = 2,
  } = options;

  return useMemo(() => {
    const rawClusters: ShapeCluster[]      = [];
    const byElement:   Map<string, string> = new Map();
    const noise:       string[]            = [];

    // ── Pass A: Small closed polygon symbols ──────────────────────────────────
    if (clusterAreas) {
      const candidates = elements.filter((e): e is SvgArea =>
        e.type === 'area' && !isNotSymbol(e as SvgArea),
      );

      const buckets = new Map<string, SvgArea[]>();
      for (const area of candidates) {
        const fp = fingerprintPoly(area);
        if (!fp) { noise.push(area.id); continue; }
        if (!buckets.has(fp)) buckets.set(fp, []);
        buckets.get(fp)!.push(area);
      }

      let idx = 0;
      for (const members of buckets.values()) {
        if (members.length < minClusterSize) {
          // FIX: Singleton rescue for door-like shapes.
          // Previously ALL singletons went to noise, so a room with one door
          // (unique fingerprint) would never show a label.
          // Now: if the shape geometry matches a door, we still emit a cluster
          // of count=1 so it gets a tooltip and can be counted in takeoff.
          const lbl = guessLabel(members[0], members.length, 'area');
          if ((lbl === 'Door' || looksLikeDoor(members[0])) && members.length >= 1) {
            const id        = `cluster-area-${idx++}`;
            const instances = members.map(a => a.bounds);
            rawClusters.push({
              id,
              type:           'area',
              label:          'Door',
              members:        members.map(a => a.id),
              count:          members.length,
              bounds:         mergeBounds(instances),
              repBounds:      instances[0],
              instanceBounds: instances,
            });
            members.forEach(a => byElement.set(a.id, id));
            continue;
          }

          members.forEach(a => noise.push(a.id));
          continue;
        }

        const id        = `cluster-area-${idx++}`;
        const instances = members.map(a => a.bounds);
        rawClusters.push({
          id,
          type:           'area',
          label:          guessLabel(members[0], members.length, 'area'),
          members:        members.map(a => a.id),
          count:          members.length,
          bounds:         mergeBounds(instances),
          repBounds:      instances[0],
          instanceBounds: instances,
        });
        members.forEach(a => byElement.set(a.id, id));
      }

      console.log(
        `[useShapeCluster] passA: ${candidates.length} candidates → ` +
        `${rawClusters.filter(c => c.type === 'area').length} raw area clusters`,
      );
    }

    // ── Pass C: Short line-fragment compound symbols ──────────────────────────
    if (clusterCompound) {
      const fragments = elements.filter((e): e is SvgLine =>
        e.type === 'line' &&
        (e as SvgLine).lengthN !== undefined &&
        (e as SvgLine).lengthN < MAX_FRAGMENT_LENGTH &&
        !byElement.has(e.id),
      );

      const groups       = groupFragments(fragments, compoundProximity);
      const symbolGroups = groups.filter(g =>
        bboxDiag(g.bounds) < MAX_BBOX_DIAG && !isInLegendRegion(g.bounds),
      );

      const buckets = new Map<string, typeof symbolGroups>();
      for (const g of symbolGroups) {
        const fp = fingerprintCompound(g.bounds, g.memberIds.length);
        if (!buckets.has(fp)) buckets.set(fp, []);
        buckets.get(fp)!.push(g);
      }

      let idx = 0;
      for (const groupList of buckets.values()) {
        if (groupList.length < minClusterSize) {
          groupList.forEach(g => g.memberIds.forEach(id => noise.push(id)));
          continue;
        }
        const id         = `cluster-compound-${idx++}`;
        const instances  = groupList.map(g => g.bounds);
        const allMembers = groupList.flatMap(g => g.memberIds);
        rawClusters.push({
          id,
          type:           'compound',
          label:          guessLabel(null, groupList[0].memberIds.length, 'compound', groupList[0].bounds),
          members:        allMembers,
          count:          groupList.length,
          bounds:         mergeBounds(instances),
          repBounds:      instances[0],
          instanceBounds: instances,
        });
        allMembers.forEach(mid => byElement.set(mid, id));
      }

      console.log(
        `[useShapeCluster] passC: ${fragments.length} fragments → ` +
        `${symbolGroups.length} groups → ` +
        `${rawClusters.filter(c => c.type === 'compound').length} raw compound clusters`,
      );
    }

    // ── Post-merge: collapse same-label/same-size split clusters ─────────────
    const clusters = postMergeClusters(rawClusters);

    // Re-sync byElement after merge
    for (const c of clusters) {
      c.members.forEach(mid => byElement.set(mid, c.id));
    }

    if (clusters.length > 0) {
      console.group('[useShapeCluster] Final clusters');
      clusters.forEach(c => console.log(
        `${c.label} ×${c.count}  [${c.id}]  diag: ${bboxDiag(c.bounds).toFixed(3)}`,
      ));
      console.groupEnd();
    }

    return { clusters, byElement, noise };
  }, [elements, clusterAreas, clusterCompound, compoundProximity, minClusterSize]);
}
// lib/symbolClusterer.ts
//
// Agglomerative clustering of SvgArea shapes by geometric fingerprint.
// Produces SymbolCluster[] — each cluster has an auto-label, color, and member list.
// Rooms (large areas) are excluded by areaN threshold before this runs.

import type { SvgArea } from '@/hooks/useSvgInteraction';
import { fingerprintArea, fingerprintDistance, ShapeFingerprint } from './symbolFingerprint';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SymbolCluster {
  /** Stable identifier: "cluster-0", "cluster-1", … sorted by member count desc */
  id: string;

  /**
   * Auto-inferred label.
   * "Door-like"    → high circularity + hasArc
   * "Pillar-like"  → near-square aspect + high convexity + low vertex count
   * "Window-like"  → high aspect ratio + rectangular
   * "Symbol A/B/…" → everything else, labelled alphabetically
   */
  label: string;

  /** Hex color auto-assigned per cluster */
  color: string;

  /** All SvgArea members of this cluster */
  members: SvgArea[];

  /** Mean fingerprint of cluster (used for display + distance checks) */
  centroidFingerprint: ShapeFingerprint;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Areas with areaN above this are considered rooms and excluded from clustering.
 * 0.005 = 0.5% of page area — tune if needed.
 */
export const ROOM_AREA_THRESHOLD_N = 0.005;

/**
 * Minimum number of members for a cluster to be reported.
 * Singletons / pairs are likely unique decorations, not repeating symbols.
 */
export const MIN_CLUSTER_SIZE = 2;

// Distance threshold for greedy agglomerative merge
const DEFAULT_THRESHOLD = 0.18;

// Palette — cycles if there are more clusters than colors
const CLUSTER_COLORS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
  '#84cc16', // lime
  '#6366f1', // indigo
  '#14b8a6', // teal
  '#e11d48', // rose
];

// ─── Infer label from fingerprint ─────────────────────────────────────────────

function inferLabel(fp: ShapeFingerprint, fallback: string): string {
  const { aspectRatio, circularity, hasArc, convexity, vertexCount } = fp;

  // Door-like: contains arc + reasonably circular
  if (hasArc && circularity > 0.4) return 'Door-like';

  // Pillar-like: near-square, very convex, few vertices (simple polygon)
  if (aspectRatio > 0.7 && aspectRatio < 1.4 && convexity > 0.92 && vertexCount <= 8)
    return 'Pillar-like';

  // Window-like: wide rectangle, few vertices
  if ((aspectRatio > 2.5 || aspectRatio < 0.4) && vertexCount <= 6 && convexity > 0.88)
    return 'Window-like';

  // Stair-like: many vertices, low convexity (stepped outline)
  if (vertexCount > 12 && convexity < 0.75) return 'Stair-like';

  return fallback;
}

// ─── Mean fingerprint ─────────────────────────────────────────────────────────

function meanFingerprint(fps: ShapeFingerprint[]): ShapeFingerprint {
  if (fps.length === 0) return fps[0];
  const n = fps.length;
  const sum = fps.reduce(
    (acc, fp) => ({
      aspectRatio:  acc.aspectRatio  + fp.aspectRatio,
      vertexCount:  acc.vertexCount  + fp.vertexCount,
      circularity:  acc.circularity  + fp.circularity,
      hasArc:       acc.hasArc,        // handled below
      areaN:        acc.areaN        + fp.areaN,
      convexity:    acc.convexity    + fp.convexity,
      huMoments:    acc.huMoments.map((v, i) => v + (fp.huMoments[i] ?? 0)),
    }),
    {
      aspectRatio: 0, vertexCount: 0, circularity: 0,
      hasArc: false, areaN: 0, convexity: 0,
      huMoments: new Array(7).fill(0),
    },
  );
  return {
    aspectRatio:  sum.aspectRatio  / n,
    vertexCount:  Math.round(sum.vertexCount / n),
    circularity:  sum.circularity  / n,
    hasArc:       fps.filter(f => f.hasArc).length > n / 2,
    areaN:        sum.areaN        / n,
    convexity:    sum.convexity    / n,
    huMoments:    sum.huMoments.map(v => v / n),
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Given a list of SvgArea elements (already filtered to exclude rooms),
 * returns clusters sorted by member count descending.
 */
export function clusterSymbols(
  areas: SvgArea[],
  threshold = DEFAULT_THRESHOLD,
): SymbolCluster[] {
  if (areas.length === 0) return [];

  // 1. Fingerprint all
  const fingerprints = areas.map(a => fingerprintArea(a));

  // 2. Greedy agglomerative clustering
  //    For each area, find the existing cluster whose centroid is closest.
  //    If distance < threshold, merge; otherwise start a new cluster.
  const clusterMembers: SvgArea[][]         = [];
  const clusterFps:     ShapeFingerprint[][] = [];

  for (let i = 0; i < areas.length; i++) {
    const fp = fingerprints[i];
    let bestCluster = -1, bestDist = threshold;

    for (let c = 0; c < clusterMembers.length; c++) {
      const centFp = meanFingerprint(clusterFps[c]);
      const d      = fingerprintDistance(fp, centFp);
      if (d < bestDist) { bestDist = d; bestCluster = c; }
    }

    if (bestCluster === -1) {
      clusterMembers.push([areas[i]]);
      clusterFps.push([fp]);
    } else {
      clusterMembers[bestCluster].push(areas[i]);
      clusterFps[bestCluster].push(fp);
    }
  }

  // 3. Filter out clusters below minimum size
  const significant = clusterMembers
    .map((members, i) => ({ members, fps: clusterFps[i] }))
    .filter(c => c.members.length >= MIN_CLUSTER_SIZE);

  // 4. Sort by count descending
  significant.sort((a, b) => b.members.length - a.members.length);

  // 5. Build SymbolCluster objects
  const alphabetLabels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let fallbackIdx = 0;

  return significant.map((c, i) => {
    const centFp = meanFingerprint(c.fps);
    const fallback = `Symbol ${alphabetLabels[fallbackIdx % alphabetLabels.length]}`;
    const label = inferLabel(centFp, fallback);
    // Only advance fallback counter for generic labels
    if (label.startsWith('Symbol')) fallbackIdx++;

    return {
      id:                  `cluster-${i}`,
      label,
      color:               CLUSTER_COLORS[i % CLUSTER_COLORS.length],
      members:             c.members,
      centroidFingerprint: centFp,
    } satisfies SymbolCluster;
  });
}

/**
 * Tag each SvgArea in-place with cluster metadata.
 * Call this after clusterSymbols() to make cluster info accessible from SvgArea objects.
 */
export function tagAreasWithCluster(clusters: SymbolCluster[]): void {
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      (member as any).clusterId    = cluster.id;
      (member as any).clusterLabel = cluster.label;
      (member as any).clusterColor = cluster.color;
    }
  }
}

/**
 * Retrieve cluster metadata from a tagged SvgArea.
 */
export function getAreaCluster(area: SvgArea): {
  clusterId: string; clusterLabel: string; clusterColor: string;
} | null {
  const a = area as any;
  if (!a.clusterId) return null;
  return { clusterId: a.clusterId, clusterLabel: a.clusterLabel, clusterColor: a.clusterColor };
}
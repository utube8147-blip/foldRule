// hooks/useSymbolSelection.ts
//
// Manages which symbol cluster is selected.
// "Click one → select all in cluster" logic lives here.
// Exposes selectedAreas so ViewerCanvas can highlight them.

import { useState, useCallback, useMemo } from 'react';
import type { SvgArea } from '@/hooks/snapEngine/useSnapEngine';
import type { SymbolCluster } from '@/lib/shapes/symbolClusterer';
import { getAreaCluster } from '@/lib/shapes/symbolClusterer';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UseSymbolSelectionReturn {
  /** ID of the currently selected cluster, or null */
  selectedClusterId: string | null;

  /** All SvgArea members of the selected cluster */
  selectedAreas: SvgArea[];

  /** The full SymbolCluster object for the selected cluster */
  selectedCluster: SymbolCluster | null;

  /** Call when the user clicks an area on the canvas */
  handleAreaClick: (area: SvgArea) => void;

  /** Call when the user clicks a cluster row in the legend */
  handleClusterSelect: (clusterId: string) => void;

  /** Deselect everything */
  clearSelection: () => void;

  /** Whether a given SvgArea is part of the selected cluster */
  isSelected: (area: SvgArea) => boolean;

  /** Whether a given SvgArea belongs to ANY known cluster */
  isClustered: (area: SvgArea) => boolean;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSymbolSelection(
  clusters: SymbolCluster[],
): UseSymbolSelectionReturn {
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);

  // Fast lookup: clusterId → SymbolCluster
  const clusterMap = useMemo(
    () => new Map(clusters.map(c => [c.id, c])),
    [clusters],
  );

  const selectedCluster = useMemo(
    () => (selectedClusterId ? clusterMap.get(selectedClusterId) ?? null : null),
    [selectedClusterId, clusterMap],
  );

  const selectedAreas = useMemo(
    () => selectedCluster?.members ?? [],
    [selectedCluster],
  );

  // Fast set for O(1) isSelected checks
  const selectedAreaIds = useMemo(
    () => new Set(selectedAreas.map((a: any) => a.id)),
    [selectedAreas],
  );

  const handleAreaClick = useCallback((area: SvgArea) => {
    const meta = getAreaCluster(area);
    if (!meta) return;
    // Toggle: clicking same cluster deselects
    setSelectedClusterId(prev => prev === meta.clusterId ? null : meta.clusterId);
  }, []);

  const handleClusterSelect = useCallback((clusterId: string) => {
    setSelectedClusterId(prev => prev === clusterId ? null : clusterId);
  }, []);

  const clearSelection = useCallback(() => setSelectedClusterId(null), []);

  const isSelected = useCallback(
    (area: SvgArea) => selectedAreaIds.has((area as any).id),
    [selectedAreaIds],
  );

  const isClustered = useCallback(
    (area: SvgArea) => getAreaCluster(area) !== null,
    [],
  );

  return {
    selectedClusterId,
    selectedAreas,
    selectedCluster,
    handleAreaClick,
    handleClusterSelect,
    clearSelection,
    isSelected,
    isClustered,
  };
}

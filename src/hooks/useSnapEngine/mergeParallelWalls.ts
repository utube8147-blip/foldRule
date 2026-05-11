// hooks/useSnapEngine/mergeParallelWalls.ts
// Used only after raster extraction — vector walls have no double-edge problem.

export interface NormalisedWall {
  nx1: number; ny1: number;
  nx2: number; ny2: number;
  angle: 0 | 90 | 'diagonal';
  length: number;
  thicknessPx: number;
  thicknessNorm: number;
  isFilled: boolean;
  x1: number; y1: number;
  x2: number; y2: number;
}

export function mergeParallelWalls(
  walls: NormalisedWall[],
  pageW: number,
  pageH: number,
  mergeThresholdNorm = 0.015, // ~1.5% of page — covers typical wall thickness
): NormalisedWall[] {
  const hWalls = walls.filter(w => w.angle === 0);
  const vWalls = walls.filter(w => w.angle === 90);
  const diag   = walls.filter(w => w.angle === 'diagonal');

  return [
    ...collapseGroup(hWalls, 'h', mergeThresholdNorm),
    ...collapseGroup(vWalls, 'v', mergeThresholdNorm),
    ...diag, // diagonals untouched
  ];
}

function collapseGroup(
  walls: NormalisedWall[],
  axis: 'h' | 'v',
  threshold: number,
): NormalisedWall[] {
  if (walls.length === 0) return [];

  const perpKey = axis === 'h' ? 'ny1' : 'nx1';
  const sorted = [...walls].sort((a, b) => a[perpKey] - b[perpKey]);
  const result: NormalisedWall[] = [];
  let i = 0;

  while (i < sorted.length) {
    const group: NormalisedWall[] = [sorted[i]];
    const baseCoord = sorted[i][perpKey];
    let j = i + 1;

    while (j < sorted.length && Math.abs(sorted[j][perpKey] - baseCoord) <= threshold) {
      group.push(sorted[j++]);
    }

    result.push(mergeGroup(group, axis));
    i = j;
  }

  return result;
}

function mergeGroup(group: NormalisedWall[], axis: 'h' | 'v'): NormalisedWall {
  // Average the perpendicular coord, union the parallel extent
  const avgPerp = group.reduce((s, w) => s + (axis === 'h' ? w.ny1 : w.nx1), 0) / group.length;
  const avgThickness = group.reduce((s, w) => s + w.thicknessPx, 0) / group.length;

  if (axis === 'h') {
    const nx1 = Math.min(...group.map(w => w.nx1));
    const nx2 = Math.max(...group.map(w => w.nx2));
    return {
      ...group[0],
      nx1, ny1: avgPerp, nx2, ny2: avgPerp,
      x1: group[0].x1, y1: group[0].y1, // recalculated by caller with dims
      x2: group[0].x2, y2: group[0].y2,
      thicknessPx: avgThickness,
      length: nx2 - nx1,
    };
  } else {
    const ny1 = Math.min(...group.map(w => w.ny1));
    const ny2 = Math.max(...group.map(w => w.ny2));
    return {
      ...group[0],
      nx1: avgPerp, ny1, nx2: avgPerp, ny2,
      x1: group[0].x1, y1: group[0].y1,
      x2: group[0].x2, y2: group[0].y2,
      thicknessPx: avgThickness,
      length: ny2 - ny1,
    };
  }
}
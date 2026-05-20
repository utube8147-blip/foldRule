// ─── types/gridCountTypes.ts ──────────────────────────────────────────────────

export type TileShape = 'square' | 'hex-flat' | 'hex-pointy' | 'triangle' | 'diamond';

export interface Point {
  x: number;
  y: number;
}

export interface ResultData {
  count: number;
  label: string;
}

export interface TileShapeConfig {
  id:           TileShape;
  label:        string;
  spacingLabel: string;
  description:  string;
  icon:         string;
}

export const TILE_SHAPES: TileShapeConfig[] = [
  { id: 'square',     label: 'Square',     spacingLabel: 'Grid spacing', description: 'Square grid',                         icon: '▪' },
  { id: 'hex-flat',   label: 'Hex flat',   spacingLabel: 'Hex width',    description: 'Flat-top hexagons, staggered columns', icon: '⬡' },
  { id: 'hex-pointy', label: 'Hex pointy', spacingLabel: 'Hex width',    description: 'Pointy-top hexagons, staggered rows',  icon: '⬡' },
  { id: 'triangle',   label: 'Triangle',   spacingLabel: 'Side length',  description: 'Equilateral triangular grid',          icon: '△' },
  { id: 'diamond',    label: 'Diamond',    spacingLabel: 'Diamond width', description: '45° rotated square grid',             icon: '◇' },
];

export const MIN_VERTICES   = 3;
export const SNAP_RADIUS_PX = 18;
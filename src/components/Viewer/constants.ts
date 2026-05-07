import {
  MousePointer2, CircleDot, Ruler, Square, Hash, Scaling,
} from 'lucide-react';

// ─── PDF Worker configuration ─────────────────────────────────────────────────

export const pdfWorkerUrl = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// ─── Static tool definitions ─────────────────────────────────────────────────

export const VIEWER_TOOLS = [
  { id: 'select',    icon: MousePointer2, label: 'Select (Pan)',  shortcut: 'V' },
  { id: 'point',     icon: CircleDot,     label: 'Point',         shortcut: 'P' },
  { id: 'linear',    icon: Ruler,         label: 'Linear',        shortcut: 'L' },
  { id: 'polygon',   icon: Square,        label: 'Polygon',       shortcut: 'A' },
  { id: 'rectangle', icon: Square,        label: 'Rectangle',     shortcut: 'R' },
  { id: 'count',     icon: Hash,          label: 'Count',         shortcut: 'C' },
  { id: 'scale',     icon: Scaling,       label: 'Calibrate',     shortcut: 'S' },
] as const;

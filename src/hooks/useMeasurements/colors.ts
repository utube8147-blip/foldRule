// ─── Color palette for measurements ───────────────────────────────────────────

const MEASUREMENT_COLORS = [
  '#EF9F27', '#3B82F6', '#10B981', '#F43F5E', '#8B5CF6',
  '#06B6D4', '#F97316', '#EC4899', '#14B8A6', '#6366F1',
  '#84CC16', '#A855F7',
];

let colorIndex = 0;

export function getNextMeasurementColor(): string {
  return MEASUREMENT_COLORS[colorIndex++ % MEASUREMENT_COLORS.length];
}

export function resetColorIndex(): void {
  colorIndex = 0;
}

export { MEASUREMENT_COLORS };

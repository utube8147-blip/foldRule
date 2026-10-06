// ─── Colour palette for measurements ──────────────────────────────────────────
// A fixed palette of clearly different colours: 12 hues × 5 shades. New items
// take the first colour nobody is using yet, walking the strong shades of
// well-separated hues first, so neighbours on the drawing look different.

const HUES: [string, string[]][] = [
  // name,      [light,     soft,      strong,    deep,      dark]
  ['Amber',   ['#FCD34D', '#FBBF24', '#EF9F27', '#D97706', '#92400E']],
  ['Blue',    ['#93C5FD', '#60A5FA', '#3B82F6', '#1D4ED8', '#1E3A8A']],
  ['Green',   ['#6EE7B7', '#34D399', '#10B981', '#047857', '#064E3B']],
  ['Rose',    ['#FDA4AF', '#FB7185', '#F43F5E', '#BE123C', '#881337']],
  ['Violet',  ['#C4B5FD', '#A78BFA', '#8B5CF6', '#6D28D9', '#4C1D95']],
  ['Cyan',    ['#67E8F9', '#22D3EE', '#06B6D4', '#0E7490', '#164E63']],
  ['Orange',  ['#FDBA74', '#FB923C', '#F97316', '#C2410C', '#7C2D12']],
  ['Pink',    ['#F9A8D4', '#F472B6', '#EC4899', '#BE185D', '#831843']],
  ['Lime',    ['#BEF264', '#A3E635', '#84CC16', '#4D7C0F', '#365314']],
  ['Indigo',  ['#A5B4FC', '#818CF8', '#6366F1', '#4338CA', '#312E81']],
  ['Teal',    ['#5EEAD4', '#2DD4BF', '#14B8A6', '#0F766E', '#134E4A']],
  ['Red',     ['#FCA5A5', '#F87171', '#EF4444', '#B91C1C', '#7F1D1D']],
  ['Yellow',  ['#FEF08A', '#FDE047', '#EAB308', '#A16207', '#713F12']],
  ['Sky',     ['#BAE6FD', '#7DD3FC', '#0EA5E9', '#0369A1', '#0C4A6E']],
  ['Fuchsia', ['#F0ABFC', '#E879F9', '#D946EF', '#A21CAF', '#701A75']],
  ['Brown',   ['#D6BCAB', '#B08968', '#8B5E3C', '#6F4518', '#432818']],
  ['Slate',   ['#CBD5E1', '#94A3B8', '#64748B', '#475569', '#1E293B']],
];

/** For the picker: rows of hues, columns light → dark. */
export const PALETTE_GRID: { name: string; shades: string[] }[] = HUES.map(([name, shades]) => ({ name, shades }));

// Order new colours are handed out in: strong shade of every hue, then deep,
// then soft, then dark, then light.
const MEASUREMENT_COLORS: string[] = [2, 3, 1, 4, 0].flatMap(shade => HUES.map(([, s]) => s[shade]));

let colorIndex = 0;
let inUse = new Set<string>();

/** Tell the palette which colours the takeoff already uses, so new ones differ. */
export function setColorsInUse(colors: Iterable<string | undefined | null>): void {
  inUse = new Set([...colors].filter(Boolean).map(c => (c as string).toLowerCase()));
}

export function getNextMeasurementColor(): string {
  for (let i = 0; i < MEASUREMENT_COLORS.length; i++) {
    const c = MEASUREMENT_COLORS[(colorIndex + i) % MEASUREMENT_COLORS.length];
    if (!inUse.has(c.toLowerCase())) {
      colorIndex = (colorIndex + i + 1) % MEASUREMENT_COLORS.length;
      inUse.add(c.toLowerCase());          // a second request before the takeoff refreshes gets another colour
      return c;
    }
  }
  return MEASUREMENT_COLORS[colorIndex++ % MEASUREMENT_COLORS.length];   // all 85 taken: go round again
}

export function resetColorIndex(): void {
  colorIndex = 0;
}

export { MEASUREMENT_COLORS };

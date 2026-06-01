// ─── svgLabelUtils.ts ─────────────────────────────────────────────────────────
// Shared label-matching + category utilities for SVG area classification.
//
// BUG FIXED: STRUCTURAL_LABELS exports 'Pillar'/'Window' (capitalised) but all
// downstream checks used lowercase literals.  matchesLabel() normalises both
// sides so casing never matters again.
// ─────────────────────────────────────────────────────────────────────────────

import type { SvgArea } from '@/hooks/useSvgInteraction';

// ── Canonical names (lowercase) ───────────────────────────────────────────────

export const SVG_LABEL = {
  DOOR:   'door',
  PILLAR: 'pillar',
  WINDOW: 'window',
} as const;

export type SvgStructuralLabel = (typeof SVG_LABEL)[keyof typeof SVG_LABEL];

// ── Core helper ───────────────────────────────────────────────────────────────

export function matchesLabel(label: string | undefined | null, target: string): boolean {
  return !!label && label.toLowerCase() === target.toLowerCase();
}

// ── Per-type guards ───────────────────────────────────────────────────────────

export function isSvgDoor(area: SvgArea): boolean {
  return matchesLabel(area.label, SVG_LABEL.DOOR) || !!area.isDoor;
}

export function isSvgPillar(area: SvgArea): boolean {
  return (
    matchesLabel(area.label, SVG_LABEL.PILLAR) ||
    area.attributes?.['data-face-type'] === 'pillar' ||
    area.attributes?.['data-structural'] === 'true'
  );
}

export function isSvgWindow(area: SvgArea): boolean {
  return (
    matchesLabel(area.label, SVG_LABEL.WINDOW) ||
    area.attributes?.['data-face-type'] === 'window'
  );
}

export function isSvgStructural(area: SvgArea): boolean {
  return isSvgDoor(area) || isSvgPillar(area) || isSvgWindow(area);
}

// ── Room category lookup ──────────────────────────────────────────────────────

const ROOM_CATEGORY_MAP: Record<string, string> = {
  OFFICE: 'office', DIRECTOR: 'office', STUDY: 'office', PRIVATE_OFFICE: 'office',
  OPEN_OFFICE: 'open', WORKSPACE: 'open', COWORKING: 'open', OPEN_PLAN: 'open',
  OPEN_PLAN_A: 'open', OPEN_PLAN_B: 'open',
  MEETING: 'meeting', BOARDROOM: 'meeting', CONFERENCE: 'meeting',
  BREAKOUT: 'meeting', TRAINING: 'meeting', SEMINAR: 'meeting',
  CORRIDOR: 'circulation', HALLWAY: 'circulation', HALL: 'circulation',
  LOBBY: 'circulation', FOYER: 'circulation', ENTRANCE: 'circulation',
  ENTRY: 'circulation', RECEPTION: 'circulation', STAIRS: 'circulation',
  STAIRWELL: 'circulation', LIFT: 'circulation', ELEVATOR: 'circulation',
  PASSAGE: 'circulation', STAIR: 'circulation', CORE: 'circulation',
  KITCHEN: 'wet', KITCHENETTE: 'wet', BREAKROOM: 'wet', PANTRY: 'wet',
  CANTEEN: 'wet', CAFETERIA: 'wet', BATHROOM: 'wet', WC: 'wet',
  TOILET: 'wet', RESTROOM: 'wet', SHOWER: 'wet', LAUNDRY: 'wet',
  STORAGE: 'utility', STORE: 'utility', STOREROOM: 'utility',
  ARCHIVE: 'utility', PLANT: 'utility', UTILITY: 'utility',
  ELECTRICAL: 'utility', SERVER: 'utility', COMMS: 'utility',
  BEDROOM: 'living', LIVING: 'living', LOUNGE: 'living', DINING: 'living',
  FAMILY: 'living',
  BALCONY: 'outdoor', PATIO: 'outdoor', TERRACE: 'outdoor',
  GARAGE: 'outdoor', CARPARK: 'outdoor', PARKING: 'outdoor',
  RETAIL: 'retail', SHOP: 'retail', SALES: 'retail', SHOWROOM: 'retail',
};

export const CATEGORY_COLORS: Record<string, { fill: string; stroke: string; pill: string }> = {
  office:      { fill: 'rgba(59,130,246,0.15)',  stroke: 'rgba(59,130,246,0.70)',  pill: 'rgba(29,78,216,0.92)'   },
  meeting:     { fill: 'rgba(139,92,246,0.15)',  stroke: 'rgba(139,92,246,0.70)',  pill: 'rgba(76,29,149,0.92)'   },
  circulation: { fill: 'rgba(245,158,11,0.15)',  stroke: 'rgba(245,158,11,0.70)',  pill: 'rgba(120,53,15,0.92)'   },
  wet:         { fill: 'rgba(20,184,166,0.15)',  stroke: 'rgba(20,184,166,0.70)',  pill: 'rgba(15,118,110,0.92)'  },
  utility:     { fill: 'rgba(244,63,94,0.15)',   stroke: 'rgba(244,63,94,0.70)',   pill: 'rgba(136,19,55,0.92)'   },
  living:      { fill: 'rgba(34,197,94,0.15)',   stroke: 'rgba(34,197,94,0.70)',   pill: 'rgba(20,83,45,0.92)'    },
  outdoor:     { fill: 'rgba(168,162,158,0.15)', stroke: 'rgba(168,162,158,0.70)', pill: 'rgba(87,83,78,0.92)'    },
  open:        { fill: 'rgba(99,102,241,0.15)',  stroke: 'rgba(99,102,241,0.70)',  pill: 'rgba(49,46,129,0.92)'   },
  medical:     { fill: 'rgba(236,72,153,0.15)',  stroke: 'rgba(236,72,153,0.70)',  pill: 'rgba(157,23,77,0.92)'   },
  retail:      { fill: 'rgba(251,191,36,0.15)',  stroke: 'rgba(251,191,36,0.70)',  pill: 'rgba(146,64,14,0.92)'   },
  default:     { fill: 'rgba(156,163,175,0.12)', stroke: 'rgba(156,163,175,0.60)', pill: 'rgba(55,65,81,0.92)'    },
};

export function getRoomCategory(label: string): string {
  if (!label) return 'default';
  const up = label.toUpperCase().trim().replace(/[\s/\-]+/g, '_');
  if (ROOM_CATEGORY_MAP[up]) return ROOM_CATEGORY_MAP[up];
  for (const [key, cat] of Object.entries(ROOM_CATEGORY_MAP)) {
    if (up === key || up.startsWith(key + '_') || up.startsWith(key + ' ') || up.includes(key))
      return cat;
  }
  return 'default';
}
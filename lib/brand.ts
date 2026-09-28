// ─── lib/brand.ts ────────────────────────────────────────────────────────────
//  Single source of truth for the Foldrule brand: name, copy and colours.
//  Change the site URL with NEXT_PUBLIC_SITE_URL (used for SEO metadata).
// ─────────────────────────────────────────────────────────────────────────────

export const BRAND = {
  name:        'Foldrule',
  wordmark:    'foldrule',
  tagline:     'PDF takeoff and BOQ, in your browser',
  description:
    'Foldrule is a quantity takeoff tool for estimators and quantity surveyors. ' +
    'Open a PDF drawing, set the scale, measure lengths, areas and counts, and export a priced BOQ to Excel — ' +
    'no install, and your drawings stay on your computer.',
  keywords: [
    'quantity takeoff', 'construction takeoff software', 'PDF takeoff', 'bill of quantities',
    'BOQ software', 'quantity surveying', 'estimating software', 'measure PDF drawings',
    'area takeoff', 'joinery estimating', 'Excel BOQ export',
  ],
  siteUrl: (process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  colors: {
    graphite: '#1D2125',
    ink:      '#16191C',
    rule:     '#F2C230',
    paper:    '#E6E9EC',
    steel:    '#56606B',
    marker:   '#B8322A',
  },
} as const;

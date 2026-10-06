// Landing page. The design lives in components/landing/landing.tsx (a client
// component, for its animations); this server wrapper adds SEO metadata and
// structured data, which a client component can't export.

import type { Metadata } from 'next';
import { Landing } from '@/components/landing/landing';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: BRAND.name,
  applicationCategory: 'BusinessApplication',
  applicationSubCategory: 'Construction quantity takeoff',
  operatingSystem: 'Web browser',
  description: BRAND.description,
  url: BRAND.siteUrl,
  image: `${BRAND.siteUrl}/opengraph-image`,
  featureList: [
    'Snap to PDF linework: endpoints, midpoints, corners, intersections',
    'Per-page scale calibration',
    'Excel BOQ export with live formulas, subtotals and VAT',
    'Length, area, polygon, arc, polyarc, count and grid-count tools',
    'Magic fill for room areas',
    'Perimeter offsets',
    'Groups, unit rates and material library',
    'Joinery presets with 3D preview',
    'Drawings stay on your device; local autosave and backup files',
  ],
};

export default function Page() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Landing />
    </>
  );
}

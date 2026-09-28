import type { MetadataRoute } from 'next';
import { BRAND } from '@/lib/brand';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name:             `${BRAND.name} — ${BRAND.tagline}`,
    short_name:       BRAND.name,
    description:      BRAND.description,
    start_url:        '/dashboard',
    scope:            '/',
    display:          'standalone',
    background_color: BRAND.colors.ink,
    theme_color:      BRAND.colors.graphite,
    categories:       ['business', 'productivity', 'utilities'],
    icons: [
      { src: '/icons/icon-192.png',     sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png',     sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

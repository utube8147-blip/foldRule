import type { MetadataRoute } from 'next';
import { BRAND } from '@/lib/brand';

// `file_handlers` / `launch_handler` let the installed app open .foldrule
// backups and PDFs from File Explorer ("Open with Foldrule"). They're newer
// than Next's Manifest type, hence the widened return type.
type ManifestWithFiles = MetadataRoute.Manifest & {
  file_handlers?: { action: string; accept: Record<string, string[]>; launch_type?: string }[];
  launch_handler?: { client_mode: string | string[] };
};

export default function manifest(): ManifestWithFiles {
  return {
    id:               '/',
    name:             `${BRAND.name} — ${BRAND.tagline}`,
    short_name:       BRAND.name,
    description:      BRAND.description,
    start_url:        '/dashboard',
    scope:            '/',
    display:          'standalone',
    background_color: BRAND.colors.ink,
    theme_color:      BRAND.colors.graphite,
    categories:       ['business', 'productivity', 'utilities'],
    file_handlers: [
      {
        action: '/open',
        accept: {
          'application/pdf': ['.pdf'],
          'application/vnd.foldrule+json': ['.foldrule'],
        },
        launch_type: 'single-client',
      },
    ],
    launch_handler: { client_mode: ['navigate-existing', 'auto'] },
    icons: [
      { src: '/icons/icon-192.png',     sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png',     sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

import type { MetadataRoute } from 'next';
import { BRAND } from '@/lib/brand';

// Only the public landing page is indexable. Project screens hold private,
// browser-local data; lab and auth placeholders aren't for search either.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{
      userAgent: '*',
      allow:     '/',
      disallow:  [
        '/api/', '/dashboard', '/workspace', '/takeoff-full', '/presets',
        '/login', '/register', '/magicFill', '/PdfCVMatchPage', '/Snap',
      ],
    }],
    sitemap: `${BRAND.siteUrl}/sitemap.xml`,
    host:    BRAND.siteUrl,
  };
}

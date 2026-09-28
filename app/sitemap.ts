import type { MetadataRoute } from 'next';
import { BRAND } from '@/lib/brand';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${BRAND.siteUrl}/`, changeFrequency: 'monthly', priority: 1 },
  ];
}

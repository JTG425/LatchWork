import type { MetadataRoute } from 'next';

const SITE_URL = (process.env.APP_BASE_URL ?? 'https://www.latchwork.io').replace(/\/+$/, '');

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];
}

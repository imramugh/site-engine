/** Review this policy quarterly. Its version is emitted with crawler-facing output. */
export const CRAWLER_POLICY_VERSION = '2026-10-03';

export type CrawlerMode = 'public' | 'preview';

export function crawlerMode(basePath: string, configured = process.env.SITE_CRAWLER_MODE): CrawlerMode {
  // A mounted build is always a preview, even if a deployment environment has
  // a stale public-mode variable. Preview URLs must never become indexable.
  if (basePath !== '/') return 'preview';
  if (configured === 'preview') return 'preview';
  return 'public';
}

export function robotsText(mode: CrawlerMode, sitemapURL: string): string {
  const directives = mode === 'preview' ? ['User-agent: *', 'Disallow: /'] : ['User-agent: *', 'Allow: /', `Sitemap: ${sitemapURL}`];
  return [`# site-engine crawler policy ${CRAWLER_POLICY_VERSION}`, ...directives, ''].join('\n');
}

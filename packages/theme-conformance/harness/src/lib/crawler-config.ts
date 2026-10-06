import type { SiteSnapshot } from '@site-engine/contract';

/** Review the supported vendor tokens quarterly. Its version is emitted with
 * crawler-facing output so a release can be audited without guessing. */
export const CRAWLER_POLICY_VERSION = '2026-10-05';
export const CRAWLER_POLICY_REVIEWED_AT = '2026-10-05';
export const CRAWLER_POLICY_NEXT_REVIEW_DUE = '2027-01-05';

export type CrawlerMode = 'public' | 'preview';

export function crawlerMode(basePath: string, configured = process.env.SITE_CRAWLER_MODE): CrawlerMode {
  // A mounted build is always a preview, even if a deployment environment has
  // a stale public-mode variable. Preview URLs must never become indexable.
  if (basePath !== '/') return 'preview';
  if (configured === 'preview') return 'preview';
  return 'public';
}

type CrawlerPolicy = NonNullable<SiteSnapshot['settings']['crawlerPolicy']>;
const legacyPolicy: CrawlerPolicy = { searchEngines: true, aiSearchAndAnswers: true, aiModelTraining: true };
const protectedPaths = ['/admin/', '/preview/', '/api/', '/oauth/', '/mcp/'];

function group(agents: readonly string[], allowed: boolean): string[] {
  return [
    ...agents.map(agent => `User-agent: ${agent}`),
    ...(allowed ? [...protectedPaths.map(path => `Disallow: ${path}`), 'Allow: /'] : ['Disallow: /']),
  ];
}

export function robotsText(mode: CrawlerMode, sitemapURL: string, policy: SiteSnapshot['settings']['crawlerPolicy'] = legacyPolicy): string {
  if (mode === 'preview') return [`# site-engine crawler policy ${CRAWLER_POLICY_VERSION}`, 'User-agent: *', 'Disallow: /', ''].join('\n');
  const selected = policy ?? legacyPolicy;
  const directives = [
    ...group(['*'], selected.searchEngines),
    '',
    ...group(['OAI-SearchBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot'], selected.aiSearchAndAnswers),
    '',
    ...group(['GPTBot', 'ClaudeBot', 'Google-Extended'], selected.aiModelTraining),
    '',
    `Sitemap: ${sitemapURL}`,
  ];
  return [`# site-engine crawler policy ${CRAWLER_POLICY_VERSION}`, ...directives, ''].join('\n');
}

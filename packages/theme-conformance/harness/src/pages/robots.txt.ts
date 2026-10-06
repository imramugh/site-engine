import { crawlerMode, robotsText } from '../lib/crawler-config.js';
import { localURL, publicOrigin, renderBase, siteSnapshot } from '../lib/snapshot.js';

export const GET = () => new Response(robotsText(crawlerMode(renderBase), new URL(localURL('/sitemap.xml'), publicOrigin).href, siteSnapshot.settings.crawlerPolicy), {
  headers: { 'content-type': 'text/plain; charset=utf-8' },
});

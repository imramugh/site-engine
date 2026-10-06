import { publicOrigin, siteHomepageId, siteSnapshot } from '../lib/snapshot.js';
import { publicModel, sitemapXML } from '../lib/seo.js';

export const GET = () => new Response(sitemapXML(publicModel(siteSnapshot, siteHomepageId), publicOrigin), {
  headers: { 'content-type': 'application/xml; charset=utf-8' },
});

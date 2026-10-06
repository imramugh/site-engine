import { publicOrigin, siteHomepageId, siteSnapshot } from '../lib/snapshot.js';
import { llmsText, publicModel } from '../lib/seo.js';

export const GET = () => new Response(llmsText(publicModel(siteSnapshot, siteHomepageId), siteSnapshot, publicOrigin), {
  headers: { 'content-type': 'text/plain; charset=utf-8' },
});

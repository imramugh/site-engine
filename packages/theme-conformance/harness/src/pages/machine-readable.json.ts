import { publicOrigin, siteHomepageId, siteSnapshot } from '../lib/snapshot.js';
import { machineReadablePages, publicModel } from '../lib/seo.js';

export const GET = () => new Response(JSON.stringify(machineReadablePages(publicModel(siteSnapshot, siteHomepageId), siteSnapshot, publicOrigin), null, 2), {
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

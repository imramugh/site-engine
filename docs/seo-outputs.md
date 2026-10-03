# SEO and crawler outputs

The static renderer derives every public output from a validated snapshot. Draft and archived records never enter routes, sitemap entries, JSON-LD, `llms.txt`, or `machine-readable.json`.

`updatedAt` and `publishedAt` are optional for contract 1.0 compatibility. When a published page supplies `updatedAt`, `sitemap.xml` emits it as `lastmod`; otherwise the optional element is omitted. This follows the [Sitemaps protocol](https://www.sitemaps.org/protocol.html).

`Organization`, `WebPage`, and breadcrumbs use page and site fields. `ProfessionalService` requires the explicit `settings.organizationType` value. Article markup requires real publication and revision timestamps. Job markup requires explicit `jobPosting` metadata, a location, and visible rich-text detail; expired roles are omitted, following [Google's JobPosting guidance](https://developers.google.com/search/docs/appearance/structured-data/job-posting).

Crawler directives are versioned in `crawler-config.ts` and reviewed quarterly. Mounted snapshot previews are always noindex and disallow all crawling. Public robots rules also disallow admin, preview, API, OAuth, and MCP paths.

`buildSnapshot` never sends network notifications. Deploy the verification key file emitted from `SITE_INDEXNOW_KEY`, then invoke `publishIndexNowAfterActivation` only after the immutable artifact is active at its HTTPS origin. The hook allowlists the endpoint, rejects redirects, has a ten-second request timeout, and batches at the [IndexNow request limit](https://www.indexnow.org/documentation).

# Review preview worker protocol

The CMS owns immutable `preview-render-jobs`. The worker calls only internal CMS
endpoints, authenticated with the `PREVIEW_WORKER_TOKEN` bearer token. These
endpoints are not public-edge routes.

`POST /api/internal/preview-jobs/claim` claims the oldest pending or expired
lease and returns `{ job, live, proposed, basePaths, versionPins }`, or
`{ job: null }` when idle. `job` is `{ id, leaseToken, leaseExpiresAt }`; `id`
is a UUID. `live` and `proposed` are complete `SiteSnapshot` values.
`basePaths` is exactly `{ live: 'live', proposed: 'proposed' }`; it never
contains an origin. `versionPins` is exactly `{ engineVersion, themeVersion,
contractVersion }` taken from the prepared proof. The worker obtains its public
origin only from trusted runtime configuration and performs rendering and all
network work after claim, outside the CMS transaction.

`POST /api/internal/preview-jobs/renew`, `/complete`, and `/fail` accept a JSON
body no larger than 16 KiB. Each includes `id` and the opaque `leaseToken`.
Completion includes `liveManifestHash`, `proposedManifestHash`, and an opaque
artifact digest. The two manifest hashes are canonical `SiteSnapshot` content
hashes, never artifact-manifest digests. The worker recomputes them before work;
the CMS compares them to immutable job inputs before recording completion.
`artifactDigest` is SHA-256 of the canonical pair of actual output file
manifests. Failure accepts only a bounded uppercase error code. A job is
terminal after three attempts.

The worker must not read drafts, change sets, sessions, or asset records. Review
paths are `/preview/changes/{jobUUID}/{live|proposed}/`; the renderer must route
all page and asset reads through the CMS review-session authorization endpoint.

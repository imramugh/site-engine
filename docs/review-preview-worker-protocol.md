# Review preview worker protocol

The CMS owns immutable `preview-render-jobs`. The worker calls only internal CMS
endpoints, authenticated with the `PREVIEW_WORKER_TOKEN` bearer token. These
endpoints are not public-edge routes.

`POST /api/internal/preview-jobs/claim` claims the oldest pending or expired
lease and returns `{ job, live, proposed, basePaths, versionPins }`, or
`{ job: null }` when idle. `job` is `{ id, leaseToken, leaseExpiresAt }`; `id`
is a UUID. `live` and `proposed` are complete `SiteSnapshot` values.
`basePaths` is exactly `{ live: 'live', proposed: 'proposed' }`; it never
contains an origin. `versionPins` contains `{ engineVersion, themeVersion,
contractVersion }` for the proposed candidate. It can additionally contain
`liveThemeVersion` and `liveContractVersion` when a reviewed theme transition
compares a retained live release with a newer candidate. Missing live pins in a
legacy job mean the proposed pins. The configured environment supplies the worker default; it does not replace a frozen claim contract. The worker requires the exact installed engine pin and accepts only contracts supported by that installed engine, then renders and proves each frozen live/proposed pin. It rejects unsupported future contracts and any snapshot, theme, or candidate pin mismatch before rendering. The worker obtains its public
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

A contract upgrade is an explicit reviewed theme-selection change. It produces
a proposed snapshot with the selected theme contract while leaving the live
snapshot and its pins unchanged. Ordinary content changes do not advance a
contract pin. Approval compares both live and proposed pins with the completed
job so a stale or substituted comparison cannot be approved.

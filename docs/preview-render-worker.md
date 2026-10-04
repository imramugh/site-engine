# Preview rendering worker

Run `node apps/site/scripts/run-preview-worker.mjs` from an installed engine
checkout, or build `apps/site/Dockerfile.worker` from a committed source archive.
This worker only renders review artifacts. It cannot approve or activate content.

Supply these values through restricted runtime configuration:

- `PREVIEW_CMS_ORIGIN`: the private CMS HTTP(S) origin, without a path.
- `PREVIEW_WORKER_TOKEN`: at least 32 random characters, matching the CMS.
- `PREVIEW_ARTIFACT_ROOT`: a dedicated writable artifact directory.
- `SITE_PUBLIC_ORIGIN`: the external site origin used for canonical URLs.
- `SITE_ENGINE_VERSION`, `SITE_THEME_VERSION`, `SITE_CONTRACT_VERSION`: the exact
  startup/default metadata. Every claimed job must supply immutable version pins. The job engine pin must exactly match the configured engine version; each job contract is validated against the installed engine's supported-contract set (currently 1.0.0 and 1.1.0). The worker renders and proves those job pins; an unsupported contract, missing pin, snapshot/pin mismatch, or substituted theme pin is refused.

Run one worker with a read-only container filesystem, no published port, no
Docker socket, and only its private CMS network. Mount the artifact directory
writable and `/workspace/apps/site/.astro` plus `/tmp` as writable tmpfs owned by
the runtime user. Astro caches and frozen source inputs live in private temporary
job directories and are removed when the job finishes. The preview HTTP service
must mount the artifact directory read-only under the same non-root UID and
require authorization for every document and asset request.

The worker claims an immutable live/proposed pair, renews its lease during builds,
validates the generated file inventory and source hashes, and atomically installs
the completed pair under its job UUID. The CMS receives the two snapshot content
hashes and a digest of the pair of file manifests. If a completion response is
lost, a retry reuses the existing artifact only after verifying every file again.
Lease loss or shutdown cancels the Astro process group and prevents completion.
Build errors are reported as bounded codes; source text, credentials and raw
exception messages are not sent to the CMS or worker logs.

All review URLs use `/preview/changes/{job UUID}/{live|proposed}/`. Direct access
to the artifact service must remain private; the edge calls the CMS review-session
authorization endpoint before serving any file. A completed artifact is not a
public release.

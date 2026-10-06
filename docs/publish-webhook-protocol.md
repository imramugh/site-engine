# Private publish build webhook

The durable CMS publish outbox remains the source of truth. A `publish-dispatcher`
claims one job through the existing private CMS worker API, signs its immutable
claim, and posts it to the `publish` renderer receiver on the private Docker
network. No public route, GitHub workflow, or production runner credential is
involved.

## Runtime configuration

- `PUBLISH_ROLE=publish-dispatcher` runs the durable dispatcher.
- `PUBLISH_ROLE=publish` and `PUBLISH_WEBHOOK_PORT=3002` run the receiver.
- `PUBLISH_BUILD_WEBHOOK_URL` is the receiver's private base URL.
- `PUBLISH_WEBHOOK_SECRET` is a shared secret of at least 32 bytes.
- `PUBLISH_DISPATCH_TIMEOUT_MS` defaults to `120000`.
- `PUBLISH_DISPATCHER_HEALTH_FILE` optionally receives a UTC timestamp after
  every successful CMS claim, including an empty queue. Use a 180-second health
  window because a renderer build may run for two minutes.

The receiver exposes only `GET /healthz` on its private network listener. It
contains no configuration or secret values.

## Request contract

The dispatcher sends `POST /internal/publish-build` with a JSON body:

```json
{
  "job": { "id": "uuid", "leaseToken": "opaque", "leaseExpiresAt": "ISO-8601", "sequence": 42, "correlationID": "uuid" },
  "snapshot": { "...": "immutable approved manifest" },
  "contentHash": "sha256",
  "versionPins": { "themeVersion": "...", "engineVersion": "...", "contractVersion": "..." },
  "immutableContext": { "changeSetID": "uuid", "approvedRevision": 7, "includedChangeKeys": ["pages:uuid"], "snapshotID": "uuid", "approvedBy": "uuid", "approvedAt": "ISO-8601" }
}
```

Headers are `X-Publish-Timestamp` (milliseconds), `X-Publish-Nonce` (UUID),
and `X-Publish-Signature: sha256=<hex>`. The signature is HMAC-SHA-256 over
`<timestamp>.<nonce>.<raw JSON bytes>`. The receiver accepts a timestamp within
60 seconds, bounds the body at 1 MiB, and rejects replayed nonces. It validates
the immutable claim before invoking the existing renderer, which renews the CMS
lease before activation and completes or fails through the existing private CMS
API. A dispatcher timeout or rejected receiver request reports `fail` through
that same lease; a receiver-side failure racing that report is harmless because
the lease guard permits only one transition.

# Public analytics hooks

The public site has configurable, privacy safe measurement hooks. They are
disabled unless `PUBLIC_ANALYTICS_ENDPOINT` is set to a valid HTTPS URL with
no userinfo. An unset or invalid endpoint disables measurement. Preview builds
never send measurement requests, even when an endpoint is configured.

## Configuration

| Variable | Behavior |
| --- | --- |
| `PUBLIC_ANALYTICS_ENDPOINT` | Required to enable hooks. Must be HTTPS and must not contain userinfo. |
| `PUBLIC_ANALYTICS_CONSENT_REQUIRED` | Consent is required by default. Set exactly to `false` to make consent optional. |
| `PUBLIC_ANALYTICS_EVENTS_JSON` | Optional JSON array of allowed event names. The default is `page_view`, `primary_cta`, `navigation`, `phone_tap`, `form_accepted`, and `form_failed`. Invalid JSON or a non-array fails closed. |
| `PUBLIC_ANALYTICS_NAVIGATION_PATHS_JSON` | Optional JSON array of approved same-origin navigation paths. The default is an empty list. Invalid input fails closed. |
| `PUBLIC_ANALYTICS_PRIMARY_CTA_PATHS_JSON` | Optional JSON array of paths that extend explicit `data-primary-cta` controls. The default is an empty list. Invalid input fails closed. |

Configured event lists are allowlists. Hooks only emit events enabled by the
effective list and by the relevant path or control rule. Navigation paths are
approved same-origin paths; primary CTA paths supplement explicit
`data-primary-cta` markup. No event is emitted from preview measurement.

When consent is required, the consent choice is stored scoped to the endpoint.
Granting consent enables later events for that endpoint. Revocation stops all
subsequent events immediately; it does not retroactively erase requests that
were already sent. A consent UI may expose equivalent grant and revoke
actions through `window.siteAnalyticsConsent.grant()` and
`window.siteAnalyticsConsent.revoke()`. A storage failure retains the current
page’s choice in memory.

## Collector deployment

A collector must accept anonymous JSON POST requests and, for cross-origin
collection, permit the site's exact origin in its CORS response. The site's
Content Security Policy must permit the collector's exact HTTPS origin in
`connect-src`; keep the default self-only policy until a collector is reviewed.
Do not add a wildcard or expose a private API credential in a public endpoint.
A same-origin collector still needs an explicitly configured server route.

Verification uses an intercepted mock collector and synthetic form data. This
proves the hooks and consent behavior, not an operational reporting service.

## Event contract

Every request contains exactly the allowlisted `event` and `path` fields, plus
the optional `attribution` field when a source is observed. Conversion events
also contain `form`, whose value is `inquiry` or `application`:

```json
{
  "event": "form_accepted",
  "path": "/contact/",
  "attribution": "search",
  "form": "inquiry"
}
```

The event names are `page_view`, `primary_cta`, `navigation`, `phone_tap`,
`form_accepted`, and `form_failed`. Attribution is one of `direct`, `search`,
`referral`, or `ai_assistant`. UTM handling uses only exact known source
mappings. Unknown sources are omitted; the hooks do not guess a campaign or
classify it from a similar string. Internal referrers are omitted. If there is
no referrer and no UTM source, `direct` means no external source was observed;
it does not prove how the visitor arrived. An unknown UTM source or malformed
referrer leaves attribution absent.

The hooks never send form inputs, phone numbers, query strings, record or user
IDs, idempotency tokens, email addresses, cookies, or fingerprints. The
collector can still observe the network source IP as part of normal HTTP
delivery, so the collector owner must define its own schema, access controls,
retention, and deletion policies. These client hooks do not choose a
collector, install a vendor SDK, or create a live dashboard.

## Reporting

Baseline and post-launch reports should record the measurement conditions and
show aggregate results only. The following table is the minimum reporting
contract:

| Area | Record |
| --- | --- |
| Scope | Reporting period, timezone, site build/version, and generation time |
| Volume | Aggregate event counts by event and path; conversion rates using page views as the denominator. Do not invent session counts. |
| Conversion | Aggregate accepted and failed inquiry/application counts, with the applicable page-view denominator. |
| Content freshness | CMS records’ `lastReviewed` and `publishedAt` values, summarized by page or content group. |
| Performance | LCP, INP, CLS, and TTFB, clearly labeled as lab or field data with the sample/source identified. |

Content freshness and performance measures are reporting inputs from CMS,
testing, or field-performance sources. These hooks do not collect
CMS timestamps, browser performance metrics, sessions, or user identity.

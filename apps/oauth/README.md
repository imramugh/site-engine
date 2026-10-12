# Same-origin OAuth proof service

This is an isolated Node authorization-server process intended to be routed by
the existing edge under the same public origin at `/oauth`. It does not add CMS
collections, migrations, public test-login routes, or development credentials.

The service uses `oidc-provider@9.12.2` and a SQLite adapter that hashes every
provider record key before persistence. It is a protocol proof only: production
must inject the authenticated CMS session bridge and deploy edge routing,
backups, migrations, and rollback checks before this service can issue real
visitor credentials.

The interaction page is deliberately bounded: the bridge must identify an
enabled CMS session user, then that user confirms each requested client and
scope with a same-origin CSRF-protected form. There is no automatic consent.
The proof accepts only the configured exact resource indicator and S256 PKCE;
the edge still needs production request-size, rate-limit, TLS, and audit-log
policy before release. Supply a private signing JWKS from the deployment secret
store; this repository contains no usable key material.

Optional presentation branding is deployment-owned: set OAUTH_BRANDING_DIR to a directory with branding.json containing optional name and a local logoFile, plus optional branding.css and local .woff2 fonts. The service exposes only the declared logo, branding.css, and regular local fonts under the issuer assets path; invalid manifests and symlinks fall back to the neutral presentation. The base stylesheet is served from the issuer assets path.

For a private HTTP container behind an HTTPS edge, set `OAUTH_TRUST_PROXY=true`.
This enables oidc-provider's proxy mode so its secure authorization cookies and
redirect handling use the edge's `X-Forwarded-Proto: https`. Set it only when
the edge is private to the service and overwrites forwarded headers. Leave it
unset for loopback and direct deployments.

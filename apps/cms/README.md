# CMS foundation

Payload serves its admin shell at `/admin` and its health probe at `/api/health`.
All content collections deny unauthenticated Local API and REST access. Pages and sections
have Payload drafts; saving a draft does not invoke a public-site publish action.

`DATABASE_URI` must be a local `file:` URI. At process initialization the CMS sets
`journal_mode=WAL`, `foreign_keys=ON`, and `busy_timeout=5000`. One CMS writer owns the
mounted database directory. SQLite is not claimed to support multi-writer deployment;
capacity or multi-instance needs require a separately tested migration.

For production, create and review an expand/contract migration with `pnpm migrate:create`,
commit it, back up the database, then apply it with `pnpm migrate`. The migration command is
the deployment hook; production config disables schema push. The initial operator is created
once through `BOOTSTRAP_OPERATOR_TOKEN_FILE=/secure/token pnpm bootstrap:operator email name`,
using the Payload Local API with `overrideAccess: false`. The restricted operator-readable file is the only
bootstrap secret source and must be removed from the runtime service after use. Until SSO
invitation redemption exists, no authenticated user can create another account.

Microsoft/Google invite redemption, passkey fallback, approval reauthentication, session
revocation audits, content change-set linkage, preview, publishing, and MCP remain gated
follow-on work. Local Payload authentication is deliberately disabled until the invite-only
SSO/passkey implementation exists, so the admin shell is not a claim of a usable sign-in
flow. There is intentionally no `/mcp` placeholder route.

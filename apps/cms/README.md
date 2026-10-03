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
once through `BOOTSTRAP_OPERATOR_TOKEN_FILE=/secure/token pnpm bootstrap:operator email name provider verified-subject`,
using the Payload Local API with `overrideAccess: false`. The restricted operator-readable file is the only
bootstrap secret source. This initial CLI still needs a preverified provider subject; a usable
invitation-first enrollment flow is required before exposing staff sign-in.

Google and Microsoft OIDC callbacks validate issuer, nonce, state, PKCE, invitation binding,
and browser state. Accounts bind to an exact provider/issuer/subject tuple; email never
links a second provider. Opaque sessions are checked against SQLite on each request,
expire after eight idle hours, and have a seven-day absolute limit. Sensitive identity
mutations require authentication within fifteen minutes. Disabling a user or changing
roles revokes sessions and writes an audit event in the same transaction.

Emergency Owner authentication uses an encrypted TOTP seed and single-use recovery codes.
Credential consumption, rate counters, sessions, and audit writes are transactional;
secret fields are excluded from ordinary API reads and writes. Provisioning is an operator
CLI action, not a public enrollment endpoint. There is no emergency-login UI yet.

The configured deployment still denies public admin and auth routes. Real provider
registration, initial enrollment, browser-level staff journeys, approval workflows,
preview, publishing, and MCP remain unfinished. There is no `/mcp` placeholder route.

## SQLite transaction compatibility pin

Payload 3.90.2 pins `@libsql/client` 0.14.0. This workspace scopes its package-manager
override to that dependency at 0.18.0 and applies a narrow patch to
`@payloadcms/drizzle` 3.90.2 so deferred transaction commit errors reach callers.
The regression test reproduces the local WAL failure sequence: a competing failed
`BEGIN` after a write must not make the next transaction's `COMMIT` fail with
`SQLITE_BUSY: SQL statements in progress`. It also verifies a real deferred foreign-key
commit failure rolls back and is surfaced. Keep the exact Payload pin, override, and
patch together until an upstream release contains both fixes; do not remove either
without running `tests/transaction-failure.integration.test.ts` and the identity
transaction tests.

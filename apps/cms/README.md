# CMS foundation

Payload serves its admin shell at `/admin` and its health probe at `/api/health`.
All content collections deny unauthenticated Local API and REST access. Pages and sections
have Payload drafts; saving a draft does not invoke a public-site publish action.

`DATABASE_URI` must be a local `file:` URI. At process initialization the CMS sets
`journal_mode=WAL`, `foreign_keys=ON`, and `busy_timeout=5000`. One CMS writer owns the
mounted database directory. SQLite is not claimed to support multi-writer deployment;
capacity or multi-instance needs require a separately tested migration.

### SQLite writer limits

Run exactly one CMS process against a mounted database directory. WAL permits concurrent
readers, but SQLite still permits one writer at a time. A competing writer waits for the
configured five-second `busy_timeout`; when that deadline expires, application code must
classify `SQLITE_BUSY` as retryable and return controlled backpressure instead of treating
the write as successful. Keep external provider work outside database transactions, use
the existing bounded internal worker batches, and do not add a second CMS, direct database
writer, or network filesystem-backed database without a separately tested database plan.

For production, create and review an expand/contract migration with `pnpm migrate:create`,
commit it, back up the database, then apply it with `pnpm migrate`. The migration command is
the deployment hook; production config disables schema push. Initial enrollment is created
once through `BOOTSTRAP_OPERATOR_TOKEN_FILE=/secure/token pnpm bootstrap:operator email name provider [prebound-subject]`.
It creates no account: it emits a one-time, 24-hour invitation link, and the first verified OIDC callback
creates the Owner account. A supplied subject is enforced. The restricted operator-readable file is the only
bootstrap secret source; copy the link through an approved channel and remove the mount.

Google and Microsoft OIDC callbacks validate issuer, nonce, state, PKCE, invitation binding,
and browser state. Accounts bind to an exact provider/issuer/subject tuple; email never
links a second provider. Opaque sessions are checked against SQLite on each request,
expire after eight idle hours, and have a seven-day absolute limit. Sensitive identity
mutations require authentication within fifteen minutes. Disabling a user or changing
roles revokes sessions and writes an audit event in the same transaction.

Emergency Owner authentication uses an encrypted TOTP seed and single-use recovery codes.
Credential consumption, rate counters, sessions, and audit writes are transactional;
secret fields are excluded from ordinary API reads and writes and from the authenticated
profile passed to the admin client. Provisioning is an operator CLI action. The login
page accepts a TOTP or recovery code through the existing emergency-owner endpoint.

The deployment edge controls exposure of admin and authentication routes. A
verified local Owner can use the authenticator path before external providers
are registered. Real provider integration, approval workflows, preview,
publishing, and MCP remain unfinished. There is no `/mcp` placeholder route.

Mail drafts and their one-time authorization records are local foundation data
for a future reviewed mail workflow. They have no admin collection entry, REST
send endpoint, or compose/send UI; the edge does not expose a mail-drafts API.

`pnpm test:e2e:cms` builds and runs the actual CMS against an isolated SQLite
database and a synthetic TLS OIDC issuer. It exercises browser navigation,
session cookies, profile permissions, logout, callback replay, and CSRF. A local
Owner journey also verifies collection navigation, the actual admin logout
link, revoked-cookie rejection, and immediate disablement. These
tests do not establish connectivity to a real Google or Microsoft registration.

### Editorial role boundary

Owners and Editors may create and edit Pages. Approvers may update existing
Pages through the whole-page editor or an explicitly consented MCP
content-write grant, own and submit the resulting change set, and review other
submitted work. Approvers cannot create Pages or change Sections, Assets,
Redirects, themes, integrations, or users. Every Approver edit remains a draft;
approval still requires a separate fresh-authentication action bound to the
exact change-set revision, change hash, rendered preview, and version pins.
MCP exposes no approval or publication tool.

### AI provider pricing and caps

Provider jobs use integer micro-USD (`1,000,000` = US $1) for every cap and
usage value. An Owner must configure the exact model's reviewed input and output
prices per million tokens, the source URL, and the date reviewed. These values
are pinned with the provider configuration; the service does not fetch or infer
current prices. A missing or invalid price prevents a provider request. Before a
request, the service reserves the input's UTF-8 byte count plus the bounded
maximum output tokens at those rates. It settles from normalized input/output
token usage (never above the conservative reservation) and keeps the full reservation when usage is absent. OpenRouter's
reported `cost` is intentionally never used.

### Internal AI worker

Run the HTTP-only poller with `node apps/cms/scripts/run-ai-worker.mjs` from the repository root. It requires `AI_WORKER_CMS_ORIGIN` (an internal HTTP(S) CMS origin with no path), `AI_WORKER_TOKEN` (at least 32 bytes, independent from other worker tokens), and optionally `AI_WORKER_TIMEOUT_MS` (45,000 ms default; maximum 55,000), `AI_WORKER_IDLE_MS`, and `AI_WORKER_ERROR_MS` (each 100–60,000 ms). The CMS route is `POST /api/internal/ai-worker/run`; keep it unavailable through every public edge or proxy. The poller has no Payload, SQLite, credential, or provider configuration access.

### Internal notification worker

Notification dispatch remains inactive until an operator deliberately runs
`node apps/cms/scripts/run-notification-worker.mjs` from the repository root.
It requires `NOTIFICATION_WORKER_CMS_ORIGIN` (an internal HTTP(S) CMS origin
with no path) and an independent `NOTIFICATION_WORKER_TOKEN` of at least 32
bytes. Optional `NOTIFICATION_WORKER_TIMEOUT_MS` defaults to 45,000 and caps
at 55,000; `NOTIFICATION_WORKER_IDLE_MS` and
`NOTIFICATION_WORKER_ERROR_MS` each accept 100–60,000. The worker only calls
`POST /api/internal/notification-worker/run`; keep it unavailable through
every public edge or proxy. It has no SQLite, SMTP, mailbox credential, or
recipient configuration access. Missing or untested mail configuration leaves
receipts queued or retryable; ambiguous SMTP results become `unknown` and are
never automatically resent.

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

### Local owner bootstrap

Only before any user or live invitation exists, an operator may run `pnpm bootstrap:local-owner <email> <name>` with `ALLOW_LOCAL_OWNER_BOOTSTRAP=true`, `PAYLOAD_SECRET`, `EMERGENCY_TOTP_ENCRYPTION_KEY`, a protected `BOOTSTRAP_OPERATOR_TOKEN_FILE`, and a new `LOCAL_OWNER_CREDENTIALS_FILE`. The command writes the TOTP handoff material only to that exclusive 0600 file; it never prints credentials.
# CMS

## Optional admin branding bundle

The public engine has neutral admin styling. A private build may provide an
optional bundle without adding private assets to this repository:

- `admin-branding/branding.json` is a runtime manifest, copied into the CMS
  standalone image and exposed to the process through `ADMIN_BRANDING_DIR` when
  it is not located beside the CMS runtime.
- `public/admin-branding/admin-branding.css` and `public/admin-branding/assets/`
  are the browser-visible stylesheet and same-origin logo assets.

The manifest accepts `name` (1–80 characters), `initials` (1–4 characters), an
optional root-relative `/admin-branding/...` `logoUrl`, and the bounded color
tokens `--admin-accent`, `--admin-accent-contrast`, `--admin-surface`,
`--admin-sidebar`, `--admin-text`, and `--admin-border`. An absent or invalid
bundle always falls back to the neutral public shell.

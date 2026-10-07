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
readers, but SQLite still permits one writer at a time. Payload transactions use a
per-adapter FIFO queue with at most 100 pending writers and a five-second queue wait.
An expired waiter is removed without interrupting the active transaction. This avoids
blocking the Node event loop on a local writer that needs that same event loop to commit.
An independent database writer can still contend after queue admission; each libSQL
connection has a five-second `timeout`, including lazy and replacement connections.
When either wait expires, application code must
classify `SQLITE_BUSY` as retryable and return controlled backpressure instead of treating
the write as successful. Keep external provider work outside database transactions, use
the existing bounded internal worker batches, and do not add a second CMS, direct database
writer, or network filesystem-backed database without a separately tested database plan.

For production, create and review an expand/contract migration with `pnpm migrate:create`,
commit it, back up the database, then apply it with `pnpm migrate`. The migration command is
the deployment hook; production config disables schema push. The initial Owner is created through the protected local bootstrap command described below. Owners issue one-time, 24-hour enrollment links; invitees scan the authenticator QR code and prove their first code before an account or session exists. The invite token stays in the URL fragment and only its hash is stored. Opaque sessions are checked against SQLite on each request,
expire after eight idle hours, and have a seven-day absolute limit. Sensitive identity
mutations require authentication within fifteen minutes. Disabling a user or changing
roles revokes sessions and writes an audit event in the same transaction.

Local authenticator authentication uses an encrypted TOTP seed and single-use recovery codes.
Credential consumption, rate counters, sessions, and audit writes are transactional;
secret fields are excluded from ordinary API reads and writes and from the authenticated
profile passed to the admin client. Provisioning is an operator CLI action. The login
page accepts a TOTP or recovery code through `/api/auth/local`; `/api/auth/emergency` remains a compatibility alias.

The deployment edge controls exposure of admin and authentication routes. The
MCP OAuth service remains independent from staff sign-in and resolves the same
server-side CMS session after local authenticator authentication.

`pnpm test:e2e:cms` runs the CMS against isolated SQLite state. It covers local
sign-in, token-bound invitation enrollment, sessions, logout, CSRF, revoked
cookies, and disabled accounts.

### Editorial role boundary

Owners and Editors may create and edit Pages. Approvers may update existing
Pages through the whole-page editor or an explicitly consented MCP
content-write grant, own and submit the resulting change set, and review other
submitted work. Approvers cannot create Pages or change Sections, Assets,
Redirects, themes, integrations, or users. Every Approver edit remains a draft;
approval still requires a separate fresh-authentication action bound to the
exact change-set revision, change hash, rendered preview, and version pins.
MCP exposes no approval or publication tool.

### Direct text editing in the page preview

In the full page editor, prepare the saved draft preview and choose **Edit text
in preview**. Explicit renderer markers support existing Hero eyebrow,
heading and body, and Callout/CTA heading and body. Generated navigation,
service introductions projected from page metadata, links, nested items and
unsupported fields retain the complete split-view controls. An absent,
duplicate or mismatched marker disables preview typing rather than guessing
which source field owns the text.

Typing updates only the local draft. **Check draft** validates the exact page
hash and owned change-set revision without saving; review its field errors and
publication-readiness results before **Save draft**. Selecting Save on an
unchecked draft performs the check first and requires another Save to persist.
A valid draft may still have publication blockers. Save uses normal change-set
capture and refreshes the protected preview; it never publishes. A stale save
retains typed text until the editor explicitly chooses to reload and discard.
Owners, Editors and Approvers use the same whole-page authorization boundary.

Expose `POST /api/editorial/page-editor/:id/validate` through the deployment
edge with the existing 2,000,000-byte page-save limit. Allow the generic
`GET /page-editor-preview.css` stylesheet so preview highlighting works under
a strict same-origin CSP without inline styles. Keep private preview access
protected by the existing session and change-set checks.

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

The Drizzle patch also coordinates SQLite transaction starts until commit or rollback,
releasing the queue lease on failed starts and failed commits. It applies only to the
SQLite adapter. Regression coverage checks FIFO order, queue capacity, timed-out waiter
removal, surviving transactions, and successful writes after each failure path.

The workspace also pins a narrow `@libsql/client` 0.18.0 patch. It discards only the
connection whose transaction `BEGIN` failed, then serves one queued borrower with a
replacement connection. It never closes, reconnects, or rolls back the shared client.
Remove this patch only after upgrading to a Payload-compatible libSQL release that
contains equivalent failed-`BEGIN` disposal and waiter handling, and after the direct
edit SQLite contention regression proves both ESM and CJS clients can commit a retry
while an independent transaction remains usable.

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

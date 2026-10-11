# Email provider setup

The Email workspace provides one owner-controlled workflow for Microsoft 365,
Google Workspace and SMTP. Staff sign-in is independent: local authenticator
accounts do not require a Microsoft or Google identity provider. A mailbox
connection still needs that mail provider's authorization.

Credentials are write-only and encrypted using purpose-specific authenticated
encryption under `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` (32 bytes, base64url).
Keep that key stable and backed up outside the repository. Configure mailbox
connections from a fresh Owner session in Integrations → Email. A connection
check reads provider state without sending email. A test message requires an
explicit review and confirmation; it is an actual email when using a live
provider. Revoking a connection removes its local credentials, sender proofs
and area mappings, and disables notification processing.

## Microsoft shared mailbox (recommended)

1. Register a single-tenant Entra application. Record its tenant ID, application
   ID and a client secret. No interactive redirect URI is needed for app-only
   access.
2. Have the Exchange administrator authorize that service principal for **only
   the selected shared mailbox** using [Exchange RBAC for Applications](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac).
   Assign scoped `Application Mail.ReadWrite` and `Application Mail.Send` roles;
   drafts, attachments and reply creation require read/write access. Confirm
   the selected mailbox is allowed and an unrelated mailbox is denied using
   Exchange's service-principal authorization test.
3. Do not also grant unrestricted equivalent Entra mail permissions: those
   grants are additive and can defeat the Exchange scope. Legacy Application
   Access Policies are not the recommended setup for new connections.
4. In Email, configure the tenant ID, application ID, write-only secret, exact
   shared-mailbox address and intended aliases. Run the connection test, then
   explicitly send a test from each intended sender, including the primary
   app-only sender. Only verified addresses become eligible for Leads, Careers
   and Notifications mappings.

Graph requests use `/users/{selected-mailbox}`. This application routing is an
additional restriction, not a substitute for Exchange permission scoping.
Microsoft must permit the chosen send-as address, and the draft's actual sender
must match before the application sends it.

Existing delegated connections remain supported. To enable delegated setup,
set restricted `MAILBOX_MICROSOFT_CLIENT_ID` and
`MAILBOX_MICROSOFT_CLIENT_SECRET`; register
`https://cms.example.com/api/email-workspace/oauth/microsoft/callback` using
your actual origin. The requested scopes are `offline_access`, `User.Read`,
`Mail.ReadWrite` and `Mail.Send`. Shared-mailbox notification subscriptions
require app-only authorization; delegated shared-mail scopes do not grant that
capability.

## Google Workspace

Create a Google Cloud OAuth web application, enable the Gmail API and configure
its consent screen for the mailbox account. Set restricted
`MAILBOX_GOOGLE_CLIENT_ID` and `MAILBOX_GOOGLE_CLIENT_SECRET`. Register
`https://cms.example.com/api/email-workspace/oauth/google/callback` using your
actual origin. Connect Google from a fresh Owner session and authorize the
specific mailbox account, not domain-wide delegation.

Scopes are `gmail.readonly`, `gmail.send` and `gmail.settings.basic` under
`https://www.googleapis.com/auth/`. These read matched conversation history,
send approved replies and inspect accepted send-as identities. Only provider
accepted aliases can be mapped; test delivery can be explicitly requested.
Keep consent/refresh-token restrictions appropriate to the production account.

## SMTP fallback

SMTP needs hostname, port, STARTTLS or implicit TLS, username and password.
The server pins connections to a resolved public address and rejects private,
loopback, link-local and reserved addresses. Test the connection before sending.
Aliases require an explicitly confirmed successful test from that exact
address. SMTP server acceptance proves that it accepted the envelope; it is
not a recipient delivery receipt. SMTP is outbound-only and does not supply
provider conversation history or inbound notifications.

## Notifications and polling

Microsoft Graph subscriptions and authenticated Google Pub/Sub push requests
wake the mailbox worker; notification bodies never become timeline messages.
The worker retrieves actual provider mail and matches by provider conversation
ID plus mailbox. Polling remains a fallback when notifications are unavailable.
Subscription/watch renewal runs automatically with bounded retries. Required
public POST routes are:

- `/api/email-workspace/notifications/microsoft`
- `/api/email-workspace/notifications/google`

The routes authenticate provider state/tokens, not staff cookies. Do not exempt
other Email API routes from browser origin checks. Keep the internal mailbox
worker route private and protect it with `MAILBOX_WORKER_TOKEN`.

Google push requires a topic in the same project as the Gmail client. Grant
Gmail's publishing service account permission to publish to that topic. Create
an authenticated Pub/Sub push subscription and set restricted CMS environment:

- `MAILBOX_GOOGLE_PUBSUB_TOPIC`: full `projects/.../topics/...` name.
- `MAILBOX_GOOGLE_PUBSUB_AUDIENCE`: the configured push token audience.
- `MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT`: exact push service-account email.

Configure its endpoint as the Google notification route. Tokens are verified
against Google's signing keys, issuer, audience, expiry and verified service
account email. See [Gmail push setup](https://developers.google.com/workspace/gmail/api/guides/push)
and [authenticated Pub/Sub push](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).

## Thread privacy and controlled replies

Only messages from already matched conversations are stored, including text,
metadata, attachment descriptors and safe provider links. Incoming and outgoing
messages share the timeline. Attachment bytes are fetched on demand through an
authorized record route. Same-address unrelated conversations are suggestions;
staff must adopt them explicitly. Subjects never determine thread ownership.
An assistant may prepare a reply, but the reviewed immutable envelope requires
human confirmation before one send. Editing the envelope invalidates that
confirmation.

Automated acceptance uses synthetic provider transports and browser fixtures.
A successful automated test does not establish live tenant consent, mailbox
scope, delivery, or external webhook availability; verify these when connecting
the actual mailbox.

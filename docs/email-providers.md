# Email provider setup

The Email workspace supports SMTP configuration and delivery verification. Microsoft 365 and Google Workspace are shown as available integrations, but they remain disconnected until an administrator registers and authorizes the corresponding tenant application.

## SMTP

SMTP requires a hostname, port, STARTTLS or implicit TLS, a username, and a password. The password is encrypted with `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` and purpose-specific authenticated encryption. Keep that 32-byte base64url key stable across deployments; changing it makes existing mailbox credentials unreadable.

Before connecting, the CMS resolves the configured hostname and pins the connection to one public address. Loopback, private, link-local, carrier-grade NAT, documentation, unspecified, multicast, and other reserved IPv4 and IPv6 ranges are rejected. A successful connection test is required before sending. An alias becomes eligible for Leads, Careers, or Notifications only after a successful test message from that exact address.

## Microsoft 365

A future Microsoft 365 adapter requires an application registration in the site's Microsoft Entra tenant, an approved OAuth callback, offline token access, and delegated mailbox consent. Sending as the signed-in mailbox requires `Mail.Send`; shared-mailbox sending also requires the appropriate shared-mailbox consent such as `Mail.Send.Shared`. Client secrets and refresh tokens must use server-side encrypted storage and must never enter browser-visible configuration.

## Google Workspace

A future Google Workspace adapter requires a Google Cloud OAuth web application, an approved callback, the Gmail API, offline token access, and mailbox consent for `https://www.googleapis.com/auth/gmail.send`. Client secrets and refresh tokens must use server-side encrypted storage and must never enter browser-visible configuration.

The current Microsoft and Google cards do not initiate authorization or claim a connection. SMTP is the only delivery adapter implemented by this increment.

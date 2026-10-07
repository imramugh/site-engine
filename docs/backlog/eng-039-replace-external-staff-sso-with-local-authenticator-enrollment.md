# ENG-039: Replace external staff SSO with local authenticator enrollment

**Phase:** Full blueprint launch

## Source references
- 2026-10-07 user decision: retire Microsoft/Google staff sign-in; keep local authenticator access and Owner-issued invitations

## User story
As an Owner, I can invite staff with specific roles and give each person an expiring setup link, so they can enroll their own authenticator and access only their permitted workspace. As invited staff, I can scan a TOTP QR code, prove enrollment, save recovery codes, and sign in without an external identity account.

## Acceptance criteria
- [ ] Existing local Owner credentials and sessions survive the deployment. Initial Owner bootstrap remains explicit, restricted, and unavailable once the instance is initialized.
- [ ] Staff login uses email plus an authenticator or single-use recovery code. All supported staff roles can sign in; disabled users cannot. Replay rejection, failure throttling, session expiration, fresh authentication, and role enforcement remain in force.
- [ ] Staff Microsoft/Google login and callback endpoints are retired. The staff interface no longer advertises those providers. Mailbox OAuth and the independent MCP OAuth service remain supported.
- [ ] Only a freshly authenticated Owner can issue or revoke a local invitation. Invitations carry explicit roles, expire in 24 hours, and cannot create duplicate accounts. Owner is never the default role.
- [ ] The enrollment token is opaque and stored hashed. The setup URL uses a fragment so the token does not reach ordinary request logs. Pending TOTP seeds are encrypted, and staff-list responses, audit events, initial HTML, and logs do not expose them.
- [ ] The invitee can scan a locally generated QR code or use an accessible manual setup alternative. An account and session are created only after successful TOTP confirmation. Redemption is atomic and single-use, including concurrent requests.
- [ ] Recovery codes are shown once after enrollment and stored only as hashes. The interface asks the user to save them before continuing.
- [ ] Expired, revoked, consumed, malformed, and incorrectly confirmed invitations fail safely. Owner protections and immediate session revocation after role/disable changes remain intact.
- [ ] Existing local sessions still authorize MCP through the engine's OAuth consent/token flow. No external staff identity tenant is required.

## Test requirements
- **Unit:** Validate input bounds, local-only policy, credential redaction, role defaults and QR enrollment states.
- **Integration:** Exercise real SQLite enrollment atomicity/concurrency, expiry/revocation, all-role local login, replay/rate-limit/recovery protections, fresh Owner/CSRF controls, existing Owner preservation and MCP OAuth regression.

## Browser scenarios
- Given a fresh Owner, when they invite an Editor and the invitee scans the QR or uses manual setup and confirms TOTP, then one account and session are created and recovery codes are displayed once before entering the permitted workspace.
- Given an invalid, expired, revoked or consumed invitation, when enrollment is attempted, then it creates no account/session and shows an accessible safe error.
- Given enrolled staff, when they use an authenticator or recovery code, then permitted pages work, privileged actions remain denied and no external identity provider is contacted.
- Verify keyboard access, desktop/mobile layout and axe; deploy immutable images and verify live local Owner, user management and OAuth/MCP access.

## Dependencies
- ENG-007
- ENG-017

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

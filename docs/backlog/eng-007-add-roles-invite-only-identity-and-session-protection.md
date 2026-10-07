# ENG-007: Add roles, invite-only identity, and session protection

**Phase:** Foundation

## Source references
- Strategy §8 Security
- Strategy §9 Roles
- Strategy §9 Sign-in providers
- 2026-10-07 decision: external staff SSO retired; local staff enrollment supersedes it in ENG-039

## User story
As an owner, I want scoped staff access so only appropriate people can change content, approve work, or see personal data.

## Acceptance criteria
- [ ] Support Owner, Approver, Editor, Sales, and Hiring roles, including multiple roles per person.
- [ ] Historical requirement retired on 2026-10-07: invite-only Microsoft/Google staff sign-in. Preserve its accepted evidence; local authenticator staff enrollment is now required by ENG-039.
- [ ] Permit explicitly authorized operator bootstrap of an initial local Owner when provider registration is unavailable, using the same authenticator/recovery/session protections. Write setup credentials only to an exclusive restricted file; refuse duplicate bootstrap and leave no account after a failed provisioning transaction.
- [ ] Require reauthentication when an approval session is older than 15 minutes and expire idle sessions after 8 hours.
- [ ] Allow Owners to disable a user and revoke active application/MCP sessions immediately with a measurable revocation audit event.
- [ ] Record sign-in and authorization decisions in audit history.

## Test requirements
- **Unit:** Test role matrix and session-age decisions.
- **Integration:** Preserve historical signed-provider evidence; current local authenticator enrollment and retired staff OIDC endpoints are verified under ENG-039. Retain disablement and session protection regression.

## Browser scenarios
- Given an Editor tries to approve, when they submit a decision, then the API returns forbidden and no publish begins.
- Given a disabled identity, when it reuses a session, then protected endpoints reject it.
- Given a locally provisioned Owner and no configured external provider, when they sign in with an authenticator or recovery code, then they can load the admin and permitted collections; logout revokes their session and a consumed recovery code cannot be reused.

## Dependencies
- ENG-006

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

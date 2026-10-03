# ENG-007: Add roles, invite-only identity, and session protection

**Phase:** Foundation

## Source references
- Strategy §8 Security
- Strategy §9 Roles
- Strategy §9 Sign-in providers

## User story
As an owner, I want scoped staff access so only appropriate people can change content, approve work, or see personal data.

## Acceptance criteria
- [ ] Support Owner, Approver, Editor, Sales, and Hiring roles, including multiple roles per person.
- [ ] Implement invite-only Microsoft or Google sign-in and one emergency passkey/authenticator owner path.
- [ ] Require reauthentication when an approval session is older than 15 minutes and expire idle sessions after 8 hours.
- [ ] Allow Owners to disable a user and revoke active application/MCP sessions immediately with a measurable revocation audit event.
- [ ] Record sign-in and authorization decisions in audit history.

## Test requirements
- **Unit:** Test role matrix and session-age decisions.
- **Integration:** Validate OAuth callback, invitation redemption, disablement, and passkey fallback with test providers.

## Browser scenarios
- Given an Editor tries to approve, when they submit a decision, then the API returns forbidden and no publish begins.
- Given a disabled identity, when it reuses a session, then protected endpoints reject it.

## Dependencies
- ENG-006

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

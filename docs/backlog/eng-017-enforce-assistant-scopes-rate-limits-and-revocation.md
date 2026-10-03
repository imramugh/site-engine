# ENG-017: Enforce assistant scopes, rate limits, and revocation

**Phase:** Full blueprint launch

## Source references
- Strategy §3 Inquiries through MCP
- Strategy §8 Security

## User story
As an owner, I want each connected assistant scoped and revocable so delegated access remains controlled.

## Acceptance criteria
- [ ] Grant content and optional inquiry/career scopes separately per connected client.
- [ ] Deny user management, permanent deletion, approval, and publishing through MCP.
- [ ] Revoke a client connection immediately and invalidate its tokens.
- [ ] Rate-limit MCP by identity and client with safe retry responses.
- [ ] Display connected clients, scopes, and last use to Owners.
- [ ] Support an Owner-controlled policy to hide inquiry phone numbers from MCP responses, including list/detail/export serializers and derived summaries, independently of admin access.

## Test requirements
- **Unit:** Test scope matrix, token invalidation, and rate-limit keying.
- **Integration:** Connect two test clients to one user and revoke one without affecting the other.

## Browser scenarios
- Given a content-only assistant, when it calls list_inquiries, then it receives forbidden and no lead metadata.
- Given an Owner revokes a client, when that client repeats a request, then it is rejected immediately.
- Given phone redaction is enabled, when a connected assistant reads or searches a lead it can otherwise access, then no phone value appears in responses or summaries; authorized staff can still view it in the admin.

## Dependencies
- ENG-007
- ENG-016

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

# ENG-033: Require explicit authorization for email sends

**Phase:** Full blueprint launch

## Source references
- Strategy §3 Inquiries through MCP
- Strategy §3 Email providers

## User story
As an owner, I want site-mailbox sends to require explicit confirmation so an assistant cannot email contacts autonomously.

## Acceptance criteria
- [ ] Represent prepare, explicit authorization, send, cancel, and expiry as distinct reply states.
- [ ] Bind authorization to exact recipient, sender, subject, normalized body, attachments, lead/application, and short expiry.
- [ ] Require a fresh human confirmation for every site-mailbox send; never reuse prior consent.
- [ ] Log user, assistant, and final provider result without exposing message contents in notifications.
- [ ] Reject changed, expired, unauthorized, or replayed send requests.

## Test requirements
- **Unit:** Test authorization digest, expiry, replay, and mutation invalidation.
- **Integration:** Use deterministic mail adapters for prepared, authorized, failed, and duplicated sends.

## Browser scenarios
- Given an assistant prepares a reply but receives no confirmation, when it requests send, then no provider call occurs.
- Given a body changes after confirmation, when send is attempted, then it is rejected and requires new confirmation.

## Dependencies
- ENG-020
- ENG-017

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

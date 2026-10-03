# ENG-020: Integrate lead mail threading and controlled replies

**Phase:** Full blueprint launch

## Source references
- Strategy §3 Email conversations on each lead
- Strategy §3 Email providers

## User story
As a sales user, I want replies and matching conversation history on a lead so follow-up has context.

## Acceptance criteria
- [ ] Support provider adapters for Microsoft 365, Google Workspace, and SMTP fallback behind one workflow.
- [ ] Match mail by provider conversation/thread ID, not subject; suggest other conversations from same address without auto-adding.
- [ ] Store only matched lead mail metadata/body/attachments and message links.
- [ ] Use mailbox-scoped provider permissions and verify send-as aliases.
- [ ] Allow assistant prepare_reply then explicit human confirmation for site-address sends.

## Test requirements
- **Unit:** Test thread matching, alias status, message sanitization, and suggestion logic.
- **Integration:** Use provider mocks for inbound webhook, polling fallback, send, and thread update.

## Browser scenarios
- Given a visitor replies in the original conversation, when provider delivery arrives, then the same lead timeline gains the message.
- Given an assistant drafts a site-mailbox reply without confirmation, when it requests send, then no email is sent.

## Dependencies
- ENG-019
- ENG-017

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

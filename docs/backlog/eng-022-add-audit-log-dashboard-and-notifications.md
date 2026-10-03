# ENG-022: Add audit log, dashboard, and notifications

**Phase:** Full blueprint launch

## Source references
- Strategy §9 Change log and rollback
- Strategy §9 Notifications
- Strategy §9 Dashboard

## User story
As an owner, I want one operational view of activity and failures so I can act promptly.

## Acceptance criteria
- [ ] Record content, media, settings, theme, integration, sign-in, MCP, review, and release events without secret values.
- [ ] Provide filtered audit timeline with actor, assistant, target, type, status, diffs, screenshots, and build links.
- [ ] Show pending reviews, urgent/new leads, stale/failing pages, latest publish, integration health, and shortcuts.
- [ ] Notify configured roles for reviews, leads, applications, follow-ups, publish failure, and integration outage.
- [ ] Prevent muting urgent incident alerts; keep notification emails free of personal message/resume contents.

## Test requirements
- **Unit:** Test redaction, event filters, recipient resolution, mute policy, and notification payloads.
- **Integration:** Trigger fixture events and assert audit persistence and queued role-based notifications.

## Browser scenarios
- Given an integration health check fails, when the monitor runs, then Owners receive a minimal alert with a signed-in admin link.
- Given an urgent alert recipient mutes notifications, when an incident lead arrives, then that urgent alert is still delivered.

## Dependencies
- ENG-008
- ENG-010
- ENG-019
- ENG-021

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

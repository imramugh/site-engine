# ENG-019: Build secure contact inquiry intake and lead pipeline

**Phase:** Full blueprint launch

## Source references
- Strategy §9 Leads
- Strategy §3 Contact page outline

## User story
As a visitor, I want to send an inquiry through an accessible form and as sales staff I want to manage it safely.

## Acceptance criteria
- [ ] Implement server-side validation, consent, spam controls, source page, topic, and optional contact fields.
- [ ] Create one lead per accepted inquiry with stage, notes, assignee, next action, and source attribution.
- [ ] Provide pipeline/list views, urgent pinning, filters, CSV export, and manual lead creation.
- [ ] Treat visitor message text as untrusted content in UI and MCP responses.
- [ ] Keep public forms separate from content publishing permissions.

## Test requirements
- **Unit:** Test validation, consent, spam decisions, stage transitions, and CSV escaping.
- **Integration:** Submit form fixtures including malformed input and verify lead persistence and notifications queue.

## Browser scenarios
- Given invalid email or missing consent, when a visitor submits, then accessible inline errors appear and no lead is created.
- Given an active-incident topic, when accepted, then the lead is marked urgent and alert delivery is queued.

## Dependencies
- ENG-006
- ENG-007

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

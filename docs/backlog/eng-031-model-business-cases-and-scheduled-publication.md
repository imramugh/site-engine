# ENG-031: Model business cases and scheduled publication

**Phase:** Full blueprint launch

## Source references
- Strategy §3 Content model
- Strategy §3 Templates

## User story
As an editor, I want business cases and scheduled releases represented explicitly so insights publish correctly.

## Acceptance criteria
- [ ] Add business-case fields for client/anonymized client, industry, challenge, approach, outcome, services, publication date, and SEO.
- [ ] Support scheduled publish time in the page/change-set model with timezone-safe validation.
- [ ] Keep scheduled publish subject to completed review and passing blocking checks at execution.
- [ ] Render business cases in insights listings and compatible schema outputs.
- [ ] Record a skipped/failed scheduled release without changing public content.

## Test requirements
- **Unit:** Test business-case validation and timezone/schedule state transitions.
- **Integration:** Schedule, approve, execute, and fail a fixture publication through the release worker.

## Browser scenarios
- Given an unapproved scheduled page reaches its time, when the worker runs, then it remains private and records why.
- Given an approved business case publishes, when its index loads, then its card and detail route appear once.

## Dependencies
- ENG-003
- ENG-010
- ENG-029

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

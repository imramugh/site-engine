# ENG-009: Build protected on-page and admin review comparison

**Phase:** Full blueprint launch

## Source references
- Strategy §3 Review on the page itself
- Page Review Mode

## User story
As an approver, I want to compare live and proposed pages in context so I can make an informed approval decision.

## Acceptance criteria
- [ ] Show review UI only to authenticated Approvers and only on pages affected by pending changes.
- [ ] Support Live, Proposed, side-by-side, desktop, and mobile views.
- [ ] Highlight changed blocks and show text diffs, check results, and comments.
- [ ] Offer approve, request changes, and reject actions using the same review API as admin.
- [ ] Mark preview endpoints noindex and require sign-in.

## Test requirements
- **Unit:** Test visibility gates and comparison mapping.
- **Integration:** Render a proposed fixture through the preview service with changed-block metadata.

## Browser scenarios
- Given an anonymous visitor, when they load a page with pending edits, then no review script or proposed content is delivered.
- Given an Approver with a session older than the policy limit, when approving, then reauthentication is required.

## Dependencies
- ENG-008
- ENG-004

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

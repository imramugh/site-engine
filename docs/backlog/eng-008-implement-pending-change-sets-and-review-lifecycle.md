# ENG-008: Implement pending change sets and review lifecycle

**Phase:** Foundation

## Source references
- Strategy §3 Change review
- Strategy §8 How a change goes live

## User story
As an approver, I want every proposed change grouped and reviewable so public publishing always has human control.

## Acceptance criteria
- [ ] Support open, submitted, changes-requested, approved, rejected, published, discarded, and stale states.
- [ ] Capture reversible field-level before/after diffs and affected pages.
- [ ] Run checks and create a private preview when submitted.
- [ ] Allow an approver to exclude individual changes while retaining the remainder pending.
- [ ] Flag and require refresh for a set whose base content changed; flag stale sets after 30 days.

## Test requirements
- **Unit:** Test transition guards, diff generation, exclusions, conflicts, and stale calculations.
- **Integration:** Submit a multi-page CMS change set and load its preview snapshot.

## Browser scenarios
- Given content changes after a set was submitted, when approval is attempted, then approval is blocked until refresh.
- Given a reviewer excludes one change, when approving, then only included changes proceed to publish.

## Dependencies
- ENG-006
- ENG-007

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

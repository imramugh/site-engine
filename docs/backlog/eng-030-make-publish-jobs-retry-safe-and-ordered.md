# ENG-030: Make publish jobs retry-safe and ordered

**Phase:** Full blueprint launch

## Source references
- ops architecture Publish consistency
- ops quality-and-delivery Recovery/release

## User story
As an operator, I want duplicate, stale, and failed release jobs handled safely so live content never regresses.

## Acceptance criteria
- [ ] Use transactional claiming and idempotent deployment callbacks.
- [ ] Reject stale jobs whose approved snapshot is no longer current.
- [ ] Ensure concurrent approvals cannot overwrite a newer live release.
- [ ] Keep the prior live artifact on failed build or health check.
- [ ] Expose retry reason, attempt count, and correlation ID in release history.

## Test requirements
- **Unit:** Test job ordering, stale detection, idempotency, and retry classification.
- **Integration:** Simulate duplicate callbacks, out-of-order jobs, timeout, and crash recovery against SQLite.

## Browser scenarios
- Given the same deployment callback arrives twice, when processed, then one release record is created.
- Given an older job completes after a newer release, when it reports success, then it cannot replace the newer artifact.

## Dependencies
- ENG-029
- ENG-010

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

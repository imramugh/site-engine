# ENG-029: Create immutable publish snapshots and durable outbox

**Phase:** Foundation

## Source references
- Strategy §8 How a change goes live
- ops architecture Publish consistency

## User story
As a publisher, I want approval bound to an exact snapshot so a build cannot accidentally release newer edits.

## Acceptance criteria
- [ ] Create an immutable content snapshot and release manifest inside the approval transaction.
- [ ] Persist a durable outbox job with idempotency key rather than calling CI directly.
- [ ] Bind snapshot to contract, engine, theme-version reference, checks, and revision identifiers.
- [ ] Invalidate approval when an included record changes.
- [ ] Record release state only after deployment health evidence returns.

## Test requirements
- **Unit:** Test snapshot hashing, approval invalidation, and idempotency-key generation.
- **Integration:** Run SQLite transaction/outbox commit and simulated worker recovery.

## Browser scenarios
- Given an edit occurs after approval, when the queued publish job runs, then it cannot release the changed content.
- Given a process crashes after transaction commit, when the worker resumes, then exactly one release job is processed.

## Dependencies
- ENG-008
- ENG-011

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

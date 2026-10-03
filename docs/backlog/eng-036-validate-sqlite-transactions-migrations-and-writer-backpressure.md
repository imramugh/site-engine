# ENG-036: Validate SQLite transactions, migrations, and writer backpressure

**Phase:** Foundation

## Source references
- user correction 2026-10-03
- Strategy §8 SQLite or a full database

## User story
As a maintainer, I want reliable SQLite transaction behavior under the intended single-writer deployment so concurrent workflows fail safely.

## Acceptance criteria
- [ ] Use SQLite WAL, foreign keys, busy_timeout, and explicit transaction boundaries for content, approval, outbox, and audit writes.
- [ ] Provide expand/contract migration workflow from empty and previous schema states.
- [ ] Serialize CMS writers and return retryable backpressure errors rather than leaking lock failures.
- [ ] Test transaction rollback across multi-record changes and audit/outbox insertion.
- [ ] Document SQLite operational limits without promising untested database portability.

## Test requirements
- **Unit:** Test transaction boundary and retry classification logic.
- **Integration:** Run migrations and concurrent write contention suites on real SQLite.

## Browser scenarios
- Given a change set fails midway, when its transaction rolls back, then no partial content, audit, or outbox record is visible.
- Given a locked writer exceeds busy_timeout, when a write is attempted, then the caller gets a retryable response and data remains consistent.

## Dependencies
- ENG-006
- ENG-008

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

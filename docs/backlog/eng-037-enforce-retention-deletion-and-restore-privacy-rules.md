# ENG-037: Enforce retention, deletion, and restore privacy rules

**Phase:** Full blueprint launch

## Source references
- Product requirements: media lifecycle, inquiries, careers, and privacy

## User story
As an owner, I want predictable retention and authorized deletion across personal data and media so the system honors its published privacy rules.

## Acceptance criteria
- [ ] Provide explicit policies per data class: spam cleanup after 30 days, unused media bin for 30 days, and manual deletion of retained inquiries and applications/resumes as the initial defaults.
- [ ] Show retention behavior in the admin; only Owners may change retention settings, and policy changes are audited without storing deleted personal content.
- [ ] Apply authorization to deletion through admin and APIs; MCP cannot permanently delete records or bypass retention controls.
- [ ] Delete private resume objects and related derived data when an authorized application purge completes; retry partial storage failures without reporting deletion complete prematurely.
- [ ] Record minimal deletion tombstones without personal content so restoring an older backup can reapply purges before serving data. Document that expired backups age out on their defined schedule rather than claiming instantaneous deletion from immutable backups.
- [ ] Exclude in-use public media from automatic purge and preserve content references; expose failed purge jobs to operators.

## Test requirements
- **Unit:** Test per-class eligibility boundaries, role enforcement, tombstone minimization, and idempotent purge/retry decisions with a controlled clock.
- **Integration:** Advance time in SQLite fixtures, run cleanup jobs against test object storage, simulate partial failures, and restore an older backup then reapply deletion tombstones.

## Browser scenarios
- Given spam is younger than 30 days, when cleanup runs, then it remains; after 30 days the configured cleanup removes it without deleting an active inquiry.
- Given an Editor or MCP client requests permanent deletion, when the API handles the request, then it rejects the action and retains the record.
- Given an Owner deletes an application, when the purge succeeds, then its resume is unavailable and the audit record contains no resume or message content.
- Given an old backup contains a previously purged application, when operators restore it, then the deletion ledger is applied before access resumes and the application stays unavailable.

## Dependencies
- ENG-014
- ENG-017
- ENG-019
- ENG-021
- ENG-022

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

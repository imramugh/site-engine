# Release policy

Publication uses an approved immutable snapshot and an ordered durable queue.
Draft edits never alter a queued or published snapshot.

## Scheduled publication

A scheduled publication accepts only a future, UTC ISO-8601 timestamp. Scheduling
freezes the approved snapshot, its review proof, and the exact retained set of
approved changes. It does not place the release in the publish queue before it
is due.

At the due time, the dispatcher rechecks the frozen approval before creating
publish work. It verifies the reviewer still has approval authority, the queue
baseline is still valid, the linked change set remains approved at the reviewed
revision, the retained-change hash matches, and both the saved proof and the
current deterministic blocking checks pass for the immutable snapshot.
Unrelated later drafts do not invalidate the frozen release.

If a recheck fails, the schedule is recorded as `stale` with a safe reason code
and is returned for review; no public release is created. A queued worker that
fails terminally records the schedule as `failed`; a verified worker completion
records it as `completed`. Skipped and failed attempts preserve the last public
release; successful completion records the newly activated release.

Schedules created before retained-change hashes existed remain compatible when
their approval includes the full change set. Earlier partial approvals cannot
prove the retained content exactly, so they fail closed and require a new
review and schedule.

Release automation must be reviewed separately from public validation workflows. It must use least-privilege credentials and a documented environment boundary.

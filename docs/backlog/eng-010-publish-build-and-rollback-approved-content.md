# ENG-010: Publish, build, and rollback approved content

**Phase:** Full blueprint launch

## Source references
- Strategy §8 How a change reaches the live site
- Strategy §9 Change log and rollback

## User story
As an approver, I want approved changes released through a verifiable build and reversible without unseen edits.

## Acceptance criteria
- [ ] Publish only approved included changes and invoke a build webhook with immutable change-set context.
- [ ] Track queued, building, deployed, and failed release states with build-log link.
- [ ] On failure retain published content and notify Owners.
- [ ] Prepare single-change or whole-set rollback as a new reviewable change set.
- [ ] Persist actor, reviewer, publish time, and release result in a unified log.

## Test requirements
- **Unit:** Test webhook payload signing, state transitions, and rollback diff construction.
- **Integration:** Use a fake CI receiver for success, timeout, and failed build responses.

## Browser scenarios
- Given a successful approval, when CI confirms deployment, then the public build uses the approved revision and audit log links the release.
- Given a failed build, when release processing ends, then the prior public revision remains served and Owners are notified.

## Dependencies
- ENG-008
- ENG-009

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

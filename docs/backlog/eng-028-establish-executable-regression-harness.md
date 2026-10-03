# ENG-028: Establish executable regression harness

**Phase:** Foundation

## Source references
- ops quality-and-delivery Test layers

## User story
As a maintainer, I want deterministic future-facing regression tooling so application changes have repeatable evidence.

## Acceptance criteria
- [ ] Configure Vitest for contract/unit tests, Playwright for browser flows, and axe WCAG checks across site and CMS apps.
- [ ] Use synthetic neutral fixtures only in the public engine.
- [ ] Capture traces, screenshots, and scrubbed logs on failures.
- [ ] Provide test database lifecycle helpers for isolated SQLite runs.
- [ ] Schedule the full browser/theme matrix after applications exist.

## Test requirements
- **Unit:** Self-test fixture isolation and result-artifact naming.
- **Integration:** Run a smoke suite against a seeded SQLite CMS and static site.

## Browser scenarios
- Given a failing browser assertion, when the harness runs, then trace and screenshot artifacts are retained without private fixture data.
- Given a public CI job, when tests run, then no private repository checkout or secret is required.

## Dependencies
- ENG-001

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

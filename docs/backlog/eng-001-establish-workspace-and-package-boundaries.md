# ENG-001: Establish workspace and package boundaries

**Phase:** Foundation

## Source references
- Strategy §8 Repository layout
- Strategy §6 Three layers

## User story
As a maintainer, I want independently versioned engine, checks, and theme packages so visual work can evolve without changing content behaviour.

## Acceptance criteria
- [ ] Create pnpm workspace package boundaries for site, CMS, engine, checks, starter theme, and installable themes.
- [ ] Export a versioned public contract package with no imports from a client theme.
- [ ] Enforce package dependency direction in CI.
- [ ] Provide local development commands for static site, CMS, and preview.

## Test requirements
- **Unit:** Verify package exports and contract-version parsing.
- **Integration:** Install all workspace packages from a clean lockfile and run dependency-boundary checks.

## Browser scenarios
- Given a theme imports only the contract, when engine internals change, then its contract build remains valid.
- Given a prohibited theme-to-CMS import, when CI runs, then it fails with the offending edge.

## Dependencies
- None

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

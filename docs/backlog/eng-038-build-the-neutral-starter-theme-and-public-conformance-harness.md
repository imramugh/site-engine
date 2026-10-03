# ENG-038: Build the neutral starter theme and public conformance harness

**Phase:** Foundation

## Source references
- Product requirements: theme contract and authoring

## User story
As a theme author, I want a plain conforming starter so any visual direction has a safe, documented base.

## Acceptance criteria
- [ ] Implement every standard template, block, background tone, logo rule, and motion intent from the contract.
- [ ] Ship self-hosted font setup, token architecture, component states, and accessible defaults.
- [ ] Provide fixtures for long, short, empty, image, and error content.
- [ ] Run visual, accessibility, and reduced-motion tests as installability gates.
- [ ] Document extension naming for theme-specific blocks and settings.
- [ ] Build, pack, install, and test the starter without private repositories, assets, or credentials.

## Test requirements
- **Unit:** Test manifest and token validation.
- **Integration:** Run contract, visual, and accessibility suites against starter fixtures.

## Browser scenarios
- Given a fresh conforming theme copied from starter, when installed, then the compatibility report passes standard content.
- Given a required contract element is absent, when install validation runs, then it rejects the theme.

## Dependencies
- ENG-002
- ENG-005
- ENG-015

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

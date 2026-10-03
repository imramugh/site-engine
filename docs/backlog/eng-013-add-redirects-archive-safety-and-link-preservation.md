# ENG-013: Add redirects, archive safety, and link preservation

**Phase:** Foundation

## Source references
- Strategy §3 Guardrails
- Strategy §9 Site settings redirects

## User story
As a site owner, I want safe moves and archives so old links keep resolving.

## Acceptance criteria
- [ ] Create a permanent redirect when a published slug changes, page moves, or a page is archived.
- [ ] Require a redirect target and default it to the parent when applicable.
- [ ] Block archive while page, section, or navigation references remain; return reference locations.
- [ ] Maintain redirect uniqueness, loop detection, and hit counts.
- [ ] Archive rather than permanently delete public content through editorial tooling.

## Test requirements
- **Unit:** Test redirect normalization, loop detection, reference search, and archive transitions.
- **Integration:** Move and archive fixture pages then build public redirect rules.

## Browser scenarios
- Given a page is still linked in footer navigation, when archive is requested, then the API lists the footer reference and makes no archive.
- Given an approved slug change, when a visitor follows the old URL, then they receive one permanent redirect to the new URL.

## Dependencies
- ENG-003
- ENG-008

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

# ENG-002: Define the versioned content and theme contract

**Phase:** Foundation

## Source references
- Strategy §3 Content model
- Strategy §6 Theme contract

## User story
As a platform developer, I want one typed contract for templates, blocks, appearances, and site data so the CMS, renderer, themes, and tests cannot drift.

## Acceptance criteria
- [ ] Model singleton site settings, sections, pages, media references, redirects, style guide, and change sets.
- [ ] Define standard block schemas, field limits, allowed templates, and visibility behaviour.
- [ ] Define six named backgrounds, width and spacing choices, motion intent plus optional preset, and logo tone.
- [ ] Expose machine-readable contract version and compatibility rules.
- [ ] Reject unknown block fields and raw CSS or colour input.

## Test requirements
- **Unit:** Validate valid and invalid fixtures for every schema.
- **Integration:** Generate CMS field configuration and theme TypeScript types from the same definitions.

## Browser scenarios
- Given a block with an undeclared appearance value, when saved, then the API returns a field-level validation error.
- Given a supported contract version, when a theme is installed, then the engine records compatibility.

## Dependencies
- ENG-001

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

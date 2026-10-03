# ENG-005: Render standard blocks and template layouts

**Phase:** Full blueprint launch

## Source references
- Strategy §3 Block library
- Strategy §3 Page outlines

## User story
As an editor, I want reusable blocks rendered by the engine so page composition remains content work.

## Acceptance criteria
- [ ] Implement renderer support for Hero, Feature grid, Split list, Chip list, Testimonials, FAQ, Callout, Related services, CTA, rich text, contact, and media blocks.
- [ ] Do not render a block with an empty list or a hidden state.
- [ ] Validate required fields before render and show build diagnostics with page and block IDs.
- [ ] Render FAQ with native details/summary and accessible headings.
- [ ] Keep related page references and site-detail references live rather than copied.

## Test requirements
- **Unit:** Snapshot semantic HTML for every standard block and empty-list behaviour.
- **Integration:** Build all template fixtures with long, short, optional, and missing content.

## Browser scenarios
- Given a hidden testimonial block, when a visitor loads the page, then it is absent from HTML and navigation landmarks.
- Given a related-page rename, when rebuilt, then every related card shows the new title.

## Dependencies
- ENG-002
- ENG-004

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

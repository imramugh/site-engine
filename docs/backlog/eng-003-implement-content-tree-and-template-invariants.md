# ENG-003: Implement content tree and template invariants

**Phase:** Foundation

## Source references
- Strategy §3 Content hierarchy
- Strategy §3 Templates

## User story
As an editor, I want pages constrained by section and template rules so navigation, generated parts, and structured data remain coherent.

## Acceptance criteria
- [ ] Support root, services-like, insights-like, careers-like, and future-section presets with allowed templates.
- [ ] Enforce parent depth of at most three and template-specific parent relationships.
- [ ] Generate template fixed parts such as breadcrumb, child list, or application form instead of storing duplicates.
- [ ] Require a page summary and constrain published status to reviewed content.
- [ ] Refuse a template change until incompatible blocks are removed or converted.

## Test requirements
- **Unit:** Test each template's allowed blocks, required fields, and schema mapping.
- **Integration:** Exercise section creation, page movement, duplication, and template conversion through the CMS API.

## Browser scenarios
- Given an article template selected under a services-like section, when submitted, then creation is rejected with allowed-template guidance.
- Given a page with incompatible blocks, when its template is changed, then the response lists each blocking block.

## Dependencies
- ENG-002

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

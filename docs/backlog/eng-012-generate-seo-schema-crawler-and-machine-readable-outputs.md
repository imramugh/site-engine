# ENG-012: Generate SEO, schema, crawler, and machine-readable outputs

**Phase:** Full blueprint launch

## Source references
- Strategy §7 Crawler access
- Strategy §7 Structured data
- Strategy §7 Machine-readable versions

## User story
As a site operator, I want public structured outputs derived from content so search and AI systems can understand current pages.

## Acceptance criteria
- [ ] Generate sitemap with actual last-modified values, robots policies, canonical metadata, and IndexNow publish hook.
- [ ] Generate Organization/ProfessionalService, WebPage, Article, FAQPage, BreadcrumbList, JobPosting, and collection schemas from compatible templates.
- [ ] Generate root llms.txt from site description, settings, and selected page summaries.
- [ ] Provide a machine-readable page representation without exposing drafts or private fields.
- [ ] Keep crawler policy names in one versioned configuration reviewed quarterly.

## Test requirements
- **Unit:** Validate JSON-LD outputs against schema fixtures and sitemap dates.
- **Integration:** Build a fixture tree and verify all public URLs, schemas, llms.txt, and robots output.

## Browser scenarios
- Given a page is published, when the build completes, then its sitemap entry and canonical schema include the new revision date.
- Given a preview URL, when a crawler requests it, then robots/noindex policies prevent indexing.

## Dependencies
- ENG-004
- ENG-005
- ENG-011

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

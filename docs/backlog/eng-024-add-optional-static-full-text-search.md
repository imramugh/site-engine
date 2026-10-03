# ENG-024: Add optional static full-text search

**Phase:** Later

## Source references
- Strategy §8 Search later

## User story
As a visitor, I want fast search over published content so I can find relevant information without a server query.

## Acceptance criteria
- [ ] Build a static search index from published, indexable pages only.
- [ ] Index title, summary, headings, and approved body text with result URLs.
- [ ] Exclude drafts, preview content, applications, inquiries, and noindex pages.
- [ ] Provide keyboard-accessible result navigation and empty/error states.
- [ ] Rebuild index with the public release.

## Test requirements
- **Unit:** Test index document selection, text extraction, and excluded status handling.
- **Integration:** Build a fixture release and query expected and excluded pages.

## Browser scenarios
- Given a visitor searches published text, when selecting a result, then they reach its canonical page.
- Given a draft-only phrase, when searched on public site, then no result is returned.

## Dependencies
- ENG-010
- ENG-012

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

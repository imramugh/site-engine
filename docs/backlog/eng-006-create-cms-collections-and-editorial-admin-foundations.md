# ENG-006: Create CMS collections and editorial admin foundations

**Phase:** Foundation

## Source references
- Strategy §8 Payload
- Strategy §9 Admin structure

## User story
As an editor, I want a conventional admin for all content records so I can work without an assistant.

## Acceptance criteria
- [ ] Configure CMS collections from the contract for pages, sections, assets, redirects, inquiries, applications, users, and change sets.
- [ ] Provide tree-oriented page management and field validation with useful error messages.
- [ ] Expose live draft preview beside editing fields at desktop and mobile widths.
- [ ] Ensure every content save belongs to a named or implicit change set.
- [ ] Do not expose credential values in admin record views.

## Test requirements
- **Unit:** Test collection access controls and contract-to-field generation.
- **Integration:** Create and edit a fixture page through admin/local API and read the preview draft.

## Browser scenarios
- Given an Editor changes a page, when save is pressed, then a pending change set receives the diff and public output is unchanged.
- Given a non-owner opens integrations, when access is evaluated, then the view is denied.

## Dependencies
- ENG-002
- ENG-003

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

# ENG-026: Add direct on-page typing for editors

**Phase:** Later

## Source references
- Strategy §9 Visual content editing

## User story
As an editor, I want to edit selected page text directly in preview so simple revisions require fewer context switches.

## Acceptance criteria
- [ ] Gate the feature behind Editor or higher permissions and draft/change-set rules.
- [ ] Map selectable rendered text to supported contract fields only.
- [ ] Show validation and check results before save.
- [ ] Preserve split-view editor as a complete fallback.
- [ ] Do not permit direct edits to generated, credential, or protected data.

## Test requirements
- **Unit:** Test field mapping, selection filtering, and validation errors.
- **Integration:** Edit a fixture block in preview and verify a normal change-set diff.

## Browser scenarios
- Given an Editor selects an editable hero field, when they save a valid change, then it appears only in the proposed preview.
- Given a user selects generated navigation text, when trying to edit, then no edit control is offered.

## Dependencies
- ENG-006
- ENG-008
- ENG-009

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

# ENG-018: Create block gallery and recipe workflow

**Phase:** Full blueprint launch

## Source references
- Strategy §3 Block gallery
- Strategy §3 Working with the assistant

## User story
As an editor, I want a visual catalogue and reusable recipe so I can compose permitted pages confidently.

## Acceptance criteria
- [ ] Render every contract block, template, preset, and installed theme block with fixture content in the active theme.
- [ ] Show variants, field limits, allowed templates, usage locations, and appearance controls.
- [ ] Use the same fixtures as visual and accessibility tests.
- [ ] Provide recipe builder export and MCP get_block_library/create_page_from_recipe support.
- [ ] Filter picker choices by the selected template.

## Test requirements
- **Unit:** Test catalog completeness against contract definitions and recipe schema validation.
- **Integration:** Create a page from a recipe and verify ordered blocks and appearances.

## Browser scenarios
- Given a template that disallows a block, when an editor builds a recipe, then that block cannot be selected.
- Given an assistant submits a valid recipe, when review preview opens, then every chosen block appears in the requested order.

## Dependencies
- ENG-002
- ENG-005
- ENG-016

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

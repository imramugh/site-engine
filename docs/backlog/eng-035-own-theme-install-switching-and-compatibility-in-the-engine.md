# ENG-035: Own theme install, switching, and compatibility in the engine

**Phase:** Full blueprint launch

## Source references
- Strategy §6 Switching to a new theme
- ops architecture Repository boundaries

## User story
As an owner, I want neutral engine-controlled theme compatibility and switching so private theme packages remain optional consumers of the public contract.

## Acceptance criteria
- [ ] Validate theme manifest, contract range, standard block support, settings, motion mappings, and declared theme-specific blocks.
- [ ] Generate compatibility report with conversion, replacement, hide, or intent-fallback actions.
- [ ] Preview candidate theme against immutable content without importing private source into engine CI.
- [ ] Switch only through a reviewed snapshot release and preserve namespaced theme settings.
- [ ] Never auto-switch to a fallback theme after a failed deployment; preserve last verified release.

## Test requirements
- **Unit:** Test manifest range, report generation, settings namespacing, and fallback decisions.
- **Integration:** Install synthetic external theme packages through packed public interfaces.

## Browser scenarios
- Given a theme declares an incompatible contract, when installation is proposed, then it is rejected without loading client code.
- Given a compatible theme switch is approved, when released, then routes/content stay identical and only declared visual output changes.

## Dependencies
- ENG-002
- ENG-029
- ENG-034

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

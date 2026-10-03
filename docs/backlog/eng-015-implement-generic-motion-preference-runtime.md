# ENG-015: Implement generic motion preference runtime

**Phase:** Full blueprint launch

## Source references
- Strategy §6 Animation is part of the theme
- Strategy §3 Build rules

## User story
As a visitor, I want motion that respects my preferences so the site remains comfortable and accessible.

## Acceptance criteria
- [ ] Apply motion by content intent with optional theme preset fallback.
- [ ] Respect prefers-reduced-motion and a persisted footer Reduce motion choice.
- [ ] Pause off-screen effects and provide a still poster/frame for long animation or video.
- [ ] Load only minimal vanilla client code for enabled interaction.
- [ ] Keep motion disabled in form and urgent-contact contexts where specified by theme.

## Test requirements
- **Unit:** Test preference precedence, persisted setting, intent fallback, and visibility pausing.
- **Integration:** Run browser tests with reduced-motion emulation and measure delivered runtime modules.

## Browser scenarios
- Given a visitor enables Reduce motion, when navigating between pages, then eligible animations remain still.
- Given a selected preset is unavailable after a theme switch, when rendered, then its declared intent fallback is used.

## Dependencies
- ENG-002
- ENG-005

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

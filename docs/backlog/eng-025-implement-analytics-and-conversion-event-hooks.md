# ENG-025: Implement analytics and conversion event hooks

**Phase:** Full blueprint launch

## Source references
- Strategy §1 Goals and measures
- Strategy §7 Measurement

## User story
As a site owner, I want privacy-conscious measurements of inquiries and key actions so launch goals can be tracked.

## Acceptance criteria
- [ ] Emit configurable events for form submission, phone tap, primary CTA, and approved public navigation interactions.
- [ ] Separate direct, search, referral, and AI-assistant attribution where supplied without inventing attribution.
- [ ] Keep third-party scripts disabled by default and honor configured consent requirements.
- [ ] Document baseline and post-launch reporting fields for conversion, freshness, and performance.
- [ ] Do not expose lead message content in analytics events.

## Test requirements
- **Unit:** Test event payload allowlist and attribution parser.
- **Integration:** Run browser instrumentation against a mock analytics endpoint with consent states.

## Browser scenarios
- Given consent is absent where required, when a visitor taps a CTA, then no analytics request is made.
- Given a form succeeds, when its event is emitted, then it contains only allowlisted metadata.

## Dependencies
- ENG-019
- ENG-023

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

# ENG-023: Secure integration and AI-provider configuration

**Phase:** Full blueprint launch

## Source references
- Strategy §9 Configuration and credentials
- Strategy §9 AI providers

## User story
As an owner, I want integrations configurable without exposing keys so operational services can be changed safely.

## Acceptance criteria
- [ ] Store keys encrypted using an external master key and present write-only fields with replacement affordances.
- [ ] Support connection tests, health states, and Owner-only integration configuration.
- [ ] Support OpenAI, Anthropic, Google Gemini, and OpenRouter at launch, each selected per job with model, fallback, monthly cap, and usage visibility.
- [ ] Never return secrets through API, MCP, logs, exports, diffs, or audit views.
- [ ] Log credential changes by actor and time without values.

## Test requirements
- **Unit:** Test redaction across serializers and encryption/decryption service boundaries.
- **Integration:** Save test credentials, test connection, invoke provider fallback mock, and read audit history.

## Browser scenarios
- Given an Owner saves a credential, when they reload the settings, then only a masked indicator is visible.
- Given a non-Owner calls integration endpoints, when authorized, then credentials and configuration are denied.

## Dependencies
- ENG-007
- ENG-022

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

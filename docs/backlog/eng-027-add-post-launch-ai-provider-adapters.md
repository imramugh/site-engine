# ENG-027: Add post-launch AI provider adapters

**Phase:** Later

## Source references
- Strategy §9 AI providers

## User story
As an owner with cloud or sovereign-provider needs, I want additional adapter choices so configured AI jobs can use approved providers.

## Acceptance criteria
- [ ] Add Azure OpenAI, Amazon Bedrock, Mistral, and OpenAI-compatible endpoint adapters behind the launch provider interface.
- [ ] Reuse encryption, write-only secret handling, caps, usage, fallback, health checks, and audit rules.
- [ ] Require provider-specific capability declaration, including image support where needed.
- [ ] Keep MCP client assistants separate from configured in-product AI jobs.
- [ ] Document data-processing and regional configuration requirements per adapter.

## Test requirements
- **Unit:** Test adapter capability metadata and common provider-interface conformance.
- **Integration:** Run mocked completion, image-capable, fallback, cap-exhaustion, and error flows for each adapter.

## Browser scenarios
- Given the selected provider is unavailable, when a configured job runs, then the approved fallback is used and logged.
- Given a job requires image input and the provider lacks it, when configured, then validation rejects the assignment.

## Dependencies
- ENG-023

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

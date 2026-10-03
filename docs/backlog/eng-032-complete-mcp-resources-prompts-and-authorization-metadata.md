# ENG-032: Complete MCP resources, prompts, and authorization metadata

**Phase:** Full blueprint launch

## Source references
- Strategy §3 MCP server reference
- Strategy §3 Resources and prompts

## User story
As an assistant user, I want discoverable safe resources and prompts so I can perform supported work without guessing capabilities.

## Acceptance criteria
- [ ] Expose style guide, glossary, block library, site summary, page tree, and documented ready-made prompts as read-only MCP resources.
- [ ] Cover documented discover, structure, content, media, quality, review, site/theme, redirects, leads, and careers tools with schemas.
- [ ] State no-publish/no-approve/no-user-management limits in tool metadata.
- [ ] Mark visitor-originated inquiry text as untrusted content in tool responses.
- [ ] Require effective user authorization even for Local API calls.

## Test requirements
- **Unit:** Test tool/resource registration and authorization metadata completeness.
- **Integration:** Enumerate resources and tools using a standards-compliant MCP client.

## Browser scenarios
- Given an assistant requests a documented prompt/resource, when authorized, then it receives only scoped read data.
- Given a Local API caller attempts override access without an effective user, when it invokes an MCP write, then it is denied.

## Dependencies
- ENG-016
- ENG-017

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

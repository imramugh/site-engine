# ENG-016: Expose authenticated MCP discovery and content editing

**Phase:** Full blueprint launch

## Source references
- Strategy §3 MCP server reference
- Strategy §3 Access and connection

## User story
As a connected assistant user, I want safe standard tools for content work so I can prepare changes without direct database access.

## Acceptance criteria
- [ ] Serve Streamable HTTP MCP with OAuth identity linked to an invited user.
- [ ] Implement documented discovery, tree/page read, template/block library, search, structure, block/item, media, quality, review, site, theme, and redirect tools.
- [ ] Ensure every write joins a change set, validates contract rules, and returns checks.
- [ ] Expose no approve or publish tool and describe that limit in tool metadata.
- [ ] Audit every tool invocation with user, client, scope, diff/batch, and result.

## Test requirements
- **Unit:** Test JSON schemas, tool authorization declarations, and write response check envelopes.
- **Integration:** Use an MCP test client for OAuth, discovery, a block write, submission, and audit retrieval.

## Browser scenarios
- Given an authenticated Editor assistant, when it calls update_block, then it receives a draft result and checks but cannot publish.
- Given an unknown tool parameter, when sent to MCP, then it is rejected without partial mutation.

## Dependencies
- ENG-007
- ENG-008
- ENG-011
- ENG-014

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

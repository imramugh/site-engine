# ENG-011: Build quality, style, and readiness checks

**Phase:** Foundation

## Source references
- Strategy §7 Built-in checks
- Strategy §7 How MCP server keeps standards

## User story
As an editor, I want immediate actionable checks so content remains usable, quoteable, and structurally valid.

## Acceptance criteria
- [ ] Check summary, title and description length, one H1, heading order, alt text, self-contained FAQ answers, review freshness, internal links, and orphan pages.
- [ ] Check style guide terms, Canadian spelling configuration, banned phrases, sentence length, and reading level as warnings.
- [ ] Treat broken structured-data generation as a publish blocker; preserve warning severity separately.
- [ ] Return checks on every write, audit, and review submission.
- [ ] Expose stale-page listing by review age.

## Test requirements
- **Unit:** Use fixture content for each check, severity, and remediation message.
- **Integration:** Run checks during CMS save and static build, asserting identical result codes.

## Browser scenarios
- Given invalid structured data, when a reviewer submits for approval, then publication is blocked with the exact block and field.
- Given a style warning only, when a reviewer approves, then the release may continue while the warning remains visible.

## Dependencies
- ENG-002
- ENG-006

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

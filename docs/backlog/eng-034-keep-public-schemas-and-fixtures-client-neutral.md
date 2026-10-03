# ENG-034: Keep public schemas and fixtures client-neutral

**Phase:** Foundation

## Source references
- ops architecture Repository boundaries
- ops decisions Setup defaults

## User story
As an open-source maintainer, I want public contract examples isolated from client data so the engine can be published safely.

## Acceptance criteria
- [ ] Provide neutral schema fixtures, demo content, and synthetic media metadata for public tests and docs.
- [ ] Forbid client names, assets, copy, routes, production identifiers, and private fixture imports from public packages.
- [ ] Define clean package boundary inputs for private themes and ops composition.
- [ ] Scan public tarballs, Git history, generated artifacts, and docs for prohibited provenance markers.
- [ ] Document Apache-2.0 engine licensing and separate asset/theme rights.

## Test requirements
- **Unit:** Test provenance allowlist/denylist rules.
- **Integration:** Pack the public workspace and scan the tarball and demo build.

## Browser scenarios
- Given private fixture data is imported by a public package, when CI runs, then provenance checks fail before publish.
- Given a public demo build, when inspected, then it runs entirely from synthetic neutral data.

## Dependencies
- ENG-001

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

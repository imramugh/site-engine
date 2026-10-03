# ENG-004: Build generic tree routing and global derivations

**Phase:** Foundation

## Source references
- Strategy §3 Sitemap
- Strategy §3 How Astro renders it

## User story
As a visitor, I want content-tree URLs and shared navigation rendered consistently so newly approved pages need no route code.

## Acceptance criteria
- [ ] Implement a catch-all static route that resolves published paths from the tree.
- [ ] Derive breadcrumbs, header and footer service lists from page relationships.
- [ ] Enforce header section limit with a non-blocking footer-only warning.
- [ ] Generate canonical URLs and omit draft or archived pages from public routing.
- [ ] Return an accessible not-found response for unknown and archived targets without redirects.

## Test requirements
- **Unit:** Test path resolution, breadcrumb ancestry, navigation ordering, and canonical generation.
- **Integration:** Build fixture sites containing nested pages, hidden navigation, and an archive.

## Browser scenarios
- Given an approved child page, when the static build runs, then its path, breadcrumb, and menu entry render from data.
- Given an archived page with a redirect, when its old URL is requested, then it returns a permanent redirect to the configured target.

## Dependencies
- ENG-003

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

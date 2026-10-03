# ENG-014: Implement media library, variants, and safe lifecycle

**Phase:** Full blueprint launch

## Source references
- Strategy §3 Images, media and block appearance
- Strategy §9 Media library

## User story
As an editor, I want managed media with durable references so pages remain performant and accessible.

## Acceptance criteria
- [ ] Upload media with alt text or decorative flag, tags, caption, credit, focal point, and usage references.
- [ ] Generate responsive AVIF/WebP variants with fixed dimensions and Astro image markup.
- [ ] Provide crop previews for hero, card, and thumbnail slots.
- [ ] Replace a file while retaining the asset ID and update every use.
- [ ] Prevent deleting in-use assets; send unused assets to a 30-day bin.

## Test requirements
- **Unit:** Test metadata validation, decorative exception, focal-point math, and deletion eligibility.
- **Integration:** Upload test media, create variants, render it in multiple blocks, and replace it.

## Browser scenarios
- Given an image without alt text and not decorative, when attached to a block, then saving is rejected.
- Given an in-use asset, when deletion is requested, then the admin reports all usage locations.

## Dependencies
- ENG-006
- ENG-011

## Definition of done
- [ ] Acceptance criteria are met and reviewed.
- [ ] Relevant unit and integration evidence is attached.
- [ ] Relevant Playwright and axe browser evidence is attached with this story ID.
- [ ] Deployable changes have a verified deployed URL recorded in the pull request.

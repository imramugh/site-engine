# Block gallery and recipes

Owners and Editors open `/block-gallery` to inspect the active published theme.
The card grid contains all eighteen contract blocks. Template buttons keep
disallowed blocks visible for reference and disable their recipe action. Each
card exposes schema-derived field limits, permitted templates, and links to
draft pages using that block.

Choose **Preview** to open the rendered library. Its block, template and section
preset samples run through the normal snapshot renderer, with synthetic fixture
content. The preview supports desktop/mobile widths and available appearance
variations. Templates distinguish generated structure from editable blocks.
Theme-specific blocks are listed separately; packages declaring none show an
explicit empty state.

Add compatible blocks to the ordered recipe, choose appearances, and supply
required selections. Media and related-page blocks use existing accessible
records. Testimonials require a quotation, attribution and explicit permission
confirmation. The gallery never invents media IDs or consent.

**Insert into draft** appends the recipe to the selected page in an open change
set owned by the current editor. Contract validation, record permissions,
revision checks and idempotent retries apply before capture. The draft still
requires the normal review and publication workflow.

**Copy MCP recipe** exports ordered `blocks` and `template` arguments for
`create_page_from_recipe`. The assistant must add a title, summary, slug,
section ID, request key, change-set ID and its current revision. Optional page
metadata supports template requirements such as a service parent or job details.
`get_block_library` supplies field metadata, template policy, section presets,
appearance tokens and explicit required selections. Supplying unsupported
fields or identity overrides fails validation.

## Renderer artifacts

The normal workspace build generates a neutral starter library using
`scripts/build-neutral-gallery.mjs`. It shares the synthetic fixture generator
with `@site-engine/theme-conformance`; generated output is ignored by Git.
Archive-based builds must supply `SITE_ENGINE_SOURCE_COMMIT` with the exact
source revision. Build packages before running the gallery script directly.

An optional branding bundle can install libraries for other exact theme
identities through `blockGalleryLibraries["name@version"]`. Each descriptor
contains a local `/admin-branding/…html` URL, fixture hash, canonical manifest digest, package identity,
renderer commit, contract version and capabilities. Remote URLs and malformed
provenance are rejected. The descriptor must match the published installed manifest digest and contract, including when a package reuses a version. A missing matching library is reported as unavailable;
the interface never substitutes a different theme version.

Browser acceptance covers permitted choices, export, required records/consent,
draft insertion, and actual rendered block order in review. Gallery artifacts
are synthetic reference content, not a route to published client content.

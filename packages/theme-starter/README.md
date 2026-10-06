# Neutral starter theme

`@site-engine/theme-starter` is a public neutral reference package for the
engine contract. It includes standard templates, blocks, appearance choices,
motion hooks, and accessible layout components without private repositories,
client copy, assets, credentials, or routes.

The current manifest is **1.7.0**. Its renderer accepts every frozen public
snapshot contract from 1.0.0 through 1.7.0. A 1.0.0 snapshot has no Hero
secondary CTA or supporting panel; 1.1.0 introduced those fields, and later
contracts add structured site, contact, inquiry, navigation, and crawler data
that the host and starter render together. The 1.1.0 manifest remains a
historic release; publish a new immutable version for later contract fields.

## Assets and extension rules

The starter uses neutral tokens and self-hosts unmodified DejaVu Sans with
`font-display: swap`. It was copied from Debian `fonts-dejavu-core` 2.37-8.
Its checksum and primary DejaVu project links are in
[fonts/PROVENANCE.md](fonts/PROVENANCE.md); the complete upstream notice,
including Arev/Tavmjong terms, is in [LICENSES/DejaVu.txt](LICENSES/DejaVu.txt).

`theme.json` declares a version-1 `contractSurface` with every standard block,
template, background, logo tone, components, and local font/license assets.
Theme-specific additions need a namespace such as `exampleAgency/notice`, a
compatible contract range, and must not redefine standard block meaning.

## Build and validate

```sh
corepack pnpm@12.8.1 build:packages
corepack pnpm@12.8.1 --filter @site-engine/theme-starter pack
node packages/engine/dist/theme-package-cli.js /path/to/extracted-theme
```

The validator does not import modules or execute install scripts. It rejects
missing or inconsistent surface declarations, traversal, every symlinked path
component, oversized artifacts, and missing entry/component/type files. A
successful JSON receipt contains the registry-compatible canonical manifest
digest and SHA-256 file receipts. It proves reviewed extracted files, not
visual quality; keep the static build and browser checks in the release gate.

The packed-runtime gate installs local contract, engine, and starter tarballs
offline with lifecycle scripts disabled, validates the installed starter, then
removes `BlockRenderer.astro` and proves rejection. It builds with the
installed `Layout.astro` and `BlockRenderer.astro`, tests the neutral long,
short, optional-empty, image, and inquiry-error fixture at desktop and mobile
widths, and retains screenshots and axe results under
`artifacts/theme-starter-conformance`:

```sh
corepack pnpm@12.8.1 conformance:starter
corepack pnpm@12.8.1 exec vitest run packages/theme-starter/tests
corepack pnpm@12.8.1 --filter @site-engine/site build
corepack pnpm@12.8.1 exec playwright test apps/site/e2e/site.spec.ts --grep ENG-038
```

The gate checks each deterministic screenshot against
`scripts/fixtures/theme-starter-conformance-baselines.json`. After reviewing
an intentional visual change, regenerate the checksums and commit the updated
baseline with:

```sh
UPDATE_THEME_CONFORMANCE_BASELINES=1 corepack pnpm@12.8.1 conformance:starter
```

The browser fixture covers every standard block and template at desktop and
mobile sizes, retains screenshots as test artifacts, runs axe, and checks
reduced-motion behavior.

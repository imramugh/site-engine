# Site Engine

An Apache-2.0 publishing engine under active development: an Astro static site, Payload CMS on Next.js, and SQLite WAL storage. The public demonstration uses synthetic content and requires no private repository or credentials.

## Workspace

- `apps/site`: static neutral demonstration and browser regression tests.
- `apps/cms`: protected content collections, SQLite migrations, and a health endpoint.
- `packages/contract`: versioned schemas and content tree validation.
- `packages/engine`: shared rendering and theme validation utilities.
- `packages/checks`: regression helpers and dependency/provenance checks.
- `packages/theme-starter`: neutral starter foundation.

## Development

Use Node **24.21.0** and pnpm **12.10.1**. Enable Corepack in your isolated Node installation, then run:

```sh
corepack pnpm@12.10.1 install --frozen-lockfile
corepack pnpm@12.10.1 check
corepack pnpm@12.10.1 build
corepack pnpm@12.10.1 exec playwright install --with-deps chromium firefox webkit
corepack pnpm@12.10.1 test:e2e
corepack pnpm@12.10.1 dev:site
```

`check` rebuilds shared packages before running type checks, unit tests, real SQLite permission tests, and boundary checks. Browser tests run Playwright and axe across three browser engines. `make check` validates repository metadata only. See [CMS setup](apps/cms/README.md) for migrations and runtime configuration.

Payload requires GraphQL 16; **16.14.2** is pinned as the latest compatible stable release instead of incompatible GraphQL 17. Other direct dependencies are pinned to verified stable releases with a committed lockfile.

## Current limits

This is a foundation increment, not a complete publishing product. Invite-only identity, server-side sessions, role checks, local Owner authenticator/recovery sign-in, content-tree validation, and a session authorization endpoint for private static previews are implemented. Microsoft and Google sign-in require operator configuration. Deployment routing is owned by the operator; the public static demonstration does not expose the CMS itself.

Editorial comparison and review/publication workflows, the MCP service, private media handling, and business integrations remain under development. CMS collection authorization and draft guards are enforced independently; draft edits cannot publish the public site.

User stories remain open until their complete acceptance criteria and deployment evidence pass. See [the backlog](docs/backlog/README.md), [CONTRIBUTING.md](CONTRIBUTING.md), [release policy](docs/release-policy.md), and [dependency policy](docs/dependency-policy.md). Engine licensing does not grant rights to third-party theme assets; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

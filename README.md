# Site Engine

This repository will host a reusable publishing engine for static sites with an authenticated preview workflow. It is intentionally a scaffold: no application code, dependency manifests, deployment configuration, or executable product scripts exist yet. It is licensed under Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Planned layout

- `apps/site` — Astro static site and authenticated preview (implementation pending)
- `apps/cms` — Payload CMS on Next.js (implementation pending)
- `packages/contract` — shared content and API contract (implementation pending)
- `packages/engine` — reusable engine code (implementation pending)
- `packages/checks` — quality and accessibility checks (implementation pending)
- `packages/theme-starter` — starter theme contract (implementation pending)
- `mcp` — MCP integration (implementation pending)

## Local validation

Run `make check` to validate scaffold metadata. It uses only the Python standard library and does not install dependencies or run application tests.

## Quality plan

Once implementation begins, changes should include unit tests, integration tests against a real SQLite database in WAL mode and permission model, and browser regression tests using Playwright and axe. Browser scenarios should reference the applicable story IDs. Public CI must run without private credentials and must never use a production self-hosted runner.

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/release-policy.md](docs/release-policy.md), and [docs/dependency-policy.md](docs/dependency-policy.md).

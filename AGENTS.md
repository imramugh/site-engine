# Working agreements

- Run `make check` for scaffold changes. Once application code exists, issues and pull requests must state the acceptance criteria and provide relevant unit, real database/permission integration, and Playwright plus axe evidence with story IDs.
- Deploy verified application changes to the configured environment before considering them complete, following the repository deployment and post-deployment verification workflow. Do not treat scaffold validation as a deployment.
- Public CI must use no private credentials and must never run on a production self-hosted runner.
- Use Astra at high reasoning for orchestration and architecture, Terra at medium reasoning for implementation and setup, and Luna at low reasoning for bounded routine work.

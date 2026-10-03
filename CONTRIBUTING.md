# Contributing

This repository is scaffold-only until the planned packages are implemented. Keep proposed changes small and traceable to an issue or approved work item.

Before opening a pull request, run `make check`. When application code exists, include relevant unit, integration, and browser evidence. Integration coverage must exercise real database and permission behavior; browser coverage should use Playwright with axe and cite story IDs.

Do not add secrets to source control, logs, fixtures, or CI. Public workflows must use zero private credentials and no production self-hosted runner.


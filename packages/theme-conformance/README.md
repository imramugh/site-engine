# Theme conformance

`@site-engine/theme-conformance` renders an installed theme against a neutral contract fixture, checks all supported blocks and templates at desktop and mobile widths, captures screenshots, and runs axe.

Run `site-engine-theme-conformance @scope/theme` after installing the theme and this package. Use `--artifacts-dir path` to choose the evidence directory and `--update-baselines` only when accepting intentional visual changes.

The harness contains no client assets, credentials, or checkout paths.

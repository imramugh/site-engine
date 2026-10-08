# Theme conformance

`@site-engine/theme-conformance` renders an installed theme against a neutral contract fixture, checks all supported blocks and templates at desktop and mobile widths, captures screenshots, and runs axe.

Run `site-engine-theme-conformance @scope/theme --artifacts-dir artifacts/theme --baseline-file baselines/theme.json` after installing the theme and this package. Evidence includes screenshots, axe results, and `conformance-report.json` with the theme and engine versions.

For a new or intentional visual baseline, use a caller-owned file: `--baseline-file baselines/theme.json --record-baselines`. Recording never writes into the installed package. The bundled starter has a read-only default baseline; every other theme must supply its own baseline file.

Library callers use `runThemeConformance({ themePackage, artifactsDir, baselineFile, recordBaselines })`.

Before each screenshot, the harness waits for fonts and rendering frames, then returns the viewport to the top and clears transient focus and pointer state. Keyboard and form behavior checks run before that capture reset. The matrix also verifies video playback and loaded caption cues before hiding native controls and caption overlays for static capture; browser-owned overlays depend on viewport state and are not theme pixels.

The harness contains no client assets, credentials, or checkout paths.

## Optional application-form copy

A staged theme component root may include `application-form.json` for static, plain-text copy only. Its required `schemaVersion` is `1`; optional keys are `linkedInLabel`, `noteLabel`, `consentLabel`, `submitLabel`, `successMessage`, `nameRequired`, `emailRequired`, `emailInvalid`, `resumeRequired`, and `consentRequired`. Each value is non-empty plain text up to 1,024 characters; the file is limited to 8 KiB and rejects unknown keys, invalid JSON, control characters, symlinks, and files outside the trusted staged root. Missing files use neutral defaults. Rendered values are escaped.

This file cannot change the application endpoint, upload MIME types or size limit, privacy links, consent mechanics, idempotency, or validation behavior beyond the listed messages.

# Neutral starter theme

`@site-engine/theme-starter` exposes a typed descriptor for the standard template, block, appearance, motion, and chrome surface. It uses only neutral tokens and system fonts so it can be packed and tested without a private theme repository.

Theme-specific extensions must use a namespaced identifier such as `exampleAgency/notice`, declare their contract compatibility, and must not replace or change a standard block's meaning. The engine owns content, routing, and accessibility semantics; a theme supplies tokens, classes, and presentation.

## Hero fields

The standard Hero accepts its original eyebrow, heading, body, and optional primary CTA. It may also include an optional `secondaryCta` and a `supportPanel` with an optional eyebrow, required heading and body, and optional CTA. The starter renders the actions together, labels the supporting content as an `aside`, and collapses the two-column presentation to one column on narrow screens. Themes should omit empty optional wrappers and validate internal link targets at their rendering boundary.

The public contract is now `1.1.0`. It continues to parse frozen `1.0.0` snapshots, but `secondaryCta` and `supportPanel` are rejected from `1.0.0` snapshots. A selected theme must declare the exact snapshot contract, so a `1.1.0` snapshot requires a `1.1.0` renderer manifest. The starter renderer can still render legacy `1.0.0` snapshot data.

Private theme integration must publish a new immutable theme version with `contract: "1.1.0"`, preserve its existing `1.0.0` package for frozen releases, render the optional Hero fields, and update the private registry entry. Operations must pin `1.1.0` consistently in the approved snapshot, renderer environment, and release artifact; it must not rewrite older snapshot or theme pins.

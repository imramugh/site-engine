# Neutral starter theme

`@site-engine/theme-starter` exposes a typed descriptor for the standard template, block, appearance, motion, and chrome surface. It uses only neutral tokens and system fonts so it can be packed and tested without a private theme repository.

Theme-specific extensions must use a namespaced identifier such as `exampleAgency/notice`, declare their contract compatibility, and must not replace or change a standard block's meaning. The engine owns content, routing, and accessibility semantics; a theme supplies tokens, classes, and presentation.

## Hero fields

The standard Hero accepts its original eyebrow, heading, body, and optional primary CTA. It may also include an optional `secondaryCta` and a `supportPanel` with an optional eyebrow, required heading and body, and optional CTA. The starter renders the actions together, labels the supporting content as an `aside`, and collapses the two-column presentation to one column on narrow screens. Themes should omit empty optional wrappers and validate internal link targets at their rendering boundary.

This review branch deliberately retains the published `1.0.0` version pins: the fields are optional and the package is not being published. For a registry release, publish the contract as `1.1.0`, release an updated starter and private themes that use these fields, and pin matching `1.1.0` contract values in the theme manifest, approved snapshot, and renderer. Existing `1.0.0` snapshots and themes remain valid and continue to omit the optional UI.

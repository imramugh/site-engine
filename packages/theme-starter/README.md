# Neutral starter theme

`@site-engine/theme-starter` exposes a typed descriptor for the standard template, block, appearance, motion, and chrome surface. It uses only neutral tokens and system fonts so it can be packed and tested without a private theme repository.

Theme-specific extensions must use a namespaced identifier such as `exampleAgency/notice`, declare their contract compatibility, and must not replace or change a standard block's meaning. The engine owns content, routing, and accessibility semantics; a theme supplies tokens, classes, and presentation.

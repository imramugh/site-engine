# MCP tool coverage

This is an implementation status document for the public engine. It describes
current MCP server capabilities without embedding client content, deployment
configuration, or credentials.

## Implemented

- Discovery: `get_tree`, `get_page`, `search_content`, `search_pages`,
  `list_block_types`, `list_templates`, `list_section_presets`,
  `list_appearance_options`, `get_block_library`, and `list_sections`.
- Draft editing: named change sets; section creation and updates; page creation and recipe creation; whole
  block updates; block add, move, hide, copy, remove, and reorder; validated
  page-field updates; and item add, update, move, and remove for
  contract-defined item lists.
- Scoped reads: redirects, site settings, installed themes, frozen page
  quality, leads, and applications, subject to their declared scopes and roles.

All draft writes require an explicit change set, write scope, a current
revision or page hash where applicable, contract validation, and audit data.
The server exposes no approval or publication tool.

## Planned

- Content structure operations beyond the current page and block workflows,
  including section archiving, page moves or duplication, template changes,
  and navigation overrides.
- Media lifecycle tools, quality suggestions, review-history queries, and
  additional site or theme draft operations.
- Scoped lead and careers workflow mutations that require their own privacy,
  retention, and confirmation controls.

Planned capabilities remain unavailable until they have an authenticated,
validated, revision-safe implementation and integration evidence.

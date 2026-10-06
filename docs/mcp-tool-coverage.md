# MCP tool coverage

The server uses authenticated Streamable HTTP at `/mcp`. OAuth grants resolve to
an enabled CMS user and a usable session; a client never supplies its own effective
user or an access override. Content-read scope does not grant private CRM access.

## Content workflows

| Family | Tools |
| --- | --- |
| Discovery | `get_tree`, `get_page`, `search_content`, `search_pages`, `list_sections`, `list_block_types`, `list_templates`, `list_section_presets`, `list_appearance_options`, `get_block_library` |
| Structure | `create_section`, `update_section`, `archive_section`, `create_page`, `create_page_from_recipe`, `duplicate_page`, `move_page`, `change_page_template`, `archive_page` |
| Blocks and fields | `update_page_fields`, `add_block`, `update_block`, `move_block`, `hide_block`, `copy_block`, `remove_block`, `reorder_blocks`, `add_item`, `update_item`, `move_item`, `remove_item` |
| Media | `find_media`, `get_media_usage`, `upload_media`, `update_media`, `replace_media` |
| Quality | `get_page_quality`, `audit_page`, `list_stale_pages`, `get_style_guide`, `suggest_summary`, `suggest_meta`, `suggest_faq`, `suggest_alt`, `get_ai_suggestion` |
| Review/history | `start_change_set`, `get_review_status`, `list_change_sets`, `submit_for_review`, `discard_change_set`, `list_changes`, `request_rollback` |
| Site/themes/redirects | `get_site_settings`, `update_site_settings`, `update_nav_overrides`, `list_themes`, `get_theme_compatibility`, `switch_theme`, `update_theme_settings`, `list_redirects`, `create_redirect` |

Legacy names `create_change_set`, `get_change_set`, `submit_change_set`,
`update_page` and `list_installed_themes` remain available. Discovery publishes
required scopes and applicable role restrictions. Content writes require an
explicit change set, current revision/page hash where applicable, contract
validation and returned checks. Administrative theme/site writes also require
Owner permission. A rollback prepares another reviewable draft.

The [block gallery and recipe workflow](block-gallery.md) documents all eighteen
recipe block types, explicit media/consent selections, schema-derived metadata,
template filtering and the human review boundary.

The server exposes no approval, publication, user-management or permanent-delete
tool. Unknown top-level arguments are rejected before the handler runs, including
attempts to supply `overrideAccess`. Embedded content remains subject to the
contract's schema and field rules.

## Suggestions

The four `suggest_*` calls require content-read and content-write scopes plus an
editing role. They queue a durable suggestion using the Owner-configured route
for that task. Missing configuration returns an explicit unavailable result.
The target revision is retained and status reads identify stale suggestions.
Only the requesting actor can read a suggestion job, and the target must still
be readable. Output is marked untrusted and is never automatically applied.
Applying accepted wording uses the normal revisioned content tools and review.

Image alt suggestions use validated, resized image pixels from authorized stored
media. Filenames and metadata are not substitutes for image input. Only models
with a reviewed image-input cost bound can run these jobs; unsupported routes
fail closed. Neither provider credentials nor image data are returned through
job status or invocation audit.

## Invocation audit

Authenticated calls have correlated start/result records containing the canonical
user, hashed client, scopes, method/tool, outcome and validated record/revision
references. Content mutation records retain their transactional change-set/diff
evidence. Request bodies, arbitrary tool arguments and provider secrets are not
copied into invocation records. A failed initial audit prevents execution. If a
terminal audit fails after dispatch, the response reports that the operation may
have completed; callers must inspect its state before retrying.

## Other capabilities and boundaries

Lead/application tools use their separate role and OAuth scopes. Reply preparation
is a private record workflow, not a content publication. Sending requires a fresh
human confirmation bound to the exact actor, assistant, session and envelope.
Those workflows have separate privacy, retention and delivery stories.

This file is an implementation inventory. ENG-016 acceptance requires passing
protocol/database and browser tests, production-image checks and verified
deployment evidence in its pull request.

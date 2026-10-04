# ENG-026 Hero draft editor increment

This increment provides `/direct-edit` for Owners and Editors. It supports only an existing Hero's `heading` and `body`; the screen links to Content tree for all other fields. The editor reads a bounded, role-filtered list of draft pages and caller-owned editable change sets, saves through `POST /api/editorial/direct-edit`, and keeps normal change-set capture, stale-value protection, replay behavior, and draft-only validation.

After a save, an Editor can request a protected proposed preview. The server creates an immutable, bounded preview job for the caller-owned current draft revision. The client polls its scoped status path, then embeds the canonical route for the selected page only after completion. The private preview guard allows the owning Editor or Owner while the set remains editable and the revision/hash remains current. Preparing a draft preview never writes the submitted-review preview proof and never approves or publishes content. Submission enters the existing reviewer workflow.

Browser proof covers an Editor saving a Hero heading while retaining an unsaved body field, enqueueing and completing the worker job, seeing that saved heading on a selected non-root protected page, submitting, and leaving the public release unchanged. The route is a staff-only operation; the preview guard remains internal to the edge authentication flow. The operations allowlist permits the scoped staff routes, not public content mutation.

The on-page canvas, theme field markers, keyboard interaction, and broader block-field support remain separate work. This is not the complete ENG-026 on-page editing experience.

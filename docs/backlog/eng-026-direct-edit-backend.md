# ENG-026 direct-edit backend increment

This increment accepts draft-only edits to existing Hero `heading` and `body` fields through `POST /api/editorial/direct-edit`. It requires a same-origin request, an active Owner or Editor session, and a caller-owned change set in `open` or `changes-requested` state. The request carries the page, Hero block, supported field, replacement text, expected value hash, and change-set ID.

The CMS validates the complete resulting page, including the existing Hero limits of 120 characters for `heading` and 1,000 for `body`, writes only the draft, and uses the existing editorial capture hook to maintain the normal change-set diff. A matching retry reports success without another write; a different stale value returns a conflict. The route neither prepares a preview nor approves or publishes content.

The on-page canvas, theme field markers, keyboard interaction, and broader block-field support remain separate work. This route is not a public edge endpoint.

# Mistral configured AI jobs

The Mistral adapter sends configured job text to `https://api.mistral.ai/v1/chat/completions` with an Owner-supplied API key in the `Authorization: Bearer` header. The key is encrypted at rest, remains write-only in the admin, and is never returned by public integration APIs or audit records.

Owners must review the selected model, Mistral's data-processing terms, region availability, retention settings, and current per-model input/output pricing before enabling it. The configured pricing source and effective date are stored with the configuration; the system reserves against monthly caps before transport. The adapter currently declares no image-input support, so image-required jobs are rejected before any request.

Connection checks use Mistral's authenticated model metadata endpoint. Production jobs use the fixed Mistral API origin; this adapter does not accept a custom endpoint or send traffic to arbitrary hosts.

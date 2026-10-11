# Configured AI providers

Configured AI providers run CMS jobs. They are separate from Connected assistants,
which are MCP clients and do not inherit an AI provider credential, model, fallback,
or data-processing choice.

## Before configuring a provider

An Owner records a reviewed model, credential, current pricing evidence, monthly
cap, and the provider-specific capability declaration. Credentials are encrypted at
rest and are write-only: the CMS displays only a fingerprint hint. A connection test
records health (`connected`, `unavailable`, or `rejected`), but does not prove that
a model is suitable for every job or that capacity is available.

The configured cap and the provider's bill are separate controls. Review the
provider's current price and quota information before enabling a model, and repeat
that review whenever its model, region, deployment, or pricing changes.

Jobs use a fallback only when the Owner has explicitly configured and approved it.
The fallback can process the same job data, possibly in a different region or under
a different provider's terms. Obtain the required data-processing and residency
approval before assigning it; do not use a fallback to bypass those requirements.

Image input is opt-in. Set **Image input** only after reviewing the exact deployed
model's image capability, supported limits, pricing, and data handling. The CMS
requires the reviewed positive token limit (between 1 and 1,000,000 tokens for a 768×768 image) for an image-capable declaration; a
text-only declaration cannot be assigned to an image-required job.

## Adapter details

### Azure OpenAI

Configure the Azure OpenAI resource endpoint and deployment/model name. The adapter uses the Azure v1 Responses API with the resource API key. The
endpoint is an Azure OpenAI resource origin; keep the deployment in the intended
Azure region and review its model availability, pricing, and data residency before
use. Use Azure's documented authentication and deployment conventions, including
the [Azure OpenAI REST API reference](https://learn.microsoft.com/azure/ai-foundry/openai/reference)
and [Azure OpenAI data, privacy, and security guidance](https://learn.microsoft.com/azure/ai-foundry/responsible-ai/openai/data-privacy).

### Amazon Bedrock

Configure the AWS region and approved Bedrock model or inference-profile ID. This adapter uses a Bedrock bearer API key; do not supply an IAM access-key/secret pair or role credential. The adapter accepts commercial AWS, AWS China, and AWS GovCloud region forms; select the required region explicitly. Bedrock endpoints and model availability are region-specific. Cross-region inference can process prompts in a
destination region, so verify every destination region for an inference profile
before enabling it. See [Bedrock endpoints](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html),
[Bedrock API-key authentication](https://docs.aws.amazon.com/en_us/bedrock/latest/userguide/api-keys-use.html),
and [cross-region residency considerations](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html).

### Mistral

Configure the reviewed Mistral model and API credential. Check the selected model's
modalities, limits, regional/data-processing terms, and current pricing before
declaring image input. Follow Mistral's [API reference](https://docs.mistral.ai/api/)
and [platform documentation](https://docs.mistral.ai/platform/).

### OpenAI-compatible endpoint

Configure an approved HTTPS endpoint base path, reviewed model, and the endpoint's credential.
This adapter is for an operator-approved compatible service, not an arbitrary URL.
The deployment must allow its exact origin through `AI_COMPATIBLE_ALLOWED_ORIGINS`; this
allowlist is required to prevent server-side request forgery. Do not include local,
The CMS resolves and pins the approved public DNS result before connecting and bounds provider response reads.
link-local, private-network, redirecting, or unreviewed origins. Confirm the
provider's protocol compatibility, authentication method, data-processing terms,
residency, model modality, usage limits, and pricing before allowing the origin.
The [OpenAI API reference](https://platform.openai.com/docs/api-reference) describes
the compatible request and authentication conventions, but compatibility does not
by itself establish a provider's security or data-processing posture.

## Operating the adapters

Keep health checks, caps, and usage records under review. `connected` means the
last non-billable connection check succeeded; `unavailable` means the check could
not reach an available service or model; `rejected` means authentication or the
request was rejected. These states do not authorize a fallback or establish a
provider's availability for a later job. Investigate and retest before changing
routing, and review the audit record for every configuration, health, and fallback
event.

// evolink-image-mapper.js
//
// Stage 16, Part 3 — the ONLY file allowed to know EvoLink's IMAGE
// generation request/response field names (image_urls, size, quality,
// model_params, etc.). This is deliberately SEPARATE from
// evolink-mapper.js (the existing VIDEO translator) — different endpoint
// (/v1/images/generations vs /v1/videos/generations), different verified
// field set, different normalized input shape (services/
// image-generation-executor.js's buildNormalizedImageRequest, not
// schemas/production-schema.js's createGenerationRequest). Keeping them
// separate means neither can accidentally leak a field from one task type
// into the other.
//
// Every field mapped below is VERIFIED from EvoLink's own dedicated
// OpenAPI spec pages (Stage 15's investigation — see
// docs/integrations/image-provider-investigation.md Part 4/11) via
// evolink-models.js's requestSchemaVerified flag. Nothing here invents or
// guesses a field name.

const EVOLINK_MODELS = require('./evolink-models');

// Documented (docs/integrations/image-provider-investigation.md Part 4a/4b):
// image generation tasks use the exact same status enum and lifecycle as
// video tasks (pending/processing/completed/failed, no separate
// "cancelled" value — a cancelled task is "failed" with error.code
// "request_cancelled"). Kept as its own small local copy rather than an
// import from evolink-mapper.js, so this file has zero dependency on the
// video-specific module (see file header).
const EVOLINK_STATUS_MAP = {
  pending: 'SUBMITTED',
  processing: 'PROCESSING',
  completed: 'COMPLETED',
  failed: 'FAILED',
};

function findVerifiedImageModel(model) {
  const modelInfo = EVOLINK_MODELS[model];
  if (!modelInfo || modelInfo.endpointPath !== '/v1/images/generations' || !modelInfo.requestSchemaVerified) {
    throw new Error(
      `"${model}" is not a verified EvoLink IMAGE model. Only models in evolink-models.js with ` +
        'endpointPath "/v1/images/generations" and requestSchemaVerified: true can be used — see ' +
        'docs/integrations/image-provider-investigation.md for what has actually been checked against ' +
        'the official documentation.'
    );
  }
  return modelInfo;
}

// normalizedRequest: services/image-generation-executor.js's
// buildNormalizedImageRequest() output — { prompt, referenceDetails, parameters }.
// `parameters.model` selects which verified EvoLink image model to target.
//
// referenceDetails carries { assetId, roleType, role } per reference (Stage
// 16, Part 2) — but EvoLink's image_urls field is a flat array of URLs with
// NO documented per-image semantic-role parameter (verified in Stage 15;
// see Part 7/12 of the investigation doc). This function therefore:
//   1. never invents a role field EvoLink doesn't have,
//   2. maps only the actual image URL into image_urls (resolved by the
//      CALLER via parameters.referenceImageUrls: [{assetId, url}] — this
//      mapper has no access to, and no business resolving, our own asset
//      storage; see services/keyframe-generation-service.js),
//   3. preserves roleType/role internally on the returned `warnings` so a
//      human reviewing the request can see what was intended even though
//      the provider itself cannot structurally enforce it.
function toEvolinkImageRequest(normalizedRequest) {
  const { prompt, referenceDetails = [], parameters = {} } = normalizedRequest;
  const { model, size, quality, webSearch, callbackUrl, referenceImageUrls = [] } = parameters;

  findVerifiedImageModel(model);

  if (!prompt) {
    throw new Error('toEvolinkImageRequest requires a non-empty prompt.');
  }

  const warnings = [];
  const body = { model, prompt };

  if (referenceDetails.length > 0) {
    const urlByAssetId = new Map(referenceImageUrls.map((r) => [r.assetId, r.url]));
    const imageUrls = referenceDetails.map((ref) => urlByAssetId.get(ref.assetId)).filter(Boolean);

    if (imageUrls.length > 0) {
      body.image_urls = imageUrls;
    }

    const unresolvedCount = referenceDetails.length - imageUrls.length;
    if (unresolvedCount > 0) {
      warnings.push(
        `${unresolvedCount} reference asset(s) were not included: no publicly accessible URL was supplied for ` +
          'them via parameters.referenceImageUrls. EvoLink requires directly, publicly accessible image URLs ' +
          '(docs/integrations/evolink-api.md) — a locally archived asset path is not usable as-is.'
      );
    }

    // Part 3's explicit instruction: DO NOT fake a role concept EvoLink
    // doesn't support. image_urls has no documented per-image role field —
    // only ordering, which is not documented as semantically meaningful
    // either. Preserve the intended roles here rather than silently
    // dropping them.
    if (imageUrls.length > 0) {
      const roleSummary = referenceDetails
        .filter((ref) => urlByAssetId.has(ref.assetId))
        .map((ref) => `${ref.assetId}=${ref.roleType}`)
        .join(', ');
      warnings.push(
        `EvoLink's image_urls field has no documented per-image semantic role (CHARACTER/ENVIRONMENT/WARDROBE/` +
          `PROP/STYLE/OTHER) — provider-level role enforcement is unavailable. Intended roles, preserved ` +
          `internally only: ${roleSummary}.`
      );
    }
  }

  if (size !== undefined) body.size = size;
  if (quality !== undefined) body.quality = quality;
  if (webSearch !== undefined) body.model_params = { ...(body.model_params || {}), web_search: webSearch };
  if (callbackUrl !== undefined) body.callback_url = callbackUrl;

  return { body, warnings };
}

// evolinkResponse: a raw image task object as returned by EvoLink (from
// either creating a task or querying /v1/tasks/{id} — same shape both
// times, per Stage 15's finding that the task-management endpoint is
// unified across image/video/audio). Returns our generic
// createGenerationStatus shape (providers/image-provider-interface.js).
function fromEvolinkImageTask(evolinkResponse) {
  let status = EVOLINK_STATUS_MAP[evolinkResponse.status] || 'FAILED';
  let error = null;

  if (evolinkResponse.status === 'failed' && evolinkResponse.error) {
    error = {
      code: evolinkResponse.error.code,
      message: evolinkResponse.error.message,
    };
    if (evolinkResponse.error.code === 'request_cancelled') {
      status = 'CANCELLED';
    }
  }

  // Same "never assume it's there" rule as evolink-mapper.js — usage is
  // only present on the creation response, never the polling response.
  const reservedCost =
    evolinkResponse.usage && typeof evolinkResponse.usage.credits_reserved === 'number'
      ? evolinkResponse.usage.credits_reserved
      : null;

  return {
    generationId: evolinkResponse.id,
    provider: 'evolink-image',
    model: evolinkResponse.model,
    status,
    progress: typeof evolinkResponse.progress === 'number' ? evolinkResponse.progress : null,
    reservedCost,
    results: Array.isArray(evolinkResponse.results) ? evolinkResponse.results : [],
    error,
  };
}

module.exports = {
  findVerifiedImageModel,
  toEvolinkImageRequest,
  fromEvolinkImageTask,
};

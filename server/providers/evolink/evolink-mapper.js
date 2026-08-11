// evolink-mapper.js
//
// Translates between our generic shapes (schemas/production-schema.js's
// createGenerationRequest, and provider-interface.js's
// createGenerationStatus) and EvoLink's actual request/response format.
//
// This is the ONLY file allowed to know EvoLink-specific field names like
// image_urls, aspect_ratio, quality, content_filter, etc. Everything else
// in the application deals only in our generic shapes.

const EVOLINK_MODELS = require('./evolink-models');

// Documented in docs/integrations/evolink-api.md's "Job / Task Lifecycle"
// section. EvoLink has no "cancelled" status of its own — a cancelled
// task is status "failed" with error.code "request_cancelled".
const EVOLINK_STATUS_MAP = {
  pending: 'SUBMITTED',
  processing: 'PROCESSING',
  completed: 'COMPLETED',
  failed: 'FAILED',
};

// genericRequest: { provider, model, task, references, prompt, parameters }
// (the shape schemas/production-schema.js's createGenerationRequest produces)
function toEvolinkRequest(genericRequest) {
  const { model, prompt, references = [], parameters = {} } = genericRequest;

  const modelInfo = EVOLINK_MODELS[model];
  if (!modelInfo || !modelInfo.requestSchemaVerified) {
    throw new Error(
      `"${model}" is not a verified EvoLink model. Only models in evolink-models.js with ` +
        'requestSchemaVerified: true can be used — see docs/integrations/evolink-api.md for what has ' +
        'actually been checked against the official documentation.'
    );
  }

  const body = { model, prompt };

  // Only image-to-video's reference field has been verified so far
  // (image_urls, 1-2 items). Other reference kinds (video/audio) are not
  // mapped yet — no verified schema for them.
  if (modelInfo.task === 'image-to-video') {
    const imageUrls = references.filter((ref) => ref.type === 'image').map((ref) => ref.url);
    if (imageUrls.length > 0) {
      body.image_urls = imageUrls;
    }
  }

  if (parameters.duration !== undefined) body.duration = parameters.duration;
  if (parameters.quality !== undefined) body.quality = parameters.quality;
  if (parameters.aspectRatio !== undefined) body.aspect_ratio = parameters.aspectRatio;
  if (parameters.generateAudio !== undefined) body.generate_audio = parameters.generateAudio;
  if (parameters.contentFilter !== undefined) body.content_filter = parameters.contentFilter;
  if (parameters.outputFormat !== undefined) body.output_format = parameters.outputFormat;
  if (parameters.callbackUrl !== undefined) body.callback_url = parameters.callbackUrl;

  return body;
}

// evolinkResponse: a raw task object as returned by EvoLink (from either
// creating a task or querying /v1/tasks/{id} — same shape both times).
// Returns our generic createGenerationStatus shape.
function fromEvolinkTask(evolinkResponse) {
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

  return {
    generationId: evolinkResponse.id,
    provider: 'evolink',
    model: evolinkResponse.model,
    status,
    progress: typeof evolinkResponse.progress === 'number' ? evolinkResponse.progress : null,
    results: Array.isArray(evolinkResponse.results) ? evolinkResponse.results : [],
    error,
  };
}

module.exports = {
  toEvolinkRequest,
  fromEvolinkTask,
};

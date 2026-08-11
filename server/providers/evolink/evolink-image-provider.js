// evolink-image-provider.js
//
// Stage 16, Part 4 — implements providers/image-provider-interface.js
// (createImageGeneration/getGenerationStatus) for the REAL EvoLink image
// API. This is the first real (non-fake) image provider in the codebase.
//
// Reuses, rather than duplicates:
//   - evolink-client.js's auth/base-URL/error-handling HTTP plumbing
//     (createImageGenerationTask/getTask — the same getTask() the video
//     provider already uses, since EvoLink's task-status endpoint is
//     unified across image/video/audio — see docs/integrations/
//     image-provider-investigation.md Part 4d).
//   - evolink-image-mapper.js for every EvoLink-specific field name.
//
// This file itself knows NO EvoLink field names — only how to wire the
// client and mapper together, exactly like evolink-provider.js (video)
// does for its own task type.

const client = require('./evolink-client');
const imageMapper = require('./evolink-image-mapper');

async function createImageGeneration(request) {
  const { body, warnings } = imageMapper.toEvolinkImageRequest(request);
  const evolinkResponse = await client.createImageGenerationTask(body);
  const status = imageMapper.fromEvolinkImageTask(evolinkResponse);
  if (warnings.length > 0) {
    status.warnings = warnings;
  }
  return status;
}

async function getGenerationStatus(taskId) {
  const evolinkResponse = await client.getTask(taskId);
  return imageMapper.fromEvolinkImageTask(evolinkResponse);
}

// Not part of the required image-provider interface. A safe, read-only,
// non-generation way to confirm the account/key has credits before ever
// submitting a real generation — see Stage 16, Part 7. Reuses the same
// endpoint the video provider already exposes this way (checkAccountCredits
// in evolink-provider.js) — not called anywhere automatically.
async function checkAccountCredits(options = {}) {
  return client.getCredits(options);
}

module.exports = {
  createImageGeneration,
  getGenerationStatus,
  checkAccountCredits,
};

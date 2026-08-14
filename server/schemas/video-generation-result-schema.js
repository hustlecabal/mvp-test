// video-generation-result-schema.js
//
// Stage 22B-Part-3, Part 15 — the normalized shape
// services/video-generation-service.js returns from canGenerateVideo(),
// generateVideo(), and getVideoGenerationStatus(). Mirrors
// schemas/keyframe-execution-result-schema.js's normalized-status
// discipline: BLOCKED/IN_PROGRESS/COMPLETED/FAILED are OUR OWN vocabulary,
// derived from (never a passthrough of) a generation job's raw status —
// see video-generation-service.js's normalizeStatus().
//
// Never invents an artifact URL: `assetId` is set only once the permanent
// asset has actually been created through the existing archive/storage
// pipeline (services/asset-archive-service.js) — this schema has no field
// that could hold a raw, unarchived provider URL.

const VIDEO_GENERATION_RESULT_STATUSES = ['BLOCKED', 'IN_PROGRESS', 'COMPLETED', 'FAILED'];

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function createVideoGenerationResult(overrides = {}) {
  const base = {
    generationId: null,
    projectId: null,
    sceneId: null,
    shotId: null,
    keyframeId: null,

    videoPromptPackageId: null,
    videoPromptPackageVersion: null,
    canonicalKeyframeAssetId: null,

    provider: null,
    model: null,
    providerTaskId: null,

    status: 'BLOCKED',

    // Set only once the completed video has actually been archived into
    // permanent local storage (asset-archive-service.js) — never a raw,
    // temporary provider URL.
    assetId: null,

    reservedCost: null,
    actualCost: null,

    // Present only when status === 'BLOCKED' (a structured eligibility
    // diagnostic — see video-generation-service.js's canGenerateVideo())
    // or 'FAILED' (the provider's own reported failure).
    code: null,
    reason: null,
    error: null,
  };
  return withDefaults(base, overrides);
}

module.exports = {
  VIDEO_GENERATION_RESULT_STATUSES,
  createVideoGenerationResult,
};

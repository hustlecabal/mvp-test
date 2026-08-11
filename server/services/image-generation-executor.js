// image-generation-executor.js
//
// Stage 13B, Part 8/9 — the IMAGE_GENERATION_EXECUTOR execution boundary.
//
// The skill registry (services/skill-registry.js) identifies
// banana-pro-director-2.0 as the specialist for reference-image
// generation, but this backend is NOT the thing that runs a Claude skill
// — it never has been (see docs/architecture/skill-orchestration.md's
// execution-boundary explanation from Stage 11B) and this stage does not
// change that. This file draws that boundary explicitly for image
// generation: it turns a KeyframePromptPackage into the canonical,
// provider-agnostic NORMALIZED IMAGE REQUEST (Part 9) that an image
// provider adapter (e.g. providers/fake-image/) can consume — nothing
// more. It never calls a skill, a provider, or a network API itself.

// Part 9 — the canonical shape. No EvoLink-specific (or any other
// provider-specific) field is ever added to this — a provider adapter is
// responsible for translating THIS into whatever its own API expects.
function buildNormalizedImageRequest(promptPackage, { parameters = {} } = {}) {
  if (!promptPackage) {
    throw new Error('buildNormalizedImageRequest requires a KeyframePromptPackage');
  }

  return {
    projectId: promptPackage.projectId,
    keyframeId: promptPackage.keyframeId,
    promptPackageId: promptPackage.packageId,
    promptPackageVersion: promptPackage.version,
    prompt: promptPackage.prompt,
    promptSections: promptPackage.promptSections,
    referenceAssets: (promptPackage.existingReferenceAssets || []).map((ref) => ref.assetId),
    recommendedSkill: promptPackage.recommendedSkill,
    parameters,
  };
}

// Part 8 — the initial (and, for this stage, only) executor
// implementation. Deterministic, synchronous, no I/O of its own — it only
// wraps buildNormalizedImageRequest so callers depend on a named
// "executor" concept rather than a bare function, leaving room for a
// real executor (still never a direct in-process skill call — see Part 10
// of the stage brief) to be swapped in later without changing anything
// that calls it.
const FakeImageGenerationExecutor = {
  name: 'fake-image-generation-executor',
  buildRequest(promptPackage, options) {
    return buildNormalizedImageRequest(promptPackage, options);
  },
};

module.exports = {
  buildNormalizedImageRequest,
  FakeImageGenerationExecutor,
};

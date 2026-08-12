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
//
// Stage 16, Part 2 — `referenceDetails` is an ADDITIVE field alongside the
// original `referenceAssets` (bare asset-id strings, unchanged, still
// populated exactly as before for backward compatibility). It carries each
// reference's `roleType` (CHARACTER/ENVIRONMENT/WARDROBE/PROP/STYLE/OTHER —
// schemas/keyframe-prompt-schema.js's REFERENCE_ROLE_TYPES) and free-text
// `role` label through to a provider adapter, so an adapter that CAN
// represent semantic roles has the information to do so, without forcing
// every existing caller of the plain `referenceAssets` array to change. A
// package built before Stage 16 (missing `roleType` on its entries) simply
// yields `roleType: 'OTHER'` here — never an error.
function buildNormalizedImageRequest(promptPackage, { parameters = {} } = {}) {
  if (!promptPackage) {
    throw new Error('buildNormalizedImageRequest requires a KeyframePromptPackage');
  }

  const existingReferenceAssets = promptPackage.existingReferenceAssets || [];

  return {
    projectId: promptPackage.projectId,
    keyframeId: promptPackage.keyframeId,
    promptPackageId: promptPackage.packageId,
    promptPackageVersion: promptPackage.version,
    prompt: promptPackage.prompt,
    promptSections: promptPackage.promptSections,
    referenceAssets: existingReferenceAssets.map((ref) => ref.assetId),
    referenceDetails: existingReferenceAssets.map((ref) => ({
      assetId: ref.assetId,
      roleType: ref.roleType || 'OTHER',
      role: ref.role || null,
      // Stage 19, Part 7 — whether this reference was the entity's
      // explicitly-selected CANONICAL reference at generation time, vs.
      // some other approved reusable one. Missing on a pre-Stage-19
      // package's entries, same "defaults to a safe falsy value, never an
      // error" rule as roleType above.
      canonical: ref.canonical || false,
    })),
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

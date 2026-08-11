// image-provider-interface.js
//
// Stage 13B, Part 2 — the contract every IMAGE generation provider adapter
// must implement. This is deliberately separate from
// providers/provider-interface.js (the existing VIDEO provider contract)
// rather than a modification of it — the two generation types have
// different lifecycles and this file must never change how video
// generation behaves.
//
// A provider must expose exactly two operations:
//   createImageGeneration(request)  -> generic generation status
//   getGenerationStatus(taskId)     -> generic generation status
//
// "request" is the NORMALIZED image request shape from
// services/image-generation-executor.js (Part 9): { projectId, keyframeId,
// promptPackageId, promptPackageVersion, prompt, promptSections,
// referenceAssets, recommendedSkill, parameters }. No provider-specific
// field name is allowed to leak into that shape or into this interface.
//
// Reuses providers/provider-interface.js's generic status shape
// (createGenerationStatus/GENERATION_STATUSES) rather than inventing a
// second one — an image generation's status is exactly as generic as a
// video generation's (id/provider/model/status/progress/reservedCost/
// results/error), so there is nothing image-specific to add.

const { GENERATION_STATUSES, createGenerationStatus } = require('./provider-interface');

const REQUIRED_METHODS = ['createImageGeneration', 'getGenerationStatus'];

function assertImplementsImageProviderInterface(provider) {
  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw new Error(`Image provider is missing required method: ${method}()`);
    }
  }
}

module.exports = {
  REQUIRED_METHODS,
  GENERATION_STATUSES,
  createGenerationStatus,
  assertImplementsImageProviderInterface,
};

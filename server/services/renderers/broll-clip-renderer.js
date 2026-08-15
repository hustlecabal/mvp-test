// broll-clip-renderer.js
//
// Stage 26.8A — the BROLL_CLIP renderer. Consumes the BROLL_CLIP executor's
// existing renderSpec (services/material-executors/broll-executor.js)
// VERBATIM: sourceAssetId, brollSegmentId, startTime, duration, trimIn,
// trimOut, playbackRate, fit, transform, position, scale, opacity,
// audioPolicy, role.
//
// HONEST BLOCKER (per Stage 26.8A Part 10's own explicit instruction): a
// real B-roll render requires decoding actual video frames within
// [trimIn, trimOut] at playbackRate and re-encoding/extracting them —
// genuine frame-accurate video work that requires ffmpeg (or an
// equivalent decoder), which this stage's audit confirmed is NOT a
// declared dependency of this repository, and is not resolvable from
// server/ without either adding a new dependency (Part 16's STOP-and-
// report gate) or a fragile environment-specific workaround (rejected —
// see the Stage 26.8A capabilities audit for the Playwright/Chromium
// case, which reached the same conclusion for the same reason).
//
// This renderer therefore performs every validation step that IS possible
// WITHOUT ffmpeg — the same structural re-checks the executor itself
// already performs, confirming the renderer's own input is genuinely
// sound — and then fails deterministically with RENDERER_UNAVAILABLE. It
// never substitutes a placeholder frame, a static poster image, or any
// other stand-in for real video output — that would be exactly the kind
// of faked rendering this stage's own instructions forbid.

const timelineStore = require('../timeline-store');
const { createRenderResult, createRenderDiagnostic } = require('../../schemas/render-result-schema');

function fail(executionResult, code, message) {
  return createRenderResult({
    rendererType: 'BROLL_CLIP',
    beatId: executionResult ? executionResult.beatId : null,
    materialId: executionResult ? executionResult.materialId : null,
    executionId: executionResult ? executionResult.executionId : null,
    status: 'FAILED',
    artifact: null,
    diagnostics: [createRenderDiagnostic({ code, message })],
  });
}

function render({ projectId, executionResult, outputDir } = {}) {
  if (!executionResult || !executionResult.renderSpec || executionResult.renderSpec.type !== 'BROLL_CLIP') {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'renderSpec.type must be BROLL_CLIP');
  }
  if (!outputDir) {
    return fail(executionResult, 'INVALID_RENDER_SPEC', 'an outputDir is required');
  }
  const spec = executionResult.renderSpec;

  // --- every check possible WITHOUT ffmpeg, still performed honestly ---
  const asset = timelineStore.getAsset(projectId, spec.sourceAssetId);
  if (!asset) {
    return fail(executionResult, 'MISSING_ASSET', `no asset found with id "${spec.sourceAssetId}" in project "${projectId}"`);
  }
  if (asset.type !== 'video') {
    return fail(executionResult, 'INVALID_RENDER_SPEC', `asset "${spec.sourceAssetId}" has type "${asset.type}", not "video"`);
  }
  const storageStatus = asset.storage ? asset.storage.status : 'NOT_ARCHIVED';
  if (storageStatus !== 'STORED') {
    return fail(executionResult, 'ASSET_NOT_STORED', `asset "${spec.sourceAssetId}" storage status is "${storageStatus}", not STORED`);
  }
  if (typeof spec.trimIn !== 'number' || typeof spec.trimOut !== 'number' || spec.trimIn < 0 || spec.trimOut <= spec.trimIn) {
    return fail(executionResult, 'INVALID_RENDER_SPEC', `trim window [${spec.trimIn}, ${spec.trimOut}] is not a valid, positive-length window`);
  }

  // --- the genuine, honestly-documented blocker ---
  return fail(
    executionResult,
    'RENDERER_UNAVAILABLE',
    'BROLL_CLIP rendering requires frame-accurate video decode/trim/re-encode (ffmpeg or an equivalent decoder), which is not a declared dependency of this repository — asset and trim-window validation passed; see Stage 26.8A final report for the full reasoning'
  );
}

module.exports = { render };

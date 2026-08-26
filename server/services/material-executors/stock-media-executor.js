// stock-media-executor.js
//
// The STOCK_MEDIA -> Media Acquisition bridge — same shape as
// generated-new-executor.js's own GENERATED_NEW bridge, for the same
// reason: services/material-execution-service.js's executeMaterial() and
// every executor's execute() are SYNCHRONOUS, but obtaining stock media
// requires a real network call (services/media-acquisition-service.js's
// acquireMedia(), async). This file NEVER performs that call itself.
//
//   1. look up whether stock media has ALREADY been acquired for this
//      beat, via services/media-acquisition-store.js's read-only
//      findAcquiredForBeat() — never a new lookup system.
//   2. if one exists, delegate ALL render-spec construction to the
//      EXISTING executor that already solves "place a real asset"
//      (still-image-motion-executor.js for a stock image,
//      project-asset-reuse-executor.js for stock video) — zero
//      duplicated placement logic, exactly generated-new-executor.js's
//      own delegation strategy.
//   3. if none exists yet, fail structurally (NO_ACQUIRED_STOCK_MEDIA_EXISTS)
//      naming the exact tool still required (acquire_stock_media) —
//      services/production-orchestrator-service.js records this as a
//      ProductionEscalation, exactly like GENERATED_NEW's own
//      NO_APPROVED_GENERATION_EXISTS, never a job-ending failure.
//
// Registered for TWO executorTypes (STOCK_MEDIA_IMAGE, STOCK_MEDIA_VIDEO —
// see services/material-executors/index.js), routed by
// services/material-execution-service.js's resolveExecutorType() as a
// specific (materialSource, visualTreatment) pair, checked BEFORE the
// generic STILL_IMAGE rule (same ordering discipline GENERATED_NEW
// already required, for the same reason: a STOCK_MEDIA candidate has no
// selectedAssetId yet, so it must never fall through to an executor that
// assumes one already exists).
//
// NO PROVIDER CREDENTIALS, NO PROVIDER NAME, NO NETWORK CALL anywhere in
// this file — it never imports services/media-acquisition-service.js
// (only the read-only store), and never imports asset-storage.js.

const mediaAcquisitionStore = require('../media-acquisition-store');
const stillImageMotionExecutor = require('./still-image-motion-executor');
const projectAssetReuseExecutor = require('./project-asset-reuse-executor');
const { createExecutionResult, createDiagnostic } = require('../../schemas/material-execution-schema');

function fail(beat, materialId, executorType, code, message, sourceAssetIds = []) {
  return createExecutionResult({
    beatId: beat ? beat.id : null,
    materialId,
    executorType,
    status: 'FAILED',
    renderSpec: null,
    sourceAssetIds,
    diagnostics: [createDiagnostic({ code, message })],
  });
}

const NEXT_STEP_BY_TREATMENT = {
  STILL_IMAGE: 'no stock image has been acquired yet for this beat. Call acquire_stock_media (provider "pexels" or "pixabay", mediaType "image") with this beat\'s id, then re-run material execution.',
  BROLL_CLIP: 'no stock video has been acquired yet for this beat. Call acquire_stock_media (provider "pexels" or "pixabay", mediaType "video") with this beat\'s id, then re-run material execution.',
};

// input: { projectId, beat, selectedMaterial, options }
//   selectedMaterial — a resolveMaterial() CandidateResult (materialSource:
//     'STOCK_MEDIA', visualTreatment: 'STILL_IMAGE' | 'BROLL_CLIP')
//   options — passed straight through, unchanged, to whichever existing
//     executor this bridge delegates to (see that executor's own header
//     for its accepted shape)
function execute({ projectId, beat, selectedMaterial, options = {} } = {}) {
  const materialId = selectedMaterial ? selectedMaterial.candidate : null;
  const executorType = selectedMaterial && selectedMaterial.visualTreatment === 'BROLL_CLIP' ? 'STOCK_MEDIA_VIDEO' : 'STOCK_MEDIA_IMAGE';

  if (!selectedMaterial || selectedMaterial.materialSource !== 'STOCK_MEDIA') {
    return fail(beat, materialId, executorType, 'INVALID_MATERIAL', 'selectedMaterial must be a STOCK_MEDIA candidate');
  }
  if (!['STILL_IMAGE', 'BROLL_CLIP'].includes(selectedMaterial.visualTreatment)) {
    return fail(beat, materialId, executorType, 'UNSUPPORTED_TREATMENT', `STOCK_MEDIA visualTreatment "${selectedMaterial.visualTreatment}" has no acquisition-executor mapping — only STILL_IMAGE and BROLL_CLIP are supported`);
  }
  if (!beat || !beat.id) {
    return fail(beat, materialId, executorType, 'MISSING_BEAT', 'a VisualBeat with an id is required to look up already-acquired stock media for it');
  }

  const treatment = selectedMaterial.visualTreatment;
  const mediaType = treatment === 'BROLL_CLIP' ? 'video' : 'image';
  const acquired = mediaAcquisitionStore.findAcquiredForBeat(projectId, beat.id, mediaType);

  if (!acquired || !acquired.assetId) {
    return fail(beat, materialId, executorType, 'NO_ACQUIRED_STOCK_MEDIA_EXISTS', NEXT_STEP_BY_TREATMENT[treatment]);
  }

  const delegate = treatment === 'BROLL_CLIP' ? projectAssetReuseExecutor : stillImageMotionExecutor;
  const delegated = delegate.execute({ projectId, beat, selectedMaterial: { ...selectedMaterial, selectedAssetId: acquired.assetId }, options });
  // Honest provenance: placement/motion logic was delegated, but this
  // beat's material genuinely came from STOCK_MEDIA acquisition, never
  // presented as the delegate's own materialSource.
  delegated.executorType = executorType;
  return delegated;
}

module.exports = { execute };

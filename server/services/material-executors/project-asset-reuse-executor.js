// project-asset-reuse-executor.js
//
// Stage 26.5A — the PROJECT_ASSET_REUSE deterministic executor. Takes an
// already-resolved existing project Asset (Material Resolution already
// decided WHAT — see services/material-resolution-service.js) and produces
// a deterministic ASSET_PLACEMENT render specification describing HOW that
// asset should sit on the future timeline: timing, position, scale,
// opacity, crop/object-fit, an optional transform, and optional transition
// metadata.
//
// It NEVER copies, mutates, or re-archives the source asset — it only
// READS it (via the existing, unmodified timeline-store.js) to confirm it
// is still usable, then references its id. No new asset record is ever
// created. No approval semantics are invented — the exact same "REJECTED
// is the only hard block, STORED is required" rules
// services/material-resolution-service.js's own evaluateEligibility()
// already established are reused here, not reinvented, because this
// executor only ever runs on a candidate that already passed that gate —
// this is a final, defensive re-check, not a new policy.

const timelineStore = require('../timeline-store');
const { createExecutionResult, createDiagnostic } = require('../../schemas/material-execution-schema');

const OBJECT_FIT_VALUES = ['COVER', 'CONTAIN', 'FILL'];

function fail(beat, materialId, code, message, sourceAssetIds = []) {
  return createExecutionResult({
    beatId: beat ? beat.id : null,
    materialId,
    executorType: 'PROJECT_ASSET_REUSE',
    status: 'FAILED',
    renderSpec: null,
    sourceAssetIds,
    diagnostics: [createDiagnostic({ code, message })],
  });
}

// input: { projectId, beat, selectedMaterial, options }
//   selectedMaterial — a Stage 26.3 CandidateResult (materialSource:
//     'PROJECT_ASSET_REUSE', selectedAssetId set)
//   options — { startTime, duration, position: {x,y}, scale, opacity,
//     objectFit, transform, transitionIn, transitionOut }, all optional;
//     startTime/duration default to the beat's own fields when omitted
function execute({ projectId, beat, selectedMaterial, options = {} } = {}) {
  const materialId = selectedMaterial ? selectedMaterial.candidate : null;

  if (!selectedMaterial || !selectedMaterial.selectedAssetId) {
    return fail(beat, materialId, 'MISSING_ASSET_ID', 'selectedMaterial.selectedAssetId is required for PROJECT_ASSET_REUSE execution');
  }

  const assetId = selectedMaterial.selectedAssetId;
  const asset = timelineStore.getAsset(projectId, assetId);
  if (!asset) {
    return fail(beat, materialId, 'ASSET_NOT_FOUND', `no asset found with id "${assetId}" in project "${projectId}"`, [assetId]);
  }
  if (asset.approvalStatus === 'REJECTED') {
    return fail(beat, materialId, 'ASSET_REJECTED', `asset "${assetId}" has been REJECTED and cannot be placed`, [assetId]);
  }
  const storageStatus = asset.storage ? asset.storage.status : 'NOT_ARCHIVED';
  if (storageStatus !== 'STORED') {
    return fail(beat, materialId, 'ASSET_NOT_USABLE', `asset "${assetId}" storage status is "${storageStatus}", not STORED`, [assetId]);
  }

  const startTime = options.startTime !== undefined ? options.startTime : beat && beat.startTime;
  const duration = options.duration !== undefined ? options.duration : beat && beat.duration;
  if (typeof startTime !== 'number' || Number.isNaN(startTime) || startTime < 0) {
    return fail(beat, materialId, 'INVALID_START_TIME', `startTime must be a non-negative number, got ${JSON.stringify(startTime)}`, [assetId]);
  }
  if (typeof duration !== 'number' || Number.isNaN(duration) || duration <= 0) {
    return fail(beat, materialId, 'INVALID_DURATION', `duration must be a positive number, got ${JSON.stringify(duration)}`, [assetId]);
  }

  const objectFit = OBJECT_FIT_VALUES.includes(options.objectFit) ? options.objectFit : 'COVER';

  const renderSpec = {
    type: 'ASSET_PLACEMENT',
    assetId,
    assetType: asset.type,
    startTime,
    duration,
    position: options.position || { x: 0, y: 0 },
    scale: typeof options.scale === 'number' ? options.scale : 1,
    opacity: typeof options.opacity === 'number' ? options.opacity : 1,
    objectFit,
    transform: options.transform || null,
    transitionIn: options.transitionIn || null,
    transitionOut: options.transitionOut || null,
  };

  return createExecutionResult({
    beatId: beat ? beat.id : null,
    materialId,
    executorType: 'PROJECT_ASSET_REUSE',
    status: 'COMPLETED',
    duration,
    renderSpec,
    sourceAssetIds: [assetId],
    diagnostics: [],
  });
}

module.exports = { execute, OBJECT_FIT_VALUES };

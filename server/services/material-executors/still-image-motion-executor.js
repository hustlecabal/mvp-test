// still-image-motion-executor.js
//
// Stage 26.5A — the STILL_IMAGE_MOTION deterministic executor. Turns a
// static image into a deterministic camera-motion instruction set (the Ken
// Burns family) — never AI video generation. Matches
// docs/architecture/stage-26.2-visual-production-master-spec.md, Part 12
// ("Still-Image Motion... a rendering technique applied at compile/render
// time, not a materialSource — the underlying asset is still resolved by
// PROJECT_ASSET_REUSE/GENERATED_NEW... still-image motion is metadata
// attached to how that still gets placed").
//
// Requires a CONCRETE existing image asset — this stage does not implement
// AI image generation, so a beat resolved to STILL_IMAGE via
// materialSource GENERATED_NEW (no asset exists yet) cannot be executed
// here yet; it fails structurally with NO_SOURCE_IMAGE rather than
// inventing a placeholder or silently substituting anything.

const timelineStore = require('../timeline-store');
const { createExecutionResult, createDiagnostic } = require('../../schemas/material-execution-schema');

const STILL_IMAGE_MOTION_KINDS = ['STATIC', 'ZOOM_IN', 'ZOOM_OUT', 'PAN_LEFT', 'PAN_RIGHT', 'PAN_UP', 'PAN_DOWN', 'KEN_BURNS'];

// Fixed, deterministic per-kind transform table — never randomized, never
// derived from anything but the kind itself, so identical input always
// produces an identical transform. Positions are normalized offsets
// (fraction of frame), not pixels — a future renderer maps these onto its
// own resolution.
const MOTION_TRANSFORMS = {
  STATIC: { startScale: 1, endScale: 1, startPosition: { x: 0, y: 0 }, endPosition: { x: 0, y: 0 } },
  ZOOM_IN: { startScale: 1, endScale: 1.15, startPosition: { x: 0, y: 0 }, endPosition: { x: 0, y: 0 } },
  ZOOM_OUT: { startScale: 1.15, endScale: 1, startPosition: { x: 0, y: 0 }, endPosition: { x: 0, y: 0 } },
  PAN_LEFT: { startScale: 1.08, endScale: 1.08, startPosition: { x: 0.05, y: 0 }, endPosition: { x: -0.05, y: 0 } },
  PAN_RIGHT: { startScale: 1.08, endScale: 1.08, startPosition: { x: -0.05, y: 0 }, endPosition: { x: 0.05, y: 0 } },
  PAN_UP: { startScale: 1.08, endScale: 1.08, startPosition: { x: 0, y: 0.05 }, endPosition: { x: 0, y: -0.05 } },
  PAN_DOWN: { startScale: 1.08, endScale: 1.08, startPosition: { x: 0, y: -0.05 }, endPosition: { x: 0, y: 0.05 } },
  KEN_BURNS: { startScale: 1, endScale: 1.12, startPosition: { x: 0.03, y: 0.02 }, endPosition: { x: -0.03, y: -0.02 } },
};

function fail(beat, materialId, code, message, sourceAssetIds = []) {
  return createExecutionResult({
    beatId: beat ? beat.id : null,
    materialId,
    executorType: 'STILL_IMAGE_MOTION',
    status: 'FAILED',
    renderSpec: null,
    sourceAssetIds,
    diagnostics: [createDiagnostic({ code, message })],
  });
}

function isValidPoint(p) {
  return p && typeof p.x === 'number' && typeof p.y === 'number';
}

function isValidTransform(t) {
  return t && typeof t.startScale === 'number' && typeof t.endScale === 'number' && isValidPoint(t.startPosition) && isValidPoint(t.endPosition);
}

// input: { projectId, beat, selectedMaterial, options }
//   options — { motionKind (one of STILL_IMAGE_MOTION_KINDS, default
//     'KEN_BURNS'), transform (optional full manual override, same shape as
//     MOTION_TRANSFORMS entries), duration, fadeIn, fadeOut, easing }
function execute({ projectId, beat, selectedMaterial, options = {} } = {}) {
  const materialId = selectedMaterial ? selectedMaterial.candidate : null;

  if (!selectedMaterial || !selectedMaterial.selectedAssetId) {
    return fail(beat, materialId, 'NO_SOURCE_IMAGE', 'STILL_IMAGE_MOTION requires a concrete existing image asset — AI image generation is not implemented in Stage 26.5A');
  }

  const assetId = selectedMaterial.selectedAssetId;
  const asset = timelineStore.getAsset(projectId, assetId);
  if (!asset) {
    return fail(beat, materialId, 'ASSET_NOT_FOUND', `no asset found with id "${assetId}" in project "${projectId}"`, [assetId]);
  }
  if (asset.approvalStatus === 'REJECTED') {
    return fail(beat, materialId, 'ASSET_REJECTED', `asset "${assetId}" has been REJECTED and cannot be animated`, [assetId]);
  }
  const storageStatus = asset.storage ? asset.storage.status : 'NOT_ARCHIVED';
  if (storageStatus !== 'STORED') {
    return fail(beat, materialId, 'ASSET_NOT_USABLE', `asset "${assetId}" storage status is "${storageStatus}", not STORED`, [assetId]);
  }

  const duration = options.duration !== undefined ? options.duration : beat && beat.duration;
  if (typeof duration !== 'number' || Number.isNaN(duration) || duration <= 0) {
    return fail(beat, materialId, 'INVALID_DURATION', `duration must be a positive number, got ${JSON.stringify(duration)}`, [assetId]);
  }

  let transform;
  if (options.transform !== undefined) {
    if (!isValidTransform(options.transform)) {
      return fail(beat, materialId, 'INVALID_TRANSFORM', 'options.transform must supply numeric startScale/endScale and {x,y} startPosition/endPosition', [assetId]);
    }
    transform = options.transform;
  } else {
    const motionKind = options.motionKind || 'KEN_BURNS';
    if (!STILL_IMAGE_MOTION_KINDS.includes(motionKind)) {
      return fail(beat, materialId, 'INVALID_MOTION_KIND', `motionKind "${motionKind}" is not one of ${STILL_IMAGE_MOTION_KINDS.join(', ')}`, [assetId]);
    }
    transform = MOTION_TRANSFORMS[motionKind];
  }

  const motionKind = options.transform !== undefined ? 'CUSTOM' : options.motionKind || 'KEN_BURNS';

  const renderSpec = {
    type: 'STILL_IMAGE_MOTION',
    assetId,
    motionKind,
    duration,
    startScale: transform.startScale,
    endScale: transform.endScale,
    startPosition: transform.startPosition,
    endPosition: transform.endPosition,
    fadeIn: typeof options.fadeIn === 'number' ? options.fadeIn : 0,
    fadeOut: typeof options.fadeOut === 'number' ? options.fadeOut : 0,
    easing: options.easing || 'EASE_IN_OUT',
  };

  return createExecutionResult({
    beatId: beat ? beat.id : null,
    materialId,
    executorType: 'STILL_IMAGE_MOTION',
    status: 'COMPLETED',
    duration,
    renderSpec,
    sourceAssetIds: [assetId],
    diagnostics: [],
  });
}

module.exports = { execute, STILL_IMAGE_MOTION_KINDS, MOTION_TRANSFORMS };

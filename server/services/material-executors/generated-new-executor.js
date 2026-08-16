// generated-new-executor.js
//
// P0-2 — the GENERATED_NEW -> Pipeline A bridge (see the P0-2 audit,
// docs/architecture/evolink-master-control-quality-blueprint.md's P0
// blocker list, and this session's completed Part 1-11 trace of Pipeline
// A). Registered for TWO executorTypes (GENERATED_NEW_STILL_IMAGE,
// GENERATED_NEW_VIDEO — schemas/material-execution-schema.js), routed by
// services/material-execution-service.js's resolveExecutorType() as a
// specific (materialSource, visualTreatment) pair, checked BEFORE the
// generic STILL_IMAGE rule.
//
// THIS FILE DOES NOT GENERATE ANYTHING. It is a THIN, READ-ONLY BRIDGE:
//   1. look up whether an already-APPROVED, already-STORED generated
//      Asset exists for this beat's shot, via the EXISTING Stage 12/13E
//      (keyframe) / Stage 22B (video) machinery — never a new lookup
//      system, never a new persistence layer.
//   2. if one exists, delegate ALL render-spec construction to the
//      EXISTING executor that already solves "place a real asset"
//      (still-image-motion-executor.js for images, project-asset-reuse-
//      executor.js for video) — zero duplicated placement logic.
//   3. if none exists yet, fail structurally, naming the exact existing
//      tool/step (build a prompt package, request+approve generation,
//      run generate_keyframe/generate_video, approve the result) still
//      required — through Pipeline A's own real UI/MCP/REST surface.
//
// WHY THIS NEVER TRIGGERS GENERATION ITSELF (the one real architectural
// finding this bridge is built around): services/material-execution-
// service.js's executeMaterial() and every existing executor's execute()
// are SYNCHRONOUS — no await, no polling — matching Stage 26.5A's
// established contract exactly. services/keyframe-generation-service.js's
// generateKeyframe() and services/video-generation-service.js's
// generateVideo() are ASYNCHRONOUS, poll a real provider, and in
// production spend real credits. Making Material Execution's executor
// contract async to let this file await a real generation would be a
// genuine change to an interface every other executor relies on —
// exactly the "rewrite Pipeline A" this stage was told to avoid. This
// file stays synchronous and READ-ONLY by design, never a policy gap.
//
// NEVER BYPASSED, because never touched: approval-gate.js's ledger,
// keyframeGenerationApprovalStore/videoGenerationApprovalStore, the
// duplicate-in-flight checks inside generateKeyframe/generateVideo. This
// file calls none of them — it only reads whether their OWN, already-
// proven discipline has already produced an approved asset.
//
// NO PROVIDER CREDENTIALS, NO PROVIDER NAME, NO API KEY anywhere in this
// file — it never imports a provider adapter, never imports
// generation-model-registry.js, never imports approval-gate.js.

const timelineStore = require('../timeline-store');
const keyframeStore = require('../keyframe-store');
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

// Finds a real, already-approved, already-STORED generated KEYFRAME asset
// for this shot, via the EXISTING Stage 13E canonical-keyframe-asset
// mechanism (keyframeStore.getCanonicalKeyframeAsset) — read-only, no new
// lookup system. A shot may have more than one planned Keyframe (Stage
// 12); the first one with a real, usable canonical asset wins — same
// "APPROVED + STORED is the only usable state" rule every other executor
// already applies (project-asset-reuse-executor.js's own gate).
function findApprovedKeyframeAsset(projectId, shotId) {
  const keyframes = keyframeStore.listKeyframes(projectId, { shotId }) || [];
  for (const kf of keyframes) {
    const canonical = keyframeStore.getCanonicalKeyframeAsset(projectId, kf.keyframeId);
    const asset = canonical && canonical.asset;
    if (asset && asset.approvalStatus === 'APPROVED' && asset.storage && asset.storage.status === 'STORED') {
      return asset;
    }
  }
  return null;
}

// Finds a real, already-approved, already-STORED generated VIDEO asset for
// this shot, via the EXISTING timeline-store.js asset listing — read-only,
// no new lookup system. No "canonical video asset" concept exists (Stage
// 13E's canonical selection is an image/keyframe-only concept), so every
// video asset for the shot is considered; the first APPROVED + STORED one
// wins.
function findApprovedVideoAsset(projectId, shotId) {
  const assets = timelineStore.listAssets(projectId, { shotId, type: 'video' }) || [];
  return assets.find((a) => a.approvalStatus === 'APPROVED' && a.storage && a.storage.status === 'STORED') || null;
}

const NEXT_STEP_BY_TREATMENT = {
  STILL_IMAGE:
    'no approved, generated keyframe asset exists yet for this shot. Through the existing Pipeline A flow: create a Keyframe for this shot (create_keyframe), build its prompt package (build_keyframe_prompt_package), request and approve keyframe generation (request_keyframe_generation_approval / approve_keyframe_generation), run generate_keyframe, then approve the result (approve_generated_keyframe) and select it canonical (select_canonical_keyframe_asset).',
  AI_VIDEO:
    'no approved, generated video asset exists yet for this shot. Through the existing Pipeline A flow: ensure a canonical, APPROVED keyframe asset exists for this shot, build a video prompt package (build_video_prompt_package), request and approve video generation (request_video_generation_approval / approve_video_generation), run generate_video, then approve the result (approve_generated_video).',
};

// input: { projectId, beat, selectedMaterial, options }
//   selectedMaterial — a Stage 26.4 CandidateResult (materialSource:
//     'GENERATED_NEW', visualTreatment: 'STILL_IMAGE' | 'AI_VIDEO')
//   options — passed straight through, unchanged, to whichever existing
//     executor this bridge delegates to (see that executor's own header
//     for its accepted shape)
function execute({ projectId, beat, selectedMaterial, options = {} } = {}) {
  const materialId = selectedMaterial ? selectedMaterial.candidate : null;
  const executorType = selectedMaterial && selectedMaterial.visualTreatment === 'AI_VIDEO' ? 'GENERATED_NEW_VIDEO' : 'GENERATED_NEW_STILL_IMAGE';

  if (!selectedMaterial || selectedMaterial.materialSource !== 'GENERATED_NEW') {
    return fail(beat, materialId, executorType, 'INVALID_MATERIAL', 'selectedMaterial must be a GENERATED_NEW candidate');
  }
  if (!['STILL_IMAGE', 'AI_VIDEO'].includes(selectedMaterial.visualTreatment)) {
    return fail(beat, materialId, executorType, 'UNSUPPORTED_TREATMENT', `GENERATED_NEW visualTreatment "${selectedMaterial.visualTreatment}" has no generation-executor mapping — only STILL_IMAGE and AI_VIDEO are supported`);
  }
  if (!beat || !beat.shotId) {
    return fail(beat, materialId, executorType, 'MISSING_SHOT', 'a VisualBeat with a shotId is required to look up an existing generation for this shot — GENERATED_NEW cannot resolve for a beat with no storyboard shot');
  }

  const treatment = selectedMaterial.visualTreatment;
  const asset = treatment === 'AI_VIDEO' ? findApprovedVideoAsset(projectId, beat.shotId) : findApprovedKeyframeAsset(projectId, beat.shotId);

  if (!asset) {
    return fail(beat, materialId, executorType, 'NO_APPROVED_GENERATION_EXISTS', NEXT_STEP_BY_TREATMENT[treatment]);
  }

  const delegate = treatment === 'AI_VIDEO' ? projectAssetReuseExecutor : stillImageMotionExecutor;
  const delegated = delegate.execute({ projectId, beat, selectedMaterial: { ...selectedMaterial, selectedAssetId: asset.assetId }, options });
  // Honest provenance: the placement/motion logic was delegated, but this
  // beat's material genuinely came from a GENERATED_NEW resolution, not a
  // PROJECT_ASSET_REUSE one — never presented as the delegate's own type.
  delegated.executorType = executorType;
  return delegated;
}

module.exports = { execute, findApprovedKeyframeAsset, findApprovedVideoAsset };

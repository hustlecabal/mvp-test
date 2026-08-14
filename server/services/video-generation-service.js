// video-generation-service.js
//
// Stage 22B-Part-3 — the central execution boundary for controlled,
// per-shot VIDEO generation. Mirrors services/keyframe-generation-
// service.js's structure exactly (runSafetyChecks() shared by the
// read-only canGenerateVideo() and the submitting generateVideo(); no
// provider call happens unless every check passes first) but is bound to
// the NEW per-shot pipeline: VideoPromptPackage (services/video-prompt-
// service.js) + VideoGenerationApproval (services/video-generation-
// approval-store.js) + the canonical keyframe asset, never the OLD
// project-level approvals/requestGeneration in services/generation-
// service.js (kept, untouched, as reference material only — see that
// file's own header).
//
// PROVIDER-AGNOSTIC BY DESIGN (Part 8/9): provider/model always come from
// the approved VideoGenerationApproval (which itself was requested off an
// explicit, human-supplied VideoPromptPackage selection) — this file never
// hard-codes Seedance, never prefers EvoLink over Google, and never
// chooses a model. It calls services/generation-model-registry.js only to
// VALIDATE the already-chosen provider/model, exactly like video-prompt-
// service.js's own validateVideoModelSelection (Stage 22B-Part-2) — never
// to pick one. Provider adapters are resolved from an injectable registry
// (PROVIDERS, overridable per call — same pattern as generation-
// service.js's own `providers` parameter) against ../providers/provider-
// interface.js's generic createGeneration/getGenerationStatus/
// getGenerationResult contract, so a future Google adapter plugs in here
// with zero changes to this file.
//
// INPUT IMAGE (Part 11): the canonical keyframe asset is never handed to a
// provider as an internal file path. `resolveReferenceImpl` (injectable,
// defaults to services/evolink-reference-resolver.js's
// resolveReferenceImageUrl — the existing, already-proven upload
// mechanism) turns it into a provider-ready `{ type: 'image', url }`
// reference before a request is ever built. Every test in this stage
// injects a fake resolver instead — see test/video-generation-
// service.test.js — so no test path can ever reach the real EvoLink file
// API.

const projectStore = require('./project-store');
const creativeStore = require('./creative-store');
const keyframeStore = require('./keyframe-store');
const timelineStore = require('./timeline-store');
const videoPromptService = require('./video-prompt-service');
const videoGenerationApprovalStore = require('./video-generation-approval-store');
const keyframeHandoffService = require('./keyframe-handoff-service');
const generationStore = require('./generation-store');
const generationModelRegistry = require('./generation-model-registry');
const gate = require('./approval-gate');
const assetArchiveService = require('./asset-archive-service');
const evolinkProvider = require('../providers/evolink/evolink-provider');
const evolinkReferenceResolver = require('./evolink-reference-resolver');
const { createVideoGenerationResult } = require('../schemas/video-generation-result-schema');

// The provider registry. Only "evolink" is wired in for real use — adding
// Google later means adding an entry here, not changing anything above
// this file (Part 9/10). Overridable per call so tests can register a
// separate, non-production entry (providers/fake-video/fake-video-
// provider.js) without this file ever knowing a fake provider exists.
const PROVIDERS = { evolink: evolinkProvider };

function resolveProvider(providerName, providers) {
  return providers[providerName] || null;
}

// Same generic in-flight vocabulary provider-interface.js already defines
// (GENERATION_STATUSES), reused by name rather than reinventing
// "SUBMITTING"/"IN_PROGRESS" — see provider-interface.js's own
// GENERATION_STATUSES for the full set this codebase already uses
// everywhere else a generation job's status is read.
const ACTIVE_VIDEO_GENERATION_STATUSES = ['REQUESTED', 'SUBMITTED', 'PROCESSING'];

// Same ACTIVE_HANDOFF_STATUSES vocabulary services/keyframe-handoff-
// service.js and services/operator-queue-service.js already use, reused
// here (not reimplemented) for check #21.
const ACTIVE_HANDOFF_STATUSES = ['READY', 'IN_PROGRESS'];

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ===========================================================================
// Part 13 — budget check. Mirrors keyframe-generation-service.js's
// checkKeyframeBudget() exactly, but reads a VideoGenerationApproval
// instead of a KeyframeGenerationApproval. Reuses approval-gate.js's
// getRemainingBudget/UNKNOWN_COST_POLICY — no second credit ledger.
// ===========================================================================
function checkVideoBudget(project, approval) {
  gate.ensureShape(project);

  if (project.creditLedger.blocked) {
    return { ok: false, code: 'BUDGET_BLOCKED', reason: project.creditLedger.blockedReason || 'Project is blocked pending resolution of a budget overage.' };
  }

  if (approval.estimatedCost == null && !approval.unknownCostAcknowledged) {
    return {
      ok: false,
      code: 'UNKNOWN_COST_NOT_ACKNOWLEDGED',
      reason:
        `Estimated cost is unknown and has not been explicitly acknowledged by a human (policy: ${gate.UNKNOWN_COST_POLICY}). ` +
        'Acknowledge the unknown cost, or request the approval again with an estimatedCost, before generation can proceed.',
    };
  }

  const estimatedCost = approval.estimatedCost || 0;
  const remaining = gate.getRemainingBudget(project);
  if (remaining != null && estimatedCost > remaining) {
    return { ok: false, code: 'BUDGET_BLOCKED', reason: 'Approved video generation cost would exceed the remaining project budget.' };
  }

  return { ok: true };
}

// ===========================================================================
// Part 7 — duplicate protection. Never two ACTIVE video generations for
// the same project + shot + videoPromptPackageId + videoPromptPackageVersion
// + canonicalKeyframeAssetId. A completed/failed/cancelled/timed-out job
// never permanently blocks a later authorized generation — only jobs in
// ACTIVE_VIDEO_GENERATION_STATUSES count. Never deletes old jobs.
// ===========================================================================
function findActiveDuplicate(projectId, shotId, videoPromptPackageId, videoPromptPackageVersion, canonicalKeyframeAssetId) {
  return (
    generationStore
      .listGenerationJobs({ projectId, shotId })
      .find(
        (job) =>
          job.generationType === 'VIDEO' &&
          job.videoPromptPackageId === videoPromptPackageId &&
          job.videoPromptPackageVersion === videoPromptPackageVersion &&
          job.canonicalKeyframeAssetId === canonicalKeyframeAssetId &&
          ACTIVE_VIDEO_GENERATION_STATUSES.includes(job.status)
      ) || null
  );
}

// ===========================================================================
// Part 6/8/9/11 — the full eligibility check, steps 1-23. Shared by
// canGenerateVideo() (stops here) and generateVideo() (continues to
// submission only if every step passes). NEVER throws for an ordinary
// eligibility failure — always returns a structured { ok: false, code,
// reason }. NO PROVIDER CALL happens anywhere in this function.
// ===========================================================================
function runSafetyChecks(projectId, keyframeId, { providers = PROVIDERS } = {}) {
  // 1. project exists
  const project = projectStore.getProject(projectId);
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND', reason: `No project found with id "${projectId}".` };

  const keyframe = keyframeStore.getKeyframe(projectId, keyframeId);
  if (!keyframe) return { ok: false, code: 'PROJECT_NOT_FOUND', reason: `No keyframe found with id "${keyframeId}" in project "${projectId}".` };

  // 2. shot exists
  const storyboard = creativeStore.getStoryboard(projectId);
  const shot = storyboard ? storyboard.shots.find((s) => s.shotId === keyframe.shotId) : null;
  if (!shot) return { ok: false, code: 'SHOT_NOT_FOUND', reason: `No storyboard shot found with id "${keyframe.shotId}".` };

  // 3/4. video prompt package exists and is CURRENT
  const pkg = videoPromptService.getVideoPromptPackage(projectId, keyframeId);
  if (!pkg) {
    return { ok: false, code: 'NO_VIDEO_PROMPT_PACKAGE', reason: 'No video prompt package has been built for this keyframe yet. Call build_video_prompt_package first.' };
  }
  if (pkg.status !== 'CURRENT') {
    return { ok: false, code: 'VIDEO_PACKAGE_STALE', reason: 'The video prompt package is STALE — rebuild it (build_video_prompt_package) before generating.' };
  }

  // 5/6. approval exists and is APPROVED
  const approval = videoGenerationApprovalStore.getApproval(projectId, keyframeId);
  if (!approval || approval.status !== 'APPROVED') {
    return {
      ok: false,
      code: 'NO_VIDEO_GENERATION_APPROVAL',
      reason: 'No explicit APPROVED video generation approval. Building a video prompt package is not sufficient authorization — request_video_generation_approval and approve_video_generation are required first.',
    };
  }

  // 7/8. approval binds to the exact package id + version
  if (approval.videoPromptPackageId !== pkg.packageId || approval.videoPromptPackageVersion !== pkg.version) {
    return {
      ok: false,
      code: 'APPROVAL_PACKAGE_MISMATCH',
      reason: `The generation approval was granted for video prompt package version ${approval.videoPromptPackageVersion}, but the current package is version ${pkg.version}. Request and approve generation again for the current package.`,
    };
  }

  // 9. approval binds to the exact canonical keyframe asset
  if (approval.canonicalKeyframeAssetId !== pkg.canonicalKeyframeAssetId) {
    return {
      ok: false,
      code: 'APPROVAL_CANONICAL_ASSET_MISMATCH',
      reason: 'The canonical keyframe asset has changed since this approval was granted. Request and approve generation again for the current canonical asset.',
    };
  }

  // 10/11. canonical keyframe asset is still APPROVED and still belongs to this keyframe
  const canonicalAsset = timelineStore.getAsset(projectId, pkg.canonicalKeyframeAssetId);
  if (!canonicalAsset || canonicalAsset.keyframeId !== keyframeId) {
    return { ok: false, code: 'CANONICAL_ASSET_NOT_ASSOCIATED', reason: 'The canonical keyframe asset no longer exists or no longer belongs to this keyframe.' };
  }
  if (canonicalAsset.approvalStatus !== 'APPROVED') {
    return { ok: false, code: 'CANONICAL_ASSET_NOT_APPROVED', reason: `The canonical keyframe asset is no longer APPROVED (status: ${canonicalAsset.approvalStatus}).` };
  }

  // 12/13. provider/model match the approval exactly (never re-selected here)
  if (pkg.provider !== approval.provider) {
    return { ok: false, code: 'APPROVAL_PROVIDER_MISMATCH', reason: `The video prompt package's provider ("${pkg.provider}") no longer matches the approved provider ("${approval.provider}").` };
  }
  if (pkg.model !== approval.model) {
    return { ok: false, code: 'APPROVAL_MODEL_MISMATCH', reason: `The video prompt package's model ("${pkg.model}") no longer matches the approved model ("${approval.model}").` };
  }

  // 14/15/16/17. registry validation — existence, capability, verification snapshot
  const modelEntry = generationModelRegistry.getModel(pkg.provider, pkg.model);
  if (!modelEntry) {
    return { ok: false, code: 'UNKNOWN_MODEL', reason: `No registry entry for provider "${pkg.provider}" model "${pkg.model}".` };
  }
  const capableAsImageToVideo = generationModelRegistry.isModelCapable(pkg.provider, pkg.model, { modality: 'video', imageToVideo: true });
  const capableAsReferenceToVideo = generationModelRegistry.isModelCapable(pkg.provider, pkg.model, { modality: 'video', referenceImages: true });
  if (!capableAsImageToVideo && !capableAsReferenceToVideo) {
    return {
      ok: false,
      code: 'MODEL_CAPABILITY_UNSUPPORTED',
      reason: `Model "${pkg.provider}/${pkg.model}" supports neither imageToVideo nor referenceImages — it cannot accept the canonical keyframe asset as input.`,
    };
  }
  if (!pkg.modelVerification || !pkg.modelVerification.verificationStatus) {
    return { ok: false, code: 'MODEL_VERIFICATION_MISSING', reason: 'The video prompt package has no recorded model verification status.' };
  }

  // 18/19. budget
  const budgetCheck = checkVideoBudget(project, approval);
  if (!budgetCheck.ok) return budgetCheck;

  // 20. duplicate protection
  const duplicate = findActiveDuplicate(projectId, keyframe.shotId, pkg.packageId, pkg.version, pkg.canonicalKeyframeAssetId);

  // 21. no concurrent handoff conflict — an active keyframe execution
  // handoff (Stage 13D) could still replace this keyframe's canonical
  // asset out from under an in-flight video generation.
  const activeHandoff = (keyframeHandoffService.listHandoffs(projectId, { keyframeId }) || []).find((h) => ACTIVE_HANDOFF_STATUSES.includes(h.status));
  if (activeHandoff && !duplicate) {
    return { ok: false, code: 'HANDOFF_CONFLICT', reason: `An active keyframe execution handoff ("${activeHandoff.handoffId}") exists for this keyframe's canonical asset.` };
  }

  // 22. provider adapter exists
  const providerAdapter = resolveProvider(pkg.provider, providers);
  if (!providerAdapter) {
    return { ok: false, code: 'PROVIDER_ADAPTER_NOT_FOUND', reason: `No provider adapter registered for "${pkg.provider}".` };
  }

  // 23. execution parameters are structurally valid (provider-specific
  // limits belong in that provider's own mapper, not here)
  const exec = pkg.executionParameters || {};
  if (exec.duration != null && (typeof exec.duration !== 'number' || exec.duration <= 0)) {
    return { ok: false, code: 'INVALID_EXECUTION_PARAMETERS', reason: 'executionParameters.duration must be a positive number when set.' };
  }
  if (exec.fps != null && (typeof exec.fps !== 'number' || exec.fps <= 0)) {
    return { ok: false, code: 'INVALID_EXECUTION_PARAMETERS', reason: 'executionParameters.fps must be a positive number when set.' };
  }

  return { ok: true, project, keyframe, shot, pkg, approval, canonicalAsset, providerAdapter, duplicate };
}

// Read-only: reports whether generateVideo() would currently be allowed,
// without submitting anything or creating a job. Never calls a provider.
function canGenerateVideo(projectId, keyframeId, options = {}) {
  const checks = runSafetyChecks(projectId, keyframeId, options);
  if (!checks.ok) return { allowed: false, code: checks.code, reason: checks.reason };
  return {
    allowed: true,
    reason: null,
    videoPromptPackageId: checks.pkg.packageId,
    videoPromptPackageVersion: checks.pkg.version,
    canonicalKeyframeAssetId: checks.pkg.canonicalKeyframeAssetId,
    provider: checks.pkg.provider,
    model: checks.pkg.model,
    duplicateGenerationId: checks.duplicate ? checks.duplicate.id : null,
  };
}

function listVideoGenerations(projectId, keyframeId) {
  return generationStore
    .listGenerationJobs({ projectId })
    .filter((job) => job.generationType === 'VIDEO' && job.keyframeId === keyframeId)
    .map((job) => ({ ...job, asset: job.assetId ? timelineStore.getAsset(projectId, job.assetId) : null }));
}

function getVideoGenerationStatus(generationId) {
  const job = generationStore.getGenerationJob(generationId);
  if (!job) return null;
  return normalizeJobToResult(job);
}

// Part 15 — maps a raw generation job onto the normalized
// VideoGenerationResult vocabulary (BLOCKED/IN_PROGRESS/COMPLETED/FAILED).
// A job that reached this function always already passed eligibility once
// (it only exists because generateVideo() created it), so BLOCKED never
// appears here — it is reserved for canGenerateVideo()'s own diagnostic.
function normalizeJobToResult(job) {
  let status = 'IN_PROGRESS';
  if (job.status === 'COMPLETED') status = 'COMPLETED';
  else if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(job.status)) status = 'FAILED';

  return createVideoGenerationResult({
    generationId: job.id,
    projectId: job.projectId,
    sceneId: job.sceneId,
    shotId: job.shotId,
    keyframeId: job.keyframeId,
    videoPromptPackageId: job.videoPromptPackageId,
    videoPromptPackageVersion: job.videoPromptPackageVersion,
    canonicalKeyframeAssetId: job.canonicalKeyframeAssetId || null,
    provider: job.provider,
    model: job.model,
    providerTaskId: job.providerTaskId,
    status,
    assetId: job.assetId || null,
    reservedCost: job.reservedCost,
    actualCost: job.actualCost,
    error: job.error || null,
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VIDEO_POLL_INTERVAL_MS = Number(process.env.VIDEO_GENERATION_POLL_INTERVAL_MS) || 500;
const VIDEO_POLL_MAX_ATTEMPTS = Number(process.env.VIDEO_GENERATION_POLL_MAX_ATTEMPTS) || 5;

// ===========================================================================
// Part 14 — the full submission sequence. Returns a normalized
// VideoGenerationResult. NO AUTOMATIC RETRY, NO FALLBACK PROVIDER, NO
// FALLBACK MODEL, NO ALTERNATE ASSET, NO AUTOMATIC APPROVAL, NO AUTOMATIC
// CANONICAL SELECTION anywhere in this function.
// ===========================================================================
async function generateVideo(
  projectId,
  keyframeId,
  {
    providers = PROVIDERS,
    // Part 11 — turns the canonical keyframe asset into a provider-ready
    // reference. Defaults to the real, already-proven EvoLink upload
    // mechanism for production use; EVERY test in this stage injects its
    // own fake resolver so no test path ever reaches the network.
    resolveReferenceImpl = evolinkReferenceResolver.resolveReferenceImageUrl,
    intervalMs = VIDEO_POLL_INTERVAL_MS,
    maxAttempts = VIDEO_POLL_MAX_ATTEMPTS,
    sleepImpl = defaultSleep,
  } = {}
) {
  const checks = runSafetyChecks(projectId, keyframeId, { providers });
  if (!checks.ok) {
    return createVideoGenerationResult({ projectId, keyframeId, status: 'BLOCKED', code: checks.code, reason: checks.reason });
  }
  if (checks.duplicate) {
    return normalizeJobToResult(checks.duplicate);
  }

  const { project, keyframe, pkg, approval, canonicalAsset, providerAdapter } = checks;

  // Part 11 — resolve the canonical asset into a provider-ready reference
  // BEFORE creating a job or calling the provider. Never exposes the
  // local storage path to the provider adapter.
  let reference;
  try {
    reference = await resolveReferenceImpl(projectId, canonicalAsset.assetId);
  } catch (err) {
    return createVideoGenerationResult({ projectId, keyframeId, status: 'BLOCKED', code: 'REFERENCE_RESOLUTION_FAILED', reason: `Failed to resolve the canonical keyframe asset into a provider-ready reference: ${err.message}` });
  }
  if (!reference || !reference.ok) {
    return createVideoGenerationResult({
      projectId,
      keyframeId,
      status: 'BLOCKED',
      code: 'REFERENCE_RESOLUTION_FAILED',
      reason: (reference && reference.reason) || 'The canonical keyframe asset could not be resolved into a provider-ready reference.',
    });
  }

  const genericRequest = {
    provider: pkg.provider,
    model: pkg.model,
    task: pkg.model,
    prompt: pkg.prompt,
    references: [{ type: 'image', url: reference.url, assetId: canonicalAsset.assetId }],
    parameters: { ...(pkg.executionParameters || {}) },
  };

  // Create and persist the job BEFORE calling the provider (Part 14, step
  // 7), exactly like generation-service.js/keyframe-generation-service.js
  // both already do.
  let job = generationStore.createGenerationJob({
    projectId,
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    keyframeId,
    videoPromptPackageId: pkg.packageId,
    videoPromptPackageVersion: pkg.version,
    canonicalKeyframeAssetId: pkg.canonicalKeyframeAssetId,
    generationType: 'VIDEO',
    provider: pkg.provider,
    model: pkg.model,
    task: pkg.model,
    prompt: pkg.prompt,
    references: genericRequest.references,
    parameters: genericRequest.parameters,
    status: 'REQUESTED',
    estimatedCost: approval.estimatedCost,
  });

  let providerStatus;
  try {
    providerStatus = await providerAdapter.createGeneration(genericRequest);
  } catch (err) {
    job = generationStore.updateGenerationJob(job.id, { status: 'FAILED', error: { message: err.message }, failedAt: new Date().toISOString() });
    return normalizeJobToResult(job);
  }

  job = generationStore.updateGenerationJob(job.id, {
    providerTaskId: providerStatus.generationId,
    status: providerStatus.status,
    progress: providerStatus.progress,
    reservedCost: providerStatus.reservedCost,
    submittedAt: new Date().toISOString(),
  });
  gate.reconcileGenerationCost(project, job);
  projectStore.touch(project);

  // Part 14, step 11 — poll to completion. Same shape as keyframe-
  // generation-service.js's own local polling loop.
  for (let attempt = 1; attempt <= maxAttempts && ACTIVE_VIDEO_GENERATION_STATUSES.includes(job.status); attempt++) {
    let checkStatus;
    try {
      checkStatus = await providerAdapter.getGenerationStatus(job.providerTaskId);
    } catch (err) {
      job = generationStore.updateGenerationJob(job.id, { lastPollError: { message: err.message, occurredAt: new Date().toISOString() } });
      if (attempt < maxAttempts) await sleepImpl(intervalMs);
      continue;
    }

    const updates = {
      status: checkStatus.status,
      progress: checkStatus.progress,
      reservedCost: checkStatus.reservedCost !== null ? checkStatus.reservedCost : job.reservedCost,
      lastPollError: null,
    };
    if (checkStatus.status === 'COMPLETED') {
      updates.result = { results: checkStatus.results };
      updates.completedAt = new Date().toISOString();
    } else if (checkStatus.status === 'FAILED') {
      updates.error = checkStatus.error;
      updates.failedAt = new Date().toISOString();
    }
    job = generationStore.updateGenerationJob(job.id, updates);
    gate.reconcileGenerationCost(project, job);
    projectStore.touch(project);

    if (ACTIVE_VIDEO_GENERATION_STATUSES.includes(job.status) && attempt < maxAttempts) {
      await sleepImpl(intervalMs);
    }
  }

  if (ACTIVE_VIDEO_GENERATION_STATUSES.includes(job.status)) {
    job = generationStore.updateGenerationJob(job.id, { status: 'TIMED_OUT', timedOutAt: new Date().toISOString() });
    return normalizeJobToResult(job);
  }

  if (job.status === 'FAILED') {
    return normalizeJobToResult(job);
  }

  // Part 14, steps 12-14 — completed: create the asset (Part 16 lineage),
  // archive it, reconcile final cost. The asset's own approvalStatus
  // starts at 'NONE' (production-schema.js's default) — never
  // automatically approved or canonical (Part 16).
  const resultUrl = (job.result && job.result.results && job.result.results[0]) || null;
  const asset = timelineStore.addAsset(projectId, {
    type: 'video',
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    keyframeId,
    generationType: 'VIDEO',
    videoPromptPackageId: pkg.packageId,
    videoPromptPackageVersion: pkg.version,
    prompt: pkg.prompt,
    references: genericRequest.references,
    provider: pkg.provider,
    model: pkg.model,
    generationId: job.id,
    url: resultUrl,
  });

  const fakeFetchImpl = providerAdapter.fakeFetchImpl; // only ever set by a TEST-only provider (e.g. fake-video)
  await assetArchiveService.archiveGenerationAsset(asset.assetId, { fetchImpl: fakeFetchImpl });

  job = generationStore.updateGenerationJob(job.id, { assetId: asset.assetId });

  return normalizeJobToResult(job);
}

module.exports = {
  PROVIDERS,
  ACTIVE_VIDEO_GENERATION_STATUSES,
  canGenerateVideo,
  generateVideo,
  getVideoGenerationStatus,
  listVideoGenerations,
  // exported for focused unit testing
  runSafetyChecks,
  checkVideoBudget,
  findActiveDuplicate,
  normalizeJobToResult,
};

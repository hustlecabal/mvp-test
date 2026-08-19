// keyframe-generation-service.js
//
// Stage 13B, Part 4 — the ONLY place that orchestrates a controlled
// keyframe IMAGE generation: load the keyframe and its prompt package,
// confirm every safety check passes, create ONE generation job, call the
// configured image provider, poll it to completion, archive the result,
// attach it to the keyframe, and mark the keyframe GENERATED.
//
// IF ANY PRE-GENERATION CHECK FAILS: NO PROVIDER CALL. Every check in
// runSafetyChecks() below runs and is verified BEFORE
// providerAdapter.createImageGeneration() is ever reached.
//
// Reuses the existing generation-job infrastructure wherever possible:
// services/generation-store.js (the same JSON-per-job persistence video
// generations use — this file adds no second job store), the shared
// project credit ledger via services/approval-gate.js's read-only
// getRemainingBudget/reconcileGenerationCost/UNKNOWN_COST_POLICY, and
// services/timeline-store.js/asset-archive-service.js for asset creation
// and archiving (identical to how a completed video generation's asset is
// created and archived). It never modifies, and never calls the
// video-specific requestGeneration()/checkGenerationOnce() in
// services/generation-service.js — this keeps video generation completely
// unaffected by this stage. The only thing imported from that file is its
// IN_FLIGHT_STATUSES constant, reused as-is.
//
// The actual approval this file checks is KEYFRAME_GENERATION_APPROVAL
// (services/keyframe-generation-approval-store.js) — NEVER a project's own
// approvals.status. Approving a storyboard, a keyframe plan, or a prompt
// package is explicitly NOT sufficient authorization here (Stage 13B,
// Part 5).

const projectStore = require('./project-store');
const timelineStore = require('./timeline-store');
const keyframeStore = require('./keyframe-store');
const keyframePromptService = require('./keyframe-prompt-service');
const keyframeGenerationApprovalStore = require('./keyframe-generation-approval-store');
const generationStore = require('./generation-store');
const gate = require('./approval-gate');
const recoveryService = require('./generation-recovery-service');
const controlPlane = require('./control-plane-service');
const assetArchiveService = require('./asset-archive-service');
const { FakeImageGenerationExecutor } = require('./image-generation-executor');
const fakeImageProvider = require('../providers/fake-image/fake-image-provider');
const evolinkImageProvider = require('../providers/evolink/evolink-image-provider');
// Read-only reuse of the existing in-flight vocabulary — never calls
// anything else exported by generation-service.js (see file header).
const { IN_FLIGHT_STATUSES } = require('./generation-service');

// The image-provider registry. Stage 13B, Part 10 stopped at "fake-image"
// only, until a real provider's API had been independently verified from
// primary documentation and connecting it was explicitly authorized. Stage
// 15 (docs/integrations/image-provider-investigation.md) did that
// verification; Stage 16 adds "evolink-image" here as a result.
//
// DEFAULT_PROVIDER_NAME stays "fake-image" — connecting a real provider
// does not change what every existing MCP/REST caller gets by default
// (they never pass providerName). A caller must explicitly opt in to
// "evolink-image" to ever reach the real EvoLink API, exactly like Stage
// 13B's original design intended for whenever this day came.
const IMAGE_PROVIDERS = { 'fake-image': fakeImageProvider, 'evolink-image': evolinkImageProvider };
const DEFAULT_PROVIDER_NAME = 'fake-image';

const KEYFRAME_POLL_INTERVAL_MS = Number(process.env.KEYFRAME_GENERATION_POLL_INTERVAL_MS) || 500;
const KEYFRAME_POLL_MAX_ATTEMPTS = Number(process.env.KEYFRAME_GENERATION_POLL_MAX_ATTEMPTS) || 5;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveProvider(providerName, providers) {
  const adapter = providers[providerName];
  if (!adapter) {
    throw new Error(`Unknown image provider "${providerName}". Supported providers: ${Object.keys(providers).join(', ')}`);
  }
  return adapter;
}

// Part 6 — mirrors approval-gate.js's canProceed() unknown-cost/remaining-
// budget logic exactly, but reads the KEYFRAME's own approval object
// (never project.approvals) for the estimated cost, and reads the
// project's SHARED credit ledger (services/approval-gate.js) for what's
// already reserved — Part 6: "check project budget + existing reserved
// cost + estimated keyframe cost", the same ledger every video generation
// already reconciles into.
function checkKeyframeBudget(project, approval) {
  gate.ensureShape(project);

  if (project.creditLedger.blocked) {
    return { allowed: false, reason: project.creditLedger.blockedReason || 'Project is blocked pending resolution of a budget overage.' };
  }

  if (approval.estimatedCost == null && !approval.unknownCostAcknowledged) {
    return {
      allowed: false,
      reason:
        `Estimated cost is unknown and has not been explicitly acknowledged by a human (policy: ${gate.UNKNOWN_COST_POLICY}). ` +
        'Call acknowledge_unknown_keyframe_cost (or request the approval again with an estimatedCost) before generation can proceed.',
    };
  }

  const estimatedCost = approval.estimatedCost || 0;
  const remaining = gate.getRemainingBudget(project);
  if (remaining != null && estimatedCost > remaining) {
    return { allowed: false, reason: 'Approved keyframe generation cost would exceed the remaining project budget.' };
  }

  return { allowed: true, reason: null };
}

// Part 7 — an identical in-flight generation for this exact
// (projectId, keyframeId, promptPackageVersion). A completed/failed/
// timed-out job is NOT in flight, so a fresh explicit generate_keyframe
// call after one of those always creates a new attempt — never silently
// blocked, and never silently deduplicated against old history.
function findInFlightDuplicate(projectId, keyframeId, promptPackageVersion) {
  return (
    generationStore
      .listGenerationJobs({ projectId })
      .find(
        (job) =>
          job.keyframeId === keyframeId &&
          job.keyframePromptPackageVersion === promptPackageVersion &&
          IN_FLIGHT_STATUSES.includes(job.status)
      ) || null
  );
}

// P0-HARDENING-2, Part 10 — same match as findInFlightDuplicate, but for a
// TIMED_OUT job. See generation-service.js's findStaleTimedOutDuplicate for
// the full rationale — a TIMED_OUT job must have its provider outcome
// resolved before generateKeyframe() treats "the old attempt is gone" as
// true.
function findStaleTimedOutDuplicate(projectId, keyframeId, promptPackageVersion) {
  return (
    generationStore
      .listGenerationJobs({ projectId })
      .find((job) => job.keyframeId === keyframeId && job.keyframePromptPackageVersion === promptPackageVersion && job.status === 'TIMED_OUT') || null
  );
}

// Runs every check EXCEPT actually calling a provider (Part 4, steps
// 1-6 + Part 7's dedup check). Shared by canGenerateKeyframe() (read-only)
// and generateKeyframe() (which continues only if these all pass).
function runSafetyChecks(projectId, keyframeId) {
  const project = projectStore.getProject(projectId);
  if (!project) return { ok: false, reason: `No project found with id "${projectId}"` };

  const keyframe = keyframeStore.getKeyframe(projectId, keyframeId);
  if (!keyframe) return { ok: false, reason: `No keyframe found with id "${keyframeId}" in project "${projectId}"` };

  // INT-2.5-P0 — the strategic-layer enforcement point: no paid production
  // without an APPROVED CreativeBlueprint and an ACCEPTED/OVERRIDDEN
  // pre-production gate result (see control-plane-service.js). This file
  // never checks the project-level state machine at all (see this file's
  // own header — approval here comes from KEYFRAME_GENERATION_APPROVAL,
  // not project.status), so without this explicit check a caller could
  // reach real EvoLink image generation having skipped the Blueprint/Gate
  // layer entirely, even if state-machine.js's own transition() enforced
  // it perfectly.
  const prerequisites = controlPlane.validateProductionPrerequisites(projectId);
  if (!prerequisites.ok) {
    return { ok: false, reason: `Blocked by strategic-layer prerequisite (${prerequisites.code}): ${prerequisites.reason}` };
  }

  // Part 4, step 4 — "confirm the keyframe is eligible": the keyframe
  // exists (checked above) and is a real target for generation — nothing
  // about its own status (including GENERATING) hard-blocks a request
  // here. A keyframe genuinely already mid-generation is instead handled
  // gracefully by Part 7's in-flight duplicate check below, which returns
  // the EXISTING job rather than an error — exactly what Part 7 asks for
  // ("return the existing generation job... do not submit a second
  // provider request"), and the only correct behavior for two concurrent
  // requests racing each other.

  const pkg = keyframePromptService.getKeyframePromptPackage(projectId, keyframeId);
  if (!pkg) {
    return { ok: false, reason: 'No prompt package has been built for this keyframe yet. Call build_keyframe_prompt_package first.' };
  }
  if (pkg.status !== 'CURRENT') {
    return { ok: false, reason: 'The prompt package is STALE — rebuild it (build_keyframe_prompt_package) before generating.' };
  }

  const approval = keyframeGenerationApprovalStore.getApproval(projectId, keyframeId);
  if (approval.status !== 'APPROVED') {
    return {
      ok: false,
      reason: 'No explicit keyframe generation approval. Storyboard, keyframe plan, and prompt package approval are not sufficient — request_keyframe_generation_approval and approve_keyframe_generation are required first.',
    };
  }
  if (approval.promptPackageId !== pkg.packageId || approval.promptPackageVersion !== pkg.version) {
    return {
      ok: false,
      reason: `The generation approval was granted for prompt package version ${approval.promptPackageVersion}, but the current package is version ${pkg.version}. Request and approve generation again for the current package.`,
    };
  }

  const budgetCheck = checkKeyframeBudget(project, approval);
  if (!budgetCheck.allowed) {
    return { ok: false, reason: `Blocked by budget: ${budgetCheck.reason}` };
  }

  const duplicate = findInFlightDuplicate(projectId, keyframeId, pkg.version);
  if (duplicate) {
    return { ok: true, project, keyframe, pkg, approval, duplicate };
  }

  return { ok: true, project, keyframe, pkg, approval };
}

// Read-only: reports whether generate_keyframe would currently be
// allowed, without submitting anything or creating a job. Used by the
// REST/MCP/UI layers to decide whether to enable the GENERATE button
// (Part 14).
function canGenerateKeyframe(projectId, keyframeId) {
  const checks = runSafetyChecks(projectId, keyframeId);
  if (!checks.ok) return { allowed: false, reason: checks.reason };
  return { allowed: true, reason: null, promptPackageVersion: checks.pkg.version, approval: checks.approval };
}

// Enriches each job with its resulting asset (approvalStatus, storage
// status, etc.) inline, so a caller (the Creative Director UI, or Claude
// Code via list_keyframe_generations) never needs a second round-trip
// just to know whether a completed generation still needs human review.
// Read-only — never creates or modifies anything.
function listKeyframeGenerations(projectId, keyframeId) {
  return generationStore
    .listGenerationJobs({ projectId })
    .filter((job) => job.keyframeId === keyframeId)
    .map((job) => ({ ...job, asset: job.assetId ? timelineStore.getAsset(projectId, job.assetId) : null }));
}

// Part 4 — the full 14-step orchestration. Returns { ok, job, asset? }
// on success (including the "returned the existing in-flight job instead
// of submitting a duplicate" case — Part 7), or { ok: false, reason } if
// any pre-generation check failed. NO PROVIDER CALL happens in the
// `ok: false` path.
async function generateKeyframe(
  projectId,
  keyframeId,
  {
    providers = IMAGE_PROVIDERS,
    providerName = DEFAULT_PROVIDER_NAME,
    // Stage 16, Part 4 — passed straight through to
    // buildNormalizedImageRequest()'s `parameters`, unchanged from before
    // for any caller that doesn't supply it (defaults to {}, exactly the
    // prior behavior). A real-provider caller uses this to supply
    // provider-relevant values like { model, size, quality,
    // referenceImageUrls } — see evolink-image-mapper.js.
    imageParameters = {},
    intervalMs = KEYFRAME_POLL_INTERVAL_MS,
    maxAttempts = KEYFRAME_POLL_MAX_ATTEMPTS,
    sleepImpl = defaultSleep,
  } = {}
) {
  const checks = runSafetyChecks(projectId, keyframeId);
  if (!checks.ok) {
    return { ok: false, reason: checks.reason };
  }
  if (checks.duplicate) {
    return { ok: true, job: checks.duplicate, deduplicated: true };
  }

  const { keyframe, pkg, approval } = checks;

  let providerAdapter;
  try {
    providerAdapter = resolveProvider(providerName, providers);
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  // P0-HARDENING-2, Part 10 — resolve a stale TIMED_OUT attempt for this
  // exact keyframe/package version before allowing a new one.
  const staleJob = findStaleTimedOutDuplicate(projectId, keyframeId, pkg.version);
  if (staleJob) {
    const recovery = await recoveryService.classifyJobRecovery(staleJob, providerAdapter);

    if (recovery.classification === 'ALREADY_COMPLETED') {
      const updatedJob = generationStore.updateGenerationJob(staleJob.id, {
        status: 'COMPLETED',
        progress: recovery.providerStatus.progress,
        reservedCost: recovery.providerStatus.reservedCost !== null ? recovery.providerStatus.reservedCost : staleJob.reservedCost,
        result: { results: recovery.providerStatus.results },
        completedAt: new Date().toISOString(),
      });
      await gate.settleGenerationCost(projectId, updatedJob);
      return { ok: true, job: updatedJob, deduplicated: true, recovery: recovery.classification };
    }

    if (recovery.classification === 'PROVIDER_OUTCOME_UNKNOWN') {
      return { ok: false, reason: `Cannot safely retry: ${recovery.reason}`, job: staleJob, recovery: recovery.classification };
    }

    if (recovery.classification === 'FAILED_CONFIRMED') {
      await gate.releaseReservation(projectId, {
        jobId: staleJob.id,
        provider: staleJob.provider,
        currency: 'credits',
        note: 'Provider confirmed failure for a previously TIMED_OUT job; releasing before allowing a new attempt.',
      });
      generationStore.updateGenerationJob(staleJob.id, {
        status: 'FAILED',
        error: (recovery.providerStatus && recovery.providerStatus.error) || { message: 'Provider confirmed failure after a local timeout.' },
        failedAt: new Date().toISOString(),
      });
    }
    // FAILED_CONFIRMED and SAFE_TO_RETRY both fall through to submit a
    // genuinely new request below.
  }

  const normalizedRequest = FakeImageGenerationExecutor.buildRequest(pkg, { parameters: imageParameters });

  // Create and persist the job BEFORE calling the provider (Part 1/4),
  // exactly like generation-service.js's requestGeneration does for video.
  let job = generationStore.createGenerationJob({
    projectId,
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    keyframeId,
    keyframePromptPackageId: pkg.packageId,
    keyframePromptPackageVersion: pkg.version,
    generationType: 'IMAGE_KEYFRAME',
    provider: providerName,
    model: null,
    task: 'image-keyframe-generation',
    prompt: pkg.prompt,
    references: normalizedRequest.referenceAssets,
    parameters: normalizedRequest.parameters,
    status: 'REQUESTED',
    estimatedCost: approval.estimatedCost,
  });

  // P0-HARDENING-2, Part 5/6/8 — reserve budget atomically BEFORE the
  // provider call, exactly like generation-service.js's requestGeneration.
  // reserveBudget() does its own fresh read of the project inside a
  // per-project lock, so two concurrent keyframe generations for the same
  // project can never both reserve against the same remaining budget.
  const reservation = await gate.reserveBudget(projectId, {
    jobId: job.id,
    provider: providerName,
    operation: 'image-keyframe-generation',
    amount: approval.estimatedCost,
    currency: 'credits',
    unknownCostAcknowledged: approval.unknownCostAcknowledged,
  });
  if (!reservation.allowed) {
    job = generationStore.updateGenerationJob(job.id, {
      status: 'FAILED',
      error: { code: 'BUDGET_RESERVATION_BLOCKED', message: reservation.reason },
      failedAt: new Date().toISOString(),
    });
    return { ok: false, reason: reservation.reason, job };
  }

  keyframeStore.setKeyframeGenerationStatus(projectId, keyframeId, 'GENERATING');

  let providerStatus;
  try {
    providerStatus = await providerAdapter.createImageGeneration(normalizedRequest);
  } catch (err) {
    // Reservation is released, never left stranded — see
    // generation-service.js's requestGeneration for the same EvoLink
    // release-on-pre-creation-failure policy and why it's correct.
    await gate.releaseReservation(projectId, {
      jobId: job.id,
      provider: providerName,
      currency: 'credits',
      note: 'Provider submission failed before task creation; assumed not billed.',
    });
    job = generationStore.updateGenerationJob(job.id, { status: 'FAILED', error: { message: err.message }, failedAt: new Date().toISOString() });
    keyframeStore.setKeyframeGenerationStatus(projectId, keyframeId, 'GENERATION_APPROVED');
    return { ok: false, reason: `Provider submission failed: ${err.message}`, job };
  }

  job = generationStore.updateGenerationJob(job.id, {
    providerTaskId: providerStatus.generationId,
    status: providerStatus.status,
    progress: providerStatus.progress,
    reservedCost: providerStatus.reservedCost,
    model: providerStatus.model,
    submittedAt: new Date().toISOString(),
  });
  await gate.settleGenerationCost(projectId, job);

  // Part 4, step 10 — poll to completion. Same shape as
  // generation-poller.js's loop, kept local to this file (see header) so
  // video polling behavior is never touched.
  for (let attempt = 1; attempt <= maxAttempts && IN_FLIGHT_STATUSES.includes(job.status); attempt++) {
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
    await gate.settleGenerationCost(projectId, job);

    if (IN_FLIGHT_STATUSES.includes(job.status) && attempt < maxAttempts) {
      await sleepImpl(intervalMs);
    }
  }

  if (IN_FLIGHT_STATUSES.includes(job.status)) {
    job = generationStore.updateGenerationJob(job.id, { status: 'TIMED_OUT', timedOutAt: new Date().toISOString() });
    keyframeStore.setKeyframeGenerationStatus(projectId, keyframeId, 'GENERATION_APPROVED');
    return { ok: false, reason: 'Generation timed out while polling the provider.', job };
  }

  if (job.status === 'FAILED') {
    keyframeStore.setKeyframeGenerationStatus(projectId, keyframeId, 'GENERATION_APPROVED');
    return { ok: false, reason: job.error ? job.error.message : 'Generation failed.', job };
  }

  // Part 4, steps 11-14 — completed: create the asset (Part 11 lineage),
  // archive it, and mark the keyframe GENERATED. The asset's own
  // approvalStatus starts at 'NONE' (production-schema.js's default) —
  // Part 13: a generated keyframe is never automatically an approved
  // reference.
  const resultUrl = (job.result && job.result.results && job.result.results[0]) || null;
  const asset = timelineStore.addAsset(projectId, {
    type: 'keyframe',
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    keyframeId,
    generationType: 'IMAGE_KEYFRAME',
    promptPackageId: pkg.packageId,
    promptPackageVersion: pkg.version,
    prompt: pkg.prompt,
    references: normalizedRequest.referenceAssets,
    provider: providerName,
    model: job.model,
    generationId: job.id,
    url: resultUrl,
  });

  await assetArchiveService.archiveGenerationAsset(asset.assetId, { fetchImpl: providerAdapter.fakeFetchImpl });

  job = generationStore.updateGenerationJob(job.id, { assetId: asset.assetId });
  keyframeStore.setKeyframeGenerationStatus(projectId, keyframeId, 'GENERATED');

  return { ok: true, job, asset: timelineStore.getAsset(projectId, asset.assetId) };
}

// Part 13 — human review after generation. Never automatic. Uses the same
// non-versioned status setter as the generation transitions above (see
// its comment on keyframeStore.setKeyframeGenerationStatus) — approving/
// rejecting a RESULT is a lifecycle outcome, not a creative-content edit,
// and the real, permanent record of the decision is the asset's own
// approvalStatus (services/timeline-store.js), never lost or overwritten.
function approveGeneratedKeyframe(projectId, keyframeId, assetId, { approvedBy } = {}) {
  const asset = timelineStore.getAsset(projectId, assetId);
  if (!asset || asset.keyframeId !== keyframeId) {
    return { ok: false, reason: `No generated asset "${assetId}" found for keyframe "${keyframeId}".` };
  }
  timelineStore.setAssetApprovalStatus(projectId, assetId, 'APPROVED');
  const keyframe = keyframeStore.setKeyframeGenerationStatus(projectId, keyframeId, 'APPROVED');
  return { ok: true, asset: timelineStore.getAsset(projectId, assetId), keyframe };
}

function rejectGeneratedKeyframe(projectId, keyframeId, assetId, { decidedBy, reason } = {}) {
  const asset = timelineStore.getAsset(projectId, assetId);
  if (!asset || asset.keyframeId !== keyframeId) {
    return { ok: false, reason: `No generated asset "${assetId}" found for keyframe "${keyframeId}".` };
  }
  timelineStore.setAssetApprovalStatus(projectId, assetId, 'REJECTED');
  const keyframe = keyframeStore.setKeyframeGenerationStatus(projectId, keyframeId, 'REJECTED');
  // Part 13 — the rejected attempt is never deleted: the asset record and
  // its generation job both remain exactly as they are, permanently
  // visible in list_keyframe_generations / the asset's own history.
  return { ok: true, asset: timelineStore.getAsset(projectId, assetId), keyframe };
}

module.exports = {
  IMAGE_PROVIDERS,
  DEFAULT_PROVIDER_NAME,
  canGenerateKeyframe,
  generateKeyframe,
  listKeyframeGenerations,
  approveGeneratedKeyframe,
  rejectGeneratedKeyframe,
};

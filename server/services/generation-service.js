// generation-service.js
//
// The ONLY place that orchestrates the full generation lifecycle: looking
// up the project and shot, checking the project is in a generation state,
// checking the approval/budget gate, creating and persisting a generation
// job, submitting it to a provider, and — later, via checkGenerationOnce —
// handling the result and creating the asset.
//
// MCP tools call this service. This service calls the provider interface.
// It never talks to EvoLink's HTTP API directly — see
// providers/evolink/evolink-provider.js for that. See
// docs/architecture/generation-lifecycle.md for the full explanation.

const projectStore = require('./project-store');
const timelineStore = require('./timeline-store');
const generationStore = require('./generation-store');
const gate = require('./approval-gate');
const recoveryService = require('./generation-recovery-service');
const stateMachine = require('../schemas/state-machine');
const productionSchema = require('../schemas/production-schema');
const evolinkProvider = require('../providers/evolink/evolink-provider');

// The provider registry. Only "evolink" is wired in — adding another
// provider later means adding an entry here, not changing anything above
// this file (Creative IR, Timeline IR, MCP tools, etc. stay untouched).
const PROVIDERS = { evolink: evolinkProvider };

function resolveProvider(providerName, providers) {
  const adapter = providers[providerName];
  if (!adapter) {
    throw new Error(`Unknown provider "${providerName}". Supported providers: ${Object.keys(providers).join(', ')}`);
  }
  return adapter;
}

// A job counts as "in flight" if it hasn't reached a final state yet —
// used both to find safety-relevant duplicates and to know when polling
// should stop.
const IN_FLIGHT_STATUSES = ['REQUESTED', 'SUBMITTED', 'PROCESSING'];

// Runs every check EXCEPT actually calling a provider. Shared by
// estimateGeneration() (which stops here) and requestGeneration() (which
// continues on to submission only if these all pass).
function runSafetyChecks({ projectId, shotId }) {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { ok: false, reason: `No project found with id "${projectId}"` };
  }

  const shot = timelineStore.getShot(projectId, shotId);
  if (!shot) {
    return { ok: false, reason: `No shot found with id "${shotId}" in project "${projectId}"` };
  }

  if (!stateMachine.isGenerationState(project.status)) {
    return {
      ok: false,
      reason:
        `Project is in state "${project.status}", which is not a generation state. ` +
        `Move it into one of: ${stateMachine.GENERATION_STATES.join(', ')} first.`,
    };
  }

  // gate.canProceed checks BOTH approval status and budget in one call —
  // this is the exact same Stage 3 function, not reimplemented here.
  const gateCheck = gate.canProceed(project);
  if (!gateCheck.allowed) {
    return { ok: false, reason: `Blocked by approval/budget gate: ${gateCheck.reason}` };
  }

  return { ok: true, project, shot };
}

// Read-only: reports whether a generation would currently be allowed,
// without submitting anything or creating a job.
function estimateGeneration(input) {
  const checks = runSafetyChecks(input);
  if (!checks.ok) {
    return { allowed: false, reason: checks.reason };
  }

  return {
    allowed: true,
    reason: null,
    projectStatus: checks.project.status,
    approvalStatus: checks.project.approvals.status,
    estimatedCost: checks.project.approvals.estimatedCost,
    budgetLimit: checks.project.creditLedger.limit,
    reservedCredits: checks.project.creditLedger.reserved,
    actualSpent: checks.project.creditLedger.actualSpent,
    remainingBudget: gate.getRemainingBudget(checks.project),
  };
}

function requestKey({ provider, model, task, prompt, references, parameters }) {
  return JSON.stringify({ provider, model, task, prompt, references, parameters });
}

// Finds an existing, still-in-flight job for the exact same intended
// request (same project/shot/provider/model/task/prompt/references/
// parameters). A simple JSON-equality check — deliberately not a
// sophisticated distributed idempotency system, per Stage 7's scope.
function findInFlightDuplicate(input) {
  const key = requestKey(input);
  const candidates = generationStore.listGenerationJobs({ projectId: input.projectId, shotId: input.shotId });
  return candidates.find((job) => IN_FLIGHT_STATUSES.includes(job.status) && requestKey(job) === key) || null;
}

// P0-HARDENING-2, Part 10 — the same exact-request match as
// findInFlightDuplicate, but for a job that TIMED_OUT (not IN_FLIGHT).
// findInFlightDuplicate deliberately does NOT match TIMED_OUT jobs (a
// fresh explicit request after a genuine, confirmed failure/timeout must
// stay possible) — but requestGeneration() must resolve what actually
// happened to a TIMED_OUT job before treating "the old attempt is gone" as
// true, or it risks a second real charge for work that may still be
// running or may have already completed.
function findStaleTimedOutDuplicate(input) {
  const key = requestKey(input);
  const candidates = generationStore.listGenerationJobs({ projectId: input.projectId, shotId: input.shotId });
  return candidates.find((job) => job.status === 'TIMED_OUT' && requestKey(job) === key) || null;
}

// Submits a real generation, but ONLY if every safety check passes. This
// is the one function in the whole system that is allowed to cause real
// provider spending.
async function requestGeneration(input, { providers = PROVIDERS } = {}) {
  const { projectId, shotId, provider, model, task, prompt, references = [], parameters = {} } = input;

  const checks = runSafetyChecks({ projectId, shotId });
  if (!checks.ok) {
    return { ok: false, reason: checks.reason };
  }

  const duplicate = findInFlightDuplicate({ projectId, shotId, provider, model, task, prompt, references, parameters });
  if (duplicate) {
    return { ok: true, job: duplicate, deduplicated: true };
  }

  let providerAdapter;
  try {
    providerAdapter = resolveProvider(provider, providers);
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  // P0-HARDENING-2, Part 10 — resolve a stale TIMED_OUT attempt for this
  // exact request before allowing a new one.
  const staleJob = findStaleTimedOutDuplicate({ projectId, shotId, provider, model, task, prompt, references, parameters });
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
      // Never create a new paid request while the prior attempt's outcome
      // (and therefore its final cost) is unresolved.
      return { ok: false, reason: `Cannot safely retry: ${recovery.reason}`, job: staleJob, recovery: recovery.classification };
    }

    if (recovery.classification === 'FAILED_CONFIRMED') {
      // The stale job never went through a normal catch block (polling
      // simply timed out), so its reservation — if the provider never
      // actually billed it, per this confirmed failure — was never
      // released. Release it now, then fall through to submit a genuinely
      // new request below.
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

  const genericRequest = productionSchema.createGenerationRequest({ provider, model, task, prompt, references, parameters });

  // Create and persist the job BEFORE calling the provider, so a record
  // exists even if the process crashes mid-submission.
  let job = generationStore.createGenerationJob({
    projectId,
    sceneId: checks.shot.sceneId,
    shotId,
    provider,
    model,
    task,
    prompt,
    references,
    parameters,
    status: 'REQUESTED',
    estimatedCost: checks.project.approvals.estimatedCost,
  });

  // P0-HARDENING-2, Part 5/6/8/9 — reserve budget atomically BEFORE the
  // provider call. reserveBudget() does its OWN fresh read of the project
  // (inside a per-project lock), so two concurrent requests for the same
  // project can never both reserve against the same remaining budget —
  // the exact lost-update race the forensic audit reproduced. This is why
  // the job is created (above) before the reservation: the reservation's
  // ledger event and the seeded reconciledJobs delta-baseline both need a
  // jobId to key off. `checks.project.approvals` here is only the basis
  // for the amount/policy passed in — reserveBudget re-validates against
  // a fresh read rather than trusting it.
  const reservation = await gate.reserveBudget(projectId, {
    jobId: job.id,
    provider: 'evolink',
    operation: task,
    amount: checks.project.approvals.estimatedCost,
    currency: 'credits',
    unknownCostAcknowledged: checks.project.approvals.unknownCostAcknowledged,
  });
  if (!reservation.allowed) {
    job = generationStore.updateGenerationJob(job.id, {
      status: 'FAILED',
      error: { code: 'BUDGET_RESERVATION_BLOCKED', message: reservation.reason },
      failedAt: new Date().toISOString(),
    });
    return { ok: false, reason: reservation.reason, job };
  }

  let providerStatus;
  try {
    providerStatus = await providerAdapter.createGeneration(genericRequest);
  } catch (err) {
    // EvoLink's own documented model reserves credits only as part of a
    // SUCCESSFUL task-creation response (see evolink-mapper.js's
    // fromEvolinkTask, which only ever maps reservedCost off that
    // response) — a throw here means task creation never happened on
    // EvoLink's side, so the reservation is released rather than left
    // stranded against a job that was never actually billed.
    await gate.releaseReservation(projectId, {
      jobId: job.id,
      provider: 'evolink',
      currency: 'credits',
      note: 'Provider submission failed before task creation; assumed not billed.',
    });
    job = generationStore.updateGenerationJob(job.id, {
      status: 'FAILED',
      error: { code: err.code || null, message: err.message },
      failedAt: new Date().toISOString(),
    });
    return { ok: false, reason: `Provider submission failed: ${err.message}`, job };
  }

  // Persist the provider task id immediately — if our process crashes
  // right after this line, we still know the external task exists.
  job = generationStore.updateGenerationJob(job.id, {
    providerTaskId: providerStatus.generationId,
    status: providerStatus.status,
    progress: providerStatus.progress,
    reservedCost: providerStatus.reservedCost,
    submittedAt: new Date().toISOString(),
  });

  // Fold the provider's real reserved cost into the project's ledger,
  // atomically. settleGenerationCost() re-reads the project fresh (inside
  // the same per-project lock) and delegates to the existing, unmodified
  // reconcileGenerationCost() delta math, which corrects the estimate
  // reserveBudget() seeded above to this real number without
  // double-counting (Part 3/6 of docs/architecture/budget-safety.md).
  await gate.settleGenerationCost(projectId, job);

  return { ok: true, job };
}

// Checks a job's current status with its provider ONE time, updates the
// stored job, and — the first time a job is seen as COMPLETED — creates
// its asset. Called repeatedly by generation-poller.js; never creates a
// new generation itself.
async function checkGenerationOnce(jobId, { providers = PROVIDERS } = {}) {
  const job = generationStore.getGenerationJob(jobId);
  if (!job) {
    throw new Error(`No generation job found with id "${jobId}"`);
  }

  if (!job.providerTaskId) {
    // Never actually reached the provider — nothing to check yet.
    return job;
  }

  const providerAdapter = resolveProvider(job.provider, providers);

  let providerStatus;
  try {
    providerStatus = await providerAdapter.getGenerationStatus(job.providerTaskId);
  } catch (err) {
    // A polling/network error is NOT the same as the generation failing —
    // record it separately and leave the job's real status untouched, so
    // the next poll attempt can simply try again.
    return generationStore.updateGenerationJob(jobId, {
      lastPollError: { message: err.message, occurredAt: new Date().toISOString() },
    });
  }

  const updates = {
    status: providerStatus.status,
    progress: providerStatus.progress,
    reservedCost: providerStatus.reservedCost !== null ? providerStatus.reservedCost : job.reservedCost,
    lastPollError: null, // this check succeeded — clear any earlier transient error
  };

  if (providerStatus.status === 'COMPLETED') {
    updates.result = { results: providerStatus.results };
    updates.completedAt = new Date().toISOString();
  } else if (providerStatus.status === 'FAILED') {
    updates.error = providerStatus.error;
    updates.failedAt = new Date().toISOString();
  }

  let updatedJob = generationStore.updateGenerationJob(jobId, updates);

  // Re-reconcile in case anything changed (e.g. a provider that DID return
  // an actualCost on completion — EvoLink currently never does, but this
  // stays correct if that ever changes). reconcileGenerationCost is
  // delta-based, so this never double-counts the reservedCost already
  // folded in at submission time. settleGenerationCost() is the
  // concurrency-safe wrapper (fresh read + per-project lock) around that
  // same unmodified function — see approval-gate.js.
  if (projectStore.getProject(updatedJob.projectId)) {
    await gate.settleGenerationCost(updatedJob.projectId, updatedJob);
  }

  if (updatedJob.status === 'COMPLETED' && !updatedJob.assetId) {
    updatedJob = createAssetForCompletedJob(updatedJob);
  }

  return updatedJob;
}

// A simple, documented heuristic — see docs/architecture/
// generation-lifecycle.md. Only video tasks have been verified so far
// (Stage 6), so that's the only case this maps with confidence.
function inferAssetType(task) {
  if (typeof task !== 'string') return null;
  if (task.includes('video')) return 'video';
  if (task.includes('image')) return 'keyframe';
  return null;
}

function createAssetForCompletedJob(job) {
  const resultUrls = (job.result && job.result.results) || [];

  const asset = timelineStore.addAsset(job.projectId, {
    type: inferAssetType(job.task),
    sceneId: job.sceneId,
    shotId: job.shotId,
    prompt: job.prompt,
    references: job.references,
    provider: job.provider,
    model: job.model,
    generationId: job.id,
    url: resultUrls[0] || null,
  });

  return generationStore.updateGenerationJob(job.id, { assetId: asset.assetId });
}

module.exports = {
  estimateGeneration,
  requestGeneration,
  checkGenerationOnce,
  IN_FLIGHT_STATUSES,
};

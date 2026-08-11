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

  let providerStatus;
  try {
    providerStatus = await providerAdapter.createGeneration(genericRequest);
  } catch (err) {
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

  // Fold the provider's reserved cost into the project's ledger the moment
  // it's known (Part 3/6 of docs/architecture/budget-safety.md) — this is
  // also the earliest point an overage can be detected, even though it's
  // already too late to stop THIS submission (EvoLink gave no
  // pre-submission quote to check against).
  gate.reconcileGenerationCost(checks.project, job);
  projectStore.touch(checks.project);

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
  // folded in at submission time.
  const project = projectStore.getProject(updatedJob.projectId);
  if (project) {
    gate.reconcileGenerationCost(project, updatedJob);
    projectStore.touch(project);
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

// Tests for services/generation-service.js — the orchestrator. Every
// provider call is a fake object injected via the `providers` option, so
// none of these tests make any real HTTP call. Real projects/shots are
// created through the real stores, so the actual safety-check logic
// (state machine + approval gate) is genuinely exercised, not mocked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-gen-service-projects-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-gen-service-jobs-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-gen-service-creative-'));
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-gen-service-blueprints-'));
const gateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-gen-service-gates-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.CREATIVE_BLUEPRINT_DATA_DIR = blueprintTempDir;
process.env.PRE_PRODUCTION_GATE_DATA_DIR = gateTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const generationStore = require('../services/generation-store');
const gate = require('../services/approval-gate');
const stateMachine = require('../schemas/state-machine');
const generationService = require('../services/generation-service');
const creativeStore = require('../services/creative-store');
const creativeBlueprintStore = require('../services/creative-blueprint-store');
const preProductionGateStore = require('../services/pre-production-gate-store');
const { createCreativeBlueprint } = require('../schemas/creative-blueprint-schema');
const { createPreProductionGateResult } = require('../schemas/pre-production-gate-schema');

// INT-2.5-P0 — satisfies control-plane-service.js's validateProductionPrerequisites()
// for a project: a real, persisted APPROVED CreativeBlueprint, a real ACCEPTed
// PreProductionGateResult referencing it, and a Storyboard.blueprintId link — the
// exact chain the strategic-layer enforcement now requires before any generation
// safety check runs. Built directly via the schema factories + stores (the same
// "real record, direct construction" convention already used by
// p0-4a-blueprint-storyboard-contract.test.js's setupBlueprintWithRecommendation)
// — the review/evaluate SERVICE CHAIN itself is exercised by the dedicated
// control-plane bypass tests, not re-proven in every fixture here.
function satisfyProductionPrerequisites(projectId) {
  const blueprint = createCreativeBlueprint({
    projectId,
    recommendationSetId: 'rec-set-fixture',
    status: 'APPROVED',
    concept: 'fixture concept',
    corePromise: 'fixture promise',
    targetDuration: 60,
  });
  const savedBlueprint = creativeBlueprintStore.addCreativeBlueprint(projectId, blueprint).blueprint;
  const gateResult = createPreProductionGateResult({
    projectId,
    blueprintId: savedBlueprint.id,
    blueprintRevision: savedBlueprint.id,
    blueprintUpdatedAt: savedBlueprint.updatedAt,
    machineAssessment: 'PROCEED',
    costStatus: 'UNKNOWN',
  });
  const savedGateResult = preProductionGateStore.addGateResult(projectId, gateResult).gateResult;
  preProductionGateStore.recordHumanDecision(projectId, savedGateResult.id, { humanDecision: 'ACCEPT', humanDecidedBy: 'test-fixture', humanRationale: null });
  creativeStore.updateStoryboard(projectId, { blueprintId: savedBlueprint.id });
  return { blueprintId: savedBlueprint.id, gateResultId: savedGateResult.id };
}

const FORWARD_PATH = [
  'RESEARCH',
  'CREATIVE_REVIEW',
  'SCRIPTING',
  'SCRIPT_REVIEW',
  'VISUAL_DEVELOPMENT',
  'VISUAL_REVIEW',
  'STORYBOARD',
  'GENERATION_REVIEW',
  'CALIBRATION',
  'KEYFRAME_GENERATION',
];

function walkTo(project, targetState) {
  for (const state of FORWARD_PATH) {
    const result = stateMachine.transition(project, state);
    assert.equal(result.ok, true, `expected to reach ${state}: ${result.reason}`);
    if (state === targetState) return;
  }
  throw new Error(`${targetState} is not on the forward path`);
}

// Creates a project + shot, approves a budget, and walks the project into
// a generation state — everything requestGeneration should require before
// it's willing to submit anything.
function setupReadyProject({ estimatedCost = 100, budgetLimit = 1000, targetState = 'KEYFRAME_GENERATION' } = {}) {
  const created = projectStore.createProject({ title: 'Gen test', topic: 'x' });
  const scene = timelineStore.addScene(created.id, { title: 'S1', description: 'd' });
  const shot = timelineStore.addShot(created.id, { sceneId: scene.sceneId, narrativePurpose: 'test shot' });

  const project = projectStore.getProject(created.id);
  gate.setBudget(project, budgetLimit);
  gate.requestApproval(project, { estimatedCost });
  gate.decideApproval(project, { approve: true });
  walkTo(project, targetState);
  projectStore.touch(project);
  satisfyProductionPrerequisites(created.id);

  return { projectId: created.id, shotId: shot.shotId };
}

function baseInput(overrides = {}) {
  return {
    provider: 'evolink',
    model: 'seedance-2.5-text-to-video',
    task: 'text-to-video',
    prompt: 'A lighthouse at dusk',
    references: [],
    parameters: { duration: 8 },
    ...overrides,
  };
}

function fakeProvider(overrides = {}) {
  return {
    createGeneration: async () => ({
      generationId: 'task-unified-fake-1',
      provider: 'evolink',
      model: 'seedance-2.5-text-to-video',
      status: 'SUBMITTED',
      progress: 0,
      reservedCost: 42,
      results: [],
      error: null,
    }),
    getGenerationStatus: async () => ({
      generationId: 'task-unified-fake-1',
      provider: 'evolink',
      model: 'seedance-2.5-text-to-video',
      status: 'PROCESSING',
      progress: 50,
      reservedCost: null,
      results: [],
      error: null,
    }),
    getGenerationResult: async () => ({}),
    ...overrides,
  };
}

// --- estimateGeneration: never submits anything -----------------------

test('estimateGeneration reports allowed:true without creating any job', () => {
  const { projectId, shotId } = setupReadyProject();
  const before = generationStore.listGenerationJobs({ projectId }).length;

  const result = generationService.estimateGeneration({ projectId, shotId, ...baseInput() });

  assert.equal(result.allowed, true);
  assert.equal(generationStore.listGenerationJobs({ projectId }).length, before, 'estimate must not create a job');
});

// --- blocked scenarios (5-9) --------------------------------------------

test('5. generation blocked when project does not exist', async () => {
  const result = await generationService.requestGeneration({
    projectId: '00000000-0000-0000-0000-000000000000',
    shotId: '11111111-1111-1111-1111-111111111111',
    ...baseInput(),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No project found/);
});

test('6. generation blocked when shot does not exist', async () => {
  const created = projectStore.createProject({ title: 'x', topic: 'y' });
  const result = await generationService.requestGeneration({
    projectId: created.id,
    shotId: '11111111-1111-1111-1111-111111111111',
    ...baseInput(),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No shot found/);
});

test('7. generation blocked when project is in the wrong state', async () => {
  const created = projectStore.createProject({ title: 'x', topic: 'y' });
  const scene = timelineStore.addScene(created.id, { title: 'S1', description: 'd' });
  const shot = timelineStore.addShot(created.id, { sceneId: scene.sceneId });
  // project is still PLANNING -- never walked to a generation state

  const result = await generationService.requestGeneration({
    projectId: created.id,
    shotId: shot.shotId,
    ...baseInput(),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a generation state/);
});

// Note: because entering a generation state already requires the gate
// (schemas/state-machine.js calls the same gate.canProceed at the
// transition boundary), a project can't normally end up IN a generation
// state without approval at all. To prove requestGeneration's OWN direct
// gate check (not just the state machine's) actually catches an
// unapproved/over-budget project, these two tests force the project's
// status directly on the in-memory object (never through
// projectStore.updateProject — Stage 13E, Part 4 removed "status" from
// its whitelist entirely, exactly so this kind of direct assignment can
// no longer happen through the public update path) — simulating "somehow
// got into this state" (a bug elsewhere, a hand-edited file) and
// confirming the gate still refuses regardless of how status got there.

test('8. generation blocked without approval (gate check independent of the state machine)', async () => {
  const created = projectStore.createProject({ title: 'x', topic: 'y' });
  const scene = timelineStore.addScene(created.id, { title: 'S1', description: 'd' });
  const shot = timelineStore.addShot(created.id, { sceneId: scene.sceneId });
  const project = projectStore.getProject(created.id);
  project.status = 'KEYFRAME_GENERATION'; // no approval at all
  projectStore.touch(project);
  satisfyProductionPrerequisites(created.id);

  const result = await generationService.requestGeneration({
    projectId: created.id,
    shotId: shot.shotId,
    ...baseInput(),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Blocked by approval\/budget gate/);
});

test('9. generation blocked by budget (gate check independent of the state machine)', async () => {
  const created = projectStore.createProject({ title: 'x', topic: 'y' });
  const scene = timelineStore.addScene(created.id, { title: 'S1', description: 'd' });
  const shot = timelineStore.addShot(created.id, { sceneId: scene.sceneId });
  const project = projectStore.getProject(created.id);
  gate.setBudget(project, 10);
  gate.requestApproval(project, { estimatedCost: 999 });
  gate.decideApproval(project, { approve: true });
  project.status = 'KEYFRAME_GENERATION';
  projectStore.touch(project);
  satisfyProductionPrerequisites(created.id);

  const result = await generationService.requestGeneration({
    projectId: created.id,
    shotId: shot.shotId,
    ...baseInput(),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Blocked by approval\/budget gate/);
  assert.match(result.reason, /budget/i);
});

// --- successful submission (10, 12) -------------------------------------

test('10. provider submission is called only after safety checks pass', async () => {
  const { projectId, shotId } = setupReadyProject();
  let called = false;
  const providers = {
    evolink: fakeProvider({
      createGeneration: async () => {
        called = true;
        return {
          generationId: 'task-unified-abc',
          status: 'SUBMITTED',
          progress: 0,
          reservedCost: 10,
          results: [],
          error: null,
        };
      },
    }),
  };

  const result = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });

  assert.equal(called, true);
  assert.equal(result.ok, true);
});

test('provider is never called when safety checks fail', async () => {
  let called = false;
  const providers = { evolink: fakeProvider({ createGeneration: async () => { called = true; return {}; } }) };

  await generationService.requestGeneration(
    { projectId: 'nope', shotId: 'nope', ...baseInput() },
    { providers }
  );

  assert.equal(called, false);
});

test('12. providerTaskId, status, and reservedCost are persisted immediately on the job', async () => {
  const { projectId, shotId } = setupReadyProject();
  const providers = { evolink: fakeProvider() };

  const result = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });

  assert.equal(result.ok, true);
  assert.equal(result.job.providerTaskId, 'task-unified-fake-1');
  assert.equal(result.job.status, 'SUBMITTED');
  assert.equal(result.job.reservedCost, 42);
  assert.ok(result.job.submittedAt);

  // and it's really on disk, not just in memory
  const reloaded = generationStore.getGenerationJob(result.job.id);
  assert.equal(reloaded.providerTaskId, 'task-unified-fake-1');
});

test('estimatedCost is snapshotted from the project approval onto the job', async () => {
  const { projectId, shotId } = setupReadyProject({ estimatedCost: 77 });
  const providers = { evolink: fakeProvider() };

  const result = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });
  assert.equal(result.job.estimatedCost, 77);
});

// --- provider submission failure (11) -----------------------------------

test('11. a provider submission failure marks the job FAILED instead of crashing', async () => {
  const { projectId, shotId } = setupReadyProject();
  const providers = {
    evolink: fakeProvider({
      createGeneration: async () => {
        const err = new Error('Insufficient quota. Please top up your account.');
        err.code = 'insufficient_quota';
        throw err;
      },
    }),
  };

  const result = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Insufficient quota/);
  assert.equal(result.job.status, 'FAILED');
  assert.equal(result.job.error.code, 'insufficient_quota');
  assert.ok(result.job.failedAt);
});

// --- idempotency ----------------------------------------------------------

test('a second request_generation for the same in-flight job returns the existing job, not a new one', async () => {
  const { projectId, shotId } = setupReadyProject();
  let submissionCount = 0;
  const providers = {
    evolink: fakeProvider({
      createGeneration: async () => {
        submissionCount += 1;
        return { generationId: `task-${submissionCount}`, status: 'SUBMITTED', progress: 0, reservedCost: 5, results: [], error: null };
      },
    }),
  };

  const first = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });
  const second = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });

  assert.equal(submissionCount, 1, 'the provider must only be called once');
  assert.equal(second.deduplicated, true);
  assert.equal(second.job.id, first.job.id);
});

test('a different prompt for the same shot is NOT treated as a duplicate', async () => {
  const { projectId, shotId } = setupReadyProject();
  let submissionCount = 0;
  const providers = {
    evolink: fakeProvider({
      createGeneration: async () => {
        submissionCount += 1;
        return { generationId: `task-${submissionCount}`, status: 'SUBMITTED', progress: 0, reservedCost: 5, results: [], error: null };
      },
    }),
  };

  await generationService.requestGeneration({ projectId, shotId, ...baseInput({ prompt: 'prompt A' }) }, { providers });
  await generationService.requestGeneration({ projectId, shotId, ...baseInput({ prompt: 'prompt B' }) }, { providers });

  assert.equal(submissionCount, 2);
});

test('a job that already reached COMPLETED does not block a fresh request', async () => {
  const { projectId, shotId } = setupReadyProject();
  let submissionCount = 0;
  const providers = {
    evolink: fakeProvider({
      createGeneration: async () => {
        submissionCount += 1;
        return { generationId: `task-${submissionCount}`, status: 'SUBMITTED', progress: 0, reservedCost: 5, results: [], error: null };
      },
    }),
  };

  const first = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });
  generationStore.updateGenerationJob(first.job.id, { status: 'COMPLETED' });

  const second = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });

  assert.equal(submissionCount, 2, 'a finished job must not suppress a new submission');
  assert.notEqual(second.job.id, first.job.id);
});

// --- status mapping via checkGenerationOnce (13-16) ----------------------

async function submitReadyJob(providerOverrides = {}) {
  const { projectId, shotId } = setupReadyProject();
  const providers = { evolink: fakeProvider(providerOverrides) };
  const result = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });
  return { job: result.job, providers };
}

test('13. a pending/submitted provider status keeps the job SUBMITTED', async () => {
  const { job, providers } = await submitReadyJob({
    getGenerationStatus: async () => ({ status: 'SUBMITTED', progress: 0, results: [], error: null, reservedCost: null }),
  });
  const updated = await generationService.checkGenerationOnce(job.id, { providers });
  assert.equal(updated.status, 'SUBMITTED');
});

test('14. a processing provider status maps to PROCESSING', async () => {
  const { job, providers } = await submitReadyJob({
    getGenerationStatus: async () => ({ status: 'PROCESSING', progress: 55, results: [], error: null, reservedCost: null }),
  });
  const updated = await generationService.checkGenerationOnce(job.id, { providers });
  assert.equal(updated.status, 'PROCESSING');
  assert.equal(updated.progress, 55);
});

test('15. a completed provider status maps to COMPLETED and stores the result', async () => {
  const { job, providers } = await submitReadyJob({
    getGenerationStatus: async () => ({
      status: 'COMPLETED',
      progress: 100,
      results: ['https://example.com/generated-video.mp4'],
      error: null,
      reservedCost: null,
    }),
  });
  const updated = await generationService.checkGenerationOnce(job.id, { providers });
  assert.equal(updated.status, 'COMPLETED');
  assert.deepEqual(updated.result.results, ['https://example.com/generated-video.mp4']);
  assert.ok(updated.completedAt);
});

test('16. a failed provider status maps to FAILED and stores the error', async () => {
  const { job, providers } = await submitReadyJob({
    getGenerationStatus: async () => ({
      status: 'FAILED',
      progress: 0,
      results: [],
      error: { code: 'content_policy_violation', message: 'Blocked by safety filters' },
      reservedCost: null,
    }),
  });
  const updated = await generationService.checkGenerationOnce(job.id, { providers });
  assert.equal(updated.status, 'FAILED');
  assert.equal(updated.error.code, 'content_policy_violation');
  assert.ok(updated.failedAt);
});

test('a polling/network error is recorded separately and does not change the job status', async () => {
  const { job, providers } = await submitReadyJob({
    getGenerationStatus: async () => {
      throw new Error('network timeout');
    },
  });
  const updated = await generationService.checkGenerationOnce(job.id, { providers });
  assert.equal(updated.status, 'SUBMITTED', 'status must be unchanged by a transient polling error');
  assert.match(updated.lastPollError.message, /network timeout/);
});

// --- asset creation on completion (19, 20) --------------------------------

test('19. a completed generation creates an asset linked to the job', async () => {
  const { job, providers } = await submitReadyJob({
    getGenerationStatus: async () => ({
      status: 'COMPLETED',
      progress: 100,
      results: ['https://example.com/generated-video.mp4'],
      error: null,
      reservedCost: null,
    }),
  });

  const updated = await generationService.checkGenerationOnce(job.id, { providers });
  assert.ok(updated.assetId);

  const assets = timelineStore.listAssets(job.projectId);
  const asset = assets.find((a) => a.assetId === updated.assetId);
  assert.ok(asset, 'the asset must actually exist on the project');
  assert.equal(asset.url, 'https://example.com/generated-video.mp4');
});

test('20. asset lineage traces back to project, scene, shot, generation job, provider, model, and prompt', async () => {
  const { job, providers } = await submitReadyJob({
    getGenerationStatus: async () => ({
      status: 'COMPLETED',
      progress: 100,
      results: ['https://example.com/video.mp4'],
      error: null,
      reservedCost: null,
    }),
  });

  const updated = await generationService.checkGenerationOnce(job.id, { providers });
  const asset = timelineStore.getAsset(job.projectId, updated.assetId);

  assert.equal(asset.projectId, job.projectId);
  assert.equal(asset.sceneId, job.sceneId);
  assert.equal(asset.shotId, job.shotId);
  assert.equal(asset.generationId, job.id);
  assert.equal(asset.provider, job.provider);
  assert.equal(asset.model, job.model);
  assert.equal(asset.prompt, job.prompt);
});

test('checking an already-completed job a second time does not create a second asset', async () => {
  const { job, providers } = await submitReadyJob({
    getGenerationStatus: async () => ({
      status: 'COMPLETED',
      progress: 100,
      results: ['https://example.com/video.mp4'],
      error: null,
      reservedCost: null,
    }),
  });

  const first = await generationService.checkGenerationOnce(job.id, { providers });
  const second = await generationService.checkGenerationOnce(job.id, { providers });

  assert.equal(second.assetId, first.assetId);
  const assets = timelineStore.listAssets(job.projectId, { shotId: job.shotId });
  assert.equal(assets.length, 1);
});

// ===========================================================================
// P0-HARDENING-2 — Part 14 auditability + Part 15/16 concurrency/crash
// tests, exercised through the REAL requestGeneration()/checkGenerationOnce()
// call sites (not just approval-gate.js directly — see
// test/p0-hardening-2-ledger.test.js for the lower-level mechanics).
// ===========================================================================

test('P0H2-1. a successful operation: the project ledger reconstructs approval -> reservation -> provider call -> settlement', async () => {
  const { projectId, shotId } = setupReadyProject({ estimatedCost: 50 });
  const providers = { evolink: fakeProvider() }; // reservedCost: 42 on submission

  const result = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });
  assert.equal(result.ok, true);

  const project = projectStore.getProject(projectId);
  const events = project.creditLedger.ledgerEvents;
  assert.equal(events.length, 1, 'one RESERVED event for this job — EvoLink never reports an actualCost, so there is nothing to SETTLE separately (see budget-safety.md)');
  assert.equal(events[0].event, 'RESERVED');
  assert.equal(events[0].jobId, result.job.id);
  assert.equal(events[0].amount, 50, 'the reservation is seeded from the approved estimate, before the provider is ever called');

  // The provider's REAL reservedCost (42) corrects the ledger via the
  // existing, unmodified reconcileGenerationCost delta math — never
  // double-counted against the original 50-credit reservation.
  assert.equal(project.creditLedger.reserved, 42);
});

test('P0H2-2. a provider failure: the reservation is released, reconstructable from the ledger as RESERVED then RELEASED', async () => {
  const { projectId, shotId } = setupReadyProject({ estimatedCost: 20 });
  const providers = { evolink: fakeProvider({ createGeneration: async () => { throw new Error('provider rejected the request'); } }) };

  const result = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });
  assert.equal(result.ok, false);
  assert.equal(result.job.status, 'FAILED');

  const project = projectStore.getProject(projectId);
  const events = project.creditLedger.ledgerEvents;
  assert.deepEqual(events.map((e) => e.event), ['RESERVED', 'RELEASED']);
  assert.equal(project.creditLedger.reserved, 0);
});

test('P0H2-3. two concurrent requestGeneration calls for the SAME project (different shots) never lose a reservation update', async () => {
  const created = projectStore.createProject({ title: 'concurrent shots', topic: 'x' });
  const scene = timelineStore.addScene(created.id, { title: 'S1', description: 'd' });
  const shotA = timelineStore.addShot(created.id, { sceneId: scene.sceneId, narrativePurpose: 'shot A' });
  const shotB = timelineStore.addShot(created.id, { sceneId: scene.sceneId, narrativePurpose: 'shot B' });
  const project = projectStore.getProject(created.id);
  gate.setBudget(project, 10);
  gate.requestApproval(project, { estimatedCost: 7 });
  gate.decideApproval(project, { approve: true });
  walkTo(project, 'KEYFRAME_GENERATION');
  projectStore.touch(project);
  satisfyProductionPrerequisites(created.id);

  const providers = { evolink: fakeProvider({ createGeneration: async () => ({ generationId: 'concurrent-task', status: 'SUBMITTED', progress: 0, reservedCost: 7, results: [], error: null }) }) };

  const [resA, resB] = await Promise.all([
    generationService.requestGeneration({ projectId: created.id, shotId: shotA.shotId, ...baseInput() }, { providers }),
    generationService.requestGeneration({ projectId: created.id, shotId: shotB.shotId, ...baseInput() }, { providers }),
  ]);

  const succeeded = [resA, resB].filter((r) => r.ok && r.job && r.job.status !== 'FAILED');
  // Exactly one of the two £7 requests against a £10 budget can succeed;
  // the other must be blocked by the reservation gate, never silently lost.
  assert.equal(succeeded.length, 1, `expected exactly one of two concurrent £7 requests against a £10 budget to succeed, got: ${JSON.stringify([resA, resB])}`);

  const reloaded = projectStore.getProject(created.id);
  assert.equal(reloaded.creditLedger.reserved, 7, 'the ledger must reflect exactly one £7 reservation, never a lost update showing 0 and never a double-count showing 14');
});

test('P0H2-4. TIMED_OUT retry does not double-charge: a still-active provider operation is returned as-is, never resubmitted', async () => {
  const { projectId, shotId } = setupReadyProject({ estimatedCost: 20 });
  let submissionCount = 0;
  const providers = {
    evolink: fakeProvider({
      createGeneration: async () => {
        submissionCount += 1;
        return { generationId: 'timeout-task-1', status: 'SUBMITTED', progress: 0, reservedCost: 5, results: [], error: null };
      },
      getGenerationStatus: async () => ({ status: 'PROCESSING', progress: 60, results: [], error: null, reservedCost: null }),
    }),
  };

  const first = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });
  assert.equal(first.ok, true);
  // Simulate this process giving up on polling (the exact TIMED_OUT
  // scenario Part 10 describes) while the real provider op is still active.
  generationStore.updateGenerationJob(first.job.id, { status: 'TIMED_OUT', timedOutAt: new Date().toISOString() });

  const retry = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });

  assert.equal(submissionCount, 1, 'the provider must NOT be called a second time while the original operation is still active — this is the exact double-charge risk P1-2 fixes');
  assert.equal(retry.ok, false);
  assert.equal(retry.recovery, 'PROVIDER_OUTCOME_UNKNOWN');
});

test('P0H2-5. TIMED_OUT retry after provider-confirmed completion reconciles and returns the existing result, never creating a second job', async () => {
  const { projectId, shotId } = setupReadyProject({ estimatedCost: 20 });
  let submissionCount = 0;
  const providers = {
    evolink: fakeProvider({
      createGeneration: async () => {
        submissionCount += 1;
        return { generationId: 'timeout-task-2', status: 'SUBMITTED', progress: 0, reservedCost: 5, results: [], error: null };
      },
      getGenerationStatus: async () => ({ status: 'COMPLETED', progress: 100, results: ['https://example.com/done.mp4'], error: null, reservedCost: 5 }),
    }),
  };

  const first = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });
  generationStore.updateGenerationJob(first.job.id, { status: 'TIMED_OUT', timedOutAt: new Date().toISOString() });

  const retry = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });

  assert.equal(submissionCount, 1, 'the provider must not be called again once it confirms the original operation already completed');
  assert.equal(retry.ok, true);
  assert.equal(retry.job.id, first.job.id);
  assert.equal(retry.job.status, 'COMPLETED');
});

test('P0H2-6. TIMED_OUT retry after provider-confirmed failure releases the stale reservation and allows a genuinely new attempt', async () => {
  const { projectId, shotId } = setupReadyProject({ estimatedCost: 20 });
  let submissionCount = 0;
  const providers = {
    evolink: fakeProvider({
      createGeneration: async () => {
        submissionCount += 1;
        return { generationId: `timeout-task-3-${submissionCount}`, status: 'SUBMITTED', progress: 0, reservedCost: 5, results: [], error: null };
      },
      getGenerationStatus: async () => ({ status: 'FAILED', progress: null, results: null, error: { message: 'provider confirms this run failed' }, reservedCost: null }),
    }),
  };

  const first = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });
  generationStore.updateGenerationJob(first.job.id, { status: 'TIMED_OUT', timedOutAt: new Date().toISOString() });

  const retry = await generationService.requestGeneration({ projectId, shotId, ...baseInput() }, { providers });

  assert.equal(submissionCount, 2, 'a genuinely NEW attempt is allowed once the provider confirms the original one failed');
  assert.equal(retry.ok, true);
  assert.notEqual(retry.job.id, first.job.id);

  const project = projectStore.getProject(projectId);
  // Only the SECOND job's reservation remains outstanding — the first
  // job's stale reservation was released, not left stranded.
  assert.equal(project.creditLedger.reserved, 5);
});

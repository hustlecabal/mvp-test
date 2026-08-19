// Tests for services/keyframe-generation-service.js — the Stage 13B
// controlled keyframe generation orchestrator. Covers every pre-
// generation safety check (missing approval, stale package, unknown
// cost, budget exceeded, duplicate protection), the full fake-provider
// lifecycle (submission, polling, completion, asset creation, archival,
// lineage), keyframe status transitions, human review after generation,
// and confirms nothing here ever reaches a provider or mutates budget
// when a pre-check fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-assets-'));
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-blueprints-'));
const gateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-gates-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = approvalTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;
process.env.CREATIVE_BLUEPRINT_DATA_DIR = blueprintTempDir;
process.env.PRE_PRODUCTION_GATE_DATA_DIR = gateTempDir;

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const creativeStore = require('../services/creative-store');
const timelineStore = require('../services/timeline-store');
const keyframeStore = require('../services/keyframe-store');
const kfp = require('../services/keyframe-prompt-service');
const approvalStore = require('../services/keyframe-generation-approval-store');
const generationStore = require('../services/generation-store');
const kfgen = require('../services/keyframe-generation-service');
const fakeImageProvider = require('../providers/fake-image/fake-image-provider');
const creativeBlueprintStore = require('../services/creative-blueprint-store');
const preProductionGateStore = require('../services/pre-production-gate-store');
const { createCreativeBlueprint } = require('../schemas/creative-blueprint-schema');
const { createPreProductionGateResult } = require('../schemas/pre-production-gate-schema');

const FAST_POLL = { intervalMs: 0, sleepImpl: async () => {} };

function newProject(title = 'kfgen service test') {
  return projectStore.createProject({ title, topic: 'x' });
}

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

// Builds a fresh project with one storyboard shot + one keyframe + a
// built, CURRENT prompt package. Returns everything a test needs.
function buildFixture() {
  const project = newProject();
  // Link the Blueprint/Gate BEFORE any storyboard version bump this fixture
  // makes below — updateStoryboard() itself bumps the storyboard's version
  // (Part 6/10's "every storyboard write is a tracked, versioned update"
  // rule), so linking first means the scene/shot/keyframe/package built
  // afterward all capture the CURRENT (post-link) version and never start
  // out spuriously STALE.
  satisfyProductionPrerequisites(project.id);
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, {
    shotId: shot.shotId,
    sceneId: scene.sceneId,
    frameType: 'DETAIL_FRAME',
    sourceShotVersion: storyboard.version,
  });
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  return { project, scene, shot, keyframe, pkg };
}

function approve(projectId, keyframeId, pkg, { estimatedCost = 2 } = {}) {
  approvalStore.requestApproval(projectId, keyframeId, {
    promptPackageId: pkg.packageId,
    promptPackageVersion: pkg.version,
    estimatedCost,
    requestedBy: 'tester',
  });
  return approvalStore.decideApproval(projectId, keyframeId, { approve: true, decidedBy: 'tester' });
}

test.beforeEach(() => fakeImageProvider.resetFakeImageProvider());

// --- 5/6. generation approval / missing approval blocks generation -------------------

test('5/6. generateKeyframe is blocked with NO provider call and NO job when there is no approval', async () => {
  const { project, keyframe } = buildFixture();
  const spyProviders = {
    'fake-image': {
      createImageGeneration: () => { throw new Error('MUST NOT BE CALLED'); },
      getGenerationStatus: () => { throw new Error('MUST NOT BE CALLED'); },
    },
  };

  const result = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, { ...FAST_POLL, providers: spyProviders });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No explicit keyframe generation approval/);
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, 0, '27. zero provider calls when blocked implies zero jobs too');
});

test('project-level video-generation approval is NOT sufficient (Part 5)', async () => {
  const { project, keyframe } = buildFixture();
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 10 });
  gate.decideApproval(project, { approve: true });
  projectStore.touch(project);

  const result = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);
  assert.equal(result.ok, false);
  assert.match(result.reason, /No explicit keyframe generation approval/);
});

// --- 7. stale package blocks generation -----------------------------------------------

test('7. a STALE prompt package blocks generation, with zero provider calls', async () => {
  const { project, keyframe, pkg, shot } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);

  // Make the package stale by editing the shot after it was built.
  creativeStore.updateStoryboardShot(project.id, shot.shotId, { purpose: 'revised' }, { changeNote: 'revise' });

  const spyProviders = { 'fake-image': { createImageGeneration: () => { throw new Error('MUST NOT BE CALLED'); }, getGenerationStatus: () => {} } };
  const result = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, { ...FAST_POLL, providers: spyProviders });
  assert.equal(result.ok, false);
  assert.match(result.reason, /STALE/);
});

// --- 8. unknown cost policy -------------------------------------------------------------

test('8. unknown cost (no estimatedCost, not acknowledged) blocks generation', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approvalStore.requestApproval(project.id, keyframe.keyframeId, { promptPackageId: pkg.packageId, promptPackageVersion: pkg.version });
  approvalStore.decideApproval(project.id, keyframe.keyframeId, { approve: true, decidedBy: 'tester' });

  const blocked = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /Estimated cost is unknown/);

  approvalStore.acknowledgeUnknownCost(project.id, keyframe.keyframeId, { acknowledgedBy: 'tester' });
  const allowed = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);
  assert.equal(allowed.ok, true, 'acknowledging unknown cost unblocks generation');
});

// --- 9. budget exceeded blocks generation -----------------------------------------------

test('9. an estimated cost exceeding the remaining project budget blocks generation', async () => {
  const { project, keyframe, pkg } = buildFixture();
  gate.setBudget(project, 1);
  projectStore.touch(project);
  approve(project.id, keyframe.keyframeId, pkg, { estimatedCost: 100 });

  const result = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);
  assert.equal(result.ok, false);
  assert.match(result.reason, /exceed the remaining project budget/);
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, 0);
});

test('an unacknowledged project-level overage (creditLedger.blocked) also blocks keyframe generation', async () => {
  const { project, keyframe, pkg } = buildFixture();
  gate.setBudget(project, 10);
  project.creditLedger.blocked = true;
  project.creditLedger.blockedReason = 'test overage';
  projectStore.touch(project);
  approve(project.id, keyframe.keyframeId, pkg, { estimatedCost: 1 });

  const result = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);
  assert.equal(result.ok, false);
  assert.match(result.reason, /test overage/);
});

// --- 10. duplicate generation prevention ------------------------------------------------

test('10. two concurrent generateKeyframe calls for the same package version return the SAME job, not two', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);

  const [first, second] = await Promise.all([
    kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL),
    kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.job.id, second.job.id, 'both calls must resolve to the same generation job');
  assert.ok(first.deduplicated || second.deduplicated, 'exactly one of the two must be reported as deduplicated');
});

// --- 11/12/13. fake submission, polling, completion --------------------------------------

test('11/12/13. a full generation submits to the fake provider, polls to COMPLETED, and records the result', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);

  const result = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);
  assert.equal(result.ok, true);
  assert.equal(result.job.status, 'COMPLETED');
  assert.ok(result.job.providerTaskId);
  assert.equal(result.job.provider, 'fake-image');
  assert.equal(result.job.reservedCost, fakeImageProvider.FAKE_RESERVED_COST);
  assert.ok(result.job.result.results[0].includes('sample-keyframe.png'));
});

// --- 14/15/16. asset creation, archival, lineage ------------------------------------------

test('14/15/16. the completed generation creates a fully-traced, locally-archived asset', async () => {
  const { project, scene, shot, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);

  const result = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);
  const asset = result.asset;

  assert.equal(asset.projectId, project.id);
  assert.equal(asset.sceneId, scene.sceneId);
  assert.equal(asset.shotId, shot.shotId);
  assert.equal(asset.keyframeId, keyframe.keyframeId);
  assert.equal(asset.generationId, result.job.id);
  assert.equal(asset.provider, 'fake-image');
  assert.equal(asset.generationType, 'IMAGE_KEYFRAME');
  assert.equal(asset.promptPackageId, pkg.packageId);
  assert.equal(asset.promptPackageVersion, pkg.version);
  assert.equal(asset.prompt, pkg.prompt);
  assert.ok(Array.isArray(asset.references));
  assert.equal(asset.approvalStatus, 'NONE');

  assert.equal(asset.storage.status, 'STORED', '15. the fake image must actually be archived locally');
  assert.ok(asset.storage.path);
  const storedFile = path.join(assetsTempDir, asset.storage.path);
  assert.ok(fs.existsSync(storedFile), 'the archived file must really exist on disk');
  assert.ok(fs.statSync(storedFile).size > 0);
});

// --- 17/18. generated keyframe status / starts unapproved ---------------------------------

test('17/18. the keyframe is marked GENERATED, and the new asset starts with approvalStatus NONE', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);

  const result = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);
  assert.equal(keyframeStore.getKeyframe(project.id, keyframe.keyframeId).status, 'GENERATED');
  assert.equal(result.asset.approvalStatus, 'NONE');
});

test('marking the keyframe GENERATING/GENERATED never bumps the Keyframe Plan version (so its own package does not go stale)', async () => {
  const { project, keyframe, pkg } = buildFixture();
  const planBefore = keyframeStore.getKeyframePlan(project.id).version;
  approve(project.id, keyframe.keyframeId, pkg);

  await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);

  const planAfter = keyframeStore.getKeyframePlan(project.id).version;
  assert.equal(planAfter, planBefore, 'lifecycle status writes must not bump the plan version');
  assert.equal(kfp.getKeyframePromptPackage(project.id, keyframe.keyframeId).status, 'CURRENT');
});

// --- 19/20/21. human review after generation ------------------------------------------------

test('19. approveGeneratedKeyframe approves the asset and marks the keyframe APPROVED', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);
  const generated = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);

  const result = kfgen.approveGeneratedKeyframe(project.id, keyframe.keyframeId, generated.asset.assetId, { approvedBy: 'tester' });
  assert.equal(result.ok, true);
  assert.equal(result.asset.approvalStatus, 'APPROVED');
  assert.equal(result.keyframe.status, 'APPROVED');
});

test('20. rejectGeneratedKeyframe rejects the asset and marks the keyframe REJECTED', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);
  const generated = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);

  const result = kfgen.rejectGeneratedKeyframe(project.id, keyframe.keyframeId, generated.asset.assetId, { decidedBy: 'tester', reason: 'wrong pose' });
  assert.equal(result.ok, true);
  assert.equal(result.asset.approvalStatus, 'REJECTED');
  assert.equal(result.keyframe.status, 'REJECTED');
});

test('21. a rejected generation remains fully visible in history — nothing is ever deleted', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);
  const generated = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);
  kfgen.rejectGeneratedKeyframe(project.id, keyframe.keyframeId, generated.asset.assetId, { decidedBy: 'tester' });

  const history = kfgen.listKeyframeGenerations(project.id, keyframe.keyframeId);
  assert.equal(history.length, 1);
  assert.equal(history[0].id, generated.job.id);
  assert.equal(history[0].asset.approvalStatus, 'REJECTED');
  assert.ok(timelineStore.getAsset(project.id, generated.asset.assetId), 'the rejected asset itself must still exist');
});

test('approving/rejecting an asset that does not belong to this keyframe is refused', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);
  const generated = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);

  const result = kfgen.approveGeneratedKeyframe(project.id, 'some-other-keyframe-id', generated.asset.assetId, {});
  assert.equal(result.ok, false);
});

// --- 22. regeneration requires explicit action --------------------------------------------

test('22. calling generateKeyframe again after completion creates a genuinely NEW attempt, never automatically', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);
  const first = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);
  assert.equal(first.ok, true);

  // No timer, no automatic retry: a second EXPLICIT call is required, and
  // it must create a distinct job (the first is no longer in flight).
  const second = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);
  assert.equal(second.ok, true);
  assert.notEqual(second.job.id, first.job.id);
  assert.equal(kfgen.listKeyframeGenerations(project.id, keyframe.keyframeId).length, 2);
});

// --- 27/28. zero provider calls / zero budget mutation when blocked ------------------------

test('27/28. every blocked pre-check leaves the project credit ledger completely unchanged', async () => {
  const { project, keyframe } = buildFixture(); // no approval requested at all
  const before = JSON.stringify(projectStore.getProject(project.id).creditLedger);

  await kfgen.generateKeyframe(project.id, keyframe.keyframeId, FAST_POLL);

  const after = JSON.stringify(projectStore.getProject(project.id).creditLedger);
  assert.equal(after, before);
});

// --- canGenerateKeyframe: read-only eligibility check --------------------------------------

test('canGenerateKeyframe reports the same reasons as generateKeyframe, without creating anything', async () => {
  const { project, keyframe } = buildFixture();
  const check = kfgen.canGenerateKeyframe(project.id, keyframe.keyframeId);
  assert.equal(check.allowed, false);
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, 0);
});

// --- safety: no forbidden imports -----------------------------------------------------------

test('services/keyframe-generation-service.js imports generation-service.js ONLY for its IN_FLIGHT_STATUSES constant, and never imports the VIDEO-specific EvoLink provider/mapper or approval-gate video-submission paths', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'keyframe-generation-service.js'), 'utf8');
  const requireStatements = [...text.matchAll(/require\(\s*['"`][^'"`]+['"`]\s*\)/g)].map((m) => m[0]);
  // Stage 16 intentionally requires providers/evolink/evolink-image-provider
  // (the IMAGE adapter) — what must never happen is requiring the VIDEO
  // provider/mapper, which would mean this file duplicating (or bypassing)
  // generation-service.js's own video generation path.
  assert.ok(!requireStatements.some((r) => r.includes("providers/evolink/evolink-provider'")), 'must never require the video-specific EvoLink provider');
  assert.ok(!requireStatements.some((r) => r.includes("providers/evolink/evolink-mapper'")), 'must never require the video-specific EvoLink mapper');
  assert.ok(requireStatements.some((r) => r.includes('providers/evolink/evolink-image-provider')), 'Stage 16: must require the real EvoLink IMAGE provider');
  // Only the destructuring import line should mention these two names —
  // check there's no actual CALL syntax (a `.` member-call or bare
  // invocation) anywhere in the file, ignoring the doc-comment prose above
  // that explains this very rule.
  assert.doesNotMatch(text, /\.requestGeneration\(|\.checkGenerationOnce\(/, 'must never call the video-specific generation functions');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.ok(requires.includes('./generation-service'), 'the only expected use of generation-service.js is importing IN_FLIGHT_STATUSES');
});

// --- Stage 16: provider registry -------------------------------------------------------------

test('Stage 16: IMAGE_PROVIDERS registers both fake-image and evolink-image, but DEFAULT_PROVIDER_NAME stays fake-image', () => {
  assert.deepEqual(Object.keys(kfgen.IMAGE_PROVIDERS).sort(), ['evolink-image', 'fake-image']);
  assert.equal(kfgen.DEFAULT_PROVIDER_NAME, 'fake-image');
});

test('Stage 16: generateKeyframe only reaches the real EvoLink provider when providerName is explicitly "evolink-image" — every existing caller (no providerName passed) is completely unaffected', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);
  gate.setBudget(project, 100);

  let realProviderCalled = false;
  const spyEvolinkProvider = {
    createImageGeneration: async () => {
      realProviderCalled = true;
      throw new Error('should never be reached by the default call');
    },
    getGenerationStatus: async () => {
      throw new Error('should never be reached');
    },
  };

  // Default call (no providerName) must route to fake-image, never touch
  // the injected "evolink-image" stand-in.
  const result = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, {
    ...FAST_POLL,
    providers: { 'fake-image': fakeImageProvider, 'evolink-image': spyEvolinkProvider },
  });
  assert.equal(result.ok, true);
  assert.equal(realProviderCalled, false, 'the real/injected evolink-image provider must never be called unless explicitly requested');
});

test('Stage 16: generateKeyframe with providerName "evolink-image" reaches only that provider, passing imageParameters through to it', async () => {
  const { project, keyframe, pkg } = buildFixture();
  approve(project.id, keyframe.keyframeId, pkg);
  gate.setBudget(project, 100);

  let receivedRequest;
  const spyEvolinkProvider = {
    createImageGeneration: async (request) => {
      receivedRequest = request;
      return { generationId: 'fake-task-1', provider: 'evolink-image', model: 'gemini-3-pro-image-preview', status: 'COMPLETED', progress: 100, reservedCost: 0, results: ['https://fake-image-provider.local/fixtures/sample-keyframe.png'], error: null };
    },
    getGenerationStatus: async () => {
      throw new Error('COMPLETED on submission — polling must not be reached in this test');
    },
    fakeFetchImpl: fakeImageProvider.fakeFetchImpl,
  };

  const result = await kfgen.generateKeyframe(project.id, keyframe.keyframeId, {
    ...FAST_POLL,
    providerName: 'evolink-image',
    imageParameters: { model: 'gemini-3-pro-image-preview', size: 'auto', quality: '1K' },
    providers: { 'fake-image': fakeImageProvider, 'evolink-image': spyEvolinkProvider },
  });

  assert.equal(result.ok, true);
  assert.equal(result.job.provider, 'evolink-image');
  assert.deepEqual(receivedRequest.parameters, { model: 'gemini-3-pro-image-preview', size: 'auto', quality: '1K' });
});

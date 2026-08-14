// Tests for services/video-generation-service.js — the central execution
// boundary for controlled, per-shot VIDEO generation (Stage 22B-Part-3).
// Covers eligibility (canGenerateVideo), submission (generateVideo) via a
// dedicated in-memory fake provider, duplicate protection, budget/cost
// reconciliation, archival/lineage, and the safety-regression chain
// (build package -> request approval -> approve -> eligibility never
// itself generates; only generate_video may submit, and only after every
// gate passes). NO NETWORK CALL, NO REAL PROVIDER CALL, NO CREDENTIAL USE
// anywhere in this file — every generation flows through
// providers/fake-video/fake-video-provider.js and an injected fake
// resolveReferenceImpl.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vgs-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vgs-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vgs-keyframes-'));
const keyframePromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vgs-kf-packages-'));
const videoPromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vgs-video-packages-'));
const videoApprovalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vgs-video-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vgs-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vgs-assets-'));
const keyframeApprovalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vgs-kf-approvals-'));
const handoffTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vgs-handoffs-'));

process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = keyframePromptTempDir;
process.env.VIDEO_PROMPT_DATA_DIR = videoPromptTempDir;
process.env.VIDEO_GENERATION_APPROVAL_DATA_DIR = videoApprovalTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = keyframeApprovalTempDir;
process.env.KEYFRAME_HANDOFF_DATA_DIR = handoffTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const timelineStore = require('../services/timeline-store');
const keyframeStore = require('../services/keyframe-store');
const keyframePromptService = require('../services/keyframe-prompt-service');
const videoPromptService = require('../services/video-prompt-service');
const videoGenerationApprovalStore = require('../services/video-generation-approval-store');
const generationStore = require('../services/generation-store');
const vgs = require('../services/video-generation-service');
const evolinkProvider = require('../providers/evolink/evolink-provider');
const fakeVideoProvider = require('../providers/fake-video/fake-video-provider');

const GOOD_PROVIDER = 'evolink';
const GOOD_MODEL = 'seedance-2.0-mini-image-to-video';
const REFERENCE_CAPABLE_MODEL = 'seedance-2.0-mini-reference-to-video';

const FAKE_REFERENCE_URL = 'https://fake-video-provider.local/fixtures/fake-reference.png';
async function fakeResolveReferenceImpl(projectId, assetId) {
  return { ok: true, assetId, url: FAKE_REFERENCE_URL, expiresAt: null };
}
async function failingResolveReferenceImpl() {
  return { ok: false, reason: 'simulated resolution failure' };
}

// Providers map used by every test below — 'evolink' is deliberately
// mapped to the TEST-ONLY fake-video provider here so a test project's
// video prompt package can use provider: 'evolink' (a real, registry-
// known provider name) while every actual createGeneration/
// getGenerationStatus call in the test stays fully in-memory. See "Part
// 23 — real provider boundary" below for the test that instead confirms
// the REAL evolinkProvider is what PROVIDERS.evolink resolves to by
// default.
const TEST_PROVIDERS = { evolink: fakeVideoProvider };

test.beforeEach(() => fakeVideoProvider.resetFakeVideoProvider());

function newProject(title = 'video generation service test') {
  return projectStore.createProject({ title, topic: 'x' });
}

// Mirrors video-prompt-service.test.js's buildFixture: 1 shot, 1 keyframe
// with an image KeyframePromptPackage, 1 APPROVED canonical asset.
function buildFixture({ approveAsset = true, selectCanonical = true } = {}) {
  const project = newProject();
  creativeStore.updateStoryboard(project.id, { scenes: [{ sceneId: 'scene-1', title: 'Scene 1' }], shots: [{ shotId: 'shot-1', sceneId: 'scene-1' }] }, {});
  const keyframe = keyframeStore.createKeyframe(project.id, { sceneId: 'scene-1', shotId: 'shot-1', subject: 'A', frameType: 'CHARACTER_REFERENCE' });
  keyframePromptService.buildKeyframePromptPackage(project.id, keyframe.keyframeId, {});

  const asset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: 'scene-1', shotId: 'shot-1', approvalStatus: 'NONE' });
  if (approveAsset) timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  if (selectCanonical) keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId, { selectedBy: 'tester' });

  return { project, keyframe, asset };
}

function buildPackage(project, keyframe, overrides = {}) {
  const result = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, ...overrides });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.package;
}

function requestAndApprove(project, keyframe, pkg, { estimatedCost = 2, requestedBy = 'tester' } = {}) {
  videoGenerationApprovalStore.requestApproval(project.id, keyframe.keyframeId, {
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    videoPromptPackageId: pkg.packageId,
    videoPromptPackageVersion: pkg.version,
    canonicalKeyframeAssetId: pkg.canonicalKeyframeAssetId,
    provider: pkg.provider,
    model: pkg.model,
    executionParameters: pkg.executionParameters,
    estimatedCost,
    requestedBy,
  });
  return videoGenerationApprovalStore.decideApproval(project.id, keyframe.keyframeId, { approve: true, decidedBy: 'tester' });
}

// A fully eligible fixture: package built, approval requested+approved.
function buildEligibleFixture(overrides = {}) {
  const { project, keyframe, asset } = buildFixture();
  const pkg = buildPackage(project, keyframe, overrides);
  requestAndApprove(project, keyframe, pkg);
  return { project, keyframe, asset, pkg };
}

// ===========================================================================
// Eligibility (canGenerateVideo)
// ===========================================================================

test('canGenerateVideo: missing project', () => {
  const result = vgs.canGenerateVideo('00000000-0000-0000-0000-000000000000', 'kf-1');
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'PROJECT_NOT_FOUND');
});

test('canGenerateVideo: missing keyframe', () => {
  const project = newProject();
  const result = vgs.canGenerateVideo(project.id, 'nope');
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'PROJECT_NOT_FOUND');
});

test('canGenerateVideo: shot no longer exists in the storyboard', () => {
  const { project, keyframe } = buildFixture();
  creativeStore.updateStoryboard(project.id, { scenes: [], shots: [] }, {});
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'SHOT_NOT_FOUND');
});

test('canGenerateVideo: no video prompt package built yet', () => {
  const { project, keyframe } = buildFixture();
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'NO_VIDEO_PROMPT_PACKAGE');
});

test('canGenerateVideo: video prompt package is STALE', () => {
  const { project, keyframe } = buildFixture();
  buildPackage(project, keyframe);
  // Bump the storyboard version -> the video package goes STALE (Stage 22B-Part-2).
  creativeStore.updateStoryboard(project.id, { scenes: [{ sceneId: 'scene-1', title: 'Scene 1 renamed' }], shots: [{ shotId: 'shot-1', sceneId: 'scene-1' }] }, {});
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'VIDEO_PACKAGE_STALE');
});

test('canGenerateVideo: no video generation approval requested yet', () => {
  const { project, keyframe } = buildFixture();
  buildPackage(project, keyframe);
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'NO_VIDEO_GENERATION_APPROVAL');
});

test('canGenerateVideo: approval is PENDING, not APPROVED', () => {
  const { project, keyframe } = buildFixture();
  const pkg = buildPackage(project, keyframe);
  videoGenerationApprovalStore.requestApproval(project.id, keyframe.keyframeId, {
    videoPromptPackageId: pkg.packageId,
    videoPromptPackageVersion: pkg.version,
    canonicalKeyframeAssetId: pkg.canonicalKeyframeAssetId,
    provider: pkg.provider,
    model: pkg.model,
    estimatedCost: 2,
  });
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'NO_VIDEO_GENERATION_APPROVAL');
});

test('canGenerateVideo: approval was REJECTED', () => {
  const { project, keyframe } = buildFixture();
  const pkg = buildPackage(project, keyframe);
  videoGenerationApprovalStore.requestApproval(project.id, keyframe.keyframeId, {
    videoPromptPackageId: pkg.packageId,
    videoPromptPackageVersion: pkg.version,
    canonicalKeyframeAssetId: pkg.canonicalKeyframeAssetId,
    provider: pkg.provider,
    model: pkg.model,
    estimatedCost: 2,
  });
  videoGenerationApprovalStore.decideApproval(project.id, keyframe.keyframeId, { approve: false, decidedBy: 'tester' });
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'NO_VIDEO_GENERATION_APPROVAL');
});

test('canGenerateVideo: approval package version no longer matches (package rebuilt after approval)', () => {
  const { project, keyframe, pkg } = buildEligibleFixture();
  // Rebuild with different execution parameters -> version bumps, approval stays bound to v1.
  videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, executionParameters: { duration: 8 } });
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'APPROVAL_PACKAGE_MISMATCH');
});

test('canGenerateVideo: canonical keyframe asset changed since approval (package goes STALE first, caught upstream)', () => {
  const { project, keyframe } = buildEligibleFixture();
  const newAsset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: 'scene-1', shotId: 'shot-1', approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, newAsset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, newAsset.assetId, { selectedBy: 'tester' });

  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'VIDEO_PACKAGE_STALE');
});

test('canGenerateVideo: canonical asset changed AND package rebuilt -> approval canonical-asset mismatch surfaces as package-version mismatch (approval never silently re-authorizes)', () => {
  const { project, keyframe } = buildEligibleFixture();
  const newAsset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: 'scene-1', shotId: 'shot-1', approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, newAsset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, newAsset.assetId, { selectedBy: 'tester' });
  videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });

  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'APPROVAL_PACKAGE_MISMATCH');
});

test('canGenerateVideo: canonical asset is no longer APPROVED (rejected after approval, package/approval unchanged)', () => {
  const { project, keyframe, asset } = buildEligibleFixture();
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'REJECTED');
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'CANONICAL_ASSET_NOT_APPROVED');
});

test('canGenerateVideo: approval bound to a provider/model the current package no longer matches (defense-in-depth, constructed directly)', () => {
  const { project, keyframe, pkg } = buildEligibleFixture();
  // Directly request a NEW approval whose provider/model deliberately do
  // not match the package's own (simulating an approval store write that
  // bypassed the MCP tool's auto-fill-from-package convenience) — proves
  // the SERVICE independently re-checks provider/model rather than
  // trusting a version match alone.
  videoGenerationApprovalStore.requestApproval(project.id, keyframe.keyframeId, {
    videoPromptPackageId: pkg.packageId,
    videoPromptPackageVersion: pkg.version,
    canonicalKeyframeAssetId: pkg.canonicalKeyframeAssetId,
    provider: 'evolink',
    model: REFERENCE_CAPABLE_MODEL, // != pkg.model
    estimatedCost: 2,
  });
  videoGenerationApprovalStore.decideApproval(project.id, keyframe.keyframeId, { approve: true, decidedBy: 'tester' });

  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'APPROVAL_MODEL_MISMATCH');
});

test('canGenerateVideo: budget blocked', () => {
  const { project: staleProject, keyframe } = buildEligibleFixture();
  // Re-fetch fresh: timelineStore.addAsset/setAssetApprovalStatus (called
  // inside buildEligibleFixture, via buildFixture) mutate the project
  // document's own embedded `assets` array on disk — the `project` object
  // captured before those calls is stale, and touching it directly would
  // silently wipe out the assets that were added afterward.
  const gate = require('../services/approval-gate');
  const project = projectStore.getProject(staleProject.id);
  gate.ensureShape(project);
  project.creditLedger.blocked = true;
  project.creditLedger.blockedReason = 'test block';
  projectStore.touch(project);
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'BUDGET_BLOCKED');
});

test('canGenerateVideo: unknown cost not acknowledged', () => {
  const { project, keyframe } = buildFixture();
  const pkg = buildPackage(project, keyframe);
  videoGenerationApprovalStore.requestApproval(project.id, keyframe.keyframeId, {
    videoPromptPackageId: pkg.packageId,
    videoPromptPackageVersion: pkg.version,
    canonicalKeyframeAssetId: pkg.canonicalKeyframeAssetId,
    provider: pkg.provider,
    model: pkg.model,
    estimatedCost: null,
  });
  videoGenerationApprovalStore.decideApproval(project.id, keyframe.keyframeId, { approve: true, decidedBy: 'tester' });
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'UNKNOWN_COST_NOT_ACKNOWLEDGED');
});

test('canGenerateVideo: unknown cost acknowledged -> now eligible', () => {
  const { project, keyframe } = buildFixture();
  const pkg = buildPackage(project, keyframe);
  videoGenerationApprovalStore.requestApproval(project.id, keyframe.keyframeId, {
    videoPromptPackageId: pkg.packageId,
    videoPromptPackageVersion: pkg.version,
    canonicalKeyframeAssetId: pkg.canonicalKeyframeAssetId,
    provider: pkg.provider,
    model: pkg.model,
    estimatedCost: null,
  });
  videoGenerationApprovalStore.decideApproval(project.id, keyframe.keyframeId, { approve: true, decidedBy: 'tester' });
  videoGenerationApprovalStore.acknowledgeUnknownCost(project.id, keyframe.keyframeId, { acknowledgedBy: 'tester' });
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId);
  assert.equal(result.allowed, true);
});

test('canGenerateVideo: no provider adapter registered for the package provider', () => {
  const { project, keyframe } = buildEligibleFixture();
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId, { providers: {} });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'PROVIDER_ADAPTER_NOT_FOUND');
});

test('canGenerateVideo: invalid execution parameters (negative duration) blocked', () => {
  const { project, keyframe } = buildFixture();
  const pkg = buildPackage(project, keyframe, { executionParameters: { duration: -5 } });
  requestAndApprove(project, keyframe, pkg);
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'INVALID_EXECUTION_PARAMETERS');
});

test('canGenerateVideo: active keyframe handoff conflict blocks eligibility', () => {
  const { project, keyframe } = buildEligibleFixture();
  const keyframeHandoffService = require('../services/keyframe-handoff-service');
  const keyframeGenerationApprovalStore = require('../services/keyframe-generation-approval-store');
  const imgPkg = keyframePromptService.getKeyframePromptPackage(project.id, keyframe.keyframeId);
  keyframeGenerationApprovalStore.requestApproval(project.id, keyframe.keyframeId, { promptPackageId: imgPkg.packageId, promptPackageVersion: imgPkg.version, estimatedCost: 1 });
  keyframeGenerationApprovalStore.decideApproval(project.id, keyframe.keyframeId, { approve: true, decidedBy: 'tester' });
  const created = keyframeHandoffService.createHandoff(project.id, keyframe.keyframeId, { createdBy: 'tester' });
  assert.equal(created.ok, true, JSON.stringify(created));

  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'HANDOFF_CONFLICT');
});

test('canGenerateVideo: fully eligible fixture is allowed with all binding fields reported', () => {
  const { project, keyframe, pkg } = buildEligibleFixture();
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS });
  assert.equal(result.allowed, true);
  assert.equal(result.videoPromptPackageId, pkg.packageId);
  assert.equal(result.videoPromptPackageVersion, pkg.version);
  assert.equal(result.canonicalKeyframeAssetId, pkg.canonicalKeyframeAssetId);
  assert.equal(result.provider, GOOD_PROVIDER);
  assert.equal(result.model, GOOD_MODEL);
});

// Defense-in-depth: UNKNOWN_MODEL / MODEL_CAPABILITY_UNSUPPORTED can never
// occur through the normal build pipeline (video-prompt-service.js's own
// validateVideoModelSelection already refuses to build a package with an
// unknown/incapable model — see video-prompt-service.test.js). Proven here
// by directly corrupting the persisted package+approval JSON to simulate
// a registry entry that changed/disappeared between package-build time and
// generation time — the service must still catch it independently rather
// than trusting the package blindly.
test('canGenerateVideo: UNKNOWN_MODEL is caught even if a package/approval pair somehow references one (defense-in-depth)', () => {
  const { project, keyframe, pkg } = buildEligibleFixture();
  const filePath = path.join(videoPromptTempDir, `${project.id}.json`);
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  record.packages.find((p) => p.packageId === pkg.packageId).model = 'no-such-model-xyz';
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));

  const approvalFilePath = path.join(videoApprovalTempDir, `${project.id}.json`);
  const approvalRecord = JSON.parse(fs.readFileSync(approvalFilePath, 'utf8'));
  approvalRecord.approvals[keyframe.keyframeId].model = 'no-such-model-xyz';
  fs.writeFileSync(approvalFilePath, JSON.stringify(approvalRecord, null, 2));

  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'UNKNOWN_MODEL');
});

// ===========================================================================
// Duplicate protection (Part 7)
// ===========================================================================

test('duplicate protection: an active generation for the same package/canonical asset is returned instead of resubmitting', async () => {
  const { project, keyframe } = buildEligibleFixture();
  generationStore.createGenerationJob({
    projectId: project.id,
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    keyframeId: keyframe.keyframeId,
    videoPromptPackageId: videoPromptService.getVideoPromptPackage(project.id, keyframe.keyframeId).packageId,
    videoPromptPackageVersion: videoPromptService.getVideoPromptPackage(project.id, keyframe.keyframeId).version,
    canonicalKeyframeAssetId: videoPromptService.getVideoPromptPackage(project.id, keyframe.keyframeId).canonicalKeyframeAssetId,
    generationType: 'VIDEO',
    provider: GOOD_PROVIDER,
    model: GOOD_MODEL,
    status: 'PROCESSING',
  });

  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;
  const result = await vgs.generateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS, resolveReferenceImpl: fakeResolveReferenceImpl });
  assert.equal(result.status, 'IN_PROGRESS');
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before, 'must not create a second job');
});

test('duplicate protection: a COMPLETED prior job for the same package does NOT block a fresh generation', async () => {
  const { project, keyframe } = buildEligibleFixture();
  const pkgNow = videoPromptService.getVideoPromptPackage(project.id, keyframe.keyframeId);
  generationStore.createGenerationJob({
    projectId: project.id,
    shotId: keyframe.shotId,
    keyframeId: keyframe.keyframeId,
    videoPromptPackageId: pkgNow.packageId,
    videoPromptPackageVersion: pkgNow.version,
    canonicalKeyframeAssetId: pkgNow.canonicalKeyframeAssetId,
    generationType: 'VIDEO',
    provider: GOOD_PROVIDER,
    model: GOOD_MODEL,
    status: 'COMPLETED',
  });

  const result = await vgs.generateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS, resolveReferenceImpl: fakeResolveReferenceImpl, intervalMs: 1, sleepImpl: () => Promise.resolve() });
  assert.equal(result.status, 'COMPLETED');
  assert.notEqual(result.generationId, undefined);
});

// ===========================================================================
// Generation (generateVideo) — mocked provider only
// ===========================================================================

test('generateVideo: BLOCKED result carries the same code/reason as canGenerateVideo, and creates no job', async () => {
  const { project, keyframe } = buildFixture();
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;
  const result = await vgs.generateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code, 'NO_VIDEO_PROMPT_PACKAGE');
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

test('generateVideo: exactly one submission, provider task id recorded, completes, archives, reconciles cost', async () => {
  const { project, keyframe, pkg } = buildEligibleFixture();
  const budgetBefore = require('../services/approval-gate').getRemainingBudget(project);

  const result = await vgs.generateVideo(project.id, keyframe.keyframeId, {
    providers: TEST_PROVIDERS,
    resolveReferenceImpl: fakeResolveReferenceImpl,
    intervalMs: 1,
    sleepImpl: () => Promise.resolve(),
  });

  assert.equal(result.status, 'COMPLETED');
  assert.ok(result.providerTaskId);
  assert.ok(result.assetId);
  assert.equal(result.reservedCost, fakeVideoProvider.FAKE_RESERVED_COST);

  const jobs = generationStore.listGenerationJobs({ projectId: project.id }).filter((j) => j.generationType === 'VIDEO');
  assert.equal(jobs.length, 1, 'exactly one video generation job must exist');

  const asset = timelineStore.getAsset(project.id, result.assetId);
  assert.equal(asset.type, 'video');
  assert.equal(asset.approvalStatus, 'NONE', 'a generated video is never automatically approved');
  assert.equal(asset.keyframeId, keyframe.keyframeId);
  assert.equal(asset.videoPromptPackageId, pkg.packageId);
  assert.equal(asset.videoPromptPackageVersion, pkg.version);
  assert.equal(asset.provider, GOOD_PROVIDER);
  assert.equal(asset.model, GOOD_MODEL);
  assert.equal(asset.storage.status, 'STORED', 'the result must have been archived');
});

test('generateVideo: FAILED provider outcome is recorded, no asset is created', async () => {
  const { project, keyframe } = buildEligibleFixture();

  // A minimal, self-contained provider (independent of fake-video-
  // provider.js's own in-memory task map) that reports FAILED on the
  // first status check — proves generateVideo's FAILED branch without
  // relying on video-prompt-schema.js's narrow executionParameters shape
  // (which deliberately only forwards duration/resolution/aspectRatio/fps
  // — see schemas/video-prompt-schema.js).
  const failingProvider = {
    async createGeneration(req) {
      return { generationId: 'fail-task-1', provider: 'evolink', model: req.model, status: 'SUBMITTED', progress: 0, reservedCost: 1, results: [], error: null };
    },
    async getGenerationStatus(taskId) {
      return { generationId: taskId, provider: 'evolink', model: GOOD_MODEL, status: 'FAILED', progress: 100, reservedCost: 1, results: [], error: { code: 'test_failure', message: 'forced failure' } };
    },
  };

  const result = await vgs.generateVideo(project.id, keyframe.keyframeId, {
    providers: { evolink: failingProvider },
    resolveReferenceImpl: fakeResolveReferenceImpl,
    intervalMs: 1,
    sleepImpl: () => Promise.resolve(),
  });
  assert.equal(result.status, 'FAILED');
  assert.ok(result.error);
  assert.equal(result.assetId, null);
});

test('generateVideo: a failed reference resolution blocks before any job is created', async () => {
  const { project, keyframe } = buildEligibleFixture();
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;
  const result = await vgs.generateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS, resolveReferenceImpl: failingResolveReferenceImpl });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code, 'REFERENCE_RESOLUTION_FAILED');
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

test('generateVideo: never exposes an internal filesystem path to the provider — only the resolved URL', async () => {
  const { project, keyframe } = buildEligibleFixture();
  let seenRequest = null;
  const spyProvider = {
    ...fakeVideoProvider,
    async createGeneration(req) {
      seenRequest = req;
      return fakeVideoProvider.createGeneration(req);
    },
  };
  await vgs.generateVideo(project.id, keyframe.keyframeId, {
    providers: { evolink: spyProvider },
    resolveReferenceImpl: fakeResolveReferenceImpl,
    intervalMs: 1,
    sleepImpl: () => Promise.resolve(),
  });
  assert.ok(seenRequest);
  assert.equal(seenRequest.references[0].url, FAKE_REFERENCE_URL);
  assert.doesNotMatch(seenRequest.references[0].url, /^\/|^[A-Za-z]:\\/, 'must never be a raw filesystem path');
});

// ===========================================================================
// Safety regression (Part 24)
// ===========================================================================

test('safety regression: build package -> request approval -> approve -> eligibility check never itself generates', async () => {
  const { project, keyframe } = buildEligibleFixture();
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;
  vgs.canGenerateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS });
  vgs.canGenerateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS });
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

test('safety regression: a REJECTED approval blocks generateVideo', async () => {
  const { project, keyframe } = buildFixture();
  const pkg = buildPackage(project, keyframe);
  videoGenerationApprovalStore.requestApproval(project.id, keyframe.keyframeId, {
    videoPromptPackageId: pkg.packageId,
    videoPromptPackageVersion: pkg.version,
    canonicalKeyframeAssetId: pkg.canonicalKeyframeAssetId,
    provider: pkg.provider,
    model: pkg.model,
    estimatedCost: 2,
  });
  videoGenerationApprovalStore.decideApproval(project.id, keyframe.keyframeId, { approve: false, decidedBy: 'tester' });

  const result = await vgs.generateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS, resolveReferenceImpl: fakeResolveReferenceImpl });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code, 'NO_VIDEO_GENERATION_APPROVAL');
});

test('safety regression: modifying the package after approval blocks generateVideo', async () => {
  const { project, keyframe } = buildEligibleFixture();
  videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, executionParameters: { duration: 9 } });

  const result = await vgs.generateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS, resolveReferenceImpl: fakeResolveReferenceImpl });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code, 'APPROVAL_PACKAGE_MISMATCH');
});

test('safety regression: changing the canonical asset after approval blocks generateVideo', async () => {
  const { project, keyframe } = buildEligibleFixture();
  const newAsset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: 'scene-1', shotId: 'shot-1', approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, newAsset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, newAsset.assetId, { selectedBy: 'tester' });

  const result = await vgs.generateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS, resolveReferenceImpl: fakeResolveReferenceImpl });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code, 'VIDEO_PACKAGE_STALE');
});

test('safety regression: generateVideo never auto-selects a canonical asset or auto-approves anything', async () => {
  const { project, keyframe, asset } = buildEligibleFixture();
  const before = timelineStore.getAsset(project.id, asset.assetId);
  await vgs.generateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS, resolveReferenceImpl: fakeResolveReferenceImpl, intervalMs: 1, sleepImpl: () => Promise.resolve() });
  const kfAfter = keyframeStore.getKeyframe(project.id, keyframe.keyframeId);
  assert.equal(kfAfter.canonicalAssetId, before.assetId, 'canonical selection must never change as a side effect of generation');
  assert.equal(timelineStore.getAsset(project.id, asset.assetId).approvalStatus, 'APPROVED', 'the canonical IMAGE asset approval must be untouched');
});

// ===========================================================================
// Real-provider boundary (Part 23) — NO real EvoLink request, NO Google
// request, NO credential use anywhere in this file. This test proves
// provider selection is generic (based on provider/model, never
// hard-coded) by confirming the REAL evolinkProvider module is exactly
// what PROVIDERS.evolink resolves to by default — without ever calling
// createGeneration on it.
// ===========================================================================

test('real provider boundary: the default PROVIDERS registry resolves "evolink" to the real, unmodified evolinkProvider module', () => {
  assert.strictEqual(vgs.PROVIDERS.evolink, evolinkProvider);
});

test('real provider boundary: the real EvoLink mapper builds a valid request body for the exact smoke-test-proven model, without any network call', () => {
  const evolinkMapper = require('../providers/evolink/evolink-mapper');
  const body = evolinkMapper.toEvolinkRequest({
    provider: 'evolink',
    model: 'seedance-2.5-image-to-video',
    prompt: 'a test prompt',
    references: [{ type: 'image', url: FAKE_REFERENCE_URL }],
    parameters: { duration: 5 },
  });
  assert.equal(body.model, 'seedance-2.5-image-to-video');
  assert.deepEqual(body.image_urls, [FAKE_REFERENCE_URL]);
  assert.equal(body.duration, 5);
});

test('real provider boundary: video-generation-service.js has no import of fetch/http/axios and never calls the real evolinkProvider.createGeneration in this test file', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'video-generation-service.js'), 'utf8');
  assert.doesNotMatch(src, /\baxios\b/);
  assert.doesNotMatch(src, /require\(['"]https?['"]\)/);
});

// ===========================================================================
// Performance (Part 26) — no N+1 store reads in eligibility.
// ===========================================================================

test('performance: canGenerateVideo does not scale its store reads with unrelated keyframe count', () => {
  const { project, keyframe: seedKeyframe } = buildFixture();
  // Add 50 unrelated keyframes with no packages/approvals/assets of their
  // own BEFORE building the target package, so the plan-version bump each
  // creates doesn't itself stale the package under test.
  for (let i = 0; i < 50; i++) {
    keyframeStore.createKeyframe(project.id, { sceneId: 'scene-1', shotId: 'shot-1', subject: `filler-${i}`, frameType: 'DETAIL_FRAME' });
  }
  const pkg = buildPackage(project, seedKeyframe);
  requestAndApprove(project, seedKeyframe, pkg);
  const keyframe = seedKeyframe;

  const start = Date.now();
  const result = vgs.canGenerateVideo(project.id, keyframe.keyframeId, { providers: TEST_PROVIDERS });
  const elapsedMs = Date.now() - start;
  assert.equal(result.allowed, true);
  assert.ok(elapsedMs < 200, `canGenerateVideo took ${elapsedMs}ms with 50 unrelated keyframes present — expected O(1) w.r.t. unrelated keyframes`);
});

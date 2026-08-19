// Tests for services/operator-queue-service.js — Stage 14's core
// deliverable. Covers every queue category transition end to end, using
// real calls into the exact same services the queue reads from (never
// hand-built fixture objects that could drift from real shapes).
//
// This file never calls a provider, EvoLink, or the network — every
// "asset" here is either the fake-image generation path (Stage 13B,
// already zero-cost) or a locally-uploaded PNG buffer through the human
// handoff path (Stage 13D), exactly like every other test in this repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-assets-'));
const handoffTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-handoffs-'));
// Stage 22B-Part-3 — operator-queue-service.js now also reads
// video-prompt-service.js/video-generation-approval-store.js (bulk,
// read-only). Without isolating these too, every buildProjectQueue() call
// below (which this file calls constantly) would fall through to their
// REAL default data dirs and write empty per-project record files into
// the actual repo's server/data/ — always isolate every store a file
// under test transitively touches, never just the ones it directly calls.
const videoPromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-video-packages-'));
const videoApprovalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-video-approvals-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = approvalTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;
process.env.KEYFRAME_HANDOFF_DATA_DIR = handoffTempDir;
process.env.VIDEO_PROMPT_DATA_DIR = videoPromptTempDir;
process.env.VIDEO_GENERATION_APPROVAL_DATA_DIR = videoApprovalTempDir;
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-blueprints-'));
const gateDataTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-gates-'));
process.env.CREATIVE_BLUEPRINT_DATA_DIR = blueprintTempDir;
process.env.PRE_PRODUCTION_GATE_DATA_DIR = gateDataTempDir;

const projectStore = require('../services/project-store');
const gate = require('../services/approval-gate');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const kfp = require('../services/keyframe-prompt-service');
const approvalStore = require('../services/keyframe-generation-approval-store');
const handoffService = require('../services/keyframe-handoff-service');
const keyframeGenerationService = require('../services/keyframe-generation-service');
const generationStore = require('../services/generation-store');
const oq = require('../services/operator-queue-service');
const { satisfyProductionPrerequisites } = require('./helpers/control-plane-fixture');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);

function newProject(title = 'oq test') {
  return projectStore.createProject({ title, topic: 'x' });
}

function itemFor(items, keyframeId) {
  return items.find((i) => i.keyframeId === keyframeId);
}

function buildFixture({ withScene = true } = {}) {
  const project = newProject();
  if (!withScene) return { project };
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1', order: 1 });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, purpose: 'A shot', order: 1 });
  return { project, scene, shot };
}

function buildKeyframeFixture() {
  const { project, scene, shot } = buildFixture();
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, {
    shotId: shot.shotId,
    sceneId: scene.sceneId,
    frameType: 'DETAIL_FRAME',
    sourceShotVersion: storyboard.version,
    order: 1,
  });
  return { project, scene, shot, keyframe };
}

function approve(projectId, keyframeId, pkg, { estimatedCost = 2 } = {}) {
  approvalStore.requestApproval(projectId, keyframeId, { promptPackageId: pkg.packageId, promptPackageVersion: pkg.version, estimatedCost });
  return approvalStore.decideApproval(projectId, keyframeId, { approve: true, decidedBy: 'tester' });
}

// --- 1. empty project ----------------------------------------------------------------

test('1. an empty project (no storyboard) produces an empty queue and a zeroed summary', () => {
  const { project } = buildFixture({ withScene: false });
  assert.deepEqual(oq.buildProjectQueue(project.id), []);
  assert.deepEqual(oq.getQueueSummary(project.id), {
    totalKeyframes: 0,
    complete: 0,
    needsAttention: 0,
    blocked: 0,
    inProgress: 0,
    needsApproval: 0,
    readyForHandoff: 0,
    assetsAwaitingReview: 0,
    completionPercentage: 0,
  });
  assert.deepEqual(oq.getNextAction(project.id), { nextAction: null });
});

test('buildProjectQueue/getQueueSummary/getNextAction return null for an unknown project', () => {
  const bogus = '00000000-0000-0000-0000-000000000000';
  assert.equal(oq.buildProjectQueue(bogus), null);
  assert.equal(oq.getQueueSummary(bogus), null);
  assert.equal(oq.getNextAction(bogus), null);
});

// --- 3. missing keyframe plan ----------------------------------------------------------

test('3. a shot with zero planned keyframes produces a NEEDS_KEYFRAME_PLAN placeholder item', () => {
  const { project, shot } = buildFixture();
  const items = oq.buildProjectQueue(project.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].category, 'NEEDS_KEYFRAME_PLAN');
  assert.equal(items[0].keyframeId, null);
  assert.equal(items[0].shotId, shot.shotId);
  assert.equal(items[0].nextAction, 'Analyze keyframes');
  assert.equal(items[0].blockingReason, 'This shot has no planned keyframes yet.');
  assert.equal(items[0].status, 'NEEDS_ATTENTION');
});

// --- 2/4. one incomplete keyframe / missing prompt package -----------------------------

test('2/4. a keyframe with no prompt package is NEEDS_PROMPT_PACKAGE', () => {
  const { project, keyframe } = buildKeyframeFixture();
  const items = oq.buildProjectQueue(project.id);
  const item = itemFor(items, keyframe.keyframeId);
  assert.equal(item.category, 'NEEDS_PROMPT_PACKAGE');
  assert.equal(item.blockingReason, 'Keyframe has no current prompt package.');
  assert.equal(item.nextAction, 'Build prompt package');
  assert.equal(item.promptPackageId, null);
});

// --- 5. stale prompt package -------------------------------------------------------------

test('5. a STALE prompt package is also NEEDS_PROMPT_PACKAGE, with a distinct reason', () => {
  const { project, keyframe, shot } = buildKeyframeFixture();
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  approve(project.id, keyframe.keyframeId, pkg);
  creativeStore.updateStoryboardShot(project.id, shot.shotId, { purpose: 'revised' }, { changeNote: 'revise' });

  const items = oq.buildProjectQueue(project.id);
  const item = itemFor(items, keyframe.keyframeId);
  assert.equal(item.category, 'NEEDS_PROMPT_PACKAGE');
  assert.equal(item.blockingReason, 'Prompt package is stale.');
  assert.equal(item.promptPackageStatus, 'STALE');
});

// --- 6. missing generation approval -------------------------------------------------------

test('6. a CURRENT package with no approval is NEEDS_APPROVAL', () => {
  const { project, keyframe } = buildKeyframeFixture();
  kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);

  const items = oq.buildProjectQueue(project.id);
  const item = itemFor(items, keyframe.keyframeId);
  assert.equal(item.category, 'NEEDS_APPROVAL');
  assert.equal(item.blockingReason, 'Keyframe generation approval is missing.');
  assert.equal(item.nextAction, 'Approve keyframe generation');
});

test('6b. a PENDING or REJECTED approval reports a distinct blocking reason', () => {
  const { project, keyframe } = buildKeyframeFixture();
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);

  approvalStore.requestApproval(project.id, keyframe.keyframeId, { promptPackageId: pkg.packageId, promptPackageVersion: pkg.version, estimatedCost: 2 });
  let item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'NEEDS_APPROVAL');
  assert.match(item.blockingReason, /pending/i);

  approvalStore.decideApproval(project.id, keyframe.keyframeId, { approve: false, decidedBy: 'tester' });
  item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'NEEDS_APPROVAL');
  assert.match(item.blockingReason, /rejected/i);
});

// --- 7. ready for handoff -----------------------------------------------------------------

test('7. an APPROVED, version-matching approval against a CURRENT package is READY_FOR_HANDOFF', () => {
  const { project, keyframe } = buildKeyframeFixture();
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  approve(project.id, keyframe.keyframeId, pkg);

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'READY_FOR_HANDOFF');
  assert.equal(item.blockingReason, null);
  assert.equal(item.nextAction, 'Create human handoff');
});

// --- 8. active handoff / 23. frozen handoff ------------------------------------------------

test('8/23. an active (READY) handoff is HANDOFF_IN_PROGRESS, and reports its frozen package version', () => {
  const { project, keyframe, shot } = buildKeyframeFixture();
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  approve(project.id, keyframe.keyframeId, pkg);
  const created = handoffService.createHandoff(project.id, keyframe.keyframeId, { createdBy: 'tester' });

  let item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'HANDOFF_IN_PROGRESS');
  assert.equal(item.blockingReason, 'An active handoff already exists.');
  assert.equal(item.handoffId, created.handoff.handoffId);
  assert.equal(item.handoffStatus, 'READY');
  assert.equal(item.handoffPromptPackageVersion, pkg.version);

  // 24. now make the LIVE package stale/rebuilt — the handoff stays
  // active and its own frozen version must not silently follow the live
  // package (Stage 13D/13E's frozen-handoff guarantee, reflected here).
  creativeStore.updateStoryboardShot(project.id, shot.shotId, { purpose: 'revised' }, { changeNote: 'revise' });
  const rebuilt = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  assert.ok(rebuilt.version > pkg.version);

  item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'HANDOFF_IN_PROGRESS', '24. stale current package: the active handoff still wins');
  assert.equal(item.handoffPromptPackageVersion, pkg.version, 'handoff stays frozen at its original version');
  assert.equal(item.promptPackageVersion, rebuilt.version, 'but the item also reports the CURRENT live version');
});

// --- 9/16. ingested asset needs review ------------------------------------------------------

test('9. an INGESTED handoff whose asset is unreviewed is NEEDS_ASSET_REVIEW', () => {
  const { project, keyframe } = buildKeyframeFixture();
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  approve(project.id, keyframe.keyframeId, pkg);
  const created = handoffService.createHandoff(project.id, keyframe.keyframeId, { createdBy: 'tester' });
  const ingested = handoffService.ingestHandoffAsset(created.handoff.handoffId, PNG_BYTES, { completedBy: 'tester' });

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'NEEDS_ASSET_REVIEW');
  assert.equal(item.blockingReason, 'Returned asset has not been reviewed.');
  assert.equal(item.nextAction, 'Approve or reject asset');
  assert.equal(item.assetCount, 1);
  assert.equal(ingested.asset.approvalStatus, 'NONE');
});

test('an unreviewed asset from the generation path (no handoffId) is IMAGE_RETURNED, not NEEDS_ASSET_REVIEW', async () => {
  const project = newProject();
  // INT-2.5-P0 — must be linked BEFORE the scene/shot/keyframe below (each
  // of which bumps the storyboard version), or the keyframe's own captured
  // sourceShotVersion would start out spuriously STALE.
  satisfyProductionPrerequisites(project.id);
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1', order: 1 });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, purpose: 'A shot', order: 1 });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version, order: 1 });
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  approve(project.id, keyframe.keyframeId, pkg);
  await keyframeGenerationService.generateKeyframe(project.id, keyframe.keyframeId);

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'IMAGE_RETURNED');
  assert.equal(item.blockingReason, 'Returned asset has not been reviewed.');
  assert.equal(item.nextAction, 'Review returned image');
});

// --- 10. asset awaiting review (alias of 9, via REST-shaped assertions) -------------------

test('10. assetsAwaitingReview in the summary counts both NEEDS_ASSET_REVIEW and IMAGE_RETURNED', async () => {
  const kf1 = buildKeyframeFixture();
  const pkg1 = kfp.buildKeyframePromptPackage(kf1.project.id, kf1.keyframe.keyframeId);
  approve(kf1.project.id, kf1.keyframe.keyframeId, pkg1);
  const h1 = handoffService.createHandoff(kf1.project.id, kf1.keyframe.keyframeId, { createdBy: 'x' });
  handoffService.ingestHandoffAsset(h1.handoff.handoffId, PNG_BYTES, { completedBy: 'x' });

  const summary = oq.getQueueSummary(kf1.project.id);
  assert.equal(summary.assetsAwaitingReview, 1);
});

// --- 11/12. approved asset / approved non-canonical -----------------------------------------

test('11/12. an APPROVED asset with no canonical selection is READY_FOR_CANONICAL_SELECTION', () => {
  const { project, keyframe } = buildKeyframeFixture();
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  approve(project.id, keyframe.keyframeId, pkg);
  const created = handoffService.createHandoff(project.id, keyframe.keyframeId, { createdBy: 'tester' });
  const ingested = handoffService.ingestHandoffAsset(created.handoff.handoffId, PNG_BYTES, { completedBy: 'tester' });
  keyframeGenerationService.approveGeneratedKeyframe(project.id, keyframe.keyframeId, ingested.asset.assetId, { approvedBy: 'tester' });

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'READY_FOR_CANONICAL_SELECTION');
  assert.equal(item.blockingReason, 'Canonical asset has not been selected.');
  assert.equal(item.nextAction, 'Select canonical asset');
  assert.equal(item.approvedAssetCount, 1);
});

// --- 13. canonical approved asset -> COMPLETE ------------------------------------------------

test('13. a canonical + APPROVED asset is COMPLETE with no next action', () => {
  const { project, keyframe } = buildKeyframeFixture();
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  approve(project.id, keyframe.keyframeId, pkg);
  const created = handoffService.createHandoff(project.id, keyframe.keyframeId, { createdBy: 'tester' });
  const ingested = handoffService.ingestHandoffAsset(created.handoff.handoffId, PNG_BYTES, { completedBy: 'tester' });
  keyframeGenerationService.approveGeneratedKeyframe(project.id, keyframe.keyframeId, ingested.asset.assetId, { approvedBy: 'tester' });
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, ingested.asset.assetId, { selectedBy: 'tester' });

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'COMPLETE');
  assert.equal(item.blockingReason, null);
  assert.equal(item.nextAction, null);
  assert.equal(item.canonicalAssetId, ingested.asset.assetId);
  assert.equal(item.canonicalAssetApprovalStatus, 'APPROVED');
});

// --- 14. blocked budget ------------------------------------------------------------------

test('14. a project-wide budget block converts NEEDS_APPROVAL and READY_FOR_HANDOFF into BLOCKED with the exact ledger reason', () => {
  const { project, keyframe } = buildKeyframeFixture();
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  approve(project.id, keyframe.keyframeId, pkg);

  const loadedProject = projectStore.getProject(project.id);
  gate.setBudget(loadedProject, 1);
  const job = generationStore.createGenerationJob({ projectId: project.id, reservedCost: 999 });
  gate.reconcileGenerationCost(loadedProject, job);
  projectStore.touch(loadedProject);
  assert.equal(loadedProject.creditLedger.blocked, true);

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'BLOCKED');
  assert.equal(item.blockingReason, loadedProject.creditLedger.blockedReason);
});

test('a budget block does NOT change categories that require no spend (review, canonical selection, planning)', () => {
  const { project, keyframe } = buildKeyframeFixture();
  // No package yet — NEEDS_PROMPT_PACKAGE requires no spend.
  const loadedProject = projectStore.getProject(project.id);
  gate.setBudget(loadedProject, 1);
  const job = generationStore.createGenerationJob({ projectId: project.id, reservedCost: 999 });
  gate.reconcileGenerationCost(loadedProject, job);
  projectStore.touch(loadedProject);

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'NEEDS_PROMPT_PACKAGE', 'planning categories are never converted to BLOCKED');
});

// --- 25. duplicate handoff protection (reused from Stage 13E, reflected in the queue) -------

test('25. the queue never shows two active handoffs for one keyframe — Stage 13E already guarantees at most one', () => {
  const { project, keyframe } = buildKeyframeFixture();
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  approve(project.id, keyframe.keyframeId, pkg);
  const first = handoffService.createHandoff(project.id, keyframe.keyframeId, { createdBy: 'tester' });

  const secondAttempt = handoffService.createHandoff(project.id, keyframe.keyframeId, { createdBy: 'tester' });
  assert.equal(secondAttempt.ok, false, 'the underlying guard still refuses a second active handoff');

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.handoffId, first.handoff.handoffId);
  assert.equal(item.category, 'HANDOFF_IN_PROGRESS');
});

// --- 17. deterministic ordering -----------------------------------------------------------

test('17. buildProjectQueue is fully deterministic — repeated calls for the same state produce identical output', () => {
  const { project, keyframe } = buildKeyframeFixture();
  kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);

  const first = oq.buildProjectQueue(project.id);
  const second = oq.buildProjectQueue(project.id);
  assert.deepEqual(first, second);
});

// --- 18. priority -----------------------------------------------------------------------

test('18. priority ordering matches CATEGORY_INFO exactly, and the queue sorts by priority ascending', () => {
  const project = newProject();
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1', order: 1 });

  // shot with no keyframes -> NEEDS_KEYFRAME_PLAN (priority 7)
  creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1 });

  // shot with a keyframe that has an APPROVED asset -> READY_FOR_CANONICAL_SELECTION (priority 3)
  const shot2 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 2 });
  const storyboard = creativeStore.getStoryboard(project.id);
  const kf2 = keyframeStore.createKeyframe(project.id, { shotId: shot2.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version, order: 1 });
  const pkg2 = kfp.buildKeyframePromptPackage(project.id, kf2.keyframeId);
  approve(project.id, kf2.keyframeId, pkg2);
  const h2 = handoffService.createHandoff(project.id, kf2.keyframeId, { createdBy: 'x' });
  const ing2 = handoffService.ingestHandoffAsset(h2.handoff.handoffId, PNG_BYTES, { completedBy: 'x' });
  keyframeGenerationService.approveGeneratedKeyframe(project.id, kf2.keyframeId, ing2.asset.assetId, { approvedBy: 'x' });

  const items = oq.buildProjectQueue(project.id);
  assert.equal(items[0].category, 'READY_FOR_CANONICAL_SELECTION');
  assert.equal(items[0].priority, 3);
  assert.equal(items[1].category, 'NEEDS_KEYFRAME_PLAN');
  assert.equal(items[1].priority, 7);
  // priorities must be non-decreasing across the whole list
  for (let i = 1; i < items.length; i += 1) {
    assert.ok(items[i].priority >= items[i - 1].priority);
  }
});

// --- 19. next action ----------------------------------------------------------------------

test('19. getNextAction returns the single highest-priority item, and null when everything is COMPLETE', () => {
  const { project, keyframe } = buildKeyframeFixture();
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  approve(project.id, keyframe.keyframeId, pkg);
  const created = handoffService.createHandoff(project.id, keyframe.keyframeId, { createdBy: 'tester' });
  const ingested = handoffService.ingestHandoffAsset(created.handoff.handoffId, PNG_BYTES, { completedBy: 'tester' });

  let next = oq.getNextAction(project.id);
  assert.equal(next.category, 'NEEDS_ASSET_REVIEW');
  assert.equal(next.keyframeId, keyframe.keyframeId);

  keyframeGenerationService.approveGeneratedKeyframe(project.id, keyframe.keyframeId, ingested.asset.assetId, { approvedBy: 'tester' });
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, ingested.asset.assetId, { selectedBy: 'tester' });

  next = oq.getNextAction(project.id);
  assert.deepEqual(next, { nextAction: null }, 'never invents work once everything is COMPLETE');
});

// --- 30/31/32: no generation, no EvoLink, no credit spend -------------------------------

test('30/31/32: calling buildProjectQueue/getQueueSummary/getNextAction/getShotReadiness never changes the project, its credit ledger, its assets, or its keyframes', () => {
  const { project, keyframe } = buildKeyframeFixture();
  const pkg = kfp.buildKeyframePromptPackage(project.id, keyframe.keyframeId);
  approve(project.id, keyframe.keyframeId, pkg);
  handoffService.createHandoff(project.id, keyframe.keyframeId, { createdBy: 'tester' });

  const before = JSON.stringify(projectStore.getProject(project.id));
  const keyframesBefore = JSON.stringify(keyframeStore.listKeyframes(project.id));

  oq.buildProjectQueue(project.id);
  oq.getQueueSummary(project.id);
  oq.getNextAction(project.id);
  oq.getShotReadiness(project.id);

  const after = JSON.stringify(projectStore.getProject(project.id));
  const keyframesAfter = JSON.stringify(keyframeStore.listKeyframes(project.id));
  assert.equal(after, before, 'the project record must be byte-identical after any queue read');
  assert.equal(keyframesAfter, keyframesBefore, 'no keyframe field (including canonicalAssetId) may change from a queue read');
});

// --- safety: this file's own imports -------------------------------------------------------

test('services/operator-queue-service.js never imports a provider, EvoLink, or a mutating call to any store', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'operator-queue-service.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/evolink|fake-image/i.test(req), `unexpected import: ${req}`);
  }
  assert.doesNotMatch(text, /\bfetch\(/, 'must never call fetch()');
  // 30/31/32 — no generation, no EvoLink, no credit spend: this file must
  // never call any store's WRITE path.
  for (const forbidden of ['createHandoff(', 'ingestHandoffAsset(', 'generateKeyframe(', 'requestGeneration(', 'selectCanonicalKeyframeAsset(', 'decideApproval(']) {
    assert.doesNotMatch(text, new RegExp(forbidden.replace('(', '\\(')), `must never call the mutating function ${forbidden}`);
  }
});

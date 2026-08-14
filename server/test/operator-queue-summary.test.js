// Tests for Stage 14, Part 11/12 — getQueueSummary()'s project-level
// rollup, completionPercentage, and getShotReadiness()'s per-shot signal.
// completionPercentage must count ONLY canonical + APPROVED keyframes as
// complete — never "an image exists" (this is exactly why Stage 13E's
// canonical-asset work was a prerequisite for this stage).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqs-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqs-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqs-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqs-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqs-approvals-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqs-assets-'));
const handoffTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqs-handoffs-'));
// Stage 22B-Part-3 — operator-queue-service.js now also reads
// video-prompt-service.js/video-generation-approval-store.js; isolate
// both so this file's queue calls never fall through to the real repo
// data.
const videoPromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqs-video-packages-'));
const videoApprovalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqs-video-approvals-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = approvalTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;
process.env.KEYFRAME_HANDOFF_DATA_DIR = handoffTempDir;
process.env.VIDEO_PROMPT_DATA_DIR = videoPromptTempDir;
process.env.VIDEO_GENERATION_APPROVAL_DATA_DIR = videoApprovalTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const kfp = require('../services/keyframe-prompt-service');
const approvalStore = require('../services/keyframe-generation-approval-store');
const handoffService = require('../services/keyframe-handoff-service');
const keyframeGenerationService = require('../services/keyframe-generation-service');
const oq = require('../services/operator-queue-service');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);

function approve(projectId, keyframeId, pkg) {
  approvalStore.requestApproval(projectId, keyframeId, { promptPackageId: pkg.packageId, promptPackageVersion: pkg.version, estimatedCost: 2 });
  approvalStore.decideApproval(projectId, keyframeId, { approve: true, decidedBy: 'tester' });
}

function completeKeyframe(project, shot, scene, storyboard, order) {
  const kf = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version, order });
  const pkg = kfp.buildKeyframePromptPackage(project.id, kf.keyframeId);
  approve(project.id, kf.keyframeId, pkg);
  const handoff = handoffService.createHandoff(project.id, kf.keyframeId, { createdBy: 'x' });
  const ingested = handoffService.ingestHandoffAsset(handoff.handoff.handoffId, PNG_BYTES, { completedBy: 'x' });
  keyframeGenerationService.approveGeneratedKeyframe(project.id, kf.keyframeId, ingested.asset.assetId, { approvedBy: 'x' });
  keyframeStore.selectCanonicalKeyframeAsset(project.id, kf.keyframeId, ingested.asset.assetId, { selectedBy: 'x' });
  return kf;
}

function plainKeyframe(project, shot, scene, storyboard, order) {
  return keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version, order });
}

// --- 20/21. queue summary + completion percentage ------------------------------------------

test('20/21. getQueueSummary counts categories correctly and completionPercentage counts ONLY canonical+approved keyframes', () => {
  const project = projectStore.createProject({ title: 'summary test', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1', order: 1 });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1 });
  const storyboard = creativeStore.getStoryboard(project.id);

  completeKeyframe(project, shot, scene, storyboard, 1); // COMPLETE
  plainKeyframe(project, shot, scene, storyboard, 2); // NEEDS_PROMPT_PACKAGE — an "image exists" trap would wrongly count this if it only checked assetCount

  const summary = oq.getQueueSummary(project.id);
  assert.equal(summary.totalKeyframes, 2);
  assert.equal(summary.complete, 1);
  assert.equal(summary.completionPercentage, 50);
});

test('21b. completionPercentage is 0 (never NaN) for a project with keyframes but zero complete', () => {
  const project = projectStore.createProject({ title: 'zero complete', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1', order: 1 });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1 });
  const storyboard = creativeStore.getStoryboard(project.id);
  plainKeyframe(project, shot, scene, storyboard, 1);

  const summary = oq.getQueueSummary(project.id);
  assert.equal(summary.completionPercentage, 0);
  assert.ok(Number.isFinite(summary.completionPercentage));
});

test('an APPROVED asset that is NOT canonical does not count as complete, even though "an image exists"', () => {
  const project = projectStore.createProject({ title: 'approved not canonical', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1', order: 1 });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1 });
  const storyboard = creativeStore.getStoryboard(project.id);
  const kf = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version, order: 1 });
  const pkg = kfp.buildKeyframePromptPackage(project.id, kf.keyframeId);
  approve(project.id, kf.keyframeId, pkg);
  const handoff = handoffService.createHandoff(project.id, kf.keyframeId, { createdBy: 'x' });
  const ingested = handoffService.ingestHandoffAsset(handoff.handoff.handoffId, PNG_BYTES, { completedBy: 'x' });
  keyframeGenerationService.approveGeneratedKeyframe(project.id, kf.keyframeId, ingested.asset.assetId, { approvedBy: 'x' });
  // deliberately never select canonical

  const summary = oq.getQueueSummary(project.id);
  assert.equal(summary.complete, 0);
  assert.equal(summary.completionPercentage, 0);
});

// --- 22. shot readiness -------------------------------------------------------------------

test('22. getShotReadiness reports readyForVideo only once every planned keyframe for that shot is COMPLETE', () => {
  const project = projectStore.createProject({ title: 'shot readiness test', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1', order: 1 });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1 });
  const storyboard = creativeStore.getStoryboard(project.id);

  completeKeyframe(project, shot, scene, storyboard, 1);
  const second = plainKeyframe(project, shot, scene, storyboard, 2);

  let readiness = oq.getShotReadiness(project.id).find((r) => r.shotId === shot.shotId);
  assert.equal(readiness.keyframesRequired, 2);
  assert.equal(readiness.keyframesComplete, 1);
  assert.equal(readiness.keyframesMissing, 1);
  assert.equal(readiness.readyForVideo, false);

  // finish the second keyframe too
  const pkg2 = kfp.buildKeyframePromptPackage(project.id, second.keyframeId);
  approve(project.id, second.keyframeId, pkg2);
  const handoff2 = handoffService.createHandoff(project.id, second.keyframeId, { createdBy: 'x' });
  const ingested2 = handoffService.ingestHandoffAsset(handoff2.handoff.handoffId, PNG_BYTES, { completedBy: 'x' });
  keyframeGenerationService.approveGeneratedKeyframe(project.id, second.keyframeId, ingested2.asset.assetId, { approvedBy: 'x' });
  keyframeStore.selectCanonicalKeyframeAsset(project.id, second.keyframeId, ingested2.asset.assetId, { selectedBy: 'x' });

  readiness = oq.getShotReadiness(project.id).find((r) => r.shotId === shot.shotId);
  assert.equal(readiness.keyframesComplete, 2);
  assert.equal(readiness.keyframesMissing, 0);
  assert.equal(readiness.readyForVideo, true);
});

test('a shot with zero planned keyframes is never readyForVideo (reported as 0 required, not ready)', () => {
  const project = projectStore.createProject({ title: 'no keyframes shot', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1', order: 1 });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1 });

  const readiness = oq.getShotReadiness(project.id).find((r) => r.shotId === shot.shotId);
  assert.ok(readiness, 'the shot still gets a readiness entry, via its NEEDS_KEYFRAME_PLAN queue item');
  assert.equal(readiness.keyframesRequired, 0);
  assert.equal(readiness.readyForVideo, false, 'zero required keyframes is never "ready" — there is nothing to be ready');
});

test('getShotReadiness never starts, prepares, or references video generation — read-only signal only', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'operator-queue-service.js'), 'utf8');
  const fnStart = text.indexOf('function getShotReadiness');
  const fnEnd = text.indexOf('\nfunction ', fnStart + 1);
  const fnText = text.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.doesNotMatch(fnText, /generation-service|requestGeneration|evolink/i);
});

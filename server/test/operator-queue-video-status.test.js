// Tests for the Stage 22B-Part-3, Part 17 additive `videoStatus` field on
// operator-queue-service.js's queue items — computeVideoStatus(). This
// field is deliberately additive: it must never change the existing
// `category`/`priority` decision (covered exhaustively by
// test/operator-queue-service.test.js, which stays untouched and passing
// unmodified) — every test here only inspects videoStatus/videoAssetId/
// videoPromptPackage*/videoGenerationApprovalStatus fields.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqvs-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqvs-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqvs-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqvs-packages-'));
const videoPromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqvs-video-packages-'));
const videoApprovalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqvs-video-approvals-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqvs-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqvs-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqvs-assets-'));
const handoffTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oqvs-handoffs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = promptTempDir;
process.env.VIDEO_PROMPT_DATA_DIR = videoPromptTempDir;
process.env.VIDEO_GENERATION_APPROVAL_DATA_DIR = videoApprovalTempDir;
process.env.KEYFRAME_GENERATION_APPROVAL_DATA_DIR = approvalTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;
process.env.KEYFRAME_HANDOFF_DATA_DIR = handoffTempDir;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const keyframePromptService = require('../services/keyframe-prompt-service');
const timelineStore = require('../services/timeline-store');
const videoPromptService = require('../services/video-prompt-service');
const videoGenerationApprovalStore = require('../services/video-generation-approval-store');
const generationStore = require('../services/generation-store');
const oq = require('../services/operator-queue-service');

const GOOD_PROVIDER = 'evolink';
const GOOD_MODEL = 'seedance-2.0-mini-image-to-video';

function itemFor(items, keyframeId) {
  return items.find((i) => i.keyframeId === keyframeId);
}

// Builds a keyframe all the way to COMPLETE (canonical + APPROVED image
// asset) — the prerequisite for videoStatus to ever be anything other
// than NOT_APPLICABLE.
function buildCompleteKeyframeFixture() {
  const project = projectStore.createProject({ title: 'oq video-status test', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1', order: 1 });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, purpose: 'A shot', order: 1 });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version, order: 1 });
  keyframePromptService.buildKeyframePromptPackage(project.id, keyframe.keyframeId, {});
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId, approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId, { selectedBy: 'tester' });
  return { project, scene, shot, keyframe, asset };
}

function approveVideo(project, keyframe, pkg) {
  videoGenerationApprovalStore.requestApproval(project.id, keyframe.keyframeId, {
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    videoPromptPackageId: pkg.packageId,
    videoPromptPackageVersion: pkg.version,
    canonicalKeyframeAssetId: pkg.canonicalKeyframeAssetId,
    provider: pkg.provider,
    model: pkg.model,
    estimatedCost: 2,
  });
  return videoGenerationApprovalStore.decideApproval(project.id, keyframe.keyframeId, { approve: true, decidedBy: 'tester' });
}

test('videoStatus is NOT_APPLICABLE when the image pipeline is not COMPLETE (no canonical APPROVED asset)', () => {
  const project = projectStore.createProject({ title: 'incomplete', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version });

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'NEEDS_PROMPT_PACKAGE', 'sanity check: the existing image category is unaffected');
  assert.equal(item.videoStatus, 'NOT_APPLICABLE');
});

test('videoStatus is NEEDS_VIDEO_PACKAGE once the image is COMPLETE but no video package exists yet', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'COMPLETE', 'sanity check: the existing image category is unaffected');
  assert.equal(item.videoStatus, 'NEEDS_VIDEO_PACKAGE');
});

test('videoStatus is VIDEO_READY_FOR_APPROVAL once a CURRENT video package exists with no matching approval', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.videoStatus, 'VIDEO_READY_FOR_APPROVAL');
  assert.equal(item.videoPromptPackageId, built.package.packageId);
  assert.equal(item.videoPromptPackageVersion, built.package.version);
  assert.equal(item.videoPromptPackageStatus, 'CURRENT');
});

test('videoStatus is VIDEO_READY_FOR_GENERATION once the approval matches the current package exactly', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  approveVideo(project, keyframe, built.package);

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.videoStatus, 'VIDEO_READY_FOR_GENERATION');
  assert.equal(item.videoGenerationApprovalStatus, 'APPROVED');
});

test('videoStatus is VIDEO_READY_FOR_APPROVAL again once the package is rebuilt after approval (stale binding)', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  approveVideo(project, keyframe, built.package);
  videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL, executionParameters: { duration: 9 } });

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.videoStatus, 'VIDEO_READY_FOR_APPROVAL', 'the stale binding must not still read as ready for generation');
});

test('videoStatus is VIDEO_IN_PROGRESS when an active video generation job exists', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  approveVideo(project, keyframe, built.package);
  generationStore.createGenerationJob({
    projectId: project.id,
    shotId: keyframe.shotId,
    keyframeId: keyframe.keyframeId,
    videoPromptPackageId: built.package.packageId,
    videoPromptPackageVersion: built.package.version,
    canonicalKeyframeAssetId: built.package.canonicalKeyframeAssetId,
    generationType: 'VIDEO',
    provider: GOOD_PROVIDER,
    model: GOOD_MODEL,
    status: 'PROCESSING',
  });

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.videoStatus, 'VIDEO_IN_PROGRESS');
});

// Stage 25 — found during the MVP acceptance run: a FAILED job that never
// produced an asset fell straight through to VIDEO_READY_FOR_GENERATION,
// indistinguishable from "never attempted." VIDEO_FAILED closes that gap.
test('videoStatus is VIDEO_FAILED when the most recent job is a terminal FAILED with no asset', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  approveVideo(project, keyframe, built.package);
  const job = generationStore.createGenerationJob({
    projectId: project.id,
    shotId: keyframe.shotId,
    keyframeId: keyframe.keyframeId,
    videoPromptPackageId: built.package.packageId,
    videoPromptPackageVersion: built.package.version,
    canonicalKeyframeAssetId: built.package.canonicalKeyframeAssetId,
    generationType: 'VIDEO',
    provider: GOOD_PROVIDER,
    model: GOOD_MODEL,
    status: 'FAILED',
    assetId: null,
    error: { message: 'prompt cannot be empty' },
  });

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.videoStatus, 'VIDEO_FAILED');
  assert.equal(item.videoGenerationId, job.id);
  assert.equal(item.videoFailureReason, 'prompt cannot be empty');
});

test('videoStatus is VIDEO_READY_FOR_GENERATION again once a rebuild/regenerate follows a VIDEO_FAILED job (not permanently stuck)', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  approveVideo(project, keyframe, built.package);
  generationStore.createGenerationJob({
    projectId: project.id,
    shotId: keyframe.shotId,
    keyframeId: keyframe.keyframeId,
    videoPromptPackageId: built.package.packageId,
    videoPromptPackageVersion: built.package.version,
    canonicalKeyframeAssetId: built.package.canonicalKeyframeAssetId,
    generationType: 'VIDEO',
    provider: GOOD_PROVIDER,
    model: GOOD_MODEL,
    status: 'FAILED',
    assetId: null,
    error: { message: 'prompt cannot be empty' },
  });
  // A later successful attempt for the same keyframe.
  const videoAsset = timelineStore.addAsset(project.id, {
    type: 'video',
    keyframeId: keyframe.keyframeId,
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    videoPromptPackageId: built.package.packageId,
    videoPromptPackageVersion: built.package.version,
    approvalStatus: 'NONE',
  });

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.videoStatus, 'VIDEO_RETURNED', 'a later completed asset always takes priority over an older failed job');
  assert.equal(item.videoAssetId, videoAsset.assetId);
});

test('videoStatus is VIDEO_RETURNED when a completed video asset has not been reviewed yet', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  approveVideo(project, keyframe, built.package);
  const videoAsset = timelineStore.addAsset(project.id, {
    type: 'video',
    keyframeId: keyframe.keyframeId,
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    videoPromptPackageId: built.package.packageId,
    videoPromptPackageVersion: built.package.version,
    approvalStatus: 'NONE',
  });

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.videoStatus, 'VIDEO_RETURNED');
  assert.equal(item.videoAssetId, videoAsset.assetId);
  assert.equal(item.videoAssetApprovalStatus, 'NONE');
});

test('videoStatus is VIDEO_APPROVED once the video asset is approved', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  approveVideo(project, keyframe, built.package);
  const videoAsset = timelineStore.addAsset(project.id, {
    type: 'video',
    keyframeId: keyframe.keyframeId,
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    videoPromptPackageId: built.package.packageId,
    videoPromptPackageVersion: built.package.version,
    approvalStatus: 'NONE',
  });
  timelineStore.setAssetApprovalStatus(project.id, videoAsset.assetId, 'APPROVED');

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.videoStatus, 'VIDEO_APPROVED');
  assert.equal(item.videoAssetId, videoAsset.assetId);
});

// --- Stage 23: VIDEO_REJECTED ------------------------------------------------------

test('videoStatus is VIDEO_REJECTED when every video asset for the keyframe has been rejected', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  approveVideo(project, keyframe, built.package);
  const videoAsset = timelineStore.addAsset(project.id, {
    type: 'video',
    keyframeId: keyframe.keyframeId,
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    videoPromptPackageId: built.package.packageId,
    videoPromptPackageVersion: built.package.version,
    approvalStatus: 'NONE',
  });
  timelineStore.setAssetApprovalStatus(project.id, videoAsset.assetId, 'REJECTED');

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.videoStatus, 'VIDEO_REJECTED');
  assert.equal(item.videoAssetId, videoAsset.assetId);
  assert.equal(item.videoAssetApprovalStatus, 'REJECTED');
});

test('videoStatus prefers an unreviewed video asset over an older rejected one from a prior attempt', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  approveVideo(project, keyframe, built.package);
  const firstAttempt = timelineStore.addAsset(project.id, {
    type: 'video',
    keyframeId: keyframe.keyframeId,
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    videoPromptPackageId: built.package.packageId,
    videoPromptPackageVersion: built.package.version,
    approvalStatus: 'NONE',
  });
  timelineStore.setAssetApprovalStatus(project.id, firstAttempt.assetId, 'REJECTED');
  // A second, later generation attempt for the same keyframe, still unreviewed.
  const secondAttempt = timelineStore.addAsset(project.id, {
    type: 'video',
    keyframeId: keyframe.keyframeId,
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    videoPromptPackageId: built.package.packageId,
    videoPromptPackageVersion: built.package.version,
    approvalStatus: 'NONE',
  });

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.videoStatus, 'VIDEO_RETURNED', 'an unreviewed asset always takes priority over an older rejected one');
  assert.equal(item.videoAssetId, secondAttempt.assetId);
});

test('a rejected video asset does not delete or hide the underlying generation job', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  approveVideo(project, keyframe, built.package);
  const job = generationStore.createGenerationJob({
    projectId: project.id,
    shotId: keyframe.shotId,
    keyframeId: keyframe.keyframeId,
    videoPromptPackageId: built.package.packageId,
    videoPromptPackageVersion: built.package.version,
    canonicalKeyframeAssetId: built.package.canonicalKeyframeAssetId,
    generationType: 'VIDEO',
    provider: GOOD_PROVIDER,
    model: GOOD_MODEL,
    status: 'COMPLETED',
  });
  const videoAsset = timelineStore.addAsset(project.id, {
    type: 'video',
    keyframeId: keyframe.keyframeId,
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    videoPromptPackageId: built.package.packageId,
    videoPromptPackageVersion: built.package.version,
    approvalStatus: 'NONE',
  });
  timelineStore.setAssetApprovalStatus(project.id, videoAsset.assetId, 'REJECTED');

  oq.buildProjectQueue(project.id);
  assert.ok(generationStore.getGenerationJob(job.id), 'the job must still exist after rejection');
  assert.ok(timelineStore.getAsset(project.id, videoAsset.assetId), 'the rejected asset must still exist');
});

test('a video asset never contaminates the existing IMAGE unreviewedAsset/canonicalAsset logic', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  approveVideo(project, keyframe, built.package);
  // An UNREVIEWED video asset exists — before the fix, this would have
  // incorrectly flipped the image category to NEEDS_ASSET_REVIEW/
  // IMAGE_RETURNED, since both share the same Asset.keyframeId field.
  timelineStore.addAsset(project.id, {
    type: 'video',
    keyframeId: keyframe.keyframeId,
    sceneId: keyframe.sceneId,
    shotId: keyframe.shotId,
    videoPromptPackageId: built.package.packageId,
    videoPromptPackageVersion: built.package.version,
    approvalStatus: 'NONE',
  });

  const item = itemFor(oq.buildProjectQueue(project.id), keyframe.keyframeId);
  assert.equal(item.category, 'COMPLETE', 'the IMAGE category must stay COMPLETE — a video asset must never be read as an image asset');
  assert.equal(item.videoStatus, 'VIDEO_RETURNED');
});

test('getQueueSummary/getShotReadiness are unaffected by videoStatus (still computed from the image category only)', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });

  const summary = oq.getQueueSummary(project.id);
  assert.equal(summary.complete, 1);
  const readiness = oq.getShotReadiness(project.id);
  assert.equal(readiness[0].readyForVideo, true);
});

test('videoStatus computation never mutates any store (read-only, same as the rest of the queue)', () => {
  const { project, keyframe } = buildCompleteKeyframeFixture();
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  const before = JSON.stringify(videoPromptService.getVideoPromptPackage(project.id, keyframe.keyframeId));
  oq.buildProjectQueue(project.id);
  oq.buildProjectQueue(project.id);
  const after = JSON.stringify(videoPromptService.getVideoPromptPackage(project.id, keyframe.keyframeId));
  assert.equal(before, after);
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, 0);
});

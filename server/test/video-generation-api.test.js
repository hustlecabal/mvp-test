// Tests for the Stage 22B-Part-3 Controlled Video Generation REST
// endpoints in index.js. Every route is a thin wrapper over
// services/video-generation-approval-store.js or services/video-
// generation-service.js.
//
// SAFETY: POST /shots/:shotId/video-generation always resolves the REAL
// provider registry (video-generation-service.js's PROVIDERS — REST has
// no way to inject a fake one), so this file NEVER archives/STOREs the
// canonical keyframe asset it uses. services/evolink-reference-
// resolver.js's resolveReferenceImageUrl (the real, default
// resolveReferenceImpl) refuses to resolve any asset that isn't locally
// STORED BEFORE it would ever construct a request or reach the network —
// see the assertion on REFERENCE_RESOLUTION_FAILED's reason below, which
// proves the call never got far enough to touch the network. No
// EVOLINK_API_KEY is set anywhere in this process either way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-api-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-api-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-api-keyframes-'));
const keyframePromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-api-kf-packages-'));
const videoPromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-api-video-packages-'));
const videoApprovalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-api-video-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-api-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = keyframePromptTempDir;
process.env.VIDEO_PROMPT_DATA_DIR = videoPromptTempDir;
process.env.VIDEO_GENERATION_APPROVAL_DATA_DIR = videoApprovalTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
delete process.env.EVOLINK_API_KEY;

const app = require('../index');
const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const keyframePromptService = require('../services/keyframe-prompt-service');
const timelineStore = require('../services/timeline-store');
const videoPromptService = require('../services/video-prompt-service');
const generationStore = require('../services/generation-store');

const GOOD_PROVIDER = 'evolink';
const GOOD_MODEL = 'seedance-2.0-mini-image-to-video';

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => server.close());

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function buildFixture() {
  const project = projectStore.createProject({ title: 'video generation API test', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version });
  keyframePromptService.buildKeyframePromptPackage(project.id, keyframe.keyframeId, {});
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId, approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId, { selectedBy: 'tester' });
  const built = videoPromptService.buildVideoPromptPackage(project.id, keyframe.keyframeId, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  return { project, scene, shot, keyframe, asset, pkg: built.package };
}

async function requestAndApproveViaRest(shotId, keyframeId) {
  await postJson(`${baseUrl}/shots/${shotId}/video-generation/approval`, { keyframeId, estimatedCost: 2, requestedBy: 'tester' });
  return (await postJson(`${baseUrl}/shots/${shotId}/video-generation/approval/approve`, { keyframeId, approvedBy: 'tester' })).json();
}

// --- POST/GET /shots/:shotId/video-generation/approval ---------------------------------

test('POST /shots/:shotId/video-generation/approval creates a PENDING approval bound to the current package', async () => {
  const { shot, keyframe, pkg } = buildFixture();
  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval`, { keyframeId: keyframe.keyframeId, estimatedCost: 2, requestedBy: 'tester' });
  assert.equal(res.status, 200);
  const approval = await res.json();
  assert.equal(approval.status, 'PENDING');
  assert.equal(approval.videoPromptPackageId, pkg.packageId);
  assert.equal(approval.provider, GOOD_PROVIDER);
});

test('POST /shots/:shotId/video-generation/approval 404s without a keyframeId', async () => {
  const { shot } = buildFixture();
  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval`, {});
  assert.equal(res.status, 404);
});

test('POST /shots/:shotId/video-generation/approval 409s when no video prompt package has been built', async () => {
  const project = projectStore.createProject({ title: 'no package', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version });

  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval`, { keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  assert.equal(res.status, 409);
});

test('GET /shots/:shotId/video-generation/approval reads the current approval', async () => {
  const { shot, keyframe } = buildFixture();
  await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval`, { keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  const res = await fetch(`${baseUrl}/shots/${shot.shotId}/video-generation/approval?keyframeId=${keyframe.keyframeId}`);
  assert.equal(res.status, 200);
  const approval = await res.json();
  assert.equal(approval.status, 'PENDING');
});

test('GET /shots/:shotId/video-generation/approval 404s for a keyframe that does not belong to the shot', async () => {
  const { shot } = buildFixture();
  const res = await fetch(`${baseUrl}/shots/${shot.shotId}/video-generation/approval?keyframeId=nope`);
  assert.equal(res.status, 404);
});

// --- POST /shots/:shotId/video-generation/approval/approve|reject ----------------------

test('POST /shots/:shotId/video-generation/approval/approve records APPROVED', async () => {
  const { shot, keyframe } = buildFixture();
  await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval`, { keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval/approve`, { keyframeId: keyframe.keyframeId, approvedBy: 'tester' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'APPROVED');
  assert.equal(body.approvedBy, 'tester');
});

test('POST /shots/:shotId/video-generation/approval/reject records REJECTED', async () => {
  const { shot, keyframe } = buildFixture();
  await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval`, { keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval/reject`, { keyframeId: keyframe.keyframeId, decidedBy: 'tester', reason: 'no' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'REJECTED');
});

test('POST /shots/:shotId/video-generation/approval/approve 409s when nothing is pending', async () => {
  const { shot, keyframe } = buildFixture();
  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval/approve`, { keyframeId: keyframe.keyframeId });
  assert.equal(res.status, 409);
});

// --- GET /shots/:shotId/video-generation/eligibility ------------------------------------

test('GET /shots/:shotId/video-generation/eligibility reports allowed:false before approval, true after', async () => {
  const { shot, keyframe } = buildFixture();
  const before = await (await fetch(`${baseUrl}/shots/${shot.shotId}/video-generation/eligibility?keyframeId=${keyframe.keyframeId}`)).json();
  assert.equal(before.allowed, false);
  assert.equal(before.code, 'NO_VIDEO_GENERATION_APPROVAL');

  await requestAndApproveViaRest(shot.shotId, keyframe.keyframeId);

  const after = await (await fetch(`${baseUrl}/shots/${shot.shotId}/video-generation/eligibility?keyframeId=${keyframe.keyframeId}`)).json();
  assert.equal(after.allowed, true);
});

test('GET /shots/:shotId/video-generation/eligibility 404s for an unknown shot', async () => {
  const res = await fetch(`${baseUrl}/shots/00000000-0000-0000-0000-000000000000/video-generation/eligibility?keyframeId=x`);
  assert.equal(res.status, 404);
});

// --- POST /shots/:shotId/video-generation ------------------------------------------------

test('POST /shots/:shotId/video-generation returns a structured BLOCKED result (never throws) before approval, and creates no job', async () => {
  const { project, shot, keyframe } = buildFixture();
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;
  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation`, { keyframeId: keyframe.keyframeId });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'BLOCKED');
  assert.equal(body.code, 'NO_VIDEO_GENERATION_APPROVAL');
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

test('POST /shots/:shotId/video-generation, once approved, is BLOCKED on reference resolution (never reaches the network — the canonical asset is never locally STORED in this test)', async () => {
  const { project, shot, keyframe } = buildFixture();
  await requestAndApproveViaRest(shot.shotId, keyframe.keyframeId);

  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;
  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation`, { keyframeId: keyframe.keyframeId });
  const body = await res.json();
  assert.equal(body.status, 'BLOCKED');
  assert.equal(body.code, 'REFERENCE_RESOLUTION_FAILED');
  // Proves the call never got past the LOCAL "is this asset archived"
  // check inside evolink-reference-resolver.js — i.e. never reached
  // evolinkClient.uploadBase64File, and therefore never attempted a real
  // network request.
  assert.match(body.reason, /not STORED locally/);
  // A job IS created before reference resolution is attempted (Part 14
  // creates the job only after resolution succeeds, per generateVideo's
  // own ordering) — confirm no job was left behind either.
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

// --- GET /shots/:shotId/video-generation/:generationId ----------------------------------

test('GET /shots/:shotId/video-generation/:generationId reads a job created directly on disk', async () => {
  const { project, shot, keyframe } = buildFixture();
  const job = generationStore.createGenerationJob({
    projectId: project.id,
    sceneId: shot.sceneId,
    shotId: shot.shotId,
    keyframeId: keyframe.keyframeId,
    generationType: 'VIDEO',
    provider: GOOD_PROVIDER,
    model: GOOD_MODEL,
    status: 'PROCESSING',
    progress: 30,
  });
  const res = await fetch(`${baseUrl}/shots/${shot.shotId}/video-generation/${job.id}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.generationId, job.id);
  assert.equal(body.status, 'IN_PROGRESS');
});

test('GET /shots/:shotId/video-generation/:generationId 404s for an unknown generationId', async () => {
  const { shot } = buildFixture();
  const res = await fetch(`${baseUrl}/shots/${shot.shotId}/video-generation/00000000-0000-0000-0000-000000000000`);
  assert.equal(res.status, 404);
});

// --- Stage 23: GET /shots/:shotId/video-generations (list, with asset) -----------------

test('GET /shots/:shotId/video-generations lists jobs for a keyframe with the resulting asset attached', async () => {
  const { project, shot, keyframe } = buildFixture();
  const videoAsset = timelineStore.addAsset(project.id, { type: 'video', keyframeId: keyframe.keyframeId, sceneId: shot.sceneId, shotId: shot.shotId, approvalStatus: 'NONE' });
  const job = generationStore.createGenerationJob({
    projectId: project.id,
    sceneId: shot.sceneId,
    shotId: shot.shotId,
    keyframeId: keyframe.keyframeId,
    generationType: 'VIDEO',
    provider: GOOD_PROVIDER,
    model: GOOD_MODEL,
    status: 'COMPLETED',
    assetId: videoAsset.assetId,
  });

  const res = await fetch(`${baseUrl}/shots/${shot.shotId}/video-generations?keyframeId=${keyframe.keyframeId}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].id, job.id);
  assert.equal(body[0].asset.assetId, videoAsset.assetId);
});

test('GET /shots/:shotId/video-generations 404s without a keyframeId', async () => {
  const { shot } = buildFixture();
  const res = await fetch(`${baseUrl}/shots/${shot.shotId}/video-generations`);
  assert.equal(res.status, 404);
});

// --- safety: no video-generation REST call other than a fully-eligible
// POST /video-generation can ever create a job -----------------------------------------

test('no video-generation REST call other than POST /video-generation creates a generation job', async () => {
  const { project, shot, keyframe } = buildFixture();
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval`, { keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  await fetch(`${baseUrl}/shots/${shot.shotId}/video-generation/approval?keyframeId=${keyframe.keyframeId}`);
  await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval/approve`, { keyframeId: keyframe.keyframeId });
  await fetch(`${baseUrl}/shots/${shot.shotId}/video-generation/eligibility?keyframeId=${keyframe.keyframeId}`);

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

// --- Stage 23: POST /shots/:shotId/video-generation/approval/acknowledge-unknown-cost --

test('POST .../acknowledge-unknown-cost records the acknowledgement on the existing approval', async () => {
  const { shot, keyframe } = buildFixture();
  await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval`, { keyframeId: keyframe.keyframeId });
  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval/acknowledge-unknown-cost`, { keyframeId: keyframe.keyframeId, acknowledgedBy: 'tester' });
  assert.equal(res.status, 200);
  const approval = await res.json();
  assert.equal(approval.unknownCostAcknowledged, true);
  assert.equal(approval.unknownCostAcknowledgedBy, 'tester');
});

test('POST .../acknowledge-unknown-cost 404s without a keyframeId', async () => {
  const { shot } = buildFixture();
  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/approval/acknowledge-unknown-cost`, {});
  assert.equal(res.status, 404);
});

// --- Stage 23: POST /shots/:shotId/video-generation/review ------------------------------
// Uses a manually-created 'video' type asset (never a real provider call)
// to test the review route's own delegation to videoGenerationService.
// approveGeneratedVideo/rejectGeneratedVideo — exactly this file's existing
// safety convention (no real generation anywhere in this file).

function addFakeVideoAsset(project, keyframe) {
  return timelineStore.addAsset(project.id, { type: 'video', keyframeId: keyframe.keyframeId, sceneId: keyframe.sceneId, shotId: keyframe.shotId, approvalStatus: 'NONE' });
}

test('POST /shots/:shotId/video-generation/review approves a video asset', async () => {
  const { project, shot, keyframe } = buildFixture();
  const videoAsset = addFakeVideoAsset(project, keyframe);

  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/review`, { keyframeId: keyframe.keyframeId, assetId: videoAsset.assetId, approve: true, decidedBy: 'tester' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.asset.approvalStatus, 'APPROVED');
});

test('POST /shots/:shotId/video-generation/review rejects a video asset', async () => {
  const { project, shot, keyframe } = buildFixture();
  const videoAsset = addFakeVideoAsset(project, keyframe);

  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/review`, { keyframeId: keyframe.keyframeId, assetId: videoAsset.assetId, approve: false, decidedBy: 'tester', reason: 'bad take' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.asset.approvalStatus, 'REJECTED');
});

test('POST /shots/:shotId/video-generation/review 400s without an assetId', async () => {
  const { shot, keyframe } = buildFixture();
  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/review`, { keyframeId: keyframe.keyframeId, approve: true });
  assert.equal(res.status, 400);
});

test('POST /shots/:shotId/video-generation/review 409s for a non-video asset (the canonical keyframe image)', async () => {
  const { shot, keyframe, asset } = buildFixture();
  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/review`, { keyframeId: keyframe.keyframeId, assetId: asset.assetId, approve: true });
  assert.equal(res.status, 409);
});

test('POST /shots/:shotId/video-generation/review 404s without a keyframeId', async () => {
  const { shot } = buildFixture();
  const res = await postJson(`${baseUrl}/shots/${shot.shotId}/video-generation/review`, { assetId: 'x', approve: true });
  assert.equal(res.status, 404);
});

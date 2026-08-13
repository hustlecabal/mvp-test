// Tests for the Stage 22B-Part-2 Video Prompt Packaging REST endpoints in
// index.js. Every route is a thin wrapper over
// services/video-prompt-service.js — nothing here can generate a video,
// call a provider, spend a credit, create a generation job, or create/
// change a generation approval or canonical-asset selection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-api-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-api-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-api-keyframes-'));
const keyframePromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-api-kf-packages-'));
const videoPromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-api-video-packages-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-api-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.KEYFRAME_PROMPT_DATA_DIR = keyframePromptTempDir;
process.env.VIDEO_PROMPT_DATA_DIR = videoPromptTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const app = require('../index');
const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const keyframePromptService = require('../services/keyframe-prompt-service');
const timelineStore = require('../services/timeline-store');
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

// Builds a project with an APPROVED, canonical-selected keyframe asset,
// entirely through the real services layer (same fixture shape as
// video-prompt-service.test.js), without going through generation/
// approval REST routes -- this file is testing the video-prompt-package
// routes, not the generation pipeline.
function buildFixture() {
  const project = projectStore.createProject({ title: 'video prompt API test', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, {
    shotId: shot.shotId,
    sceneId: scene.sceneId,
    frameType: 'DETAIL_FRAME',
    sourceShotVersion: storyboard.version,
  });
  keyframePromptService.buildKeyframePromptPackage(project.id, keyframe.keyframeId, {});
  const asset = timelineStore.addAsset(project.id, { type: 'keyframe', keyframeId: keyframe.keyframeId, sceneId: scene.sceneId, shotId: shot.shotId, approvalStatus: 'NONE' });
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'APPROVED');
  keyframeStore.selectCanonicalKeyframeAsset(project.id, keyframe.keyframeId, asset.assetId, { selectedBy: 'tester' });
  return { project, scene, shot, keyframe, asset };
}

// --- GET/POST /keyframes/:keyframeId/video-prompt-package ------------------------------

test('GET /keyframes/:keyframeId/video-prompt-package 404s before any package has been built', async () => {
  const { keyframe } = buildFixture();
  const res = await fetch(`${baseUrl}/keyframes/${keyframe.keyframeId}/video-prompt-package`);
  assert.equal(res.status, 404);
});

test('GET /keyframes/:keyframeId/video-prompt-package 404s for an unknown keyframe', async () => {
  const res = await fetch(`${baseUrl}/keyframes/00000000-0000-0000-0000-000000000000/video-prompt-package`);
  assert.equal(res.status, 404);
});

test('POST /keyframes/:keyframeId/video-prompt-package builds a package, and a subsequent GET retrieves it', async () => {
  const { keyframe, asset } = buildFixture();

  const built = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/video-prompt-package`, { provider: GOOD_PROVIDER, model: GOOD_MODEL })).json();
  assert.equal(built.ok, true);
  assert.equal(built.package.keyframeId, keyframe.keyframeId);
  assert.equal(built.package.canonicalKeyframeAssetId, asset.assetId);
  assert.equal(built.package.version, 1);

  const fetched = await (await fetch(`${baseUrl}/keyframes/${keyframe.keyframeId}/video-prompt-package`)).json();
  assert.equal(fetched.keyframeId, keyframe.keyframeId);
  assert.equal(fetched.version, 1);
});

test('POST /keyframes/:keyframeId/video-prompt-package 404s for an unknown keyframe', async () => {
  const res = await postJson(`${baseUrl}/keyframes/00000000-0000-0000-0000-000000000000/video-prompt-package`, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(res.status, 404);
});

test('POST /keyframes/:keyframeId/video-prompt-package returns 409 with a structured code when there is no canonical asset', async () => {
  const project = projectStore.createProject({ title: 'no canonical', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, { shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME', sourceShotVersion: storyboard.version });

  const res = await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/video-prompt-package`, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'NO_CANONICAL_ASSET_SELECTED');
});

test('POST /keyframes/:keyframeId/video-prompt-package returns 409 UNKNOWN_MODEL for a nonexistent provider/model', async () => {
  const { keyframe } = buildFixture();
  const res = await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/video-prompt-package`, { provider: 'evolink', model: 'no-such-model' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'UNKNOWN_MODEL');
});

test('POST /keyframes/:keyframeId/video-prompt-package rebuild bumps version and preserves history', async () => {
  const { keyframe } = buildFixture();
  await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/video-prompt-package`, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  const second = await (await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/video-prompt-package`, { provider: GOOD_PROVIDER, model: GOOD_MODEL, executionParameters: { duration: 4 } })).json();
  assert.equal(second.package.version, 2);
  assert.equal(second.package.executionParameters.duration, 4);
  assert.equal(second.package.history.length, 1);
});

// --- GET /shots/:shotId/video-prompt-packages ------------------------------

test('GET /shots/:shotId/video-prompt-packages lists every built package for that shot', async () => {
  const { shot, keyframe } = buildFixture();
  await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/video-prompt-package`, { provider: GOOD_PROVIDER, model: GOOD_MODEL });

  const res = await fetch(`${baseUrl}/shots/${shot.shotId}/video-prompt-packages`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].keyframeId, keyframe.keyframeId);
});

test('GET /shots/:shotId/video-prompt-packages 404s for an unknown shot', async () => {
  const res = await fetch(`${baseUrl}/shots/00000000-0000-0000-0000-000000000000/video-prompt-packages`);
  assert.equal(res.status, 404);
});

// --- safety: no video-prompt-package REST call ever creates a generation job -----------

test('no video-prompt-package REST call ever creates a generation job', async () => {
  const { project, keyframe } = buildFixture();
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/video-prompt-package`, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  await postJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/video-prompt-package`, { provider: GOOD_PROVIDER, model: GOOD_MODEL });
  await fetch(`${baseUrl}/keyframes/${keyframe.keyframeId}/video-prompt-package`);

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

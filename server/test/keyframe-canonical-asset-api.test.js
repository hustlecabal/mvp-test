// Tests for the Stage 13E, Part 1 canonical-asset REST routes
// (PUT/GET /keyframes/:keyframeId/canonical-asset).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-api-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-api-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-api-keyframes-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;

const app = require('../index');
const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const keyframeStore = require('../services/keyframe-store');
const timelineStore = require('../services/timeline-store');

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

function buildFixture() {
  const project = projectStore.createProject({ title: 'canonical-asset API test', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  const shot = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId });
  const storyboard = creativeStore.getStoryboard(project.id);
  const keyframe = keyframeStore.createKeyframe(project.id, {
    shotId: shot.shotId,
    sceneId: scene.sceneId,
    frameType: 'DETAIL_FRAME',
    sourceShotVersion: storyboard.version,
  });
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe', keyframeId: keyframe.keyframeId });
  return { project, keyframe, asset };
}

function putJson(url, body) {
  return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('PUT /keyframes/:keyframeId/canonical-asset selects a canonical asset', async () => {
  const { keyframe, asset } = buildFixture();

  const res = await putJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/canonical-asset`, { assetId: asset.assetId, selectedBy: 'tester' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.canonicalAssetId, asset.assetId);
});

test('PUT /keyframes/:keyframeId/canonical-asset requires assetId', async () => {
  const { keyframe } = buildFixture();
  const res = await putJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/canonical-asset`, {});
  assert.equal(res.status, 400);
});

test('PUT /keyframes/:keyframeId/canonical-asset 409s for a REJECTED asset', async () => {
  const { project, keyframe, asset } = buildFixture();
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'REJECTED');

  const res = await putJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/canonical-asset`, { assetId: asset.assetId });
  assert.equal(res.status, 409);
});

test('PUT /keyframes/:keyframeId/canonical-asset 404s for an unknown keyframe', async () => {
  const res = await putJson(`${baseUrl}/keyframes/nope/canonical-asset`, { assetId: 'x' });
  assert.equal(res.status, 404);
});

test('GET /keyframes/:keyframeId/canonical-asset reads the current selection', async () => {
  const { keyframe, asset } = buildFixture();
  await putJson(`${baseUrl}/keyframes/${keyframe.keyframeId}/canonical-asset`, { assetId: asset.assetId, selectedBy: 'tester' });

  const res = await fetch(`${baseUrl}/keyframes/${keyframe.keyframeId}/canonical-asset`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.canonicalAssetId, asset.assetId);
  assert.equal(body.asset.assetId, asset.assetId);
});

test('GET /keyframes/:keyframeId/canonical-asset 404s for an unknown keyframe', async () => {
  const res = await fetch(`${baseUrl}/keyframes/nope/canonical-asset`);
  assert.equal(res.status, 404);
});

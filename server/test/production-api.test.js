// Tests for the P0-ORCH-ENTRY REST endpoints in index.js:
//   POST /projects/:projectId/production
//   GET  /projects/:projectId/production
//   GET  /production-jobs/:productionJobId
//
// Every route is a thin wrapper over services/production-orchestrator-
// service.js / services/production-job-store.js — see that file's own
// header for the real stage sequence and approval/financial boundaries.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prod-api-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prod-api-creative-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prod-api-assets-'));
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prod-api-blueprints-'));
const gateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prod-api-gates-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prod-api-jobs-'));
const outputTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prod-api-output-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;
process.env.CREATIVE_BLUEPRINT_DATA_DIR = blueprintTempDir;
process.env.PRE_PRODUCTION_GATE_DATA_DIR = gateTempDir;
process.env.PRODUCTION_JOBS_DATA_DIR = jobsTempDir;
process.env.PRODUCTION_OUTPUT_DATA_DIR = outputTempDir;

const app = require('../index');
const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const { satisfyProductionPrerequisites } = require('./helpers/control-plane-fixture');
const { makeTinyPng } = require('./fixtures/png-fixture');

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

function makeStoredImageAsset(projectId) {
  const assetId = crypto.randomUUID();
  const stored = assetStorage.storeUploadedImage(makeTinyPng(320, 180), assetId);
  timelineStore.addAsset(projectId, { assetId, type: 'keyframe' });
  timelineStore.updateAssetStorage(projectId, assetId, { status: 'STORED', provider: 'local', path: stored.relativePath, contentType: stored.contentType });
}

function makeStoredVideoAsset(projectId) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'video' });
  const relativePath = `${asset.assetId}.mp4`;
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: relativePath });
  const absolutePath = assetStorage.resolveStoredPath(relativePath);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:duration=5:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', absolutePath]);
}

function buildGoldenProject() {
  const project = projectStore.createProject({ title: 'REST production golden test', topic: 'x' });
  satisfyProductionPrerequisites(project.id);
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1', order: 1 });
  const shot1 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1, duration: 4, visualTreatment: 'STILL_IMAGE' });
  const shot2 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 2, duration: 3, visualTreatment: 'AI_VIDEO' });
  makeStoredImageAsset(project.id);
  makeStoredVideoAsset(project.id);
  return { project, shot1, shot2 };
}

test('POST /projects/:projectId/production returns 404 for an unknown project', async () => {
  const res = await postJson(`${baseUrl}/projects/nonexistent-project-id/production`, {});
  assert.equal(res.status, 404);
});

test('POST /projects/:projectId/production is BLOCKED for a project with no linked Blueprint', async () => {
  const project = projectStore.createProject({ title: 'REST no-blueprint test', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1', order: 1 });
  creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1, visualTreatment: 'STILL_IMAGE' });

  const res = await postJson(`${baseUrl}/projects/${project.id}/production`, {});
  assert.equal(res.status, 200); // the orchestrator itself reports { ok:false } — this is not an HTTP-layer error
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'NO_BLUEPRINT_LINKED');
  assert.equal(body.job.status, 'FAILED');
});

test('GET /production-jobs/:productionJobId returns 404 for an unknown job', async () => {
  const res = await fetch(`${baseUrl}/production-jobs/${crypto.randomUUID()}`);
  assert.equal(res.status, 404);
});

test('GET /projects/:projectId/production returns 404 for an unknown project', async () => {
  const res = await fetch(`${baseUrl}/projects/nonexistent-project-id/production`);
  assert.equal(res.status, 404);
});

const TERMINAL_STATUSES = ['COMPLETE', 'FAILED', 'ESCALATED'];

async function pollUntilTerminal(productionJobId, { timeoutMs = 180000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${baseUrl}/production-jobs/${productionJobId}`);
    assert.equal(res.status, 200);
    const job = await res.json();
    if (TERMINAL_STATUSES.includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`production job "${productionJobId}" did not reach a terminal status within ${timeoutMs}ms (last status: ${job.status})`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('POST /projects/:projectId/production is ASYNCHRONOUS — it returns immediately, never blocking the Express event loop, and the real production run is proven by polling to COMPLETE', async () => {
  const { project, shot1, shot2 } = buildGoldenProject();

  const requestedAt = Date.now();
  const startRes = await postJson(`${baseUrl}/projects/${project.id}/production`, {
    narrationSegments: {
      [shot1.shotId]: { scriptRefId: 'rest-script-1', text: 'Every great video starts with a single clear idea.' },
      [shot2.shotId]: { scriptRefId: 'rest-script-2', text: 'Then real footage brings that idea to life on screen.' },
    },
  });
  const returnedAfterMs = Date.now() - requestedAt;
  assert.equal(startRes.status, 200);
  const started = await startRes.json();
  assert.equal(started.ok, true, JSON.stringify(started.job));
  assert.ok(!TERMINAL_STATUSES.includes(started.job.status), 'the HTTP response must return before the real production run finishes');
  assert.ok(returnedAfterMs < 5000, `POST must respond quickly (took ${returnedAfterMs}ms) — a real client (or this same single-threaded server) must never be blocked for the full run`);

  const finished = await pollUntilTerminal(started.job.productionJobId);
  assert.equal(finished.status, 'COMPLETE', JSON.stringify(finished.diagnostics));
  assert.equal(finished.assemblyResult.status, 'COMPLETED');
  assert.ok(fs.existsSync(finished.assemblyResult.artifact.path));

  const listRes = await fetch(`${baseUrl}/projects/${project.id}/production`);
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].productionJobId, started.job.productionJobId);
});

// Tests for the Stage 12 Keyframe Intelligence REST endpoints in
// index.js. Every route is a thin wrapper over services/keyframe-store.js
// / services/keyframe-planner.js — these tests confirm the HTTP wiring,
// the changeNote requirement on PUT routes, and that using any of these
// endpoints can never touch generation jobs, budget, or approval state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-api-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-api-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-api-keyframes-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-api-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const app = require('../index');
const generationStore = require('../services/generation-store');
const gate = require('../services/approval-gate');
const projectStore = require('../services/project-store');

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

test.after(() => {
  server.close();
});

async function createProject(title = 'Keyframe API test') {
  const res = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, topic: 'x' }),
  });
  return res.json();
}

function putJson(url, body) {
  return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// Storyboard scene/shot creation has no dedicated REST endpoint (only a
// bulk PUT /creative/storyboard exists) — this test file needs a real
// shot to analyze, so it uses services/creative-store.js directly to seed
// one, exactly the way keyframe-planner.test.js does.
const creativeStore = require('../services/creative-store');

function addStoryboardShot(project, overrides = {}) {
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'S1' });
  return creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, ...overrides });
}

// --- GET/PUT /projects/:id/keyframes ------------------------------------------

test('GET /projects/:id/keyframes returns an empty (not null) plan for a new project', async () => {
  const project = await createProject();
  const res = await fetch(`${baseUrl}/projects/${project.id}/keyframes`);
  assert.equal(res.status, 200);
  const plan = await res.json();
  assert.deepEqual(plan.keyframes, []);
});

test('GET /projects/:id/keyframes 404s for an unknown project', async () => {
  const res = await fetch(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000/keyframes`);
  assert.equal(res.status, 404);
});

test('PUT /projects/:id/keyframes requires a non-blank changeNote', async () => {
  const project = await createProject();
  const res = await putJson(`${baseUrl}/projects/${project.id}/keyframes`, {});
  assert.equal(res.status, 400);
});

test('PUT /projects/:id/keyframes bumps the version with a changeNote', async () => {
  const project = await createProject();
  await fetch(`${baseUrl}/projects/${project.id}/keyframes`); // create the plan
  const res = await putJson(`${baseUrl}/projects/${project.id}/keyframes`, { changeNote: 'reviewed' });
  const plan = await res.json();
  assert.equal(plan.version, 2);
});

// --- POST /projects/:id/keyframes (create one keyframe) ------------------------

test('POST /projects/:id/keyframes creates a keyframe', async () => {
  const project = await createProject();
  const res = await postJson(`${baseUrl}/projects/${project.id}/keyframes`, { shotId: 'shot-1', frameType: 'DETAIL_FRAME' });
  assert.equal(res.status, 201);
  const keyframe = await res.json();
  assert.ok(keyframe.keyframeId);
  assert.equal(keyframe.frameType, 'DETAIL_FRAME');
});

test('POST /projects/:id/keyframes 404s for an unknown project', async () => {
  const res = await postJson(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000/keyframes`, {});
  assert.equal(res.status, 404);
});

// --- GET/PUT /keyframes/:keyframeId ---------------------------------------------

test('GET /keyframes/:keyframeId retrieves a keyframe without needing its projectId, or 404s', async () => {
  const project = await createProject();
  const created = await (await postJson(`${baseUrl}/projects/${project.id}/keyframes`, { shotId: 'shot-1' })).json();

  const found = await (await fetch(`${baseUrl}/keyframes/${created.keyframeId}`)).json();
  assert.equal(found.keyframeId, created.keyframeId);

  const notFound = await fetch(`${baseUrl}/keyframes/00000000-0000-0000-0000-000000000000`);
  assert.equal(notFound.status, 404);
});

test('PUT /keyframes/:keyframeId requires a changeNote and updates the keyframe in place', async () => {
  const project = await createProject();
  const created = await (await postJson(`${baseUrl}/projects/${project.id}/keyframes`, { shotId: 'shot-1' })).json();

  const blank = await putJson(`${baseUrl}/keyframes/${created.keyframeId}`, { status: 'PLANNED' });
  assert.equal(blank.status, 400);

  const ok = await putJson(`${baseUrl}/keyframes/${created.keyframeId}`, { status: 'PLANNED', changeNote: 'reviewed' });
  assert.equal(ok.status, 200);
  const updated = await ok.json();
  assert.equal(updated.status, 'PLANNED');
});

// --- POST /projects/:id/keyframes/analyze ----------------------------------------

test('POST /projects/:id/keyframes/analyze runs the deterministic analysis over HTTP', async () => {
  const project = await createProject();
  const shot = await addStoryboardShot(project, { propReferences: ['prop-1'] });

  const res = await postJson(`${baseUrl}/projects/${project.id}/keyframes/analyze`, { shotId: shot.shotId });
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.shotId, shot.shotId);
  assert.ok(result.recommendations.some((r) => r.frameType === 'DETAIL_FRAME'));
});

test('POST /projects/:id/keyframes/analyze 404s for an unknown shotId', async () => {
  const project = await createProject();
  const res = await postJson(`${baseUrl}/projects/${project.id}/keyframes/analyze`, { shotId: 'nope' });
  assert.equal(res.status, 404);
});

// --- safety: no keyframe REST call ever creates a generation job -----------------

test('no keyframe REST call ever creates a generation job or changes approval/budget state', async () => {
  const project = await createProject();
  const projectRecord = projectStore.getProject(project.id);
  gate.setBudget(projectRecord, 100);
  gate.requestApproval(projectRecord, { estimatedCost: 10 });
  gate.decideApproval(projectRecord, { approve: true });
  projectStore.touch(projectRecord);

  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  const shot = await addStoryboardShot(project);
  const created = await (await postJson(`${baseUrl}/projects/${project.id}/keyframes`, { shotId: shot.shotId })).json();
  await putJson(`${baseUrl}/keyframes/${created.keyframeId}`, { status: 'APPROVED', changeNote: 'approved' });
  await postJson(`${baseUrl}/projects/${project.id}/keyframes/analyze`, { shotId: shot.shotId });

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);

  const reloaded = projectStore.getProject(project.id);
  assert.equal(reloaded.approvals.status, 'APPROVED');
  assert.equal(reloaded.creditLedger.reserved, 0);
});

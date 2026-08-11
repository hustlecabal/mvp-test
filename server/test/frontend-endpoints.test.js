// Tests for the two new Stage 10 read-only HTTP endpoints that the
// frontend calls directly: GET /projects/:id/budget and
// GET /shots/:shotId/history. Both just call existing services
// (approval-gate.js's getBudgetView, generation-history-service.js's
// listShotHistory) — this only checks the HTTP wiring, not the
// underlying logic (already covered by budget-ledger.test.js and
// generation-history-service.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-frontend-endpoints-projects-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-frontend-endpoints-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const app = require('../index');
const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const gate = require('../services/approval-gate');
const generationStore = require('../services/generation-store');

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

test('GET /projects/:id/budget returns the same shape as the get_project_budget MCP tool', async () => {
  const project = projectStore.createProject({ title: 'Budget endpoint test', topic: 'x' });
  gate.setBudget(project, 50);
  projectStore.touch(project);

  const res = await fetch(`${baseUrl}/projects/${project.id}/budget`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.budgetLimit, 50);
  assert.equal(body.reservedCredits, 0);
  assert.equal(body.spentCredits, null);
  assert.equal(body.generationAllowed, false); // not approved yet
  assert.ok('overage' in body && 'blocked' in body && 'reason' in body);
});

test('GET /projects/:id/budget returns 404 for an unknown project', async () => {
  const res = await fetch(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000/budget`);
  assert.equal(res.status, 404);
});

test('GET /shots/:shotId/history returns every generation attempt for a shot', async () => {
  const project = projectStore.createProject({ title: 'History endpoint test', topic: 'x' });
  const scene = timelineStore.addScene(project.id, { title: 'S1', description: 'd' });
  const shot = timelineStore.addShot(project.id, { sceneId: scene.sceneId });
  generationStore.createGenerationJob({
    projectId: project.id,
    sceneId: scene.sceneId,
    shotId: shot.shotId,
    provider: 'evolink',
    status: 'COMPLETED',
    reservedCost: 3,
  });

  const res = await fetch(`${baseUrl}/shots/${shot.shotId}/history`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.shotId, shot.shotId);
  assert.equal(body.totalCount, 1);
  assert.equal(body.generations[0].reservedCost, 3);
});

test('GET /shots/:shotId/history returns 404 for an unknown shot', async () => {
  const res = await fetch(`${baseUrl}/shots/00000000-0000-0000-0000-000000000000/history`);
  assert.equal(res.status, 404);
});

test('the frontend index page is served statically', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /EvoLink Video Factory/);
});

// Tests for the approval/budget-gate HTTP endpoints in index.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-approval-api-test-'));
process.env.PROJECT_DATA_DIR = tempDir;

const app = require('../index');

let server;
let baseUrl;

async function createProject(title = 'Gate test project') {
  const res = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, topic: 'x' }),
  });
  return res.json();
}

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

test('GET /projects/:id/approval on a fresh project cannot proceed', async () => {
  const project = await createProject();

  const res = await fetch(`${baseUrl}/projects/${project.id}/approval`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.canProceed.allowed, false);
  assert.equal(body.approvals.status, 'NONE');
});

test('POST /projects/:id/approval/request moves status to PENDING', async () => {
  const project = await createProject();

  const res = await fetch(`${baseUrl}/projects/${project.id}/approval/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ estimatedCost: 30, note: 'keyframes for scene 1' }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.approvals.status, 'PENDING');
  assert.equal(body.approvals.estimatedCost, 30);
});

test('full approve flow: request -> decide -> gate opens', async () => {
  const project = await createProject();

  await fetch(`${baseUrl}/projects/${project.id}/approval/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ estimatedCost: 10 }),
  });

  const decideRes = await fetch(`${baseUrl}/projects/${project.id}/approval/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve: true, decidedBy: 'Opeyemi' }),
  });
  assert.equal(decideRes.status, 200);
  const decided = await decideRes.json();
  assert.equal(decided.approvals.status, 'APPROVED');

  const gateRes = await fetch(`${baseUrl}/projects/${project.id}/approval`);
  const gateBody = await gateRes.json();
  assert.equal(gateBody.canProceed.allowed, true);
});

test('deciding without a pending request returns 400', async () => {
  const project = await createProject();

  const res = await fetch(`${baseUrl}/projects/${project.id}/approval/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve: true }),
  });

  assert.equal(res.status, 400);
});

test('POST /projects/:id/budget sets a limit that the gate respects', async () => {
  const project = await createProject();

  const budgetRes = await fetch(`${baseUrl}/projects/${project.id}/budget`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 20 }),
  });
  assert.equal(budgetRes.status, 200);

  await fetch(`${baseUrl}/projects/${project.id}/approval/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ estimatedCost: 50 }), // over budget
  });
  await fetch(`${baseUrl}/projects/${project.id}/approval/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve: true }),
  });

  const gateRes = await fetch(`${baseUrl}/projects/${project.id}/approval`);
  const gateBody = await gateRes.json();
  assert.equal(gateBody.canProceed.allowed, false);
  assert.match(gateBody.canProceed.reason, /budget/i);
});

test('POST /projects/:id/budget rejects a non-positive limit', async () => {
  const project = await createProject();

  const res = await fetch(`${baseUrl}/projects/${project.id}/budget`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: -5 }),
  });

  assert.equal(res.status, 400);
});

test('approval endpoints return 404 for a missing project', async () => {
  const missingId = '00000000-0000-0000-0000-000000000000';

  const getRes = await fetch(`${baseUrl}/projects/${missingId}/approval`);
  assert.equal(getRes.status, 404);

  const requestRes = await fetch(`${baseUrl}/projects/${missingId}/approval/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(requestRes.status, 404);

  const budgetRes = await fetch(`${baseUrl}/projects/${missingId}/budget`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 10 }),
  });
  assert.equal(budgetRes.status, 404);
});

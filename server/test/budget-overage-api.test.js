// Tests for Stage 13E, Part 5 — exposing acknowledgeOverage via REST
// (POST /projects/:id/budget/overage/acknowledge) and MCP
// (acknowledge_budget_overage). Both are thin wrappers over the existing
// services/approval-gate.js function; neither raises the budget limit,
// touches approvals.status, or modifies a generation job.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-overage-api-projects-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-overage-api-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const app = require('../index');
const projectStore = require('../services/project-store');
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

test.after(() => server.close());

function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// Directly drives a project into an unacknowledged overage — same
// mechanics test/budget-ledger.test.js already exercises against
// approval-gate.js, reused here as REST-layer setup.
function projectWithOverage(title) {
  const project = projectStore.createProject({ title, topic: 'x' });
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 5 });
  gate.decideApproval(project, { approve: true });
  const job = generationStore.createGenerationJob({ projectId: project.id, reservedCost: 150 });
  gate.reconcileGenerationCost(project, job);
  projectStore.touch(project);
  return { project, job };
}

// --- 20. overage acknowledgement works ------------------------------------------------------

test('20. POST /projects/:id/budget/overage/acknowledge records the acknowledgement and lifts the block', async () => {
  const { project } = projectWithOverage('overage API test 1');

  const res = await postJson(`${baseUrl}/projects/${project.id}/budget/overage/acknowledge`, { acknowledgedBy: 'a human', note: 'known, approved to continue' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.alreadyAcknowledged, false);
  assert.equal(body.overage.acknowledged, true);
  assert.equal(body.overage.acknowledgedBy, 'a human');
  assert.ok(body.overage.acknowledgedAt);
  assert.equal(body.budget.blocked, false);
});

// --- 21. missing overage rejected -----------------------------------------------------------

test('21. acknowledging a project with no overage is rejected clearly', async () => {
  const project = projectStore.createProject({ title: 'no overage', topic: 'x' });
  const res = await postJson(`${baseUrl}/projects/${project.id}/budget/overage/acknowledge`, { acknowledgedBy: 'a human' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /No active budget overage/);
});

// --- 22. acknowledgement recorded (who + when + amount/generationId preserved) --------------

test('22. amount and generationId are preserved through acknowledgement', async () => {
  const { project, job } = projectWithOverage('overage API test 2');
  const before = await (await fetch(`${baseUrl}/projects/${project.id}/budget`)).json();

  const res = await postJson(`${baseUrl}/projects/${project.id}/budget/overage/acknowledge`, { acknowledgedBy: 'a human' });
  const body = await res.json();

  assert.equal(body.overage.amount, before.overage.amount);
  assert.equal(body.overage.generationId, job.id);
});

// --- 23. repeated acknowledgement handled (idempotent-by-response) --------------------------

test('23. acknowledging an already-acknowledged overage returns alreadyAcknowledged: true, without overwriting who/when', async () => {
  const { project } = projectWithOverage('overage API test 3');
  const first = await (await postJson(`${baseUrl}/projects/${project.id}/budget/overage/acknowledge`, { acknowledgedBy: 'first human' })).json();

  const second = await (await postJson(`${baseUrl}/projects/${project.id}/budget/overage/acknowledge`, { acknowledgedBy: 'second human' })).json();
  assert.equal(second.alreadyAcknowledged, true);
  assert.equal(second.overage.acknowledgedBy, 'first human', 'must not overwrite the original acknowledger');
  assert.equal(second.overage.acknowledgedAt, first.overage.acknowledgedAt);
});

// --- 24. budget remains unchanged (never raises the limit) ----------------------------------

test('24. acknowledging an overage never changes the budget limit or reserved credits', async () => {
  const { project } = projectWithOverage('overage API test 4');
  const before = await (await fetch(`${baseUrl}/projects/${project.id}/budget`)).json();

  await postJson(`${baseUrl}/projects/${project.id}/budget/overage/acknowledge`, { acknowledgedBy: 'a human' });

  const after = await (await fetch(`${baseUrl}/projects/${project.id}/budget`)).json();
  assert.equal(after.budgetLimit, before.budgetLimit);
  assert.equal(after.reservedCredits, before.reservedCredits);
  assert.equal(after.remainingBudget, before.remainingBudget, 'still negative — acknowledging never invents credits');
});

// --- 25. other blocking conditions remain enforced -------------------------------------------

test('25. acknowledging the overage does not bypass the separate approval requirement for a NEW request', async () => {
  const project = projectStore.createProject({ title: 'overage + separate approval test', topic: 'x' });
  gate.setBudget(project, 100);
  gate.requestApproval(project, { estimatedCost: 5 });
  gate.decideApproval(project, { approve: true });
  const job = generationStore.createGenerationJob({ projectId: project.id, reservedCost: 150 });
  gate.reconcileGenerationCost(project, job);
  projectStore.touch(project);

  await postJson(`${baseUrl}/projects/${project.id}/budget/overage/acknowledge`, { acknowledgedBy: 'a human' });

  // A brand-new approval request (PENDING, not yet decided) must still
  // independently block generation — acknowledging the overage only ever
  // lifts the overage-specific hard stop, never any other gate.
  await postJson(`${baseUrl}/projects/${project.id}/approval/request`, { estimatedCost: 1 });

  const budget = await (await fetch(`${baseUrl}/projects/${project.id}/budget`)).json();
  assert.equal(budget.generationAllowed, false);
  assert.match(budget.reason, /not been approved/i);
});

// --- MCP ---------------------------------------------------------------------------------

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

test('acknowledge_budget_overage (MCP) is discoverable and matches the REST behavior', async () => {
  const mcpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-overage-mcp-projects-'));
  const mcpJobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-overage-mcp-jobs-'));
  const envVars = { PROJECT_DATA_DIR: mcpProjectDir, GENERATION_JOBS_DATA_DIR: mcpJobsDir };
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'mcp', 'server.js')], env: envVars });
  const client = new Client({ name: 'evolink-overage-mcp-test-client', version: '0.1.0' });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    assert.ok(tools.map((t) => t.name).includes('acknowledge_budget_overage'));

    process.env.PROJECT_DATA_DIR = mcpProjectDir;
    process.env.GENERATION_JOBS_DATA_DIR = mcpJobsDir;
    delete require.cache[require.resolve('../services/project-store')];
    delete require.cache[require.resolve('../services/generation-store')];
    const freshProjectStore = require('../services/project-store');
    const freshGenerationStore = require('../services/generation-store');

    const project = freshProjectStore.createProject({ title: 'mcp overage test', topic: 'x' });
    gate.setBudget(project, 100);
    gate.requestApproval(project, { estimatedCost: 5 });
    gate.decideApproval(project, { approve: true });
    const job = freshGenerationStore.createGenerationJob({ projectId: project.id, reservedCost: 150 });
    gate.reconcileGenerationCost(project, job);
    freshProjectStore.touch(project);

    // No overage yet on a fresh project — fails clearly.
    const noOverageProject = freshProjectStore.createProject({ title: 'mcp no overage', topic: 'x' });
    const noOverageResult = JSON.parse(
      (await client.callTool({ name: 'acknowledge_budget_overage', arguments: { projectId: noOverageProject.id } })).content[0].text
    );
    assert.equal(noOverageResult.ok, false);

    const acknowledged = JSON.parse(
      (await client.callTool({ name: 'acknowledge_budget_overage', arguments: { projectId: project.id, acknowledgedBy: 'claude' } })).content[0].text
    );
    assert.equal(acknowledged.ok, true);
    assert.equal(acknowledged.alreadyAcknowledged, false);
    assert.equal(acknowledged.overage.acknowledgedBy, 'claude');

    const again = JSON.parse(
      (await client.callTool({ name: 'acknowledge_budget_overage', arguments: { projectId: project.id, acknowledgedBy: 'someone else' } })).content[0].text
    );
    assert.equal(again.alreadyAcknowledged, true);
    assert.equal(again.overage.acknowledgedBy, 'claude');
  } finally {
    await client.close();
    fs.rmSync(mcpProjectDir, { recursive: true, force: true });
    fs.rmSync(mcpJobsDir, { recursive: true, force: true });
  }
});

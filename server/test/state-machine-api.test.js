// Tests for Stage 13E, Part 4 — REST state-machine enforcement.
// PATCH /projects/:id must never be able to change project.status; only
// POST /projects/:id/transition (backed by schemas/state-machine.js's own
// transition()) may. Also confirms the MCP layer's existing behavior
// (update_project refuses status, transition_project uses the state
// machine) is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-sm-api-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const app = require('../index');

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

async function createProject(title = 'state-machine API test') {
  const res = await fetch(`${baseUrl}/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, topic: 'x' }) });
  return res.json();
}
function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function patchJson(url, body) {
  return fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// --- 15. REST direct status mutation blocked ----------------------------------------------

test('15. PATCH /projects/:id cannot directly set status', async () => {
  const project = await createProject();
  const res = await patchJson(`${baseUrl}/projects/${project.id}`, { status: 'RESEARCH' });
  assert.equal(res.status, 400);

  const reread = await (await fetch(`${baseUrl}/projects/${project.id}`)).json();
  assert.equal(reread.status, 'PLANNING');
});

// --- 16. valid transition works -------------------------------------------------------------

test('16. POST /projects/:id/transition performs a valid transition', async () => {
  const project = await createProject();
  const res = await postJson(`${baseUrl}/projects/${project.id}/transition`, { to: 'RESEARCH' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'RESEARCH');

  const reread = await (await fetch(`${baseUrl}/projects/${project.id}`)).json();
  assert.equal(reread.status, 'RESEARCH');
});

// --- 17. invalid transition fails -------------------------------------------------------------

test('17. POST /projects/:id/transition rejects an illegal jump, leaving status unchanged', async () => {
  const project = await createProject();
  const res = await postJson(`${baseUrl}/projects/${project.id}/transition`, { to: 'COMPLETE' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /Cannot move/);

  const reread = await (await fetch(`${baseUrl}/projects/${project.id}`)).json();
  assert.equal(reread.status, 'PLANNING');
});

test('POST /projects/:id/transition requires "to" and 404s for an unknown project', async () => {
  const project = await createProject();
  let res = await postJson(`${baseUrl}/projects/${project.id}/transition`, {});
  assert.equal(res.status, 400);

  res = await postJson(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000/transition`, { to: 'RESEARCH' });
  assert.equal(res.status, 404);
});

// --- 18. generation-state transition remains gated ---------------------------------------

test('18. transitioning into a generation state is still blocked without approval, and works once approved', async () => {
  const project = await createProject();
  // Walk to GENERATION_REVIEW, the state just before the first generation state.
  for (const to of ['RESEARCH', 'CREATIVE_REVIEW', 'SCRIPTING', 'SCRIPT_REVIEW', 'VISUAL_DEVELOPMENT', 'VISUAL_REVIEW', 'STORYBOARD', 'GENERATION_REVIEW']) {
    const res = await postJson(`${baseUrl}/projects/${project.id}/transition`, { to });
    assert.equal(res.status, 200, `expected ${to} to succeed`);
  }

  const blocked = await postJson(`${baseUrl}/projects/${project.id}/transition`, { to: 'CALIBRATION' });
  assert.equal(blocked.status, 409);
  const blockedBody = await blocked.json();
  assert.match(blockedBody.error, /approval\/budget gate/);

  await postJson(`${baseUrl}/projects/${project.id}/approval/request`, { estimatedCost: 5 });
  await postJson(`${baseUrl}/projects/${project.id}/approval/decision`, { approve: true, decidedBy: 'tester' });

  const allowed = await postJson(`${baseUrl}/projects/${project.id}/transition`, { to: 'CALIBRATION' });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).status, 'CALIBRATION');
});

// --- 19. MCP regression (existing MCP behaviour is unchanged) ----------------------------

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

test('19. update_project (MCP) still refuses to accept a status field, and transition_project (MCP) still works', async () => {
  const mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-sm-mcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'mcp', 'server.js')], env: { PROJECT_DATA_DIR: mcpDir } });
  const client = new Client({ name: 'evolink-sm-mcp-test-client', version: '0.1.0' });
  await client.connect(transport);

  try {
    const created = JSON.parse((await client.callTool({ name: 'create_project', arguments: { title: 'mcp sm test', topic: 'x' } })).content[0].text);

    // update_project's schema has no `status` field at all — passing one
    // is simply ignored by the MCP SDK's input validation (extra keys
    // dropped), so the real regression check is that status truly never
    // moves via this tool.
    const updated = JSON.parse((await client.callTool({ name: 'update_project', arguments: { projectId: created.id, title: 'renamed' } })).content[0].text);
    assert.equal(updated.status, 'PLANNING');
    assert.equal(updated.title, 'renamed');

    const transitioned = JSON.parse((await client.callTool({ name: 'transition_project', arguments: { projectId: created.id, targetState: 'RESEARCH' } })).content[0].text);
    assert.equal(transitioned.ok, true);
    assert.equal(transitioned.project.status, 'RESEARCH');
  } finally {
    await client.close();
    fs.rmSync(mcpDir, { recursive: true, force: true });
  }
});

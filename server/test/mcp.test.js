// Tests for the MCP server (server/mcp/server.js), using a REAL MCP
// client talking to a REAL spawned server process over stdio — the same
// way Claude Code would. This is deliberately end-to-end rather than
// calling tool handlers directly, so it also proves the server starts up
// and its tools are discoverable.
//
// TEST DATA SAFETY: the spawned server is given PROJECT_DATA_DIR pointing
// at a fresh temporary folder (never server/data/projects), so nothing
// here can ever touch real project data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-mcp-test-'));

let client;

test.before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: { PROJECT_DATA_DIR: tempDir },
  });
  client = new Client({ name: 'evolink-test-client', version: '0.1.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function textOf(result) {
  return JSON.parse(result.content[0].text);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

async function createTestProject(overrides = {}) {
  const result = await call('create_project', { title: 'Test Project', topic: 'Test topic', ...overrides });
  return textOf(result);
}

test('a real MCP client can discover all 16 tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();

  assert.equal(names.length, 16);
  assert.deepEqual(names, [
    'create_project',
    'create_scene',
    'create_shot',
    'get_approval_status',
    'get_asset',
    'get_project',
    'get_project_status',
    'get_shot',
    'list_assets',
    'list_projects',
    'list_scenes',
    'list_shots',
    'record_approval_decision',
    'request_generation_approval',
    'transition_project',
    'update_project',
  ]);
});

test('safety boundary: no generation or raw-access tools exist', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  const forbidden = [
    'call_evolink',
    'raw_api_request',
    'execute_generation',
    'arbitrary_http_request',
    'generate_video',
    'generate_keyframe',
    'generate_image',
  ];
  for (const name of forbidden) {
    assert.ok(!names.includes(name), `${name} must not exist as an MCP tool`);
  }
});

test('1. create_project creates a project with expected fields', async () => {
  const project = textOf(
    await call('create_project', {
      title: 'Nokia Story',
      topic: 'Why Nokia lost the smartphone war',
      audience: 'tech enthusiasts',
    })
  );

  assert.ok(project.id);
  assert.equal(project.title, 'Nokia Story');
  assert.equal(project.audience, 'tech enthusiasts');
  assert.equal(project.status, 'PLANNING');
});

test('2. get_project retrieves a project by id', async () => {
  const created = await createTestProject({ title: 'Fetch me' });
  const fetched = textOf(await call('get_project', { projectId: created.id }));

  assert.equal(fetched.id, created.id);
  assert.equal(fetched.title, 'Fetch me');
});

test('get_project reports a clear error for an unknown id', async () => {
  const result = await call('get_project', { projectId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(result.isError, true);
});

test('3. list_projects returns a concise summary, not full project bodies', async () => {
  await createTestProject({ title: 'List test' });
  const list = textOf(await call('list_projects'));

  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
  const entry = list[0];
  assert.ok('id' in entry && 'title' in entry && 'topic' in entry && 'status' in entry);
  assert.ok('createdAt' in entry && 'updatedAt' in entry);
  assert.ok(!('script' in entry), 'list_projects should stay concise, not return full project bodies');
});

test('4. update_project updates only safe fields, never status', async () => {
  const created = await createTestProject({ title: 'Before' });
  const updated = textOf(
    await call('update_project', { projectId: created.id, title: 'After', tone: 'nostalgic' })
  );

  assert.equal(updated.title, 'After');
  assert.equal(updated.tone, 'nostalgic');
  assert.equal(updated.status, 'PLANNING', 'update_project must not be able to change status');
});

test('5. get_project_status returns a beginner-friendly summary', async () => {
  const created = await createTestProject();
  const status = textOf(await call('get_project_status', { projectId: created.id }));

  assert.equal(status.currentState, 'PLANNING');
  assert.ok(status.whatThisMeans.length > 0);
  assert.deepEqual(status.nextAllowedStates, ['RESEARCH']);
  assert.equal(status.approvalRequired, false);
  assert.equal(status.generationCurrentlyAllowed, false);
});

test('6. transition_project performs and persists a valid state transition', async () => {
  const created = await createTestProject();
  const result = textOf(await call('transition_project', { projectId: created.id, targetState: 'RESEARCH' }));

  assert.equal(result.ok, true);
  assert.equal(result.project.status, 'RESEARCH');

  const refetched = textOf(await call('get_project', { projectId: created.id }));
  assert.equal(refetched.status, 'RESEARCH', 'the transition must actually be saved to disk');
});

test('7. transition_project rejects an invalid transition with a clear reason', async () => {
  const created = await createTestProject();
  const result = textOf(await call('transition_project', { projectId: created.id, targetState: 'SCRIPTING' }));

  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
  assert.equal(result.currentState, 'PLANNING', 'status must be unchanged after a rejected transition');
});

test('8. create_scene adds a scene using the existing Production IR structure', async () => {
  const created = await createTestProject();
  const scene = textOf(
    await call('create_scene', { projectId: created.id, title: 'Opening', description: 'The intro scene' })
  );

  assert.ok(scene.sceneId);
  assert.equal(scene.title, 'Opening');

  const scenes = textOf(await call('list_scenes', { projectId: created.id }));
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].sceneId, scene.sceneId);
});

test('9. create_shot associates a shot with the correct project and scene', async () => {
  const created = await createTestProject();
  const scene = textOf(await call('create_scene', { projectId: created.id, title: 'S1', description: 'd' }));
  const shot = textOf(
    await call('create_shot', {
      projectId: created.id,
      sceneId: scene.sceneId,
      narrativePurpose: 'establish the setting',
    })
  );

  assert.ok(shot.shotId);
  assert.equal(shot.sceneId, scene.sceneId);
  assert.equal(shot.narrativePurpose, 'establish the setting');
});

test('create_shot rejects a sceneId that does not belong to the project', async () => {
  const created = await createTestProject();
  const result = await call('create_shot', { projectId: created.id, sceneId: 'not-a-real-scene' });
  assert.equal(result.isError, true);
});

test('10. list_shots returns all shots, filterable by scene', async () => {
  const created = await createTestProject();
  const sceneA = textOf(await call('create_scene', { projectId: created.id, title: 'A', description: 'd' }));
  const sceneB = textOf(await call('create_scene', { projectId: created.id, title: 'B', description: 'd' }));
  await call('create_shot', { projectId: created.id, sceneId: sceneA.sceneId });
  await call('create_shot', { projectId: created.id, sceneId: sceneB.sceneId });

  const all = textOf(await call('list_shots', { projectId: created.id }));
  assert.equal(all.length, 2);

  const onlyA = textOf(await call('list_shots', { projectId: created.id, sceneId: sceneA.sceneId }));
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].sceneId, sceneA.sceneId);
});

test('11. list_assets returns an empty list without error (nothing generates yet)', async () => {
  const created = await createTestProject();
  const assets = textOf(await call('list_assets', { projectId: created.id }));
  assert.deepEqual(assets, []);
});

test('12. get_approval_status reports the gate state from the existing gate service', async () => {
  const created = await createTestProject();
  const status = textOf(await call('get_approval_status', { projectId: created.id }));

  assert.equal(status.approvalStatus, 'NONE');
  assert.equal(status.generationAllowed, false);
});

test('13. request_generation_approval requests approval without generating anything', async () => {
  const created = await createTestProject();
  const approvals = textOf(
    await call('request_generation_approval', { projectId: created.id, estimatedCost: 25, note: 'first batch' })
  );

  assert.equal(approvals.status, 'PENDING');
  assert.equal(approvals.estimatedCost, 25);

  const status = textOf(await call('get_approval_status', { projectId: created.id }));
  assert.equal(status.generationAllowed, false, 'requesting approval must not itself grant it');
});

test('14. record_approval_decision approves a pending request via the existing gate service', async () => {
  const created = await createTestProject();
  await call('request_generation_approval', { projectId: created.id, estimatedCost: 10 });
  const decision = textOf(
    await call('record_approval_decision', { projectId: created.id, approve: true, decidedBy: 'Opeyemi' })
  );

  assert.equal(decision.ok, true);
  assert.equal(decision.approvals.status, 'APPROVED');

  const status = textOf(await call('get_approval_status', { projectId: created.id }));
  assert.equal(status.generationAllowed, true);
});

test('record_approval_decision reports a clear failure when nothing is pending', async () => {
  const created = await createTestProject();
  const decision = textOf(await call('record_approval_decision', { projectId: created.id, approve: true }));
  assert.equal(decision.ok, false);
});

test('a full MCP-driven walk reaches CALIBRATION only after approval', async () => {
  const created = await createTestProject();

  // Blocked before approval
  const blocked = textOf(
    await (async () => {
      for (const state of [
        'RESEARCH',
        'CREATIVE_REVIEW',
        'SCRIPTING',
        'SCRIPT_REVIEW',
        'VISUAL_DEVELOPMENT',
        'VISUAL_REVIEW',
        'STORYBOARD',
        'GENERATION_REVIEW',
      ]) {
        await call('transition_project', { projectId: created.id, targetState: state });
      }
      return call('transition_project', { projectId: created.id, targetState: 'CALIBRATION' });
    })()
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /gate/i);

  // Approve, then it opens
  await call('request_generation_approval', { projectId: created.id, estimatedCost: 20 });
  await call('record_approval_decision', { projectId: created.id, approve: true });

  const allowed = textOf(await call('transition_project', { projectId: created.id, targetState: 'CALIBRATION' }));
  assert.equal(allowed.ok, true);
  assert.equal(allowed.project.status, 'CALIBRATION');
});

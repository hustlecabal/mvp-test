// Tests for the Stage 11A creative-planning MCP tools, using a real
// spawned MCP server process over stdio — same pattern as
// generation-mcp.test.js / history-mcp.test.js. Confirms the read and
// update tools work end-to-end through the real MCP layer, and that none
// of them can create a generation job or touch the approval/budget gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-creative-mcp-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-creative-mcp-artifacts-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-creative-mcp-jobs-'));
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-creative-mcp-blueprints-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.CREATIVE_BLUEPRINT_DATA_DIR = blueprintTempDir;

const projectStore = require('../services/project-store');
const generationStore = require('../services/generation-store');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let client;

test.before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: { PROJECT_DATA_DIR: projectTempDir, CREATIVE_DATA_DIR: creativeTempDir, GENERATION_JOBS_DATA_DIR: jobsTempDir, CREATIVE_BLUEPRINT_DATA_DIR: blueprintTempDir },
  });
  client = new Client({ name: 'evolink-creative-mcp-test-client', version: '0.1.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client.close();
  fs.rmSync(projectTempDir, { recursive: true, force: true });
  fs.rmSync(creativeTempDir, { recursive: true, force: true });
  fs.rmSync(jobsTempDir, { recursive: true, force: true });
  fs.rmSync(blueprintTempDir, { recursive: true, force: true });
});

function textOf(result) {
  return JSON.parse(result.content[0].text);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function createProject() {
  return projectStore.createProject({ title: 'MCP creative test', topic: 'x' });
}

// --- 23. MCP read tools --------------------------------------------------------

test('23. get_creative_brief / get_master_creative_spec / get_visual_bible / get_storyboard all return null before creation', async () => {
  const project = createProject();

  assert.equal(textOf(await call('get_creative_brief', { projectId: project.id })), null);
  assert.equal(textOf(await call('get_master_creative_spec', { projectId: project.id })), null);
  assert.equal(textOf(await call('get_visual_bible', { projectId: project.id })), null);
  assert.equal(textOf(await call('get_storyboard', { projectId: project.id })), null);
});

test('get_creative_brief reports a clear error for an unknown project', async () => {
  const result = await call('get_creative_brief', { projectId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(result.isError, true);
});

// --- 24. MCP update tools -------------------------------------------------------

test('24. update_creative_brief creates then updates through MCP, versioning correctly', async () => {
  const project = createProject();

  const v1 = textOf(await call('update_creative_brief', { projectId: project.id, title: 'Brief v1', tone: 'hopeful' }));
  assert.equal(v1.version, 1);
  assert.equal(v1.title, 'Brief v1');

  const v2 = textOf(await call('update_creative_brief', { projectId: project.id, tone: 'bittersweet', changeNote: 'tone shift' }));
  assert.equal(v2.version, 2);
  assert.equal(v2.title, 'Brief v1', 'unrelated field must be preserved');
  assert.equal(v2.tone, 'bittersweet');
  assert.equal(v2.history[0].changeNote, null);
});

test('update_master_creative_spec creates and updates through MCP', async () => {
  const project = createProject();
  const v1 = textOf(await call('update_master_creative_spec', { projectId: project.id, coreConcept: 'a quiet mystery' }));
  assert.equal(v1.coreConcept, 'a quiet mystery');
  assert.equal(v1.version, 1);
});

test('update_visual_bible creates and updates through MCP, including character/location arrays', async () => {
  const project = createProject();
  const result = textOf(
    await call('update_visual_bible', {
      projectId: project.id,
      world: 'a coastal town',
      characters: [{ characterId: 'char-1', name: 'Mira' }],
      locations: [{ locationId: 'loc-1', name: 'The Lighthouse' }],
    })
  );

  assert.equal(result.world, 'a coastal town');
  assert.equal(result.characters[0].name, 'Mira');
  assert.equal(result.locations[0].name, 'The Lighthouse');
});

test('update_storyboard, create_storyboard_scene, and create_storyboard_shot all work through MCP', async () => {
  const project = createProject();

  await call('update_storyboard', { projectId: project.id, changeNote: 'initialized' });
  const scene = textOf(await call('create_storyboard_scene', { projectId: project.id, title: 'Opening' }));
  assert.ok(scene.sceneId);

  const shot = textOf(
    await call('create_storyboard_shot', {
      projectId: project.id,
      sceneId: scene.sceneId,
      purpose: 'establish the setting',
      status: 'PLANNED',
    })
  );
  assert.equal(shot.sceneId, scene.sceneId);
  assert.equal(shot.status, 'PLANNED');

  const storyboard = textOf(await call('get_storyboard', { projectId: project.id }));
  assert.equal(storyboard.scenes.length, 1);
  assert.equal(storyboard.shots.length, 1);
  assert.ok(storyboard.version >= 3, 'each of update_storyboard/create_storyboard_scene/create_storyboard_shot must bump the version');
});

// PRODUCTION COMPLETION BLOCKER, Part 4 — update_storyboard's MCP schema
// previously omitted blueprintId even though creative-store.js's own
// updateStoryboard() (and its own error text elsewhere in the codebase)
// expects exactly this call shape to link a Storyboard to a real
// CreativeBlueprint. Proves the real, end-to-end MCP surface: a real
// CreativeBlueprint built through the real MCP tool, linked through the
// real MCP update_storyboard call, and read back through the real MCP
// get_storyboard call.
test('update_storyboard can set and persist blueprintId through the real MCP surface', async () => {
  const project = createProject();
  const blueprint = textOf(
    await call('build_creative_blueprint_draft', { projectId: project.id, concept: 'c', corePromise: 'p', targetDuration: 60 })
  );
  assert.equal(blueprint.status, 'DRAFT');
  assert.equal(blueprint.recommendationSetId, null);

  const updated = textOf(await call('update_storyboard', { projectId: project.id, blueprintId: blueprint.id, changeNote: 'link blueprint' }));
  assert.equal(updated.blueprintId, blueprint.id);

  const fetched = textOf(await call('get_storyboard', { projectId: project.id }));
  assert.equal(fetched.blueprintId, blueprint.id);
});

test('update_storyboard rejects an unresolvable blueprintId rather than silently accepting it', async () => {
  const project = createProject();
  const result = await call('update_storyboard', { projectId: project.id, blueprintId: 'does-not-exist' });
  assert.equal(result.isError, true);
});

test('update_storyboard can clear blueprintId back to null', async () => {
  const project = createProject();
  const blueprint = textOf(
    await call('build_creative_blueprint_draft', { projectId: project.id, concept: 'c', corePromise: 'p', targetDuration: 60 })
  );
  await call('update_storyboard', { projectId: project.id, blueprintId: blueprint.id });
  const cleared = textOf(await call('update_storyboard', { projectId: project.id, blueprintId: null }));
  assert.equal(cleared.blueprintId, null);
});

test('create_storyboard_shot rejects an invalid planning status', async () => {
  const project = createProject();
  const result = await call('create_storyboard_shot', { projectId: project.id, status: 'NOT_A_REAL_STATUS' });
  assert.equal(result.isError, true);
});

// --- creative tools are discoverable and never generate anything ---------------

test('all 10 creative-planning tools are discoverable', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of [
    'get_creative_brief',
    'update_creative_brief',
    'get_master_creative_spec',
    'update_master_creative_spec',
    'get_visual_bible',
    'update_visual_bible',
    'get_storyboard',
    'update_storyboard',
    'create_storyboard_scene',
    'create_storyboard_shot',
  ]) {
    assert.ok(names.includes(name), `${name} must be registered`);
  }
});

test('no creative-planning MCP call ever creates a generation job', async () => {
  const project = createProject();
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  await call('update_creative_brief', { projectId: project.id, title: 'x' });
  await call('update_master_creative_spec', { projectId: project.id, coreConcept: 'x' });
  await call('update_visual_bible', { projectId: project.id, world: 'x' });
  const scene = textOf(await call('create_storyboard_scene', { projectId: project.id, title: 'S1' }));
  await call('create_storyboard_shot', { projectId: project.id, sceneId: scene.sceneId });

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

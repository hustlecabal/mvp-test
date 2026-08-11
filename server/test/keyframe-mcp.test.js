// Tests for the Stage 12 Keyframe Intelligence MCP tools, using a real
// spawned MCP server process over stdio — same pattern as
// creative-mcp.test.js. Confirms the read/write/analysis tools work
// end-to-end through the real MCP layer, and that none of them can create
// a generation job or touch the approval/budget gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-mcp-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-mcp-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-mcp-keyframes-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-keyframe-mcp-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.CREATIVE_DATA_DIR = creativeTempDir;
process.env.KEYFRAME_DATA_DIR = keyframeTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const projectStore = require('../services/project-store');
const generationStore = require('../services/generation-store');
const creativeStore = require('../services/creative-store');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let client;

test.before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: {
      PROJECT_DATA_DIR: projectTempDir,
      CREATIVE_DATA_DIR: creativeTempDir,
      KEYFRAME_DATA_DIR: keyframeTempDir,
      GENERATION_JOBS_DATA_DIR: jobsTempDir,
    },
  });
  client = new Client({ name: 'evolink-keyframe-mcp-test-client', version: '0.1.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client.close();
  fs.rmSync(projectTempDir, { recursive: true, force: true });
  fs.rmSync(creativeTempDir, { recursive: true, force: true });
  fs.rmSync(keyframeTempDir, { recursive: true, force: true });
  fs.rmSync(jobsTempDir, { recursive: true, force: true });
});

function textOf(result) {
  return JSON.parse(result.content[0].text);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function createProject() {
  return projectStore.createProject({ title: 'MCP keyframe test', topic: 'x' });
}

// --- discoverability ---------------------------------------------------------------

test('all 7 keyframe tools are discoverable', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of [
    'get_keyframe_plan',
    'update_keyframe_plan',
    'list_keyframes',
    'get_keyframe',
    'create_keyframe',
    'update_keyframe',
    'analyze_shot_keyframes',
  ]) {
    assert.ok(names.includes(name), `${name} must be registered`);
  }
});

test('no execute/generate-style keyframe tool exists', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const forbidden of ['execute_keyframe', 'generate_keyframe', 'run_keyframe_skill']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
  }
});

// --- get_keyframe_plan / update_keyframe_plan ---------------------------------------

test('get_keyframe_plan returns an empty (not null) plan for a project with no keyframes yet', async () => {
  const project = createProject();
  const plan = textOf(await call('get_keyframe_plan', { projectId: project.id }));
  assert.equal(plan.projectId, project.id);
  assert.deepEqual(plan.keyframes, []);
});

test('get_keyframe_plan reports a clear error for an unknown project', async () => {
  const result = await call('get_keyframe_plan', { projectId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(result.isError, true);
});

test('update_keyframe_plan bumps the version', async () => {
  const project = createProject();
  await call('get_keyframe_plan', { projectId: project.id });
  const updated = textOf(await call('update_keyframe_plan', { projectId: project.id, changeNote: 'reviewed' }));
  assert.equal(updated.version, 2);
});

// --- create_keyframe / update_keyframe / get_keyframe / list_keyframes --------------

test('create_keyframe, get_keyframe, update_keyframe, and list_keyframes work end-to-end through MCP', async () => {
  const project = createProject();
  const created = textOf(
    await call('create_keyframe', { projectId: project.id, shotId: 'shot-1', frameType: 'CHARACTER_REFERENCE', subject: 'Mira' })
  );
  assert.ok(created.keyframeId);
  assert.equal(created.subject, 'Mira');

  const fetched = textOf(await call('get_keyframe', { projectId: project.id, keyframeId: created.keyframeId }));
  assert.equal(fetched.keyframeId, created.keyframeId);
  assert.equal(fetched.stale, false);

  const updated = textOf(await call('update_keyframe', { projectId: project.id, keyframeId: created.keyframeId, status: 'PLANNED' }));
  assert.equal(updated.status, 'PLANNED');

  const list = textOf(await call('list_keyframes', { projectId: project.id, shotId: 'shot-1' }));
  assert.equal(list.length, 1);
  assert.equal(list[0].keyframeId, created.keyframeId);
});

test('create_keyframe rejects an invalid frameType', async () => {
  const result = await call('create_keyframe', { projectId: createProject().id, frameType: 'NOT_A_REAL_TYPE' });
  assert.equal(result.isError, true);
});

test('get_keyframe reports a clear error for an unknown keyframeId', async () => {
  const project = createProject();
  const result = await call('get_keyframe', { projectId: project.id, keyframeId: 'nope' });
  assert.equal(result.isError, true);
});

// --- analyze_shot_keyframes ----------------------------------------------------------

test('analyze_shot_keyframes runs the deterministic analysis through MCP', async () => {
  const project = createProject();
  await call('update_visual_bible', { projectId: project.id, characters: [{ characterId: 'char-1', name: 'Mira' }] });
  const scene = textOf(await call('create_storyboard_scene', { projectId: project.id, title: 'S1' }));
  const shot = textOf(await call('create_storyboard_shot', { projectId: project.id, sceneId: scene.sceneId, characterReferences: ['char-1'] }));

  const result = textOf(await call('analyze_shot_keyframes', { projectId: project.id, shotId: shot.shotId }));
  assert.equal(result.shotId, shot.shotId);
  assert.ok(result.recommendations.some((r) => r.frameType === 'CHARACTER_REFERENCE'));
});

test('analyze_shot_keyframes reports a clear error for an unknown shotId', async () => {
  const project = createProject();
  await call('update_storyboard', { projectId: project.id, changeNote: 'init' });
  const result = await call('analyze_shot_keyframes', { projectId: project.id, shotId: 'nope' });
  assert.equal(result.isError, true);
});

// --- safety: no keyframe tool call ever creates a generation job -------------------

test('no keyframe MCP call ever creates a generation job', async () => {
  const project = createProject();
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  const scene = textOf(await call('create_storyboard_scene', { projectId: project.id, title: 'S1' }));
  const shot = textOf(await call('create_storyboard_shot', { projectId: project.id, sceneId: scene.sceneId }));
  const kf = textOf(await call('create_keyframe', { projectId: project.id, shotId: shot.shotId, frameType: 'ESTABLISHING_FRAME' }));
  await call('update_keyframe', { projectId: project.id, keyframeId: kf.keyframeId, status: 'APPROVED' });
  await call('analyze_shot_keyframes', { projectId: project.id, shotId: shot.shotId });

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

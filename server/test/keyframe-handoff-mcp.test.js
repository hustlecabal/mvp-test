// Tests for the Stage 13D keyframe handoff MCP tools, using a real
// spawned MCP server process over stdio. Confirms create/get/list/cancel
// are discoverable, that create enforces the same safety gates the
// service does, and that no execute/run/generate tool exists for a
// handoff — image ingestion is REST-only (Part 6) and deliberately has
// no MCP tool at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-mcp-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-mcp-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-mcp-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-mcp-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-mcp-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-mcp-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-mcp-assets-'));
const handoffTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfhandoff-mcp-handoffs-'));
const envVars = {
  PROJECT_DATA_DIR: projectTempDir,
  CREATIVE_DATA_DIR: creativeTempDir,
  KEYFRAME_DATA_DIR: keyframeTempDir,
  KEYFRAME_PROMPT_DATA_DIR: promptTempDir,
  KEYFRAME_GENERATION_APPROVAL_DATA_DIR: approvalTempDir,
  GENERATION_JOBS_DATA_DIR: jobsTempDir,
  ASSET_STORAGE_DIR: assetsTempDir,
  KEYFRAME_HANDOFF_DATA_DIR: handoffTempDir,
};
for (const [key, value] of Object.entries(envVars)) process.env[key] = value;

const projectStore = require('../services/project-store');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let client;

test.before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: envVars,
  });
  client = new Client({ name: 'evolink-kfhandoff-mcp-test-client', version: '0.1.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client.close();
  for (const dir of Object.values(envVars)) fs.rmSync(dir, { recursive: true, force: true });
});

function textOf(result) {
  return JSON.parse(result.content[0].text);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function createProject() {
  return projectStore.createProject({ title: 'MCP kfhandoff test', topic: 'x' });
}

async function seedApprovedKeyframe(project) {
  const scene = textOf(await call('create_storyboard_scene', { projectId: project.id, title: 'S1' }));
  const shot = textOf(await call('create_storyboard_shot', { projectId: project.id, sceneId: scene.sceneId }));
  const keyframe = textOf(await call('create_keyframe', { projectId: project.id, shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME' }));
  const pkg = textOf(await call('build_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  await call('request_keyframe_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  await call('approve_keyframe_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' });
  return { scene, shot, keyframe, pkg };
}

// --- discoverability + safety boundary ---------------------------------------------------

test('all 4 keyframe handoff tools are discoverable', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('create_keyframe_handoff'));
  assert.ok(names.includes('get_keyframe_handoff'));
  assert.ok(names.includes('list_keyframe_handoffs'));
  assert.ok(names.includes('cancel_keyframe_handoff'));
});

test('there is no execute_handoff, run_handoff, run_skill, or generate_from_handoff tool', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const forbidden of ['execute_handoff', 'run_handoff', 'run_skill', 'generate_from_handoff']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
  }
});

// --- create_keyframe_handoff --------------------------------------------------------------

test('create_keyframe_handoff creates a READY handoff once approved, and fails clearly before that', async () => {
  const project = createProject();
  const scene = textOf(await call('create_storyboard_scene', { projectId: project.id, title: 'S1' }));
  const shot = textOf(await call('create_storyboard_shot', { projectId: project.id, sceneId: scene.sceneId }));
  const keyframe = textOf(await call('create_keyframe', { projectId: project.id, shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME' }));
  await call('build_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId });

  const early = await call('create_keyframe_handoff', { projectId: project.id, keyframeId: keyframe.keyframeId });
  assert.equal(early.isError, true);

  await call('request_keyframe_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  await call('approve_keyframe_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' });

  const handoff = textOf(await call('create_keyframe_handoff', { projectId: project.id, keyframeId: keyframe.keyframeId, createdBy: 'claude' }));
  assert.equal(handoff.status, 'READY');
  assert.ok(handoff.handoffId);
});

test('create_keyframe_handoff reports a clear error for an unknown project', async () => {
  const result = await call('create_keyframe_handoff', { projectId: '00000000-0000-0000-0000-000000000000', keyframeId: 'x' });
  assert.equal(result.isError, true);
});

// --- get / list / cancel ------------------------------------------------------------------

test('get_keyframe_handoff / list_keyframe_handoffs / cancel_keyframe_handoff round-trip', async () => {
  const project = createProject();
  const { keyframe } = await seedApprovedKeyframe(project);
  const handoff = textOf(await call('create_keyframe_handoff', { projectId: project.id, keyframeId: keyframe.keyframeId }));

  const fetched = textOf(await call('get_keyframe_handoff', { projectId: project.id, handoffId: handoff.handoffId }));
  assert.equal(fetched.handoffId, handoff.handoffId);

  const listed = textOf(await call('list_keyframe_handoffs', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(listed.length, 1);

  const cancelled = textOf(await call('cancel_keyframe_handoff', { projectId: project.id, handoffId: handoff.handoffId, decidedBy: 'claude' }));
  assert.equal(cancelled.status, 'CANCELLED');
});

test('get_keyframe_handoff reports a clear error for an unknown handoff', async () => {
  const project = createProject();
  const result = await call('get_keyframe_handoff', { projectId: project.id, handoffId: 'nope' });
  assert.equal(result.isError, true);
});

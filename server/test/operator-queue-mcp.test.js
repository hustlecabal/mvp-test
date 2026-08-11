// Tests for Stage 14, Part 7 — the Operator Queue MCP tools
// (get_operator_queue, get_operator_queue_summary, get_next_operator_action),
// using a real spawned MCP server process over stdio. All three are
// read-only; confirms there is no execute_queue/run_queue/generate_queue/
// auto_process_queue/batch_generate tool anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-mcp-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-mcp-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-mcp-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-mcp-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-mcp-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-mcp-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-mcp-assets-'));
const handoffTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-oq-mcp-handoffs-'));
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
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'mcp', 'server.js')], env: envVars });
  client = new Client({ name: 'evolink-oq-mcp-test-client', version: '0.1.0' });
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
  return projectStore.createProject({ title: 'MCP operator queue test', topic: 'x' });
}

test('26. all 3 operator queue tools are discoverable', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('get_operator_queue'));
  assert.ok(names.includes('get_operator_queue_summary'));
  assert.ok(names.includes('get_next_operator_action'));
});

test('there is no execute_queue, run_queue, generate_queue, auto_process_queue, or batch_generate tool', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const forbidden of ['execute_queue', 'run_queue', 'generate_queue', 'auto_process_queue', 'batch_generate']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
  }
});

test('get_operator_queue / get_operator_queue_summary / get_next_operator_action work end-to-end through real MCP calls', async () => {
  const project = createProject();
  const scene = textOf(await call('create_storyboard_scene', { projectId: project.id, title: 'S1' }));
  const shot = textOf(await call('create_storyboard_shot', { projectId: project.id, sceneId: scene.sceneId }));
  const keyframe = textOf(await call('create_keyframe', { projectId: project.id, shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME' }));
  await call('build_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId });

  const queue = textOf(await call('get_operator_queue', { projectId: project.id }));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].category, 'NEEDS_APPROVAL');

  const summary = textOf(await call('get_operator_queue_summary', { projectId: project.id }));
  assert.equal(summary.totalKeyframes, 1);
  assert.equal(summary.needsApproval, 1);

  const next = textOf(await call('get_next_operator_action', { projectId: project.id }));
  assert.equal(next.category, 'NEEDS_APPROVAL');
  assert.equal(next.nextAction, 'Approve keyframe generation');
});

test('get_operator_queue reports a clear error for an unknown project', async () => {
  const result = await call('get_operator_queue', { projectId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(result.isError, true);
});

test('an empty project (no storyboard) returns an empty queue and nextAction: null, never an error', async () => {
  const project = createProject();
  const queue = textOf(await call('get_operator_queue', { projectId: project.id }));
  assert.deepEqual(queue, []);
  const next = textOf(await call('get_next_operator_action', { projectId: project.id }));
  assert.deepEqual(next, { nextAction: null });
});

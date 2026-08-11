// Tests for the Stage 13C keyframe execution bridge MCP tools, using a
// real spawned MCP server process over stdio. Confirms
// prepare_keyframe_execution is read-only and safe, and that
// run_fixture_keyframe_execution enforces every Stage 13B safety check
// and never reaches a real provider.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-mcp-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-mcp-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-mcp-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-mcp-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-mcp-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-mcp-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfexec-mcp-assets-'));
const envVars = {
  PROJECT_DATA_DIR: projectTempDir,
  CREATIVE_DATA_DIR: creativeTempDir,
  KEYFRAME_DATA_DIR: keyframeTempDir,
  KEYFRAME_PROMPT_DATA_DIR: promptTempDir,
  KEYFRAME_GENERATION_APPROVAL_DATA_DIR: approvalTempDir,
  GENERATION_JOBS_DATA_DIR: jobsTempDir,
  ASSET_STORAGE_DIR: assetsTempDir,
};
for (const [key, value] of Object.entries(envVars)) process.env[key] = value;

const projectStore = require('../services/project-store');
const generationStore = require('../services/generation-store');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let client;

test.before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: envVars,
  });
  client = new Client({ name: 'evolink-kfexec-mcp-test-client', version: '0.1.0' });
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
  return projectStore.createProject({ title: 'MCP kfexec test', topic: 'x' });
}

async function seedShotKeyframeAndPackage(project) {
  const scene = textOf(await call('create_storyboard_scene', { projectId: project.id, title: 'S1' }));
  const shot = textOf(await call('create_storyboard_shot', { projectId: project.id, sceneId: scene.sceneId }));
  const keyframe = textOf(await call('create_keyframe', { projectId: project.id, shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME' }));
  const pkg = textOf(await call('build_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  return { scene, shot, keyframe, pkg };
}

// --- 12. MCP preparation tool ---------------------------------------------------

test('12. both keyframe execution bridge tools are discoverable', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('prepare_keyframe_execution'));
  assert.ok(names.includes('run_fixture_keyframe_execution'));
});

test('there is no raw_skill_execution, execute_any_skill, raw_command, or arbitrary_shell tool', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const forbidden of ['raw_skill_execution', 'execute_any_skill', 'raw_command', 'arbitrary_shell']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
  }
});

test('prepare_keyframe_execution is read-only and never creates a generation job', async () => {
  const project = createProject();
  const { keyframe, pkg } = await seedShotKeyframeAndPackage(project);
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  const prepared = textOf(await call('prepare_keyframe_execution', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(prepared.promptPackage.packageId, pkg.packageId);
  assert.equal(prepared.safety.allowed, false);
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

test('prepare_keyframe_execution reports a clear error for an unknown keyframe', async () => {
  const project = createProject();
  const result = await call('prepare_keyframe_execution', { projectId: project.id, keyframeId: 'nope' });
  assert.equal(result.isError, true);
});

test('run_fixture_keyframe_execution is BLOCKED with zero jobs before approval, then COMPLETED after', async () => {
  const project = createProject();
  const { keyframe } = await seedShotKeyframeAndPackage(project);

  const blocked = textOf(await call('run_fixture_keyframe_execution', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, 0);

  await call('request_keyframe_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  await call('approve_keyframe_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' });

  const completed = textOf(await call('run_fixture_keyframe_execution', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.provider, 'fake-image');
  assert.ok(completed.artifactPath);
  assert.equal(completed.artifactUrl, null);
});

test('run_fixture_keyframe_execution reports a clear error for an unknown keyframe', async () => {
  const project = createProject();
  const result = await call('run_fixture_keyframe_execution', { projectId: project.id, keyframeId: 'nope' });
  assert.equal(result.isError, true);
});

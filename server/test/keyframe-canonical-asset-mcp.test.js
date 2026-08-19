// Tests for the Stage 13E, Part 1 canonical-asset MCP tools
// (select_canonical_keyframe_asset/get_canonical_keyframe_asset), using a
// real spawned MCP server process over stdio. The candidate asset is
// produced entirely through existing MCP tools (the Stage 13B fake-image
// generation pipeline), never seeded by reaching into a store directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-mcp-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-mcp-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-mcp-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-mcp-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-mcp-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-mcp-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-mcp-assets-'));
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-mcp-blueprints-'));
const gateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-canon-mcp-gates-'));
const envVars = {
  PROJECT_DATA_DIR: projectTempDir,
  CREATIVE_DATA_DIR: creativeTempDir,
  KEYFRAME_DATA_DIR: keyframeTempDir,
  KEYFRAME_PROMPT_DATA_DIR: promptTempDir,
  KEYFRAME_GENERATION_APPROVAL_DATA_DIR: approvalTempDir,
  GENERATION_JOBS_DATA_DIR: jobsTempDir,
  ASSET_STORAGE_DIR: assetsTempDir,
  CREATIVE_BLUEPRINT_DATA_DIR: blueprintTempDir,
  PRE_PRODUCTION_GATE_DATA_DIR: gateTempDir,
};
for (const [key, value] of Object.entries(envVars)) process.env[key] = value;

const projectStore = require('../services/project-store');
const { satisfyProductionPrerequisites } = require('./helpers/control-plane-fixture');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let client;

test.before(async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'mcp', 'server.js')], env: envVars });
  client = new Client({ name: 'evolink-canon-mcp-test-client', version: '0.1.0' });
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
  return projectStore.createProject({ title: 'MCP canonical-asset test', topic: 'x' });
}

async function seedGeneratedAsset(project) {
  satisfyProductionPrerequisites(project.id);
  const scene = textOf(await call('create_storyboard_scene', { projectId: project.id, title: 'S1' }));
  const shot = textOf(await call('create_storyboard_shot', { projectId: project.id, sceneId: scene.sceneId }));
  const keyframe = textOf(await call('create_keyframe', { projectId: project.id, shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME' }));
  await call('build_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId });
  await call('request_keyframe_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  await call('approve_keyframe_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' });
  const generated = textOf(await call('generate_keyframe', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  return { keyframe, assetId: generated.asset.assetId };
}

test('select_canonical_keyframe_asset / get_canonical_keyframe_asset are discoverable', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('select_canonical_keyframe_asset'));
  assert.ok(names.includes('get_canonical_keyframe_asset'));
});

test('select_canonical_keyframe_asset then get_canonical_keyframe_asset round-trip through real MCP calls', async () => {
  const project = createProject();
  const { keyframe, assetId } = await seedGeneratedAsset(project);

  const selected = textOf(
    await call('select_canonical_keyframe_asset', { projectId: project.id, keyframeId: keyframe.keyframeId, assetId, selectedBy: 'claude' })
  );
  assert.equal(selected.canonicalAssetId, assetId);
  assert.equal(selected.canonicalAssetSelectedBy, 'claude');

  const got = textOf(await call('get_canonical_keyframe_asset', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(got.canonicalAssetId, assetId);
  assert.equal(got.asset.assetId, assetId);
});

test('get_canonical_keyframe_asset returns canonicalAssetId: null before any selection', async () => {
  const project = createProject();
  const { keyframe } = await seedGeneratedAsset(project);

  const got = textOf(await call('get_canonical_keyframe_asset', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(got.canonicalAssetId, null);
  assert.equal(got.asset, null);
});

test('select_canonical_keyframe_asset reports a clear error for a REJECTED asset', async () => {
  const project = createProject();
  const { keyframe, assetId } = await seedGeneratedAsset(project);

  await call('reject_generated_keyframe', { projectId: project.id, keyframeId: keyframe.keyframeId, assetId, decidedBy: 'claude' });

  const result = await call('select_canonical_keyframe_asset', { projectId: project.id, keyframeId: keyframe.keyframeId, assetId });
  assert.equal(result.isError, true);
});

test('select_canonical_keyframe_asset reports a clear error for an unknown keyframe/asset', async () => {
  const project = createProject();
  const result = await call('select_canonical_keyframe_asset', { projectId: project.id, keyframeId: 'nope', assetId: 'also-nope' });
  assert.equal(result.isError, true);
});

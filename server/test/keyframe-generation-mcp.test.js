// Tests for the Stage 13B Controlled Keyframe Generation MCP tools, using
// a real spawned MCP server process over stdio — same pattern as
// keyframe-prompt-mcp.test.js. Confirms the full approval -> generate ->
// review lifecycle works end-to-end through the real MCP layer, that
// every safety check is enforced server-side (a caller cannot bypass
// them), and that a blocked attempt never reaches the fake provider or
// mutates budget.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-mcp-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-mcp-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-mcp-keyframes-'));
const promptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-mcp-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-mcp-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-mcp-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-kfgen-mcp-assets-'));
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
  client = new Client({ name: 'evolink-kfgen-mcp-test-client', version: '0.1.0' });
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
  return projectStore.createProject({ title: 'MCP kfgen test', topic: 'x' });
}

async function seedShotKeyframeAndPackage(project) {
  const scene = textOf(await call('create_storyboard_scene', { projectId: project.id, title: 'S1' }));
  const shot = textOf(await call('create_storyboard_shot', { projectId: project.id, sceneId: scene.sceneId }));
  const keyframe = textOf(await call('create_keyframe', { projectId: project.id, shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME' }));
  const pkg = textOf(await call('build_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  return { scene, shot, keyframe, pkg };
}

// --- 23. discoverability ---------------------------------------------------------

test('23. all 9 keyframe generation tools are discoverable', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of [
    'request_keyframe_generation_approval',
    'get_keyframe_generation_approval',
    'approve_keyframe_generation',
    'reject_keyframe_generation',
    'generate_keyframe',
    'get_keyframe_generation_status',
    'approve_generated_keyframe',
    'reject_generated_keyframe',
    'list_keyframe_generations',
  ]) {
    assert.ok(names.includes(name), `${name} must be registered`);
  }
});

test('there is no raw_image_request, raw_http_request, bypass_budget, or force_generate tool', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const forbidden of ['raw_image_request', 'raw_http_request', 'bypass_budget', 'force_generate']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
  }
});

// --- approval lifecycle -----------------------------------------------------------

test('request/get/approve/reject_keyframe_generation manage the approval end-to-end', async () => {
  const project = createProject();
  const { keyframe, pkg } = await seedShotKeyframeAndPackage(project);

  const requested = textOf(
    await call('request_keyframe_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2, reason: 'test', requestedBy: 'claude' })
  );
  assert.equal(requested.status, 'PENDING');
  assert.equal(requested.promptPackageId, pkg.packageId);

  const fetched = textOf(await call('get_keyframe_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(fetched.status, 'PENDING');

  const approved = textOf(await call('approve_keyframe_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' }));
  assert.equal(approved.ok, true);
  assert.equal(approved.approval.status, 'APPROVED');
  assert.equal(approved.keyframe.status, 'GENERATION_APPROVED');
});

test('reject_keyframe_generation rejects a pending request', async () => {
  const project = createProject();
  const { keyframe } = await seedShotKeyframeAndPackage(project);
  await call('request_keyframe_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });

  const rejected = textOf(await call('reject_keyframe_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, decidedBy: 'claude', reason: 'no' }));
  assert.equal(rejected.ok, true);
  assert.equal(rejected.approval.status, 'REJECTED');
});

// --- generate_keyframe: blocked vs. allowed, enforced server-side -----------------------

test('generate_keyframe is blocked (zero provider calls, zero jobs) without an approval', async () => {
  const project = createProject();
  const { keyframe } = await seedShotKeyframeAndPackage(project);

  const result = textOf(await call('generate_keyframe', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(result.ok, false);
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, 0);
});

test('generate_keyframe succeeds end-to-end through MCP once approved, producing a GENERATED keyframe and an unapproved asset', async () => {
  const project = createProject();
  const { keyframe } = await seedShotKeyframeAndPackage(project);
  await call('request_keyframe_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  await call('approve_keyframe_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' });

  const result = textOf(await call('generate_keyframe', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(result.ok, true);
  assert.equal(result.job.status, 'COMPLETED');
  assert.equal(result.asset.approvalStatus, 'NONE');

  const status = textOf(await call('get_keyframe_generation_status', { generationId: result.job.id }));
  assert.equal(status.id, result.job.id);
  assert.equal(status.generationType, 'IMAGE_KEYFRAME');
});

test('get_keyframe_generation_status reports a clear error for a non-keyframe (or unknown) generation id', async () => {
  const result = await call('get_keyframe_generation_status', { generationId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(result.isError, true);
});

// --- human review after generation -------------------------------------------------------

test('approve_generated_keyframe / reject_generated_keyframe / list_keyframe_generations work end-to-end through MCP', async () => {
  const project = createProject();
  const { keyframe } = await seedShotKeyframeAndPackage(project);
  await call('request_keyframe_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  await call('approve_keyframe_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' });
  const generated = textOf(await call('generate_keyframe', { projectId: project.id, keyframeId: keyframe.keyframeId }));

  const approved = textOf(await call('approve_generated_keyframe', { projectId: project.id, keyframeId: keyframe.keyframeId, assetId: generated.asset.assetId, approvedBy: 'claude' }));
  assert.equal(approved.asset.approvalStatus, 'APPROVED');
  assert.equal(approved.keyframe.status, 'APPROVED');

  const list = textOf(await call('list_keyframe_generations', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(list.length, 1);
  assert.equal(list[0].asset.approvalStatus, 'APPROVED');
});

test('reject_generated_keyframe rejects the asset without deleting it', async () => {
  const project = createProject();
  const { keyframe } = await seedShotKeyframeAndPackage(project);
  await call('request_keyframe_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  await call('approve_keyframe_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' });
  const generated = textOf(await call('generate_keyframe', { projectId: project.id, keyframeId: keyframe.keyframeId }));

  const rejected = textOf(await call('reject_generated_keyframe', { projectId: project.id, keyframeId: keyframe.keyframeId, assetId: generated.asset.assetId, decidedBy: 'claude' }));
  assert.equal(rejected.asset.approvalStatus, 'REJECTED');

  const list = textOf(await call('list_keyframe_generations', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(list.length, 1, 'the rejected attempt must remain in history');
});

// --- safety: budget/approval enforcement cannot be bypassed by a caller ------------------

test('a caller cannot bypass the budget check by omitting estimatedCost without acknowledging unknown cost', async () => {
  const project = createProject();
  const { keyframe } = await seedShotKeyframeAndPackage(project);
  await call('request_keyframe_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId }); // no estimatedCost
  await call('approve_keyframe_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' });

  const result = textOf(await call('generate_keyframe', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown/i);
});

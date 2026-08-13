// Tests for the Stage 22B-Part-2 Video Prompt Packaging MCP tools, using a
// real spawned MCP server process over stdio — same pattern as
// keyframe-prompt-mcp.test.js / keyframe-canonical-asset-mcp.test.js.
// Confirms the build/get/list tools work end-to-end through the real MCP
// layer, and that none of them can create a generation job, a keyframe
// generation approval, or change any canonical-asset selection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-mcp-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-mcp-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-mcp-keyframes-'));
const keyframePromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-mcp-kf-packages-'));
const videoPromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-mcp-video-packages-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-mcp-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-mcp-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vp-mcp-assets-'));
const envVars = {
  PROJECT_DATA_DIR: projectTempDir,
  CREATIVE_DATA_DIR: creativeTempDir,
  KEYFRAME_DATA_DIR: keyframeTempDir,
  KEYFRAME_PROMPT_DATA_DIR: keyframePromptTempDir,
  VIDEO_PROMPT_DATA_DIR: videoPromptTempDir,
  KEYFRAME_GENERATION_APPROVAL_DATA_DIR: approvalTempDir,
  GENERATION_JOBS_DATA_DIR: jobsTempDir,
  ASSET_STORAGE_DIR: assetsTempDir,
};
for (const [key, value] of Object.entries(envVars)) process.env[key] = value;

const projectStore = require('../services/project-store');
const generationStore = require('../services/generation-store');
const keyframeGenerationApprovalStore = require('../services/keyframe-generation-approval-store');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const GOOD_PROVIDER = 'evolink';
const GOOD_MODEL = 'seedance-2.0-mini-image-to-video';

let client;

test.before(async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'mcp', 'server.js')], env: envVars });
  client = new Client({ name: 'evolink-vp-mcp-test-client', version: '0.1.0' });
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
  return projectStore.createProject({ title: 'MCP video-prompt test', topic: 'x' });
}

// Builds a keyframe all the way through to an APPROVED, canonical-selected
// asset, entirely through existing MCP tools — the same fake-image
// generation pipeline used by keyframe-canonical-asset-mcp.test.js.
async function seedApprovedCanonicalKeyframe(project) {
  const scene = textOf(await call('create_storyboard_scene', { projectId: project.id, title: 'S1' }));
  const shot = textOf(await call('create_storyboard_shot', { projectId: project.id, sceneId: scene.sceneId }));
  const keyframe = textOf(await call('create_keyframe', { projectId: project.id, shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME' }));
  await call('build_keyframe_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId });
  await call('request_keyframe_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  await call('approve_keyframe_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' });
  const generated = textOf(await call('generate_keyframe', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  const assetId = generated.asset.assetId;
  await call('approve_generated_keyframe', { projectId: project.id, keyframeId: keyframe.keyframeId, assetId, decidedBy: 'claude' });
  await call('select_canonical_keyframe_asset', { projectId: project.id, keyframeId: keyframe.keyframeId, assetId, selectedBy: 'claude' });
  return { scene, shot, keyframe, assetId };
}

// --- discoverability ---------------------------------------------------------------

test('all 3 video prompt-packaging tools are discoverable', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of ['get_video_prompt_package', 'build_video_prompt_package', 'list_video_prompt_packages']) {
    assert.ok(names.includes(name), `${name} must be registered`);
  }
});

test('no generate/approve/submit-style tool exists for video prompt packaging itself', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const forbidden of ['generate_video', 'approve_video_generation', 'submit_video_generation', 'request_video_generation', 'request_video_generation_approval']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
  }
});

// --- build / get / list ----------------------------------------------------------------

test('build_video_prompt_package builds a package end-to-end through MCP', async () => {
  const project = createProject();
  const { keyframe, assetId } = await seedApprovedCanonicalKeyframe(project);

  const built = textOf(await call('build_video_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId, provider: GOOD_PROVIDER, model: GOOD_MODEL }));
  assert.equal(built.ok, true);
  assert.equal(built.package.keyframeId, keyframe.keyframeId);
  assert.equal(built.package.canonicalKeyframeAssetId, assetId);
  assert.equal(built.package.provider, GOOD_PROVIDER);
  assert.equal(built.package.model, GOOD_MODEL);
  assert.equal(built.package.version, 1);
});

test('build_video_prompt_package reports a structured failure (not a thrown error) when there is no canonical asset', async () => {
  const project = createProject();
  const scene = textOf(await call('create_storyboard_scene', { projectId: project.id, title: 'S1' }));
  const shot = textOf(await call('create_storyboard_shot', { projectId: project.id, sceneId: scene.sceneId }));
  const keyframe = textOf(await call('create_keyframe', { projectId: project.id, shotId: shot.shotId, sceneId: scene.sceneId, frameType: 'DETAIL_FRAME' }));

  const result = textOf(await call('build_video_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId, provider: GOOD_PROVIDER, model: GOOD_MODEL }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_CANONICAL_ASSET_SELECTED');
});

test('build_video_prompt_package reports UNKNOWN_MODEL for a nonexistent provider/model', async () => {
  const project = createProject();
  const { keyframe } = await seedApprovedCanonicalKeyframe(project);

  const result = textOf(await call('build_video_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId, provider: 'evolink', model: 'no-such-model' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN_MODEL');
});

test('get_video_prompt_package returns null before any build, then the built package after', async () => {
  const project = createProject();
  const { keyframe } = await seedApprovedCanonicalKeyframe(project);

  assert.equal(textOf(await call('get_video_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId })), null);

  await call('build_video_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId, provider: GOOD_PROVIDER, model: GOOD_MODEL });
  const fetched = textOf(await call('get_video_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(fetched.keyframeId, keyframe.keyframeId);
});

test('list_video_prompt_packages lists every built package for a project', async () => {
  const project = createProject();
  const { keyframe } = await seedApprovedCanonicalKeyframe(project);
  await call('build_video_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId, provider: GOOD_PROVIDER, model: GOOD_MODEL });

  const list = textOf(await call('list_video_prompt_packages', { projectId: project.id }));
  assert.equal(list.length, 1);
  assert.equal(list[0].keyframeId, keyframe.keyframeId);
});

// --- safety: no video-prompt MCP call ever generates, spends, or approves --------------

test('no video-prompt-packaging MCP call ever creates a generation job or a keyframe generation approval', async () => {
  const project = createProject();
  const { keyframe } = await seedApprovedCanonicalKeyframe(project);
  const jobsBefore = generationStore.listGenerationJobs({ projectId: project.id }).length;
  const approvalsBefore = keyframeGenerationApprovalStore.listApprovals(project.id).length;

  await call('build_video_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId, provider: GOOD_PROVIDER, model: GOOD_MODEL });
  await call('build_video_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId, provider: GOOD_PROVIDER, model: GOOD_MODEL });
  await call('get_video_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId });
  await call('list_video_prompt_packages', { projectId: project.id });

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, jobsBefore);
  assert.equal(keyframeGenerationApprovalStore.listApprovals(project.id).length, approvalsBefore);
});

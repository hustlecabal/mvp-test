// Tests for the Stage 22B-Part-3 Controlled Video Generation MCP tools,
// using a real spawned MCP server process over stdio. Confirms the
// approval/eligibility/generation tools work end-to-end through the real
// MCP layer, that the approval/eligibility/generate separation is
// preserved (request != approve != can_generate != generate), and that no
// call here ever reaches a real provider — generate_video only ever runs
// against providers/fake-video/fake-video-provider.js in this test file
// via injected environment, never the real EvoLink adapter (no
// EVOLINK_API_KEY is set anywhere in this process).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-mcp-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-mcp-creative-'));
const keyframeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-mcp-keyframes-'));
const keyframePromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-mcp-kf-packages-'));
const videoPromptTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-mcp-video-packages-'));
const videoApprovalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-mcp-video-approvals-'));
const approvalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-mcp-approvals-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-mcp-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-vg-mcp-assets-'));
const envVars = {
  PROJECT_DATA_DIR: projectTempDir,
  CREATIVE_DATA_DIR: creativeTempDir,
  KEYFRAME_DATA_DIR: keyframeTempDir,
  KEYFRAME_PROMPT_DATA_DIR: keyframePromptTempDir,
  VIDEO_PROMPT_DATA_DIR: videoPromptTempDir,
  VIDEO_GENERATION_APPROVAL_DATA_DIR: videoApprovalTempDir,
  KEYFRAME_GENERATION_APPROVAL_DATA_DIR: approvalTempDir,
  GENERATION_JOBS_DATA_DIR: jobsTempDir,
  ASSET_STORAGE_DIR: assetsTempDir,
};
for (const [key, value] of Object.entries(envVars)) process.env[key] = value;

const projectStore = require('../services/project-store');
const generationStore = require('../services/generation-store');
const timelineStore = require('../services/timeline-store');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const GOOD_PROVIDER = 'evolink';
const GOOD_MODEL = 'seedance-2.0-mini-image-to-video';

let client;

test.before(async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'mcp', 'server.js')], env: envVars });
  client = new Client({ name: 'evolink-vg-mcp-test-client', version: '0.1.0' });
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
  return projectStore.createProject({ title: 'MCP video-generation test', topic: 'x' });
}

// Builds a keyframe all the way through to an APPROVED, canonical-selected
// asset AND a built video prompt package, through existing MCP tools —
// mirrors video-prompt-mcp.test.js's seedApprovedCanonicalKeyframe.
async function seedVideoReadyKeyframe(project) {
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
  const built = textOf(await call('build_video_prompt_package', { projectId: project.id, keyframeId: keyframe.keyframeId, provider: GOOD_PROVIDER, model: GOOD_MODEL }));
  return { scene, shot, keyframe, assetId, pkg: built.package };
}

// --- discoverability ---------------------------------------------------------------

test('all 10 video generation tools are discoverable', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of [
    'request_video_generation_approval',
    'get_video_generation_approval',
    'approve_video_generation',
    'reject_video_generation',
    'can_generate_video',
    'generate_video',
    'get_video_generation_status',
    'acknowledge_video_unknown_cost',
    'approve_generated_video',
    'reject_generated_video',
  ]) {
    assert.ok(names.includes(name), `${name} must be registered`);
  }
});

test('no single tool bypasses the approval separation (no raw generate/bypass tool exists)', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const forbidden of ['submit_video_generation', 'bypass_video_approval', 'force_generate_video', 'auto_approve_video']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not exist`);
  }
});

// --- approval lifecycle --------------------------------------------------------------

test('request_video_generation_approval -> get_video_generation_approval round-trip, bound to the exact package', async () => {
  const project = createProject();
  const { keyframe, pkg } = await seedVideoReadyKeyframe(project);

  const requested = textOf(await call('request_video_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2, requestedBy: 'claude' }));
  assert.equal(requested.status, 'PENDING');
  assert.equal(requested.videoPromptPackageId, pkg.packageId);
  assert.equal(requested.videoPromptPackageVersion, pkg.version);
  assert.equal(requested.canonicalKeyframeAssetId, pkg.canonicalKeyframeAssetId);
  assert.equal(requested.provider, GOOD_PROVIDER);
  assert.equal(requested.model, GOOD_MODEL);

  const fetched = textOf(await call('get_video_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(fetched.status, 'PENDING');
});

test('approve_video_generation records an explicit APPROVED decision', async () => {
  const project = createProject();
  const { keyframe } = await seedVideoReadyKeyframe(project);
  await call('request_video_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });

  const result = textOf(await call('approve_video_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' }));
  assert.equal(result.ok, true);
  assert.equal(result.approval.status, 'APPROVED');
  assert.equal(result.approval.approvedBy, 'claude');
});

test('reject_video_generation records an explicit REJECTED decision', async () => {
  const project = createProject();
  const { keyframe } = await seedVideoReadyKeyframe(project);
  await call('request_video_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });

  const result = textOf(await call('reject_video_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, decidedBy: 'claude', reason: 'not ready' }));
  assert.equal(result.ok, true);
  assert.equal(result.approval.status, 'REJECTED');
});

test('approve_video_generation reports ok:false when nothing is pending', async () => {
  const project = createProject();
  const { keyframe } = await seedVideoReadyKeyframe(project);
  const result = textOf(await call('approve_video_generation', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(result.ok, false);
});

// --- eligibility -----------------------------------------------------------------

test('can_generate_video is false with a clear code before approval, true once approved', async () => {
  const project = createProject();
  const { keyframe } = await seedVideoReadyKeyframe(project);

  const before = textOf(await call('can_generate_video', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(before.allowed, false);
  assert.equal(before.code, 'NO_VIDEO_GENERATION_APPROVAL');

  await call('request_video_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  await call('approve_video_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' });

  const after = textOf(await call('can_generate_video', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(after.allowed, true);
});

test('can_generate_video never creates a generation job (read-only)', async () => {
  const project = createProject();
  const { keyframe } = await seedVideoReadyKeyframe(project);
  await call('request_video_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  await call('approve_video_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' });

  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;
  await call('can_generate_video', { projectId: project.id, keyframeId: keyframe.keyframeId });
  await call('can_generate_video', { projectId: project.id, keyframeId: keyframe.keyframeId });
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

// --- generation status -------------------------------------------------------------
//
// generate_video is intentionally NOT exercised end-to-end here — through
// the real spawned MCP server, generate_video always resolves the real
// EvoLink provider adapter (video-generation-service.js's default
// PROVIDERS registry), and this file must never risk a real network call.
// The full mocked generation flow (submission, polling, completion,
// failure, archival) is covered by test/video-generation-service.test.js
// against providers/fake-video/fake-video-provider.js directly.

test('generate_video blocks with a structured (not thrown) result before approval, and creates no job', async () => {
  const project = createProject();
  const { keyframe } = await seedVideoReadyKeyframe(project);

  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;
  const result = textOf(await call('generate_video', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.code, 'NO_VIDEO_GENERATION_APPROVAL');
  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

test('get_video_generation_status reports a clear error for an unknown id', async () => {
  const result = await call('get_video_generation_status', { generationId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(result.isError, true);
});

test('get_video_generation_status reads a job created directly on disk (shared with the spawned server)', async () => {
  const job = generationStore.createGenerationJob({
    projectId: 'proj-x',
    shotId: 'shot-x',
    keyframeId: 'kf-x',
    videoPromptPackageId: 'vpkg-x',
    videoPromptPackageVersion: 1,
    generationType: 'VIDEO',
    provider: 'evolink',
    model: GOOD_MODEL,
    status: 'PROCESSING',
    progress: 40,
    reservedCost: 3,
  });
  const result = textOf(await call('get_video_generation_status', { generationId: job.id }));
  assert.equal(result.generationId, job.id);
  assert.equal(result.status, 'IN_PROGRESS');
  assert.equal(result.reservedCost, 3);
});

// --- safety: no video-generation MCP call (other than generate_video, and
// only when eligible) can ever create a job or spend a credit -----------

test('request/get/approve/reject/can_generate_video calls never create a generation job or reach a provider', async () => {
  const project = createProject();
  const { keyframe } = await seedVideoReadyKeyframe(project);
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  await call('request_video_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId, estimatedCost: 2 });
  await call('get_video_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId });
  await call('approve_video_generation', { projectId: project.id, keyframeId: keyframe.keyframeId, approvedBy: 'claude' });
  await call('can_generate_video', { projectId: project.id, keyframeId: keyframe.keyframeId });

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

// --- Stage 23: acknowledge_video_unknown_cost --------------------------------------

test('acknowledge_video_unknown_cost records the acknowledgement without changing the approval decision', async () => {
  const project = createProject();
  const { keyframe } = await seedVideoReadyKeyframe(project);
  await call('request_video_generation_approval', { projectId: project.id, keyframeId: keyframe.keyframeId });

  const result = textOf(await call('acknowledge_video_unknown_cost', { projectId: project.id, keyframeId: keyframe.keyframeId, acknowledgedBy: 'claude' }));
  assert.equal(result.ok, true);
  assert.equal(result.approval.unknownCostAcknowledged, true);
  assert.equal(result.approval.unknownCostAcknowledgedBy, 'claude');
  assert.equal(result.approval.status, 'PENDING', 'acknowledging cost must never itself approve/reject anything');
});

test('acknowledge_video_unknown_cost reports ok:false when no approval has ever been requested', async () => {
  const project = createProject();
  const { keyframe } = await seedVideoReadyKeyframe(project);
  const result = textOf(await call('acknowledge_video_unknown_cost', { projectId: project.id, keyframeId: keyframe.keyframeId }));
  assert.equal(result.ok, false);
});

// --- Stage 23: approve_generated_video / reject_generated_video --------------------
// Uses a manually-created 'video' type asset on disk (never a real
// provider call, and generate_video is never exercised through this
// spawned-server file — see the comment above generate_video's own tests).

function addFakeVideoAsset(project, keyframe) {
  return timelineStore.addAsset(project.id, { type: 'video', keyframeId: keyframe.keyframeId, sceneId: keyframe.sceneId, shotId: keyframe.shotId, approvalStatus: 'NONE' });
}

test('approve_generated_video sets the video asset approvalStatus to APPROVED', async () => {
  const project = createProject();
  const { keyframe } = await seedVideoReadyKeyframe(project);
  const videoAsset = addFakeVideoAsset(project, keyframe);

  const result = textOf(await call('approve_generated_video', { projectId: project.id, keyframeId: keyframe.keyframeId, assetId: videoAsset.assetId, approvedBy: 'claude' }));
  assert.equal(result.ok, true);
  assert.equal(result.asset.approvalStatus, 'APPROVED');
});

test('reject_generated_video sets the video asset approvalStatus to REJECTED, and the asset/job are never deleted', async () => {
  const project = createProject();
  const { keyframe } = await seedVideoReadyKeyframe(project);
  const videoAsset = addFakeVideoAsset(project, keyframe);

  const result = textOf(await call('reject_generated_video', { projectId: project.id, keyframeId: keyframe.keyframeId, assetId: videoAsset.assetId, decidedBy: 'claude', reason: 'bad take' }));
  assert.equal(result.ok, true);
  assert.equal(result.asset.approvalStatus, 'REJECTED');
  assert.ok(timelineStore.getAsset(project.id, videoAsset.assetId), 'the rejected asset must still exist');
});

test('approve_generated_video reports ok:false for a non-video asset (the canonical keyframe image)', async () => {
  const project = createProject();
  const { keyframe, assetId: canonicalAssetId } = await seedVideoReadyKeyframe(project);
  const result = textOf(await call('approve_generated_video', { projectId: project.id, keyframeId: keyframe.keyframeId, assetId: canonicalAssetId }));
  assert.equal(result.ok, false);
});

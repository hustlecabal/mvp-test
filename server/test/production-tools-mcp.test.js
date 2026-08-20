// Tests for the P0-ORCH-ENTRY MCP tools (start_production,
// get_production_status, list_production_jobs) — server/mcp/tools/
// production-tools.js — using a REAL spawned MCP server process over
// stdio, the same pattern every other *-mcp.test.js file in this
// directory already uses. This is the actual "operator entry point" the
// P0 Production Orchestrator report named as its next required step: an
// operator (or Claude Code) driving a real production run through the
// real MCP surface, not a direct in-process service call.
//
// The spawned server's env merges process.env (so its own nested
// ffmpeg/espeak-ng/faster-whisper subprocess calls can still resolve
// those binaries via PATH) with this file's temp data directories.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodtools-mcp-projects-'));
const creativeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodtools-mcp-creative-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodtools-mcp-assets-'));
const blueprintTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodtools-mcp-blueprints-'));
const gateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodtools-mcp-gates-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodtools-mcp-jobs-'));
const outputTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-prodtools-mcp-output-'));
const envVars = {
  PROJECT_DATA_DIR: projectTempDir,
  CREATIVE_DATA_DIR: creativeTempDir,
  ASSET_STORAGE_DIR: assetsTempDir,
  CREATIVE_BLUEPRINT_DATA_DIR: blueprintTempDir,
  PRE_PRODUCTION_GATE_DATA_DIR: gateTempDir,
  PRODUCTION_JOBS_DATA_DIR: jobsTempDir,
  PRODUCTION_OUTPUT_DATA_DIR: outputTempDir,
};
for (const [key, value] of Object.entries(envVars)) process.env[key] = value;

const projectStore = require('../services/project-store');
const creativeStore = require('../services/creative-store');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const { satisfyProductionPrerequisites } = require('./helpers/control-plane-fixture');
const { makeTinyPng } = require('./fixtures/png-fixture');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let client;

test.before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: { ...process.env, ...envVars },
  });
  client = new Client({ name: 'evolink-prodtools-mcp-test-client', version: '0.1.0' });
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

function makeStoredImageAsset(projectId) {
  const assetId = crypto.randomUUID();
  const stored = assetStorage.storeUploadedImage(makeTinyPng(320, 180), assetId);
  timelineStore.addAsset(projectId, { assetId, type: 'keyframe' });
  timelineStore.updateAssetStorage(projectId, assetId, { status: 'STORED', provider: 'local', path: stored.relativePath, contentType: stored.contentType });
}

function makeStoredVideoAsset(projectId) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'video' });
  const relativePath = `${asset.assetId}.mp4`;
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: relativePath });
  const absolutePath = assetStorage.resolveStoredPath(relativePath);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:duration=5:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', absolutePath]);
}

function buildGoldenProject() {
  const project = projectStore.createProject({ title: 'MCP production-tools golden test', topic: 'x' });
  satisfyProductionPrerequisites(project.id);
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1', order: 1 });
  const shot1 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1, duration: 4, visualTreatment: 'STILL_IMAGE' });
  const shot2 = creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 2, duration: 3, visualTreatment: 'KINETIC_TYPOGRAPHY' });
  makeStoredImageAsset(project.id);
  return { project, shot1, shot2 };
}

test('start_production is BLOCKED for a project with no linked Blueprint', async () => {
  const project = projectStore.createProject({ title: 'MCP production-tools no-blueprint test', topic: 'x' });
  const scene = creativeStore.addStoryboardScene(project.id, { title: 'Scene 1', order: 1 });
  creativeStore.addStoryboardShot(project.id, { sceneId: scene.sceneId, order: 1, visualTreatment: 'STILL_IMAGE' });

  const result = textOf(await call('start_production', { projectId: project.id }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_BLUEPRINT_LINKED');
  assert.equal(result.job.status, 'FAILED');
  assert.equal(result.job.failureStage, 'APPROVAL_BOUNDARY');
});

test('start_production for an unknown project returns an MCP tool error (never a silent pass)', async () => {
  const result = await call('start_production', { projectId: 'nonexistent-project-id' });
  assert.equal(result.isError, true);
});

const TERMINAL_STATUSES = ['COMPLETE', 'FAILED', 'ESCALATED'];

async function pollUntilTerminal(productionJobId, { timeoutMs = 180000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = textOf(await call('get_production_status', { productionJobId }));
    if (TERMINAL_STATUSES.includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`production job "${productionJobId}" did not reach a terminal status within ${timeoutMs}ms (last status: ${job.status})`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('start_production is ASYNCHRONOUS — it returns immediately, and the real production run is proven by polling get_production_status/list_production_jobs to COMPLETE', async () => {
  const { project, shot1, shot2 } = buildGoldenProject();

  const requestedAt = Date.now();
  const started = textOf(
    await call('start_production', {
      projectId: project.id,
      materialOptions: { [shot2.shotId]: { text: 'THE END' } },
    })
  );
  const returnedAfterMs = Date.now() - requestedAt;
  assert.equal(started.ok, true, JSON.stringify(started.job));
  assert.ok(!TERMINAL_STATUSES.includes(started.job.status), 'the tool call must return before the real production run finishes');
  assert.ok(returnedAfterMs < 5000, `start_production must return quickly (took ${returnedAfterMs}ms) — it must never block on the real render/narration/assembly work`);
  assert.ok(started.job.outputDir.includes(project.id), 'defaultOutputDirFor() must scope output by project id');

  const finished = await pollUntilTerminal(started.job.productionJobId);
  assert.equal(finished.status, 'COMPLETE', JSON.stringify(finished.diagnostics));
  assert.equal(finished.assemblyResult.status, 'COMPLETED');
  assert.ok(fs.existsSync(finished.assemblyResult.artifact.path), 'the real MP4 written by the MCP-spawned server process must exist on disk');

  const list = textOf(await call('list_production_jobs', { projectId: project.id }));
  assert.equal(list.length, 1);
  assert.equal(list[0].productionJobId, started.job.productionJobId);
});

test('get_production_status for an unknown job returns an MCP tool error (never a silent pass)', async () => {
  const result = await call('get_production_status', { productionJobId: crypto.randomUUID() });
  assert.equal(result.isError, true);
});

test('start_production is idempotent: a second call while the first run is still in flight resumes the SAME job, never a duplicate', async () => {
  const { project } = buildGoldenProject();
  const first = textOf(await call('start_production', { projectId: project.id }));
  assert.equal(first.ok, true, JSON.stringify(first.job));

  // Fired immediately, before the background run (real Chrome/FFmpeg/
  // espeak-ng) could plausibly have finished — the exact "second request
  // while one is in flight" case Part 18 requires never duplicate.
  const second = textOf(await call('start_production', { projectId: project.id }));
  assert.equal(second.ok, true, JSON.stringify(second.job));
  assert.equal(second.job.productionJobId, first.job.productionJobId, 'a second request while the first is still non-terminal must resume the same job, never create a second one');

  await pollUntilTerminal(first.job.productionJobId);

  const list = textOf(await call('list_production_jobs', { projectId: project.id }));
  assert.equal(list.length, 1, 'only one ProductionJob should exist for this project after both calls');

  // A THIRD call, after the run has genuinely finished, is a new,
  // deliberate production request — never silently merged into the
  // now-terminal job (see production-orchestrator-service.js's own
  // startProductionAsync() header).
  const third = textOf(await call('start_production', { projectId: project.id }));
  assert.equal(third.ok, true, JSON.stringify(third.job));
  assert.notEqual(third.job.productionJobId, first.job.productionJobId);
  await pollUntilTerminal(third.job.productionJobId);
});

// Tests for the Stage 9B MCP tools (list_generation_history,
// get_shot_history) and the Stage 9B list_assets filtering extension,
// using a real spawned MCP server process over stdio — same pattern as
// generation-mcp.test.js. Nothing here talks to EvoLink or creates a
// generation job through the real submission path; jobs are seeded
// directly on disk via the store modules, exactly like generation-mcp.test.js
// already does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-history-mcp-projects-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-history-mcp-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const generationStore = require('../services/generation-store');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let client;

test.before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: { PROJECT_DATA_DIR: projectTempDir, GENERATION_JOBS_DATA_DIR: jobsTempDir },
  });
  client = new Client({ name: 'evolink-history-mcp-test-client', version: '0.1.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client.close();
  fs.rmSync(projectTempDir, { recursive: true, force: true });
  fs.rmSync(jobsTempDir, { recursive: true, force: true });
});

function textOf(result) {
  return JSON.parse(result.content[0].text);
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function setupProjectWithShot() {
  const project = projectStore.createProject({ title: 'MCP history test', topic: 'x' });
  const scene = timelineStore.addScene(project.id, { title: 'S1', description: 'd' });
  const shot = timelineStore.addShot(project.id, { sceneId: scene.sceneId });
  return { project, scene, shot };
}

// --- 14. MCP list_generation_history -----------------------------------------

test('14. list_generation_history returns generations plus summary counts, and triggers nothing', async () => {
  const { project, scene, shot } = setupProjectWithShot();
  generationStore.createGenerationJob({
    projectId: project.id,
    sceneId: scene.sceneId,
    shotId: shot.shotId,
    provider: 'evolink',
    model: 'seedance-2.5-text-to-video',
    status: 'COMPLETED',
    reservedCost: 8,
  });
  generationStore.createGenerationJob({
    projectId: project.id,
    sceneId: scene.sceneId,
    shotId: shot.shotId,
    provider: 'evolink',
    status: 'FAILED',
  });

  const result = textOf(await call('list_generation_history', { projectId: project.id }));

  assert.equal(result.totalCount, 2);
  assert.equal(result.completedCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.processingCount, 0);
  assert.equal(result.totalReservedCredits, 8);
  assert.equal(result.generations.length, 2);
});

test('list_generation_history reports a clear error for an unknown project', async () => {
  const result = await call('list_generation_history', { projectId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(result.isError, true);
});

// --- 15. MCP get_shot_history -------------------------------------------------

test('15. get_shot_history returns every attempt for a shot, oldest included', async () => {
  const { project, scene, shot } = setupProjectWithShot();
  const jobIds = [];
  for (const status of ['FAILED', 'COMPLETED', 'COMPLETED']) {
    const job = generationStore.createGenerationJob({
      projectId: project.id,
      sceneId: scene.sceneId,
      shotId: shot.shotId,
      provider: 'evolink',
      status,
    });
    jobIds.push(job.id);
  }

  const result = textOf(await call('get_shot_history', { shotId: shot.shotId }));

  assert.equal(result.shotId, shot.shotId);
  assert.equal(result.totalCount, 3);
  assert.deepEqual(
    result.generations.map((g) => g.generationId).sort(),
    jobIds.sort()
  );
});

test('get_shot_history reports a clear error for an unknown shot', async () => {
  const result = await call('get_shot_history', { shotId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(result.isError, true);
});

// --- neither tool can trigger a generation ------------------------------------

test('list_generation_history and get_shot_history never create a generation job', async () => {
  const { project, shot } = setupProjectWithShot();
  const before = generationStore.listGenerationJobs({ projectId: project.id }).length;

  await call('list_generation_history', { projectId: project.id });
  await call('get_shot_history', { shotId: shot.shotId });

  assert.equal(generationStore.listGenerationJobs({ projectId: project.id }).length, before);
});

// --- Stage 9B list_assets filtering extension ---------------------------------

test('list_assets filters by scene, shot, generation, type, and storage status', async () => {
  const { project, scene, shot } = setupProjectWithShot();
  const scene2 = timelineStore.addScene(project.id, { title: 'S2', description: 'd' });
  const shot2 = timelineStore.addShot(project.id, { sceneId: scene2.sceneId });

  const videoAsset = timelineStore.addAsset(project.id, {
    type: 'video',
    sceneId: scene.sceneId,
    shotId: shot.shotId,
    generationId: 'gen-1',
  });
  timelineStore.addAsset(project.id, {
    type: 'keyframe',
    sceneId: scene2.sceneId,
    shotId: shot2.shotId,
    generationId: 'gen-2',
  });
  timelineStore.updateAssetStorage(project.id, videoAsset.assetId, { provider: 'local', path: 'x.mp4', status: 'STORED' });

  const byShot = textOf(await call('list_assets', { projectId: project.id, shotId: shot.shotId }));
  assert.equal(byShot.length, 1);
  assert.equal(byShot[0].assetId, videoAsset.assetId);

  const byType = textOf(await call('list_assets', { projectId: project.id, type: 'keyframe' }));
  assert.equal(byType.length, 1);
  assert.equal(byType[0].type, 'keyframe');

  const byStorageStatus = textOf(await call('list_assets', { projectId: project.id, storageStatus: 'STORED' }));
  assert.equal(byStorageStatus.length, 1);
  assert.equal(byStorageStatus[0].assetId, videoAsset.assetId);

  const byGeneration = textOf(await call('list_assets', { projectId: project.id, generationId: 'gen-2' }));
  assert.equal(byGeneration.length, 1);
  assert.equal(byGeneration[0].generationId, 'gen-2');

  const all = textOf(await call('list_assets', { projectId: project.id }));
  assert.equal(all.length, 2);
  assert.ok(all.every((a) => 'approvalStatus' in a));
});

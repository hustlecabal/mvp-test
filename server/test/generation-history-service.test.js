// Tests for services/generation-history-service.js — a pure read model
// over project-store/generation-store/timeline-store. No network, no
// provider, no generation ever happens here — every job/asset is created
// directly on disk via the existing store functions, exactly the way the
// real generation-service.js flow would leave them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-history-projects-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-history-jobs-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const generationStore = require('../services/generation-store');
const historyService = require('../services/generation-history-service');

function setupProjectWithShot() {
  const project = projectStore.createProject({ title: 'History test', topic: 'x' });
  const scene = timelineStore.addScene(project.id, { title: 'S1', description: 'd' });
  const shot = timelineStore.addShot(project.id, { sceneId: scene.sceneId });
  return { project, scene, shot };
}

function createJob({ project, scene, shot }, overrides = {}) {
  return generationStore.createGenerationJob({
    projectId: project.id,
    sceneId: scene.sceneId,
    shotId: shot.shotId,
    provider: 'evolink',
    model: 'seedance-2.5-text-to-video',
    task: 'text-to-video',
    prompt: 'a test prompt',
    status: 'REQUESTED',
    ...overrides,
  });
}

// --- 1. Empty project history -----------------------------------------------

test('1. a project with no generations has empty history', () => {
  const { project } = setupProjectWithShot();
  const records = historyService.listGenerationHistory(project.id);
  assert.deepEqual(records, []);

  const summary = historyService.summarizeGenerationHistory(records);
  assert.equal(summary.totalCount, 0);
  assert.equal(summary.completedCount, 0);
  assert.equal(summary.totalReservedCredits, null, 'no known cost anywhere must stay null, not 0');
  assert.equal(summary.assetsAvailable, 0);
});

test('listGenerationHistory returns null for an unknown project', () => {
  assert.equal(historyService.listGenerationHistory('00000000-0000-0000-0000-000000000000'), null);
});

// --- 2. One completed generation --------------------------------------------

test('2. one completed generation with an asset produces a full history record', () => {
  const ctx = setupProjectWithShot();
  const job = createJob(ctx, { status: 'COMPLETED', reservedCost: 12.5, completedAt: new Date().toISOString() });
  const asset = timelineStore.addAsset(ctx.project.id, {
    type: 'video',
    sceneId: ctx.scene.sceneId,
    shotId: ctx.shot.shotId,
    generationId: job.id,
    provider: job.provider,
    model: job.model,
    url: 'https://files.evolink.ai/x.mp4',
  });
  generationStore.updateGenerationJob(job.id, { assetId: asset.assetId });

  const records = historyService.listGenerationHistory(ctx.project.id);
  assert.equal(records.length, 1);

  const record = records[0];
  assert.equal(record.generationId, job.id);
  assert.equal(record.projectId, ctx.project.id);
  assert.equal(record.sceneId, ctx.scene.sceneId);
  assert.equal(record.shotId, ctx.shot.shotId);
  assert.equal(record.provider, 'evolink');
  assert.equal(record.model, 'seedance-2.5-text-to-video');
  assert.equal(record.status, 'COMPLETED');
  assert.equal(record.reservedCost, 12.5);
  assert.equal(record.assetId, asset.assetId);
  assert.equal(record.assetType, 'video');
  assert.equal(record.storageStatus, 'NOT_ARCHIVED', 'not archived in this test, so status must reflect that');
});

// --- 3. Multiple generations -------------------------------------------------

test('3. multiple generations for a project all appear in history', () => {
  const ctx = setupProjectWithShot();
  createJob(ctx, { status: 'COMPLETED' });
  createJob(ctx, { status: 'FAILED' });
  createJob(ctx, { status: 'PROCESSING' });

  const records = historyService.listGenerationHistory(ctx.project.id);
  assert.equal(records.length, 3);
});

// --- 4. Failed generation ----------------------------------------------------

test('4. a failed generation is reported with its status and no asset', () => {
  const ctx = setupProjectWithShot();
  createJob(ctx, { status: 'FAILED', error: { code: 'content_policy_violation', message: 'blocked' } });

  const records = historyService.listGenerationHistory(ctx.project.id);
  assert.equal(records[0].status, 'FAILED');
  assert.equal(records[0].assetId, null);
  assert.equal(records[0].assetType, null);
  assert.equal(records[0].storageStatus, null);
});

// --- 5. Processing generation ------------------------------------------------

test('5. a still-processing generation is reported as such', () => {
  const ctx = setupProjectWithShot();
  createJob(ctx, { status: 'PROCESSING', progress: 40 });

  const records = historyService.listGenerationHistory(ctx.project.id);
  assert.equal(records[0].status, 'PROCESSING');
});

// --- 6. Multiple generations for one shot ------------------------------------

test('6. a shot can have multiple generation attempts, none overwritten', () => {
  const ctx = setupProjectWithShot();
  const bad = createJob(ctx, { status: 'FAILED', prompt: 'attempt 1 - bad' });
  const better = createJob(ctx, { status: 'COMPLETED', prompt: 'attempt 2 - better' });
  const approved = createJob(ctx, { status: 'COMPLETED', prompt: 'attempt 3 - approved' });

  const shotHistory = historyService.listShotHistory(ctx.shot.shotId);
  assert.equal(shotHistory.length, 3);
  const ids = shotHistory.map((r) => r.generationId).sort();
  assert.deepEqual(ids, [bad.id, better.id, approved.id].sort());
});

test('listShotHistory returns null for an unknown shot', () => {
  assert.equal(historyService.listShotHistory('00000000-0000-0000-0000-000000000000'), null);
});

test("a different project's generations never leak into another project's or shot's history", () => {
  const ctxA = setupProjectWithShot();
  const ctxB = setupProjectWithShot();
  createJob(ctxA, { status: 'COMPLETED' });
  createJob(ctxB, { status: 'COMPLETED' });

  assert.equal(historyService.listGenerationHistory(ctxA.project.id).length, 1);
  assert.equal(historyService.listGenerationHistory(ctxB.project.id).length, 1);
  assert.equal(historyService.listShotHistory(ctxA.shot.shotId).length, 1);
});

// --- 7/8/9. Asset linkage, download URL, preview URL ------------------------

test('7, 8 & 9. an archived asset yields working preview/download URLs; an unarchived one yields null URLs', () => {
  const ctx = setupProjectWithShot();
  const job = createJob(ctx, { status: 'COMPLETED' });
  const asset = timelineStore.addAsset(ctx.project.id, {
    type: 'video',
    sceneId: ctx.scene.sceneId,
    shotId: ctx.shot.shotId,
    generationId: job.id,
  });
  generationStore.updateGenerationJob(job.id, { assetId: asset.assetId });

  // Before archiving: no working URLs.
  let record = historyService.getGenerationHistory(ctx.project.id, job.id);
  assert.equal(record.previewUrl, null);
  assert.equal(record.downloadUrl, null);
  assert.equal(record.storageStatus, 'NOT_ARCHIVED');

  // After archiving (simulated directly via updateAssetStorage, no real
  // download needed for this test): URLs appear, and are logical paths,
  // never a filesystem path.
  timelineStore.updateAssetStorage(ctx.project.id, asset.assetId, {
    provider: 'local',
    path: `${asset.assetId}.mp4`,
    status: 'STORED',
  });
  record = historyService.getGenerationHistory(ctx.project.id, job.id);
  assert.equal(record.previewUrl, `/assets/${asset.assetId}/preview`);
  assert.equal(record.downloadUrl, `/assets/${asset.assetId}/download`);
  assert.equal(record.storageStatus, 'STORED');
  assert.ok(!record.previewUrl.includes(os.tmpdir()), 'must never contain a filesystem path');
});

// --- 10. Reserved cost -------------------------------------------------------

test('10. reservedCost is carried through exactly, and summed correctly across generations', () => {
  const ctx = setupProjectWithShot();
  createJob(ctx, { status: 'COMPLETED', reservedCost: 10 });
  createJob(ctx, { status: 'COMPLETED', reservedCost: 5.5 });

  const summary = historyService.summarizeGenerationHistory(historyService.listGenerationHistory(ctx.project.id));
  assert.equal(summary.totalReservedCredits, 15.5);
});

// --- 11. Unknown actual cost --------------------------------------------------

test('11. actualCost stays null when the provider never reported one (never becomes 0)', () => {
  const ctx = setupProjectWithShot();
  createJob(ctx, { status: 'COMPLETED', reservedCost: 10, actualCost: null });

  const records = historyService.listGenerationHistory(ctx.project.id);
  assert.equal(records[0].actualCost, null);
});

test('unknown reservedCost values are skipped, not treated as 0, when summing', () => {
  const ctx = setupProjectWithShot();
  createJob(ctx, { status: 'REQUESTED', reservedCost: null }); // not submitted yet
  createJob(ctx, { status: 'COMPLETED', reservedCost: 20 });

  const summary = historyService.summarizeGenerationHistory(historyService.listGenerationHistory(ctx.project.id));
  assert.equal(summary.totalReservedCredits, 20, 'the null one must not drag the sum down or count as 0');
});

// --- 12. Project filtering ----------------------------------------------------

test('12. getGenerationHistory is scoped to its project — a generation from another project is not found', () => {
  const ctxA = setupProjectWithShot();
  const ctxB = setupProjectWithShot();
  const jobA = createJob(ctxA, { status: 'COMPLETED' });

  assert.ok(historyService.getGenerationHistory(ctxA.project.id, jobA.id));
  assert.equal(historyService.getGenerationHistory(ctxB.project.id, jobA.id), null);
});

// --- 13. Shot filtering --------------------------------------------------------

test('13. listShotHistory only returns generations for that exact shot, not sibling shots', () => {
  const project = projectStore.createProject({ title: 'Multi-shot test', topic: 'x' });
  const scene = timelineStore.addScene(project.id, { title: 'S1', description: 'd' });
  const shotA = timelineStore.addShot(project.id, { sceneId: scene.sceneId });
  const shotB = timelineStore.addShot(project.id, { sceneId: scene.sceneId });

  generationStore.createGenerationJob({
    projectId: project.id,
    sceneId: scene.sceneId,
    shotId: shotA.shotId,
    provider: 'evolink',
    status: 'COMPLETED',
  });
  generationStore.createGenerationJob({
    projectId: project.id,
    sceneId: scene.sceneId,
    shotId: shotB.shotId,
    provider: 'evolink',
    status: 'COMPLETED',
  });

  const historyA = historyService.listShotHistory(shotA.shotId);
  assert.equal(historyA.length, 1);
  assert.equal(historyA[0].shotId, shotA.shotId);
});

// --- summary status counts ----------------------------------------------------

test('summarizeGenerationHistory buckets statuses correctly', () => {
  const ctx = setupProjectWithShot();
  createJob(ctx, { status: 'COMPLETED' });
  createJob(ctx, { status: 'COMPLETED' });
  createJob(ctx, { status: 'FAILED' });
  createJob(ctx, { status: 'CANCELLED' });
  createJob(ctx, { status: 'PROCESSING' });
  createJob(ctx, { status: 'SUBMITTED' });

  const summary = historyService.summarizeGenerationHistory(historyService.listGenerationHistory(ctx.project.id));
  assert.equal(summary.totalCount, 6);
  assert.equal(summary.completedCount, 2);
  assert.equal(summary.failedCount, 2);
  assert.equal(summary.processingCount, 2);
});

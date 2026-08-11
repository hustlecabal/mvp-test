// Tests for services/asset-archive-service.js — the orchestration layer
// that downloads an already-completed generation's result into permanent
// local storage. Every download is a fake fetchImpl; nothing here talks to
// EvoLink or creates a generation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('node:stream');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-archive-projects-'));
const jobsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-archive-jobs-'));
const assetsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-archive-assets-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.GENERATION_JOBS_DATA_DIR = jobsTempDir;
process.env.ASSET_STORAGE_DIR = assetsTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const generationStore = require('../services/generation-store');
const archiveService = require('../services/asset-archive-service');

function fakeResponse(bodyText = 'fake video bytes') {
  return {
    ok: true,
    status: 200,
    headers: { get: (key) => (key.toLowerCase() === 'content-type' ? 'video/mp4' : null) },
    body: Readable.toWeb(Readable.from([Buffer.from(bodyText)])),
  };
}

// Builds a project + scene + shot + a COMPLETED generation job + its asset,
// exactly like generation-service.js's real flow would leave behind —
// without ever calling generation-service.js or a provider.
function setupCompletedGeneration({ resultUrl = 'https://files.evolink.ai/fake-video.mp4' } = {}) {
  const project = projectStore.createProject({ title: 'Archive test', topic: 'x' });
  const scene = timelineStore.addScene(project.id, { title: 'S1', description: 'd' });
  const shot = timelineStore.addShot(project.id, { sceneId: scene.sceneId });

  const job = generationStore.createGenerationJob({
    projectId: project.id,
    sceneId: scene.sceneId,
    shotId: shot.shotId,
    provider: 'evolink',
    model: 'seedance-2.5-text-to-video',
    task: 'text-to-video',
    prompt: 'a test prompt',
    status: 'COMPLETED',
    result: { results: [resultUrl] },
  });

  const asset = timelineStore.addAsset(project.id, {
    type: 'video',
    sceneId: scene.sceneId,
    shotId: shot.shotId,
    prompt: job.prompt,
    provider: job.provider,
    model: job.model,
    generationId: job.id,
    url: resultUrl,
  });

  return { project, scene, shot, job, asset };
}

// --- 8/9. Asset is stored correctly and metadata updated -------------------

test('8 & 9. archiving downloads the result and updates asset.storage', async () => {
  const { project, asset } = setupCompletedGeneration();
  const fetchImpl = async () => fakeResponse('hello world');

  const result = await archiveService.archiveGenerationAsset(asset.assetId, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.asset.storage.status, 'STORED');
  assert.equal(result.asset.storage.provider, 'local');
  assert.equal(result.asset.storage.contentType, 'video/mp4');
  assert.equal(result.asset.storage.sizeBytes, 'hello world'.length);
  assert.ok(result.asset.storage.archivedAt);
  assert.ok(fs.existsSync(path.join(assetsTempDir, `${asset.assetId}.mp4`)));

  // and it's really persisted, not just in memory
  const reloaded = timelineStore.getAsset(project.id, asset.assetId);
  assert.equal(reloaded.storage.status, 'STORED');
});

// --- 10. Original provider URL preserved -----------------------------------

test('10. the original provider result URL is never replaced', async () => {
  const resultUrl = 'https://files.evolink.ai/original-result.mp4';
  const { asset } = setupCompletedGeneration({ resultUrl });

  const result = await archiveService.archiveGenerationAsset(asset.assetId, { fetchImpl: async () => fakeResponse() });

  assert.equal(result.asset.url, resultUrl);
});

// --- 11. Lineage preserved ---------------------------------------------------

test('11. lineage fields are untouched by archiving', async () => {
  const { project, scene, shot, job, asset } = setupCompletedGeneration();

  const result = await archiveService.archiveGenerationAsset(asset.assetId, { fetchImpl: async () => fakeResponse() });

  assert.equal(result.asset.projectId, project.id);
  assert.equal(result.asset.sceneId, scene.sceneId);
  assert.equal(result.asset.shotId, shot.shotId);
  assert.equal(result.asset.generationId, job.id);
  assert.equal(result.asset.provider, job.provider);
  assert.equal(result.asset.model, job.model);
  assert.equal(result.asset.prompt, job.prompt);
});

// --- 12. Archive is idempotent ----------------------------------------------

test('12. calling archiveGenerationAsset twice does not download a second time', async () => {
  const { asset } = setupCompletedGeneration();
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return fakeResponse();
  };

  const first = await archiveService.archiveGenerationAsset(asset.assetId, { fetchImpl });
  const second = await archiveService.archiveGenerationAsset(asset.assetId, { fetchImpl });

  assert.equal(callCount, 1, 'the remote URL must only be fetched once');
  assert.equal(first.alreadyArchived, false);
  assert.equal(second.alreadyArchived, true);
  assert.equal(second.asset.storage.status, 'STORED');
});

// --- 13. Missing stored file handled (reconciliation) -----------------------

test('13. a missing stored file is safely re-downloaded from the original provider URL', async () => {
  const { project, asset } = setupCompletedGeneration();

  const first = await archiveService.archiveGenerationAsset(asset.assetId, { fetchImpl: async () => fakeResponse('v1') });
  assert.equal(first.ok, true);

  // Simulate the archived file being lost (disk cleared, etc.) without
  // touching the asset's metadata, which still says STORED.
  fs.rmSync(path.join(assetsTempDir, `${asset.assetId}.mp4`));
  const stillSaysStored = timelineStore.getAsset(project.id, asset.assetId);
  assert.equal(stillSaysStored.storage.status, 'STORED', 'precondition: metadata still claims STORED');

  let callCount = 0;
  const second = await archiveService.archiveGenerationAsset(asset.assetId, {
    fetchImpl: async () => {
      callCount += 1;
      return fakeResponse('v2-recovered');
    },
  });

  assert.equal(callCount, 1, 'a missing file must trigger exactly one re-download');
  assert.equal(second.ok, true);
  assert.equal(second.asset.storage.status, 'STORED');
  assert.ok(fs.existsSync(path.join(assetsTempDir, `${asset.assetId}.mp4`)));
});

test('archiving a nonexistent asset id returns a clear failure, not a crash', async () => {
  const result = await archiveService.archiveGenerationAsset('00000000-0000-0000-0000-000000000000', {
    fetchImpl: async () => fakeResponse(),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No asset found/);
});

test('a download failure marks the asset FAILED with the error recorded, and never generates anything', async () => {
  const { asset } = setupCompletedGeneration();
  const result = await archiveService.archiveGenerationAsset(asset.assetId, {
    fetchImpl: async () => ({ ok: false, status: 500, headers: { get: () => null }, body: null }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.asset.storage.status, 'FAILED');
  assert.ok(result.asset.storage.error);
});

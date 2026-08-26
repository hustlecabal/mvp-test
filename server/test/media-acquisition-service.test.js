// Tests for services/media-acquisition-service.js — the full search ->
// cache-check -> download -> validate -> register -> provenance
// orchestration. Uses services/media-acquisition/fake-stock-media-
// provider.js exclusively (registered under PROVIDER_MODULES['fake-
// stock-media'], never reachable by production code — see that
// provider's own header) so every test here runs with no network access
// and no API key.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-macq-projects-'));
const assetTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-macq-assets-'));
const macqTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-macq-store-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.ASSET_STORAGE_DIR = assetTempDir;
process.env.MEDIA_ACQUISITION_DATA_DIR = macqTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const mediaAcquisitionService = require('../services/media-acquisition-service');
const mediaAcquisitionStore = require('../services/media-acquisition-store');
const fakeStockMediaProvider = require('../services/media-acquisition/fake-stock-media-provider');
const { createMediaAcquisitionRequest } = require('../schemas/media-acquisition-schema');

function makeProject(overrides = {}) {
  return projectStore.createProject({ title: 'x', topic: 'y', ...overrides });
}

function imageRequest(projectId, overrides = {}) {
  return createMediaAcquisitionRequest({ projectId, provider: 'fake-stock-media', mediaType: 'image', searchQuery: 'city', ...overrides });
}

// --- A / successful acquisition -------------------------------------------------------------------

test('A. acquireMedia downloads, validates, registers an Asset, and records provenance for a valid image candidate', async () => {
  const project = makeProject();
  const result = await mediaAcquisitionService.acquireMedia(imageRequest(project.id, { beatId: 'beat-1' }), { fetchImpl: fakeStockMediaProvider.fakeFetchImpl });

  assert.equal(result.status, 'ACQUIRED');
  assert.equal(result.provider, 'fake-stock-media');
  assert.equal(result.providerAssetId, 'fake-image-1');
  assert.equal(result.mediaType, 'image');
  assert.match(result.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.ok(result.assetId);

  const asset = timelineStore.getAsset(project.id, result.assetId);
  assert.ok(asset, 'the Asset must actually be registered');
  assert.equal(asset.type, 'keyframe');
  assert.equal(asset.storage.status, 'STORED');
  assert.equal(asset.provider, 'fake-stock-media');
});

// --- F/G. cache hit / cache miss -------------------------------------------------------------------

test('F. a second identical acquireMedia call reuses the cached Asset (fromCache: true), never downloads a second file', async () => {
  const project = makeProject();
  const first = await mediaAcquisitionService.acquireMedia(imageRequest(project.id), { fetchImpl: fakeStockMediaProvider.fakeFetchImpl });
  assert.equal(first.fromCache, false);

  const second = await mediaAcquisitionService.acquireMedia(imageRequest(project.id), { fetchImpl: fakeStockMediaProvider.fakeFetchImpl });
  assert.equal(second.status, 'ACQUIRED');
  assert.equal(second.fromCache, true);
  assert.equal(second.assetId, first.assetId, 'must reuse the exact same Asset id, never mint a new one');
});

test('G. two DIFFERENT projects each get their own independent acquisition (no cross-project cache bleed)', async () => {
  const projectA = makeProject({ title: 'A' });
  const projectB = makeProject({ title: 'B' });
  const a = await mediaAcquisitionService.acquireMedia(imageRequest(projectA.id), { fetchImpl: fakeStockMediaProvider.fakeFetchImpl });
  const b = await mediaAcquisitionService.acquireMedia(imageRequest(projectB.id), { fetchImpl: fakeStockMediaProvider.fakeFetchImpl });
  assert.equal(a.fromCache, false);
  assert.equal(b.fromCache, false, 'a cache miss in a different project must never be reported as a hit');
  assert.notEqual(a.assetId, b.assetId);
});

// --- H. provenance persistence -------------------------------------------------------------------

test('H. provenance is traceable back to the Asset via media-acquisition-store.getProvenance', async () => {
  const project = makeProject();
  const result = await mediaAcquisitionService.acquireMedia(imageRequest(project.id, { beatId: 'beat-42', sceneId: 'scene-1' }), { fetchImpl: fakeStockMediaProvider.fakeFetchImpl });

  const provenance = mediaAcquisitionStore.getProvenance(project.id, result.assetId);
  assert.ok(provenance);
  assert.equal(provenance.provider, 'fake-stock-media');
  assert.equal(provenance.providerAssetId, 'fake-image-1');
  assert.equal(provenance.beatId, 'beat-42');
  assert.equal(provenance.sceneId, 'scene-1');
  assert.equal(provenance.searchQuery, 'city');
  assert.ok(provenance.checksum);
  assert.ok(provenance.acquiredAt);
});

// --- E. invalid downloaded asset (rejected, not registered) -------------------------------------------------------------------

test('E. an image candidate below the requested minWidth is REJECTED_INVALID and never registered as an Asset', async () => {
  const project = makeProject();
  const result = await mediaAcquisitionService.acquireMedia(imageRequest(project.id, { minWidth: 5000 }), { fetchImpl: fakeStockMediaProvider.fakeFetchImpl });

  assert.equal(result.status, 'REJECTED_INVALID');
  assert.equal(result.diagnostics[0].code, 'BELOW_MIN_WIDTH');
  assert.equal(result.assetId, null);
});

// --- K. deterministic failure handling -------------------------------------------------------------------

test('K1. an unknown provider name is a structured UNSUPPORTED_PROVIDER result, never a thrown error', async () => {
  const project = makeProject();
  const result = await mediaAcquisitionService.acquireMedia(imageRequest(project.id, { provider: 'not-a-real-provider' }));
  assert.equal(result.status, 'UNSUPPORTED_PROVIDER');
});

test('K2. a provider search failure never throws — acquireMedia returns a structured PROVIDER_FAILED result', async () => {
  const project = makeProject();
  const original = process.env.PEXELS_API_KEY;
  process.env.PEXELS_API_KEY = 'test-key';
  try {
    const result = await mediaAcquisitionService.acquireMedia(createMediaAcquisitionRequest({ projectId: project.id, provider: 'pexels', mediaType: 'image', searchQuery: 'x' }), {
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    assert.equal(result.status, 'PROVIDER_FAILED');
  } finally {
    if (original === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = original;
  }
});

test('K3. zero search candidates is a structured NO_CANDIDATES result', async () => {
  const project = makeProject();
  const original = process.env.PEXELS_API_KEY;
  process.env.PEXELS_API_KEY = 'test-key';
  try {
    const result = await mediaAcquisitionService.acquireMedia(createMediaAcquisitionRequest({ projectId: project.id, provider: 'pexels', mediaType: 'image', searchQuery: 'x' }), {
      fetchImpl: async () => ({ ok: true, json: async () => ({ photos: [] }) }),
    });
    assert.equal(result.status, 'NO_CANDIDATES');
  } finally {
    if (original === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = original;
  }
});

test('K4. a download failure is a structured PROVIDER_FAILED result, never a thrown error', async () => {
  const project = makeProject();
  const result = await mediaAcquisitionService.acquireMedia(imageRequest(project.id), {
    fetchImpl: async () => {
      throw new Error('simulated network failure during download');
    },
  });
  assert.equal(result.status, 'PROVIDER_FAILED');
  const asset = timelineStore.listAssets(project.id);
  assert.equal(asset.length, 0, 'no Asset must be registered when the download itself fails');
});

test('K5. listAvailableProviders never includes the fake test provider', () => {
  assert.equal(mediaAcquisitionService.listAvailableProviders().includes('fake-stock-media'), false);
});

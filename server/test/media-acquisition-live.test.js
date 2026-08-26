// LIVE-PROVIDER tests for Media Acquisition — a real network call to
// Pexels and/or Pixabay's real API, using whichever of PEXELS_API_KEY /
// PIXABAY_API_KEY is actually set in the environment. Deliberately kept
// in a SEPARATE file from every other Media Acquisition test (this
// stage's own explicit requirement #13: "the main test suite must not
// require live API keys") — `node --test` runs every *.test.js file, so
// this file uses node:test's own `skip` option (never a thrown error,
// never a silently-passing no-op assertion) whenever a key is missing, so
// `npm test` stays fully green with zero keys configured, and this file's
// real coverage only activates once a key is present.
//
// Run explicitly against one provider:
//   PEXELS_API_KEY=... node --test test/media-acquisition-live.test.js
//   PIXABAY_API_KEY=... node --test test/media-acquisition-live.test.js
//
// Every acquired asset here is a REAL downloaded file, validated by the
// REAL media-asset-validator.js (including real ffprobe/ffmpeg for
// video) — the first genuine end-to-end proof of this stage's own final
// success criterion, deliberately never run as part of the default
// suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-macq-live-projects-'));
const assetTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-macq-live-assets-'));
const macqTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-macq-live-store-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.ASSET_STORAGE_DIR = assetTempDir;
process.env.MEDIA_ACQUISITION_DATA_DIR = macqTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const mediaAcquisitionService = require('../services/media-acquisition-service');
const { createMediaAcquisitionRequest } = require('../schemas/media-acquisition-schema');

function makeProject(overrides = {}) {
  return projectStore.createProject({ title: 'x', topic: 'y', ...overrides });
}

const hasPexels = Boolean(process.env.PEXELS_API_KEY);
const hasPixabay = Boolean(process.env.PIXABAY_API_KEY);

test('live: Pexels — a real image search + download + validation succeeds end to end', { skip: hasPexels ? false : 'PEXELS_API_KEY not set — skipped, not failed' }, async () => {
  const project = makeProject();
  const result = await mediaAcquisitionService.acquireMedia(createMediaAcquisitionRequest({ projectId: project.id, provider: 'pexels', mediaType: 'image', searchQuery: 'mountain landscape', maxCandidates: 3 }));

  assert.equal(result.status, 'ACQUIRED', JSON.stringify(result.diagnostics));
  assert.ok(result.assetId);
  assert.match(result.checksum, /^sha256:[0-9a-f]{64}$/);
  const asset = timelineStore.getAsset(project.id, result.assetId);
  assert.equal(asset.storage.status, 'STORED');
  assert.ok(fs.existsSync(path.join(assetTempDir, asset.storage.path)));
});

test('live: Pexels — a real video search + download + ffprobe validation succeeds end to end', { skip: hasPexels ? false : 'PEXELS_API_KEY not set — skipped, not failed' }, async () => {
  const project = makeProject();
  const result = await mediaAcquisitionService.acquireMedia(
    createMediaAcquisitionRequest({ projectId: project.id, provider: 'pexels', mediaType: 'video', searchQuery: 'ocean waves', minDurationSeconds: 2, maxCandidates: 3 })
  );

  assert.equal(result.status, 'ACQUIRED', JSON.stringify(result.diagnostics));
  assert.ok(result.durationSeconds >= 2);
  assert.ok(result.width > 0 && result.height > 0);
});

test('live: Pixabay — a real image search + download + validation succeeds end to end', { skip: hasPixabay ? false : 'PIXABAY_API_KEY not set — skipped, not failed' }, async () => {
  const project = makeProject();
  const result = await mediaAcquisitionService.acquireMedia(createMediaAcquisitionRequest({ projectId: project.id, provider: 'pixabay', mediaType: 'image', searchQuery: 'forest path', maxCandidates: 3 }));

  assert.equal(result.status, 'ACQUIRED', JSON.stringify(result.diagnostics));
  assert.ok(result.assetId);
});

test('live: Pixabay — a real video search + download + ffprobe validation succeeds end to end', { skip: hasPixabay ? false : 'PIXABAY_API_KEY not set — skipped, not failed' }, async () => {
  const project = makeProject();
  const result = await mediaAcquisitionService.acquireMedia(
    createMediaAcquisitionRequest({ projectId: project.id, provider: 'pixabay', mediaType: 'video', searchQuery: 'city traffic', minDurationSeconds: 2, maxCandidates: 3 })
  );

  assert.equal(result.status, 'ACQUIRED', JSON.stringify(result.diagnostics));
  assert.ok(result.durationSeconds >= 2);
});

test('live: a repeat identical request reuses the cached asset (real provider, real cache hit)', { skip: hasPexels ? false : 'PEXELS_API_KEY not set — skipped, not failed' }, async () => {
  const project = makeProject();
  const request = createMediaAcquisitionRequest({ projectId: project.id, provider: 'pexels', mediaType: 'image', searchQuery: 'sunset over water', maxCandidates: 3 });
  const first = await mediaAcquisitionService.acquireMedia(request);
  const second = await mediaAcquisitionService.acquireMedia(request);

  assert.equal(first.status, 'ACQUIRED');
  assert.equal(second.status, 'ACQUIRED');
  assert.equal(second.fromCache, true);
  assert.equal(second.assetId, first.assetId);
});

test('live: an unconfigured provider is reported as unavailable, never a live-key requirement leaking into an unrelated provider', () => {
  // This assertion runs unconditionally (no live key required for it
  // specifically) — listAvailableProviders() must reflect exactly the
  // credentials actually present in this process right now.
  const available = mediaAcquisitionService.listAvailableProviders();
  assert.equal(available.includes('pexels'), hasPexels);
  assert.equal(available.includes('pixabay'), hasPixabay);
});

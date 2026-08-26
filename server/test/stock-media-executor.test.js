// Tests for services/material-executors/stock-media-executor.js — the
// synchronous STOCK_MEDIA -> Media Acquisition bridge. Never calls
// acquireMedia()/the network itself — every test either leaves nothing
// acquired (proving the escalation path) or writes a MediaAcquisitionResult
// directly into services/media-acquisition-store.js (proving the
// delegation path), exactly mirroring how
// test/generated-new-executor.test.js (if present) would prove
// generated-new-executor.js's own bridge without a real generation call.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-stockexec-projects-'));
const macqTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-stockexec-macq-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.MEDIA_ACQUISITION_DATA_DIR = macqTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const mediaAcquisitionStore = require('../services/media-acquisition-store');
const stockMediaExecutor = require('../services/material-executors/stock-media-executor');
const { createVisualBeat } = require('../schemas/visual-beat-schema');

function makeProject(overrides = {}) {
  return projectStore.createProject({ title: 'x', topic: 'y', ...overrides });
}

function beat(overrides = {}) {
  return createVisualBeat({ id: crypto.randomUUID(), sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 5, visualTreatment: 'BROLL_CLIP', ...overrides });
}

function candidate(treatment, beatId) {
  return { candidate: `STOCK_MEDIA+${treatment}`, materialSource: 'STOCK_MEDIA', visualTreatment: treatment, selectedAssetId: null };
}

test('no acquisition yet — execute() fails with NO_ACQUIRED_STOCK_MEDIA_EXISTS, never a thrown error', () => {
  const project = makeProject();
  const b = beat();
  const result = stockMediaExecutor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate('BROLL_CLIP', b.id) });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.executorType, 'STOCK_MEDIA_VIDEO');
  assert.equal(result.diagnostics[0].code, 'NO_ACQUIRED_STOCK_MEDIA_EXISTS');
  assert.match(result.diagnostics[0].message, /acquire_stock_media/);
});

test('an already-acquired stock VIDEO delegates to project-asset-reuse-executor and reports STOCK_MEDIA_VIDEO as its own executorType', () => {
  const project = makeProject();
  const b = beat({ visualTreatment: 'BROLL_CLIP' });

  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'video', provider: 'pexels' });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED' });
  mediaAcquisitionStore.recordAcquisition(project.id, { status: 'ACQUIRED', assetId: asset.assetId, beatId: b.id, provider: 'pexels', providerAssetId: 'p-1', mediaType: 'video' });

  const result = stockMediaExecutor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate('BROLL_CLIP', b.id) });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.executorType, 'STOCK_MEDIA_VIDEO', 'must report its own honest provenance, never the delegate\'s own type');
  assert.equal(result.renderSpec.assetId, asset.assetId);
  assert.deepEqual(result.sourceAssetIds, [asset.assetId]);
});

test('an already-acquired stock IMAGE delegates to still-image-motion-executor and reports STOCK_MEDIA_IMAGE as its own executorType', () => {
  const project = makeProject();
  const b = beat({ visualTreatment: 'STILL_IMAGE' });

  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe', provider: 'pixabay' });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED' });
  mediaAcquisitionStore.recordAcquisition(project.id, { status: 'ACQUIRED', assetId: asset.assetId, beatId: b.id, provider: 'pixabay', providerAssetId: 'p-2', mediaType: 'image' });

  const result = stockMediaExecutor.execute({ projectId: project.id, beat: b, selectedMaterial: candidate('STILL_IMAGE', b.id) });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.executorType, 'STOCK_MEDIA_IMAGE');
  assert.equal(result.sourceAssetIds[0], asset.assetId);
});

test('acquisition recorded for a DIFFERENT beat is never picked up — the lookup is beat-scoped, not project-wide', () => {
  const project = makeProject();
  const acquiredForOtherBeat = beat();
  const thisBeat = beat();

  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'video' });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED' });
  mediaAcquisitionStore.recordAcquisition(project.id, { status: 'ACQUIRED', assetId: asset.assetId, beatId: acquiredForOtherBeat.id, provider: 'pexels', providerAssetId: 'p-3', mediaType: 'video' });

  const result = stockMediaExecutor.execute({ projectId: project.id, beat: thisBeat, selectedMaterial: candidate('BROLL_CLIP', thisBeat.id) });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'NO_ACQUIRED_STOCK_MEDIA_EXISTS');
});

test('a non-STOCK_MEDIA candidate is rejected structurally', () => {
  const project = makeProject();
  const b = beat();
  const result = stockMediaExecutor.execute({ projectId: project.id, beat: b, selectedMaterial: { candidate: 'x', materialSource: 'GENERATED_NEW', visualTreatment: 'BROLL_CLIP' } });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_MATERIAL');
});

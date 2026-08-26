// L. End-to-end mock production for STOCK_MEDIA: Material Resolution ->
// Media Acquisition (fake provider, no network/API key) -> Material
// Execution -> a real renderSpec, using the SAME public entry points
// services/production-orchestrator-service.js itself calls
// (resolveBeatGraph / executeMaterial) — never a parallel/simplified
// re-implementation of that chain.
//
// Scope note: this proves the STOCK_MEDIA-specific slice of the pipeline
// (the genuinely new code this stage adds) integrates correctly end to
// end. It deliberately does not re-build the full start_production
// approval-boundary/state-machine/HyperFrames-render/FFmpeg-assembly
// fixture chain — that full proof already exists and is unchanged
// (test/video-assembly-pipeline.test.js's own GOLDEN VIDEO test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-e2e-projects-'));
const assetTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-e2e-assets-'));
const macqTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-e2e-macq-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
process.env.ASSET_STORAGE_DIR = assetTempDir;
process.env.MEDIA_ACQUISITION_DATA_DIR = macqTempDir;

const projectStore = require('../services/project-store');
const materialResolutionService = require('../services/material-resolution-service');
const materialExecutionService = require('../services/material-execution-service');
const mediaAcquisitionService = require('../services/media-acquisition-service');
const fakeStockMediaProvider = require('../services/media-acquisition/fake-stock-media-provider');
const validator = require('../services/media-acquisition/media-asset-validator');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createMediaAcquisitionRequest } = require('../schemas/media-acquisition-schema');

function makeProject(overrides = {}) {
  return projectStore.createProject({ title: 'x', topic: 'y', ...overrides });
}

test('L1. IMAGE: beat -> resolveMaterial (STOCK_MEDIA candidate) -> acquireMedia (fake provider) -> executeMaterial -> a real STILL_IMAGE_MOTION renderSpec placing the acquired asset', async () => {
  const project = makeProject();
  const beat = createVisualBeat({ id: crypto.randomUUID(), sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 4, visualTreatment: 'STILL_IMAGE' });

  // --- Material Resolution: proposes STOCK_MEDIA as a viable strategy ---
  const resolution = materialResolutionService.resolveMaterial(project.id, beat, { stockMediaProviders: ['pexels'] });
  const stockCandidate = resolution.candidates.find((c) => c.materialSource === 'STOCK_MEDIA' && c.visualTreatment === 'STILL_IMAGE');
  assert.ok(stockCandidate, 'Material Resolution must offer a STOCK_MEDIA+STILL_IMAGE candidate');

  // First attempt at execution: nothing acquired yet -> escalation, exactly
  // like a real production run would record.
  const preAcquisitionExecution = materialExecutionService.executeMaterial(project.id, beat, {
    ...resolution,
    selectedMaterial: stockCandidate,
  });
  assert.equal(preAcquisitionExecution.status, 'FAILED');
  assert.equal(preAcquisitionExecution.diagnostics[0].code, 'NO_ACQUIRED_STOCK_MEDIA_EXISTS');

  // --- Media Acquisition: the acquire_stock_media MCP tool's own call,
  // exercised directly here (no network — the fake provider). ---
  const acquisition = await mediaAcquisitionService.acquireMedia(
    createMediaAcquisitionRequest({ projectId: project.id, beatId: beat.id, provider: 'fake-stock-media', mediaType: 'image', searchQuery: 'a plain city street' }),
    { fetchImpl: fakeStockMediaProvider.fakeFetchImpl }
  );
  assert.equal(acquisition.status, 'ACQUIRED');

  // --- Material Execution: now finds the acquired asset and places it ---
  const execution = materialExecutionService.executeMaterial(project.id, beat, { ...resolution, selectedMaterial: stockCandidate });
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.executorType, 'STOCK_MEDIA_IMAGE');
  assert.equal(execution.sourceAssetIds[0], acquisition.assetId);
  assert.ok(execution.renderSpec, 'a real render specification must be produced, ready for the existing renderer stage');
});

test('L2. VIDEO: resolution + escalation prove correctly; acquisition itself is deterministically REJECTED_INVALID against this codebase\'s bundled fake-video fixture, which is NOT real video data by its own design (see providers/fake-video/fake-video-provider.js\'s header: "never a real download") — asserted honestly, in whichever of the two legitimate ways this environment produces it, never a false pass', async () => {
  const project = makeProject();
  const beat = createVisualBeat({ id: crypto.randomUUID(), sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 4, visualTreatment: 'BROLL_CLIP' });

  const resolution = materialResolutionService.resolveMaterial(project.id, beat, { stockMediaProviders: ['pixabay'] });
  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.materialSource, 'STOCK_MEDIA');

  const preAcquisitionExecution = materialExecutionService.executeMaterial(project.id, beat, resolution);
  assert.equal(preAcquisitionExecution.status, 'FAILED');
  assert.equal(preAcquisitionExecution.diagnostics[0].code, 'NO_ACQUIRED_STOCK_MEDIA_EXISTS', 'the same escalation path proven for images must hold for video too');

  const ffprobeAvailable = validator.locateOnPath('ffprobe') !== null && validator.locateOnPath('ffmpeg') !== null;
  const acquisition = await mediaAcquisitionService.acquireMedia(
    createMediaAcquisitionRequest({ projectId: project.id, beatId: beat.id, provider: 'fake-stock-media', mediaType: 'video', searchQuery: 'a plain ocean shot' }),
    { fetchImpl: fakeStockMediaProvider.fakeFetchImpl }
  );

  // Real, provider-agnostic proof this stage's own success criterion cares
  // about (a fully-decodable REAL video fixture, downloaded through a REAL
  // provider account, is exercised separately in
  // test/media-acquisition-live.test.js once PEXELS_API_KEY/
  // PIXABAY_API_KEY are configured) — this mock path only ever had access
  // to the codebase's existing placeholder fixture, so REJECTED_INVALID is
  // the correct, fail-closed outcome here regardless of local tooling.
  assert.equal(acquisition.status, 'REJECTED_INVALID');
  assert.equal(acquisition.diagnostics[0].code, ffprobeAvailable ? 'FFPROBE_VALIDATION_FAILED' : 'FFPROBE_UNAVAILABLE');
});

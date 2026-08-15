// Tests for services/renderers/asset-placement-renderer.js — Stage 26.8A.
// Real PNG bytes on disk -> real SVG file with the image embedded.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-render-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-asset-placement-renderer-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const { createExecutionResult } = require('../schemas/material-execution-schema');
const renderer = require('../services/renderers/asset-placement-renderer');
const { makeTinyPng } = require('./fixtures/png-fixture');

function buildStoredImageAsset(project, { width = 8, height = 4, type = 'keyframe' } = {}) {
  const assetId = crypto.randomUUID();
  const png = makeTinyPng(width, height);
  const stored = assetStorage.storeUploadedImage(png, assetId);
  const asset = timelineStore.addAsset(project.id, { assetId, type });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED', provider: 'local', path: stored.relativePath, contentType: stored.contentType });
  return timelineStore.getAsset(project.id, asset.assetId);
}

function execution(overrides = {}) {
  return createExecutionResult({
    beatId: 'b1',
    materialId: 'm1',
    executorType: 'PROJECT_ASSET_REUSE',
    status: 'COMPLETED',
    renderSpec: { type: 'ASSET_PLACEMENT', assetId: null, objectFit: 'COVER', scale: 1, opacity: 1, position: { x: 0, y: 0 } },
    sourceAssetIds: [],
    ...overrides,
  });
}

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-render-output-'));
}

// --- happy path -------------------------------------------------------------------

test('1. a valid, STORED PNG asset produces a COMPLETED render with a real SVG file embedding the image', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project);
  const ex = execution({ renderSpec: { type: 'ASSET_PLACEMENT', assetId: asset.assetId, objectFit: 'COVER', scale: 1, opacity: 1, position: { x: 0, y: 0 } } });

  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.rendererType, 'ASSET_PLACEMENT');
  assert.equal(result.beatId, 'b1');
  assert.equal(result.materialId, 'm1');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.artifact.format, 'SVG');
  assert.equal(result.artifact.width, 1920);
  assert.equal(result.artifact.height, 1080);
  assert.ok(fs.existsSync(result.artifact.path));
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svgText, /<image /);
  assert.match(svgText, /data:image\/png;base64,/);
});

test('2. the embedded data URI contains the EXACT original PNG bytes, byte for byte', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project, { width: 10, height: 6 });
  const originalBytes = fs.readFileSync(assetStorage.resolveStoredPath(asset.storage.path));
  const ex = execution({ renderSpec: { type: 'ASSET_PLACEMENT', assetId: asset.assetId, objectFit: 'COVER', scale: 1, opacity: 1, position: { x: 0, y: 0 } } });

  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  const match = svgText.match(/data:image\/png;base64,([^"]+)"/);
  assert.ok(match, 'svg must contain a base64 data uri');
  const embeddedBytes = Buffer.from(match[1], 'base64');
  assert.ok(embeddedBytes.equals(originalBytes));
});

// --- fit math -------------------------------------------------------------------

test('3. COVER fit for a wide source image fills the full 1920x1080 frame height, cropping width', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project, { width: 400, height: 100 }); // very wide, 4:1
  const ex = execution({ renderSpec: { type: 'ASSET_PLACEMENT', assetId: asset.assetId, objectFit: 'COVER', scale: 1, opacity: 1, position: { x: 0, y: 0 } } });

  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  const heightMatch = svgText.match(/<image[^>]*height="([\d.]+)"/);
  assert.equal(Number(heightMatch[1]), 1080, 'COVER must fill the full frame height for a wide image');
});

test('4. CONTAIN fit for the same wide source image fits within frame width instead, never exceeding it', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project, { width: 400, height: 100 });
  const ex = execution({ renderSpec: { type: 'ASSET_PLACEMENT', assetId: asset.assetId, objectFit: 'CONTAIN', scale: 1, opacity: 1, position: { x: 0, y: 0 } } });

  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  const widthMatch = svgText.match(/<image[^>]*width="([\d.]+)"/);
  assert.equal(Number(widthMatch[1]), 1920, 'CONTAIN must fit within the full frame width for a wide image');
});

test('5. FILL fit stretches to exactly the frame dimensions regardless of source aspect ratio', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project, { width: 400, height: 100 });
  const ex = execution({ renderSpec: { type: 'ASSET_PLACEMENT', assetId: asset.assetId, objectFit: 'FILL', scale: 1, opacity: 1, position: { x: 0, y: 0 } } });

  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  const widthMatch = svgText.match(/<image[^>]*width="([\d.]+)"/);
  const heightMatch = svgText.match(/<image[^>]*height="([\d.]+)"/);
  assert.equal(Number(widthMatch[1]), 1920);
  assert.equal(Number(heightMatch[1]), 1080);
});

test('6. opacity from renderSpec is applied to the <image> element', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project);
  const ex = execution({ renderSpec: { type: 'ASSET_PLACEMENT', assetId: asset.assetId, objectFit: 'COVER', scale: 1, opacity: 0.42, position: { x: 0, y: 0 } } });

  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /opacity="0\.42"/);
});

// --- failure codes -------------------------------------------------------------------

test('7. renderSpec.type !== ASSET_PLACEMENT fails with INVALID_RENDER_SPEC', () => {
  const result = renderer.render({ projectId: 'p', executionResult: execution({ renderSpec: { type: 'WHITEBOARD' } }), outputDir: outDir() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
  assert.equal(result.artifact, null);
});

test('8. a missing outputDir fails with INVALID_RENDER_SPEC', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project);
  const ex = execution({ renderSpec: { type: 'ASSET_PLACEMENT', assetId: asset.assetId } });
  const result = renderer.render({ projectId: project.id, executionResult: ex });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

test('9. a nonexistent asset fails with MISSING_ASSET', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const ex = execution({ renderSpec: { type: 'ASSET_PLACEMENT', assetId: 'does-not-exist' } });
  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'MISSING_ASSET');
});

test('10. an asset that is not STORED fails with ASSET_NOT_STORED', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe' });
  const ex = execution({ renderSpec: { type: 'ASSET_PLACEMENT', assetId: asset.assetId } });
  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'ASSET_NOT_STORED');
});

test('11. a video-type asset fails with RENDERER_UNAVAILABLE, honestly documented as the ffmpeg blocker — never a fabricated frame', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const assetId = crypto.randomUUID();
  const asset = timelineStore.addAsset(project.id, { assetId, type: 'video' });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED', provider: 'local', path: `${assetId}.mp4` });
  const ex = execution({ renderSpec: { type: 'ASSET_PLACEMENT', assetId } });
  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'RENDERER_UNAVAILABLE');
  assert.equal(result.artifact, null);
});

test('12. a non-PNG stored image (e.g. JPEG) fails with RENDERER_UNAVAILABLE, not a fabricated render', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const assetId = crypto.randomUUID();
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const stored = assetStorage.storeUploadedImage(jpegBytes, assetId);
  const asset = timelineStore.addAsset(project.id, { assetId, type: 'keyframe' });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED', provider: 'local', path: stored.relativePath });
  const ex = execution({ renderSpec: { type: 'ASSET_PLACEMENT', assetId } });
  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'RENDERER_UNAVAILABLE');
});

// --- determinism / no mutation -------------------------------------------------------------------

test('13. determinism — identical input produces identical artifact dimensions and identical embedded bytes across repeated calls', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project, { width: 20, height: 12 });
  const ex = execution({ renderSpec: { type: 'ASSET_PLACEMENT', assetId: asset.assetId, objectFit: 'COVER', scale: 1, opacity: 1, position: { x: 0, y: 0 } } });

  const first = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  const second = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });

  const firstSvg = fs.readFileSync(first.artifact.path, 'utf8').replace(/clip-[^"]+/g, 'clip-X');
  const secondSvg = fs.readFileSync(second.artifact.path, 'utf8').replace(/clip-[^"]+/g, 'clip-X');
  assert.equal(firstSvg, secondSvg);
});

test('14. the source asset is never mutated by rendering — before/after snapshot is identical', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project);
  const before = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));
  const ex = execution({ renderSpec: { type: 'ASSET_PLACEMENT', assetId: asset.assetId, objectFit: 'COVER', scale: 1, opacity: 1, position: { x: 0, y: 0 } } });

  renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });

  const after = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));
  assert.equal(before, after);
});

// --- security -------------------------------------------------------------------

test('15. services/renderers/asset-placement-renderer.js has no eval/new Function/child_process/network call', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'renderers', 'asset-placement-renderer.js'), 'utf8');
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
});

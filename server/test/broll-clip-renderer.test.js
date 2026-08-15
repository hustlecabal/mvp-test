// Tests for services/renderers/broll-clip-renderer.js — Stage 26.8A. The
// one deliberately, honestly BLOCKED renderer: frame-accurate video
// decode/trim requires ffmpeg, which is not a declared dependency of this
// repository. Every test here proves the renderer performs every
// validation step genuinely possible WITHOUT ffmpeg, then fails
// deterministically with RENDERER_UNAVAILABLE — never a fabricated frame.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-broll-clip-renderer-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const { createExecutionResult } = require('../schemas/material-execution-schema');
const renderer = require('../services/renderers/broll-clip-renderer');

function makeStoredVideoAsset(projectId) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'video' });
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.mp4` });
  return timelineStore.getAsset(projectId, asset.assetId);
}

function brollSpec(assetId, overrides = {}) {
  return {
    type: 'BROLL_CLIP',
    sourceAssetId: assetId,
    brollSegmentId: 'seg-1',
    startTime: 0,
    duration: 5,
    trimIn: 0,
    trimOut: 5,
    playbackRate: 1,
    fit: 'COVER',
    transform: null,
    position: { x: 0, y: 0 },
    scale: 1,
    opacity: 1,
    audioPolicy: 'MUTE',
    role: 'PRIMARY',
    ...overrides,
  };
}

function execution(renderSpec, overrides = {}) {
  return createExecutionResult({ beatId: 'b1', materialId: 'm1', executorType: 'BROLL_CLIP', status: 'COMPLETED', duration: 5, renderSpec, sourceAssetIds: renderSpec ? [renderSpec.sourceAssetId] : [], ...overrides });
}

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-render-output-'));
}

// --- the honest blocker itself -------------------------------------------------------------------

test('1. a fully valid BROLL_CLIP renderSpec (real, STORED video asset, valid trim window) still fails with RENDERER_UNAVAILABLE — never a fabricated frame', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = makeStoredVideoAsset(project.id);
  const ex = execution(brollSpec(asset.assetId));

  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.rendererType, 'BROLL_CLIP');
  assert.equal(result.beatId, 'b1');
  assert.equal(result.materialId, 'm1');
  assert.equal(result.artifact, null, 'never a fabricated artifact');
  assert.equal(result.diagnostics[0].code, 'RENDERER_UNAVAILABLE');
  assert.match(result.diagnostics[0].message, /ffmpeg/i);
});

// --- validation that IS possible without ffmpeg, still genuinely performed -------------------------------------------------------------------

test('2. a missing asset fails with MISSING_ASSET, not RENDERER_UNAVAILABLE — the structural check runs BEFORE the honest blocker', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const ex = execution(brollSpec('does-not-exist'));
  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  assert.equal(result.diagnostics[0].code, 'MISSING_ASSET');
});

test('3. a non-video asset fails with INVALID_RENDER_SPEC, not RENDERER_UNAVAILABLE', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const assetId = crypto.randomUUID();
  const asset = timelineStore.addAsset(project.id, { assetId, type: 'keyframe' });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED', provider: 'local', path: `${assetId}.png` });
  const ex = execution(brollSpec(assetId));
  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

test('4. an asset that is not STORED fails with ASSET_NOT_STORED, not RENDERER_UNAVAILABLE', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'video' });
  const ex = execution(brollSpec(asset.assetId));
  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  assert.equal(result.diagnostics[0].code, 'ASSET_NOT_STORED');
});

test('5. an invalid trim window (trimOut <= trimIn) fails with INVALID_RENDER_SPEC, not RENDERER_UNAVAILABLE', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = makeStoredVideoAsset(project.id);
  const ex = execution(brollSpec(asset.assetId, { trimIn: 3, trimOut: 3 }));
  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

// --- structural failure codes -------------------------------------------------------------------

test('6. renderSpec.type !== BROLL_CLIP fails with INVALID_RENDER_SPEC', () => {
  const result = renderer.render({ projectId: 'p', executionResult: execution({ type: 'WHITEBOARD' }), outputDir: outDir() });
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

test('7. a missing outputDir fails with INVALID_RENDER_SPEC', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = makeStoredVideoAsset(project.id);
  const result = renderer.render({ projectId: project.id, executionResult: execution(brollSpec(asset.assetId)) });
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

// --- no mutation, no timeline assembly -------------------------------------------------------------------

test('8. the source asset is never mutated by rendering', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = makeStoredVideoAsset(project.id);
  const before = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));
  renderer.render({ projectId: project.id, executionResult: execution(brollSpec(asset.assetId)), outputDir: outDir() });
  const after = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));
  assert.equal(before, after);
});

test('9. renderer never writes any file to outputDir (RENDERER_UNAVAILABLE means genuinely no output)', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = makeStoredVideoAsset(project.id);
  const dir = outDir();
  renderer.render({ projectId: project.id, executionResult: execution(brollSpec(asset.assetId)), outputDir: dir });
  assert.deepEqual(fs.readdirSync(dir), []);
});

// --- security / dependency discipline -------------------------------------------------------------------

test('10. services/renderers/broll-clip-renderer.js does not require ffmpeg/child_process/fluent-ffmpeg, and has no eval/network call', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'renderers', 'broll-clip-renderer.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ['../timeline-store', '../../schemas/render-result-schema'].sort());
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
});

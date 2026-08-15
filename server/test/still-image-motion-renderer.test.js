// Tests for services/renderers/still-image-motion-renderer.js — Stage 26.8A.
// Proves a real, animated (SMIL) SVG is produced from a still image + a
// Ken-Burns-family motion instruction.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-render-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-still-image-motion-renderer-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const { createExecutionResult } = require('../schemas/material-execution-schema');
const renderer = require('../services/renderers/still-image-motion-renderer');
const { MOTION_TRANSFORMS } = require('../services/material-executors/still-image-motion-executor');
const { makeTinyPng } = require('./fixtures/png-fixture');

function buildStoredImageAsset(project, { width = 20, height = 10, type = 'keyframe' } = {}) {
  const assetId = crypto.randomUUID();
  const png = makeTinyPng(width, height);
  const stored = assetStorage.storeUploadedImage(png, assetId);
  const asset = timelineStore.addAsset(project.id, { assetId, type });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED', provider: 'local', path: stored.relativePath, contentType: stored.contentType });
  return timelineStore.getAsset(project.id, asset.assetId);
}

function kenBurnsSpec(assetId, overrides = {}) {
  const t = MOTION_TRANSFORMS.KEN_BURNS;
  return {
    type: 'STILL_IMAGE_MOTION',
    assetId,
    motionKind: 'KEN_BURNS',
    duration: 4,
    startScale: t.startScale,
    endScale: t.endScale,
    startPosition: t.startPosition,
    endPosition: t.endPosition,
    fadeIn: 0,
    fadeOut: 0,
    easing: 'EASE_IN_OUT',
    ...overrides,
  };
}

function execution(renderSpec, overrides = {}) {
  return createExecutionResult({
    beatId: 'b1',
    materialId: 'm1',
    executorType: 'STILL_IMAGE_MOTION',
    status: 'COMPLETED',
    duration: renderSpec ? renderSpec.duration : null,
    renderSpec,
    sourceAssetIds: renderSpec && renderSpec.assetId ? [renderSpec.assetId] : [],
    ...overrides,
  });
}

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-render-output-'));
}

// --- happy path -------------------------------------------------------------------

test('1. KEN_BURNS produces a COMPLETED render with a real, animated SVG (SMIL <animate> present)', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project);
  const ex = execution(kenBurnsSpec(asset.assetId));

  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.rendererType, 'STILL_IMAGE_MOTION');
  assert.equal(result.artifact.duration, 4);
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /<animate attributeName="x"/);
  assert.match(svgText, /<animate attributeName="width"/);
  assert.match(svgText, /calcMode="spline"/);
});

test('2. STATIC motion (start === end) still produces a valid animated SVG (a degenerate but valid animation)', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project);
  const t = MOTION_TRANSFORMS.STATIC;
  const ex = execution(kenBurnsSpec(asset.assetId, { motionKind: 'STATIC', startScale: t.startScale, endScale: t.endScale, startPosition: t.startPosition, endPosition: t.endPosition }));

  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  assert.equal(result.status, 'COMPLETED');
});

test('3. fadeIn/fadeOut produce an opacity animation with the right number of keyframes', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project);
  const ex = execution(kenBurnsSpec(asset.assetId, { fadeIn: 0.5, fadeOut: 0.5 }));

  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.match(svgText, /<animate attributeName="opacity" values="0;1;1;0"/);
});

test('4. no fadeIn/fadeOut produces no opacity animation (static full opacity)', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project);
  const ex = execution(kenBurnsSpec(asset.assetId, { fadeIn: 0, fadeOut: 0 }));

  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  const svgText = fs.readFileSync(result.artifact.path, 'utf8');
  assert.doesNotMatch(svgText, /attributeName="opacity"/);
  assert.match(svgText, /opacity="1"/);
});

// --- failure codes -------------------------------------------------------------------

test('5. renderSpec.type !== STILL_IMAGE_MOTION fails with INVALID_RENDER_SPEC', () => {
  const result = renderer.render({ projectId: 'p', executionResult: execution({ type: 'WHITEBOARD' }), outputDir: outDir() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

test('6. a non-positive or non-finite duration fails with INVALID_DURATION', () => {
  const result1 = renderer.render({ projectId: 'p', executionResult: execution(kenBurnsSpec('x', { duration: 0 })), outputDir: outDir() });
  assert.equal(result1.diagnostics[0].code, 'INVALID_DURATION');
  const result2 = renderer.render({ projectId: 'p', executionResult: execution(kenBurnsSpec('x', { duration: Infinity })), outputDir: outDir() });
  assert.equal(result2.diagnostics[0].code, 'INVALID_DURATION');
  const result3 = renderer.render({ projectId: 'p', executionResult: execution(kenBurnsSpec('x', { duration: NaN })), outputDir: outDir() });
  assert.equal(result3.diagnostics[0].code, 'INVALID_DURATION');
});

test('7. a nonexistent asset fails with MISSING_ASSET', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const ex = execution(kenBurnsSpec('does-not-exist'));
  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  assert.equal(result.diagnostics[0].code, 'MISSING_ASSET');
});

test('8. a video-type asset fails with RENDERER_UNAVAILABLE — never a fabricated animated frame', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const assetId = crypto.randomUUID();
  const asset = timelineStore.addAsset(project.id, { assetId, type: 'video' });
  timelineStore.updateAssetStorage(project.id, asset.assetId, { status: 'STORED', provider: 'local', path: `${assetId}.mp4` });
  const ex = execution(kenBurnsSpec(assetId));
  const result = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  assert.equal(result.diagnostics[0].code, 'RENDERER_UNAVAILABLE');
});

test('9. a missing outputDir fails with INVALID_RENDER_SPEC', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project);
  const result = renderer.render({ projectId: project.id, executionResult: execution(kenBurnsSpec(asset.assetId)) });
  assert.equal(result.diagnostics[0].code, 'INVALID_RENDER_SPEC');
});

// --- determinism / no mutation -------------------------------------------------------------------

test('10. determinism — identical input produces an identical animated SVG across repeated calls', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project, { width: 16, height: 9 });
  const ex = execution(kenBurnsSpec(asset.assetId));

  const first = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });
  const second = renderer.render({ projectId: project.id, executionResult: ex, outputDir: outDir() });

  const norm = (s) => s.replace(/clip-[^"]+/g, 'clip-X');
  assert.equal(norm(fs.readFileSync(first.artifact.path, 'utf8')), norm(fs.readFileSync(second.artifact.path, 'utf8')));
});

test('11. the source asset is never mutated by rendering', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = buildStoredImageAsset(project);
  const before = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));
  renderer.render({ projectId: project.id, executionResult: execution(kenBurnsSpec(asset.assetId)), outputDir: outDir() });
  const after = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));
  assert.equal(before, after);
});

// --- security -------------------------------------------------------------------

test('12. services/renderers/still-image-motion-renderer.js has no eval/new Function/child_process/network call', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'renderers', 'still-image-motion-renderer.js'), 'utf8');
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
});

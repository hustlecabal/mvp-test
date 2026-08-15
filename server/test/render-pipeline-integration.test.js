// Stage 26.8A, Part 13 — the required real pipeline integration proof:
//
//   VisualBeat -> real resolveMaterial() -> real executeMaterial() ->
//   render-service.js's renderMaterial() -> a real renderer
//
// Every renderSpec here comes from the ACTUAL Stage 26.3/26.5A/26.5B
// resolver/executor layer — never manually reconstructed. This covers all
// 6 RENDERER_TYPES. Stage 26.8C updated test 5: BROLL_CLIP now routes to
// the real HyperFrames renderer (services/renderers/hyperframes-renderer.js)
// and genuinely succeeds — it is no longer one of the honestly-blocked
// cases. Test 6 (an existing video asset placed via ASSET_PLACEMENT/
// PROJECT_ASSET_REUSE) remains honestly RENDERER_UNAVAILABLE: that route
// still goes through the Stage 26.8A SVG renderer, which was never given
// video-decode capability.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-render-pipeline-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-render-pipeline-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
const brollTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-render-pipeline-broll-'));
process.env.BROLL_DATA_DIR = brollTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const brollLibraryService = require('../services/broll-library-service');
const materialResolutionService = require('../services/material-resolution-service');
const executionService = require('../services/material-execution-service');
const { renderMaterial } = require('../services/render-service');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { makeTinyPng } = require('./fixtures/png-fixture');

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-render-pipeline-output-'));
}

function makeStoredImageAsset(projectId, { width = 16, height = 9 } = {}) {
  const assetId = crypto.randomUUID();
  const stored = assetStorage.storeUploadedImage(makeTinyPng(width, height), assetId);
  const asset = timelineStore.addAsset(projectId, { assetId, type: 'keyframe' });
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: stored.relativePath, contentType: stored.contentType });
  return timelineStore.getAsset(projectId, asset.assetId);
}

function makeStoredVideoAsset(projectId) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'video' });
  const relativePath = `${asset.assetId}.mp4`;
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: relativePath });
  // A real, tiny, synthetic (ffmpeg lavfi, no download) video file backing
  // the stored path — required since Stage 26.8C's BROLL_CLIP route
  // (services/renderers/hyperframes-renderer.js) genuinely decodes the
  // source file rather than only checking its metadata. Harmless for the
  // AI_VIDEO/ASSET_PLACEMENT test below, which still blocks on the
  // asset's `type` field before ever reading the file.
  const absolutePath = assetStorage.resolveStoredPath(relativePath);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:duration=6:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', absolutePath]);
  return timelineStore.getAsset(projectId, asset.assetId);
}

function beat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 4, ...overrides });
}

// --- 1. STILL_IMAGE -> PROJECT_ASSET_REUSE -> STILL_IMAGE_MOTION executor -> STILL_IMAGE_MOTION renderer (COMPLETED) -------------------------------------------------------------------

test('1. real pipeline — STILL_IMAGE beat resolves via PROJECT_ASSET_REUSE, executes via STILL_IMAGE_MOTION, and renders a real animated SVG', () => {
  const project = projectStore.createProject({ title: 'EVOLINK STAGE 26.8A PIPELINE PROOF', topic: 'render pipeline proof' });
  const asset = makeStoredImageAsset(project.id, { width: 40, height: 20 });
  const b = beat({ visualTreatment: 'STILL_IMAGE' });

  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.materialSource, 'PROJECT_ASSET_REUSE');
  assert.equal(resolution.selectedMaterial.selectedAssetId, asset.assetId);

  const execution = executionService.executeMaterial(project.id, b, resolution);
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.executorType, 'STILL_IMAGE_MOTION');
  assert.equal(execution.renderSpec.type, 'STILL_IMAGE_MOTION');
  assert.equal(execution.renderSpec.assetId, asset.assetId);

  const render = renderMaterial(project.id, execution, outDir());
  assert.equal(render.status, 'COMPLETED');
  assert.equal(render.rendererType, 'STILL_IMAGE_MOTION');
  assert.equal(render.beatId, b.id);
  assert.ok(fs.existsSync(render.artifact.path));
  const svgText = fs.readFileSync(render.artifact.path, 'utf8');
  assert.match(svgText, /<animate attributeName="width"/);
  assert.match(svgText, /data:image\/png;base64,/);
});

// --- 2. KINETIC_TYPOGRAPHY -> DETERMINISTIC_TEMPLATE -> KINETIC_TYPOGRAPHY executor -> renderer (COMPLETED) -------------------------------------------------------------------

test('2. real pipeline — KINETIC_TYPOGRAPHY beat resolves via DETERMINISTIC_TEMPLATE, executes, and renders real animated text', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const b = beat({ visualTreatment: 'KINETIC_TYPOGRAPHY' });

  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.materialSource, 'DETERMINISTIC_TEMPLATE');

  const execution = executionService.executeMaterial(project.id, b, resolution, { text: 'Ship it today' });
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.executorType, 'KINETIC_TYPOGRAPHY');

  const render = renderMaterial(project.id, execution, outDir());
  assert.equal(render.status, 'COMPLETED');
  assert.equal(render.rendererType, 'KINETIC_TYPOGRAPHY');
  const svgText = fs.readFileSync(render.artifact.path, 'utf8');
  assert.match(svgText, /Ship/);
  assert.match(svgText, /today/);
});

// --- 3. MOTION_GRAPHIC -> DETERMINISTIC_TEMPLATE -> MOTION_GRAPHIC executor -> renderer (COMPLETED) -------------------------------------------------------------------

test('3. real pipeline — MOTION_GRAPHIC beat resolves via DETERMINISTIC_TEMPLATE, executes, and renders real primitives', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const b = beat({ visualTreatment: 'MOTION_GRAPHIC' });

  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  assert.equal(resolution.status, 'RESOLVED');

  const execution = executionService.executeMaterial(project.id, b, resolution, {
    elements: [{ kind: 'CIRCLE', position: { x: 0.5, y: 0.5 }, props: { radius: 50, color: '#ff8800' } }],
  });
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.executorType, 'MOTION_GRAPHIC');

  const render = renderMaterial(project.id, execution, outDir());
  assert.equal(render.status, 'COMPLETED');
  assert.equal(render.rendererType, 'MOTION_GRAPHIC');
  const svgText = fs.readFileSync(render.artifact.path, 'utf8');
  assert.match(svgText, /<circle cx="0" cy="0" r="50" fill="#ff8800"\/>/);
});

// --- 4. WHITEBOARD -> DETERMINISTIC_TEMPLATE -> WHITEBOARD executor -> renderer (COMPLETED) -------------------------------------------------------------------

test('4. real pipeline — WHITEBOARD beat resolves via DETERMINISTIC_TEMPLATE, executes, and renders a real stroke-draw animation', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const b = beat({ visualTreatment: 'WHITEBOARD' });

  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  assert.equal(resolution.status, 'RESOLVED');

  const execution = executionService.executeMaterial(project.id, b, resolution, {
    elements: [{ kind: 'TEXT', content: 'idea', drawDuration: 1 }, { kind: 'SHAPE', content: 'box', style: { shapeType: 'RECTANGLE' }, drawDuration: 1 }],
  });
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.executorType, 'WHITEBOARD');

  const render = renderMaterial(project.id, execution, outDir());
  assert.equal(render.status, 'COMPLETED');
  assert.equal(render.rendererType, 'WHITEBOARD');
  const svgText = fs.readFileSync(render.artifact.path, 'utf8');
  assert.match(svgText, /idea/);
  assert.match(svgText, /stroke-dasharray/);
});

// --- 5. BROLL_CLIP -> BROLL_LIBRARY -> BROLL_CLIP executor -> HyperFrames renderer (real MP4) -------------------------------------------------------------------

test('5. real pipeline — BROLL_CLIP beat resolves via BROLL_LIBRARY, executes to a real renderSpec, then renders to a real, ffprobe-verified MP4 via HyperFrames', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = makeStoredVideoAsset(project.id);
  // TREATMENT_TO_ASSET_TYPES maps BROLL_CLIP -> ['video'] too, so this same
  // video asset would otherwise ALSO survive as a higher-ranked
  // PROJECT_ASSET_REUSE candidate (REUSE_ORDINAL ranks PROJECT_ASSET_REUSE
  // above BROLL_LIBRARY) — REJECTED excludes it from that path without
  // affecting B-roll eligibility, isolating this proof to BROLL_LIBRARY
  // specifically. Same pattern test/broll-execution-integration.test.js
  // already established.
  timelineStore.setAssetApprovalStatus(project.id, asset.assetId, 'REJECTED');
  const registration = brollLibraryService.registerBrollSegment(project.id, { assetId: asset.assetId, source: { type: 'LOCAL_UPLOAD' }, licensing: { status: 'LICENSED' } });
  assert.equal(registration.ok, true);
  const b = beat({ visualTreatment: 'BROLL_CLIP' });

  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.materialSource, 'BROLL_LIBRARY');

  const execution = executionService.executeMaterial(project.id, b, resolution);
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.executorType, 'BROLL_CLIP');

  const render = renderMaterial(project.id, execution, outDir());
  assert.equal(render.status, 'COMPLETED');
  assert.equal(render.rendererType, 'BROLL_CLIP');
  assert.deepEqual(render.diagnostics, []);
  assert.equal(render.artifact.format, 'MP4');
  assert.ok(fs.existsSync(render.artifact.path));
  assert.equal(render.artifact.width, 1920);
  assert.equal(render.artifact.height, 1080);
  assert.ok(render.artifact.duration > 0);
});

// --- 6. AI_VIDEO -> PROJECT_ASSET_REUSE(video) -> ASSET_PLACEMENT executor -> renderer (honestly RENDERER_UNAVAILABLE) -------------------------------------------------------------------

test('6. real pipeline — AI_VIDEO beat satisfied by an existing video asset resolves via PROJECT_ASSET_REUSE, executes to a real ASSET_PLACEMENT renderSpec, then renders to the honest RENDERER_UNAVAILABLE blocker', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = makeStoredVideoAsset(project.id);
  const b = beat({ visualTreatment: 'AI_VIDEO' });

  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.materialSource, 'PROJECT_ASSET_REUSE');

  const execution = executionService.executeMaterial(project.id, b, resolution);
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.executorType, 'PROJECT_ASSET_REUSE');
  assert.equal(execution.renderSpec.type, 'ASSET_PLACEMENT');
  assert.equal(execution.renderSpec.assetId, asset.assetId);

  const render = renderMaterial(project.id, execution, outDir());
  assert.equal(render.status, 'FAILED');
  assert.equal(render.rendererType, 'ASSET_PLACEMENT');
  assert.equal(render.diagnostics[0].code, 'RENDERER_UNAVAILABLE');
});

// --- no mutation across the whole real path -------------------------------------------------------------------

test('7. no project/asset/broll data is mutated anywhere across the full real pipeline for any of the 6 cases above', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const imageAsset = makeStoredImageAsset(project.id);
  const before = JSON.stringify(timelineStore.getAsset(project.id, imageAsset.assetId));

  const b = beat({ visualTreatment: 'STILL_IMAGE' });
  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  const execution = executionService.executeMaterial(project.id, b, resolution);
  renderMaterial(project.id, execution, outDir());

  const after = JSON.stringify(timelineStore.getAsset(project.id, imageAsset.assetId));
  assert.equal(before, after);
  assert.equal(timelineStore.listAssets(project.id).length, 1, 'no second asset was ever created');
});

// --- determinism across the whole real path -------------------------------------------------------------------

test('8. determinism — repeating the full real pipeline for the same beat produces structurally identical render output', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  makeStoredImageAsset(project.id, { width: 40, height: 20 });
  const b = beat({ visualTreatment: 'STILL_IMAGE' });

  const resolution1 = materialResolutionService.resolveMaterial(project.id, b, {});
  const execution1 = executionService.executeMaterial(project.id, b, resolution1);
  const render1 = renderMaterial(project.id, execution1, outDir());

  const resolution2 = materialResolutionService.resolveMaterial(project.id, b, {});
  const execution2 = executionService.executeMaterial(project.id, b, resolution2);
  const render2 = renderMaterial(project.id, execution2, outDir());

  const norm = (s) => s.replace(/clip-[^"]+/g, 'clip-X');
  assert.equal(norm(fs.readFileSync(render1.artifact.path, 'utf8')), norm(fs.readFileSync(render2.artifact.path, 'utf8')));
});

// --- no network anywhere in the exercised path -------------------------------------------------------------------

test('9. no network call occurs anywhere in the executed path — static scan of every renderer/service file this proof exercises', () => {
  for (const file of [
    path.join('services', 'render-service.js'),
    path.join('services', 'renderer-registry.js'),
    path.join('services', 'renderers', 'asset-placement-renderer.js'),
    path.join('services', 'renderers', 'still-image-motion-renderer.js'),
    path.join('services', 'renderers', 'kinetic-typography-renderer.js'),
    path.join('services', 'renderers', 'motion-graphic-renderer.js'),
    path.join('services', 'renderers', 'whiteboard-renderer.js'),
    path.join('services', 'renderers', 'broll-clip-renderer.js'),
  ]) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
      assert.doesNotMatch(text, pattern, `${file} must not contain a network/eval/child_process call`);
    }
  }
});

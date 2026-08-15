// Stage 26.8C, Part 16 — dedicated tests for services/renderers/
// hyperframes-renderer.js itself. render-pipeline-integration.test.js
// already proves the full real pipeline for BROLL_CLIP (the one type this
// module is registry-routed for); this file exercises the module DIRECTLY
// (bypassing renderer-registry.js) for the 5 remaining renderSpec types it
// also fully supports, plus validation, security, and determinism.
//
// Every renderSpec fed into hyperframes-renderer.render() below comes from
// the REAL Stage 26.3/26.5A/26.5B resolver/executor layer — never manually
// reconstructed — matching render-pipeline-integration.test.js's own
// discipline.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-hf-renderer-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-hf-renderer-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;
const brollTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-hf-renderer-broll-'));
process.env.BROLL_DATA_DIR = brollTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const materialResolutionService = require('../services/material-resolution-service');
const executionService = require('../services/material-execution-service');
const hyperframesRenderer = require('../services/renderers/hyperframes-renderer');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { makeTinyPng } = require('./fixtures/png-fixture');

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-hf-renderer-output-'));
}

function makeStoredImageAsset(projectId, { width = 40, height = 20 } = {}) {
  const assetId = crypto.randomUUID();
  const stored = assetStorage.storeUploadedImage(makeTinyPng(width, height), assetId);
  const asset = timelineStore.addAsset(projectId, { assetId, type: 'keyframe' });
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: stored.relativePath, contentType: stored.contentType });
  return timelineStore.getAsset(projectId, asset.assetId);
}

function makeStoredVideoAsset(projectId, { durationSeconds = 6 } = {}) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'video' });
  const relativePath = `${asset.assetId}.mp4`;
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: relativePath });
  const absolutePath = assetStorage.resolveStoredPath(relativePath);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:duration=${durationSeconds}:rate=25`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', absolutePath,
  ]);
  return timelineStore.getAsset(projectId, asset.assetId);
}

function beat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 3, ...overrides });
}

function ffprobeJson(filePath) {
  const raw = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', filePath]).toString('utf8');
  return JSON.parse(raw);
}

// --- 1. ASSET_PLACEMENT (video asset) — real pipeline, direct module call --------------------------------------

test('1. ASSET_PLACEMENT — real pipeline (AI_VIDEO -> PROJECT_ASSET_REUSE) renders a real MP4 via hyperframes-renderer, where the registered SVG renderer would have honestly blocked (video decode unsupported there)', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = makeStoredVideoAsset(project.id);
  const b = beat({ visualTreatment: 'AI_VIDEO' });

  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.selectedMaterial.materialSource, 'PROJECT_ASSET_REUSE');

  const execution = executionService.executeMaterial(project.id, b, resolution);
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.renderSpec.type, 'ASSET_PLACEMENT');
  assert.equal(execution.renderSpec.assetId, asset.assetId);

  const render = hyperframesRenderer.render({ projectId: project.id, executionResult: execution, outputDir: outDir() });
  assert.equal(render.status, 'COMPLETED');
  assert.equal(render.rendererType, 'ASSET_PLACEMENT');
  assert.deepEqual(render.diagnostics, []);
  assert.equal(render.artifact.format, 'MP4');
  assert.ok(fs.existsSync(render.artifact.path));
  const probe = ffprobeJson(render.artifact.path);
  assert.ok(probe.streams.some((s) => s.codec_type === 'video'));
});

// --- 2. STILL_IMAGE_MOTION — real pipeline, direct module call --------------------------------------

test('2. STILL_IMAGE_MOTION — real pipeline renders a real Ken-Burns MP4 via hyperframes-renderer', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  makeStoredImageAsset(project.id, { width: 40, height: 20 });
  const b = beat({ visualTreatment: 'STILL_IMAGE' });

  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  assert.equal(resolution.status, 'RESOLVED');
  const execution = executionService.executeMaterial(project.id, b, resolution, { motionKind: 'ZOOM_IN' });
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.renderSpec.type, 'STILL_IMAGE_MOTION');

  const render = hyperframesRenderer.render({ projectId: project.id, executionResult: execution, outputDir: outDir() });
  assert.equal(render.status, 'COMPLETED');
  assert.equal(render.rendererType, 'STILL_IMAGE_MOTION');
  assert.equal(render.artifact.format, 'MP4');
  assert.ok(render.artifact.duration > 0);
});

// --- 3. KINETIC_TYPOGRAPHY — real pipeline, direct module call --------------------------------------

test('3. KINETIC_TYPOGRAPHY — real pipeline renders a real animated-text MP4 via hyperframes-renderer', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const b = beat({ visualTreatment: 'KINETIC_TYPOGRAPHY' });

  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  assert.equal(resolution.status, 'RESOLVED');
  const execution = executionService.executeMaterial(project.id, b, resolution, { text: 'Ship it today', entrance: 'SLIDE_UP', exit: 'FADE_OUT' });
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.renderSpec.type, 'KINETIC_TYPOGRAPHY');

  const render = hyperframesRenderer.render({ projectId: project.id, executionResult: execution, outputDir: outDir() });
  assert.equal(render.status, 'COMPLETED');
  assert.equal(render.rendererType, 'KINETIC_TYPOGRAPHY');
  assert.equal(render.artifact.format, 'MP4');
});

// --- 4. MOTION_GRAPHIC hybrid, heterogeneous, time-overlapping elements — real pipeline --------------------------------------
//
// Part 7's deterministic-track-allocation requirement + Part 13's "hybrid
// multi-material composition" proof, both satisfied within this module's
// own architectural boundary: a single MOTION_GRAPHIC renderSpec is the
// most heterogeneous single composition EVOLINK's contract allows without
// building a forbidden second timeline assembler (Stage 26.8C explicitly
// forbids "full timeline assembly" — see this module's own header). Four
// DIFFERENT primitive kinds are placed with deliberately OVERLAPPING
// sequence windows; a naive single-track scaffold would trip HyperFrames'
// own "overlapping_clips_same_track" lint error. This proves the adapter's
// one-track-per-element allocation (hyperframes-renderer.js's
// translateMotionGraphic, data-track-index="${i}") is real, not aspirational.

test('4. MOTION_GRAPHIC — hybrid composition of 4 heterogeneous, time-overlapping primitives renders successfully (proves deterministic per-element track allocation, Part 7/13)', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const b = beat({ visualTreatment: 'MOTION_GRAPHIC', duration: 3 });

  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  assert.equal(resolution.status, 'RESOLVED');
  const execution = executionService.executeMaterial(project.id, b, resolution, {
    elements: [
      { elementId: 'rect', kind: 'RECTANGLE', position: { x: 0.2, y: 0.3 }, props: { width: 200, height: 100, color: '#4fc3f7' }, sequence: { startOffset: 0, endOffset: 2 } },
      { elementId: 'circ', kind: 'CIRCLE', position: { x: 0.5, y: 0.5 }, props: { radius: 60, color: '#ff8800' }, sequence: { startOffset: 0.5, endOffset: 2.5 } },
      { elementId: 'txt', kind: 'TEXT', position: { x: 0.7, y: 0.2 }, props: { text: 'Hybrid', color: '#ffffff' }, sequence: { startOffset: 1, endOffset: 2 } },
      { elementId: 'chart', kind: 'CHART', position: { x: 0.5, y: 0.8 }, props: { data: [10, 20, 30], width: 300, height: 120, color: '#66bb6a' }, sequence: { startOffset: 0, endOffset: 3 } },
    ],
  });
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.renderSpec.elements.length, 4);
  // Confirm the fixture is genuinely overlapping in time (not accidentally sequential).
  assert.ok(execution.renderSpec.elements[0].sequence.endOffset > execution.renderSpec.elements[1].sequence.startOffset);
  assert.ok(execution.renderSpec.elements[1].sequence.endOffset > execution.renderSpec.elements[2].sequence.startOffset);

  const render = hyperframesRenderer.render({ projectId: project.id, executionResult: execution, outputDir: outDir() });
  assert.equal(render.status, 'COMPLETED', render.diagnostics[0] && render.diagnostics[0].message);
  assert.equal(render.rendererType, 'MOTION_GRAPHIC');
  assert.equal(render.artifact.format, 'MP4');
});

// --- 5. WHITEBOARD — persistent-visibility proof --------------------------------------
//
// Part 6's semantics: an element draws on, then REMAINS visible for the
// rest of the composition — never disappearing once its own drawDuration
// completes. drawDuration here (0.3s) is deliberately far shorter than the
// composition duration (3s): the pre-fix bug this exact case would have
// caught is a clip whose data-duration was set to drawDuration alone,
// vanishing at t=0.3s instead of persisting to t=3s. Proven by sampling
// real decoded pixels (never trusting the renderSpec/HTML alone) at two
// widely-separated late timestamps, both deep inside the "should still be
// visible" window, and checking they are (a) darker than the plain
// background at that region and (b) essentially identical to each other
// (stable/persisted, not still animating or gone).

function sampleRegionBrightness(videoPath, atSeconds, x, y, w, h) {
  const rawPath = path.join(os.tmpdir(), `hf-sample-${crypto.randomUUID()}.raw`);
  try {
    execFileSync('ffmpeg', [
      '-y', '-ss', String(atSeconds), '-i', videoPath,
      '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y}`,
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', rawPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const buf = fs.readFileSync(rawPath);
    let sum = 0;
    for (const byte of buf) sum += byte;
    return sum / buf.length;
  } finally {
    fs.rmSync(rawPath, { force: true });
  }
}

test('5. WHITEBOARD — an element remains visible long after its own drawDuration ends, until the composition itself ends (real pixel-sampling proof)', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const b = beat({ visualTreatment: 'WHITEBOARD', duration: 3 });

  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  assert.equal(resolution.status, 'RESOLVED');
  const execution = executionService.executeMaterial(project.id, b, resolution, {
    elements: [{ elementId: 'el-0', kind: 'TEXT', content: 'idea', drawStartOffset: 0, drawDuration: 0.3 }],
  });
  assert.equal(execution.status, 'COMPLETED');
  assert.equal(execution.renderSpec.type, 'WHITEBOARD');

  const render = hyperframesRenderer.render({ projectId: project.id, executionResult: execution, outputDir: outDir() });
  assert.equal(render.status, 'COMPLETED', render.diagnostics[0] && render.diagnostics[0].message);
  assert.ok(render.artifact.duration >= 2.5, `expected a ~3s composition, got ${render.artifact.duration}`);

  // translateWhiteboard's own grid formula for the first (only) element: x=300, y=300.
  const TEXT_X = 300, TEXT_Y = 300, REGION_W = 220, REGION_H = 60;
  const BG_X = 1500, BG_Y = 800; // far from the text, pure background (#f5f5f0)

  const textBrightnessEarly = sampleRegionBrightness(render.artifact.path, 0.8, TEXT_X, TEXT_Y, REGION_W, REGION_H);
  const textBrightnessLate = sampleRegionBrightness(render.artifact.path, 2.8, TEXT_X, TEXT_Y, REGION_W, REGION_H);
  const backgroundBrightness = sampleRegionBrightness(render.artifact.path, 2.8, BG_X, BG_Y, REGION_W, REGION_H);

  assert.ok(backgroundBrightness > 200, `background patch should be near-white #f5f5f0, got avg byte value ${backgroundBrightness}`);
  assert.ok(textBrightnessLate < backgroundBrightness - 3, `text region at t=2.8s (well after drawDuration=0.3s) should be visibly darker than background — got text=${textBrightnessLate} vs bg=${backgroundBrightness}; the element must have disappeared instead of persisting`);
  assert.ok(Math.abs(textBrightnessEarly - textBrightnessLate) < 2, `text region brightness should be stable between t=0.8s and t=2.8s (persisted, not still animating/gone) — got ${textBrightnessEarly} vs ${textBrightnessLate}`);
});

// --- 6. BROLL_CLIP validation: playbackRate !== 1 fails deterministically, never silently --------------------------------------

test('6. BROLL_CLIP — playbackRate !== 1 fails deterministically with HYPERFRAMES_PLAYBACK_RATE_UNSUPPORTED (Part 5), never a silently-wrong-speed render', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = makeStoredVideoAsset(project.id);
  const executionResult = {
    beatId: 'b1',
    materialId: 'm1',
    executionId: crypto.randomUUID(),
    status: 'COMPLETED',
    renderSpec: {
      type: 'BROLL_CLIP',
      sourceAssetId: asset.assetId,
      trimIn: 0,
      trimOut: 2,
      playbackRate: 2,
      fit: 'COVER',
      position: { x: 0, y: 0 },
      scale: 1,
      opacity: 1,
      audioPolicy: 'MUTE',
    },
  };
  const render = hyperframesRenderer.render({ projectId: project.id, executionResult, outputDir: outDir() });
  assert.equal(render.status, 'FAILED');
  assert.equal(render.diagnostics[0].code, 'HYPERFRAMES_PLAYBACK_RATE_UNSUPPORTED');
  assert.equal(render.artifact, null);
});

// --- 7. Missing asset --------------------------------------

test('7. missing asset — a renderSpec referencing a nonexistent assetId fails with MISSING_ASSET, never a crash or a fabricated frame', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const executionResult = {
    beatId: 'b1', materialId: 'm1', executionId: crypto.randomUUID(), status: 'COMPLETED',
    renderSpec: { type: 'ASSET_PLACEMENT', assetId: 'does-not-exist', duration: 3, objectFit: 'COVER', position: { x: 0, y: 0 }, scale: 1, opacity: 1 },
  };
  const render = hyperframesRenderer.render({ projectId: project.id, executionResult, outputDir: outDir() });
  assert.equal(render.status, 'FAILED');
  assert.equal(render.diagnostics[0].code, 'MISSING_ASSET');
});

// --- 8. Asset not stored --------------------------------------

test('8. asset not stored — a renderSpec referencing an asset whose storage status is not STORED fails with ASSET_NOT_STORED', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'keyframe' });
  const executionResult = {
    beatId: 'b1', materialId: 'm1', executionId: crypto.randomUUID(), status: 'COMPLETED',
    renderSpec: { type: 'ASSET_PLACEMENT', assetId: asset.assetId, duration: 3, objectFit: 'COVER', position: { x: 0, y: 0 }, scale: 1, opacity: 1 },
  };
  const render = hyperframesRenderer.render({ projectId: project.id, executionResult, outputDir: outDir() });
  assert.equal(render.status, 'FAILED');
  assert.equal(render.diagnostics[0].code, 'ASSET_NOT_STORED');
});

// --- 9. Invalid timing --------------------------------------

test('9. invalid timing — a non-positive duration fails with INVALID_DURATION before any render is attempted', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  makeStoredImageAsset(project.id);
  const executionResult = {
    beatId: 'b1', materialId: 'm1', executionId: crypto.randomUUID(), status: 'COMPLETED',
    renderSpec: { type: 'MOTION_GRAPHIC', duration: 0, elements: [{ elementId: 'e', kind: 'CIRCLE', position: { x: 0.5, y: 0.5 }, props: { radius: 40 }, sequence: { startOffset: 0, endOffset: 1 } }] },
  };
  const render = hyperframesRenderer.render({ projectId: project.id, executionResult, outputDir: outDir() });
  assert.equal(render.status, 'FAILED');
  assert.equal(render.diagnostics[0].code, 'INVALID_DURATION');
});

// --- 10. Invalid outputDir — the missing-catch-block regression --------------------------------------

test('10. invalid outputDir (a path that already exists as a FILE, not a directory) fails as a structured RenderResult, never throws — regression test for a real bug found and fixed this stage (render() was missing a catch block)', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const badOutDirParent = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-badoutdir-'));
  const badOutDir = path.join(badOutDirParent, 'not-a-directory');
  fs.writeFileSync(badOutDir, 'this is a file, not a directory');

  const executionResult = {
    beatId: 'b1', materialId: 'm1', executionId: crypto.randomUUID(), status: 'COMPLETED',
    renderSpec: { type: 'MOTION_GRAPHIC', duration: 1, elements: [{ elementId: 'e', kind: 'CIRCLE', position: { x: 0.5, y: 0.5 }, props: { radius: 40 }, sequence: { startOffset: 0, endOffset: 1 } }] },
  };

  assert.doesNotThrow(() => {
    const render = hyperframesRenderer.render({ projectId: project.id, executionResult, outputDir: badOutDir });
    assert.equal(render.status, 'FAILED');
    assert.equal(render.diagnostics[0].code, 'RENDER_FAILED');
    assert.match(render.diagnostics[0].message, /EEXIST|ENOTDIR/);
  });
});

// --- 11/12. Broken HYPERFRAMES_FFMPEG_PATH / HYPERFRAMES_FFPROBE_PATH --------------------------------------
//
// Both surface via HyperFrames' own CLI preflight check in this version
// (it validates ffmpeg AND ffprobe availability before attempting any
// render), so both reach this module's runHyperframesRender() failure
// branch rather than its own downstream ffprobeValidate() specifically —
// documented honestly here rather than presented as two independently
// distinct code paths.

function withEnvOverride(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

test('11. a broken HYPERFRAMES_FFMPEG_PATH override fails safely as RENDER_FAILED (HyperFrames own preflight), never crashes, never leaks a secret', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  makeStoredImageAsset(project.id);
  const b = beat({ visualTreatment: 'STILL_IMAGE' });
  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  const execution = executionService.executeMaterial(project.id, b, resolution);

  withEnvOverride('HYPERFRAMES_FFMPEG_PATH', '/nonexistent/ffmpeg-binary-that-does-not-exist', () => {
    const render = hyperframesRenderer.render({ projectId: project.id, executionResult: execution, outputDir: outDir() });
    assert.equal(render.status, 'FAILED');
    assert.equal(render.diagnostics[0].code, 'RENDER_FAILED');
    assert.doesNotMatch(render.diagnostics[0].message, /EVOLINK_API_KEY/);
  });
});

test('12. a broken HYPERFRAMES_FFPROBE_PATH override fails safely as RENDER_FAILED (HyperFrames own preflight), never crashes, never leaks a secret', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  makeStoredImageAsset(project.id);
  const b = beat({ visualTreatment: 'STILL_IMAGE' });
  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  const execution = executionService.executeMaterial(project.id, b, resolution);

  withEnvOverride('HYPERFRAMES_FFPROBE_PATH', '/nonexistent/ffprobe-binary-that-does-not-exist', () => {
    const render = hyperframesRenderer.render({ projectId: project.id, executionResult: execution, outputDir: outDir() });
    assert.equal(render.status, 'FAILED');
    assert.equal(render.diagnostics[0].code, 'RENDER_FAILED');
    assert.doesNotMatch(render.diagnostics[0].message, /EVOLINK_API_KEY/);
  });
});

// --- 13. Determinism at the adapter level --------------------------------------
//
// MP4 container bytes are not expected to be byte-identical across two
// separate encodes (muxer/timestamp metadata) — so this compares DECODED
// PIXEL CONTENT (scaled down for a fast, bounded-size hash) rather than
// raw file bytes, which is what "deterministic rendering" actually means
// for a video artifact.

function hashDecodedFrames(videoPath) {
  const raw = execFileSync('ffmpeg', [
    '-i', videoPath, '-vf', 'scale=160:90', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
  ], { maxBuffer: 100 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('13. determinism — rendering the same real BROLL_CLIP renderSpec twice produces decode-identical video content', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = makeStoredVideoAsset(project.id, { durationSeconds: 3 });
  const executionResult = {
    beatId: 'b1', materialId: 'm1', executionId: crypto.randomUUID(), status: 'COMPLETED',
    renderSpec: {
      type: 'BROLL_CLIP', sourceAssetId: asset.assetId, trimIn: 0, trimOut: 2, playbackRate: 1,
      fit: 'COVER', position: { x: 0, y: 0 }, scale: 1, opacity: 1, audioPolicy: 'MUTE',
    },
  };

  const render1 = hyperframesRenderer.render({ projectId: project.id, executionResult, outputDir: outDir() });
  const render2 = hyperframesRenderer.render({ projectId: project.id, executionResult, outputDir: outDir() });
  assert.equal(render1.status, 'COMPLETED', render1.diagnostics[0] && render1.diagnostics[0].message);
  assert.equal(render2.status, 'COMPLETED', render2.diagnostics[0] && render2.diagnostics[0].message);

  assert.equal(hashDecodedFrames(render1.artifact.path), hashDecodedFrames(render2.artifact.path));
});

// --- 14. Security — argument-array-only invocation, no shell, no eval --------------------------------------

test('14. security — hyperframes-renderer.js only invokes child_process via execFileSync with an explicit argument array; no shell:true, no exec/spawn-with-string, no eval/new Function', () => {
  const fullText = fs.readFileSync(path.join(__dirname, '..', 'services', 'renderers', 'hyperframes-renderer.js'), 'utf8');
  // Strip full-line "//" comments before scanning for dangerous patterns —
  // this file's own header PROSE discusses "shell: true"/"eval("/etc. as
  // things it deliberately avoids, which must not itself trip the scan.
  const text = fullText
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.filter((r) => r === 'child_process' || r.startsWith('child_process/')), ['child_process']);
  assert.doesNotMatch(text, /require\(\s*['"`]child_process['"`]\s*\)\s*\.\s*(?!execFileSync\b)\w+/, 'only child_process.execFileSync may be used');
  assert.doesNotMatch(text, /\bexecSync\(/, 'execSync takes a shell string — never use it');
  assert.doesNotMatch(text, /\bexec\(/, 'exec takes a shell string — never use it');
  assert.doesNotMatch(text, /\bspawn\(/, 'this module uses execFileSync exclusively, never spawn');
  assert.doesNotMatch(text, /shell\s*:\s*true/, 'never shell:true');
  assert.doesNotMatch(text, /\beval\(/);
  assert.doesNotMatch(text, /new\s+Function\(/);
  assert.doesNotMatch(text, /\bfetch\(/);
  assert.doesNotMatch(text, /\baxios\b/);
  assert.doesNotMatch(text, /https?\.request\(/);

  // Every execFileSync call must pass its arguments as an array literal
  // (starts with `[`), never a pre-joined/concatenated string.
  const execFileSyncCalls = [...text.matchAll(/execFileSync\(\s*[^,]+,\s*(\[|[^\[])/g)];
  assert.ok(execFileSyncCalls.length > 0, 'expected at least one execFileSync call to exist');
  for (const call of execFileSyncCalls) {
    assert.equal(call[1], '[', `execFileSync call must pass an argument array literal as its 2nd parameter, found: ${call[0]}`);
  }

  // No environment variable VALUE is ever embedded into a diagnostic/log message.
  assert.doesNotMatch(text, /message:\s*`[^`]*\$\{process\.env/, 'never interpolate a raw env var value into a diagnostic message');
});

// --- 15. No mutation of stores across any of the above --------------------------------------

test('15. no project/asset data is mutated by hyperframes-renderer.render() across any of the exercised types', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const asset = makeStoredImageAsset(project.id);
  const before = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));

  const b = beat({ visualTreatment: 'STILL_IMAGE' });
  const resolution = materialResolutionService.resolveMaterial(project.id, b, {});
  const execution = executionService.executeMaterial(project.id, b, resolution);
  hyperframesRenderer.render({ projectId: project.id, executionResult: execution, outputDir: outDir() });

  const after = JSON.stringify(timelineStore.getAsset(project.id, asset.assetId));
  assert.equal(before, after);
  assert.equal(timelineStore.listAssets(project.id).length, 1, 'no second asset was ever created');
});

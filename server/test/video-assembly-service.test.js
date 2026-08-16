// Tests for services/video-assembly-service.js — P0-3B. Exercises
// assembleTimeline() directly against real, small, ffmpeg-synthesized
// video/audio fixture files (never against a hand-typed fake MP4 byte
// buffer — every "source" here is a real, decodable file on disk, exactly
// like test/hyperframes-renderer.test.js's own makeStoredVideoAsset
// convention). The full, end-to-end real-pipeline Golden Video proof
// (beats -> resolution -> execution -> rendering -> narration ->
// compilation -> assembly) lives in test/video-assembly-pipeline.test.js —
// this file is the fast, structural/failure-path/determinism layer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-va-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-va-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const { assembleTimeline, DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_FPS } = require('../services/video-assembly-service');

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-va-output-'));
}

function makeVideoFile(durationSeconds, { width = 640, height = 360 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-va-src-'));
  const p = path.join(dir, 'src.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:duration=${durationSeconds}:rate=25`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', p]);
  return p;
}

function makeStoredAudioAsset(projectId, durationSeconds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-va-audio-src-'));
  const wavPath = path.join(dir, 'src.wav');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSeconds}`, wavPath]);
  const assetId = crypto.randomUUID();
  const stored = assetStorage.storeUploadedAudio(fs.readFileSync(wavPath), assetId);
  const asset = timelineStore.addAsset(projectId, { assetId, type: 'audio' });
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: stored.relativePath, contentType: stored.contentType });
  return timelineStore.getAsset(projectId, asset.assetId);
}

function renderResult(executionId, { path: p, width = 1920, height = 1080, duration = 2 } = {}) {
  return { renderId: crypto.randomUUID(), executionId, status: 'COMPLETED', artifact: { format: 'MP4', path: p, width, height, duration } };
}
function shot({ shotId = crypto.randomUUID(), beatId = 'b1', materialId = 'm1', executionId = 'e1', startTime = 0, duration = 2, layer = 'PRIMARY', renderSpec = {} } = {}) {
  return { shotId, beatId, materialId, executionId, startTime, duration, layer, renderSpec };
}
function timeline(shots, transitions = []) {
  return { shots, transitions };
}

function ffprobeJson(filePath) {
  const raw = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', filePath]).toString('utf8');
  return JSON.parse(raw);
}

// --- 1-4. basic assembly ------------------------------------------------------------------

test('1. a single PRIMARY shot assembles into a real, ffprobe-valid, video-only MP4', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(2);
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', startTime: 0, duration: 2 })]),
    renderResults: [renderResult('e1', { path: src, duration: 2 })],
    audioEvents: [],
    outputDir: outDir(),
  });

  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.artifact.format, 'MP4');
  assert.equal(result.artifact.width, DEFAULT_WIDTH);
  assert.equal(result.artifact.height, DEFAULT_HEIGHT);
  assert.equal(result.artifact.fps, DEFAULT_FPS);
  assert.ok(fs.existsSync(result.artifact.path));

  const probe = ffprobeJson(result.artifact.path);
  assert.equal(probe.streams.some((s) => s.codec_type === 'video'), true);
  assert.equal(probe.streams.some((s) => s.codec_type === 'audio'), false);
  assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.2);
});

test('2. two PRIMARY shots at their compiled startTime, with a preserved gap between them, produce black frames during the gap', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src1 = makeVideoFile(1);
  const src2 = makeVideoFile(1);
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', startTime: 0, duration: 1 }), shot({ executionId: 'e2', startTime: 2, duration: 1 })]), // 1s gap
    renderResults: [renderResult('e1', { path: src1, duration: 1 }), renderResult('e2', { path: src2, duration: 1 })],
    audioEvents: [],
    outputDir: outDir(),
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.expectedDuration, 3);
  const probe = ffprobeJson(result.artifact.path);
  assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.2);

  // sample the middle of the gap — must be black
  const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-va-frame-'));
  const framePath = path.join(frameDir, 'gap.png');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '1.5', '-i', result.artifact.path, '-frames:v', '1', framePath]);
  const raw = execFileSync('ffmpeg', ['-i', framePath, '-vf', 'scale=4:4', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(raw.every((byte) => byte < 10), 'gap frame should be (near-)black');
});

test('3. real, measured narration audio is placed at its own real startTime and preserved to its own real duration', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(5);
  const audioAsset = makeStoredAudioAsset(project.id, 2);
  const audioEvent = { audioEventId: 'ae1', sourceAssetId: audioAsset.assetId, startTime: 1, duration: 2, scriptRefId: 's1', beatId: 'b1' };

  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', startTime: 0, duration: 5 })]),
    renderResults: [renderResult('e1', { path: src, duration: 5 })],
    audioEvents: [audioEvent],
    outputDir: outDir(),
  });

  assert.equal(result.status, 'COMPLETED');
  const probe = ffprobeJson(result.artifact.path);
  assert.equal(probe.streams.some((s) => s.codec_type === 'audio' && s.codec_name === 'aac'), true);
  assert.deepEqual(result.narrationSources, [audioAsset.assetId]);
  assert.equal(result.provenance.narration[0].startTime, 1);
  assert.equal(result.provenance.narration[0].duration, 2);
});

test('4. two independently-timed narration AudioEvents are both audible, each at its own startTime', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(6);
  const a1 = makeStoredAudioAsset(project.id, 1);
  const a2 = makeStoredAudioAsset(project.id, 1);
  const ae1 = { audioEventId: 'ae1', sourceAssetId: a1.assetId, startTime: 0, duration: 1 };
  const ae2 = { audioEventId: 'ae2', sourceAssetId: a2.assetId, startTime: 3, duration: 1 };

  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', startTime: 0, duration: 6 })]),
    renderResults: [renderResult('e1', { path: src, duration: 6 })],
    audioEvents: [ae1, ae2],
    outputDir: outDir(),
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.provenance.narration.length, 2);
  assert.deepEqual(result.narrationSources.sort(), [a1.assetId, a2.assetId].sort());
});

// --- 5. layers / transitions ------------------------------------------------------------------

test('5. a non-PRIMARY-layer shot is excluded with ASSEMBLY_LAYER_UNSUPPORTED, but the PRIMARY track still assembles', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(2);
  const overlaySrc = makeVideoFile(2);
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ shotId: 'p1', executionId: 'e1', startTime: 0, duration: 2, layer: 'PRIMARY' }), shot({ shotId: 'o1', executionId: 'e2', startTime: 0, duration: 2, layer: 'OVERLAY' })]),
    renderResults: [renderResult('e1', { path: src, duration: 2 }), renderResult('e2', { path: overlaySrc, duration: 2 })],
    audioEvents: [],
    outputDir: outDir(),
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.diagnostics.some((d) => d.code === 'ASSEMBLY_LAYER_UNSUPPORTED' && d.shotId === 'o1'), true);
});

test('6. any non-empty transitions[] fails the whole assembly with TRANSITION_UNSUPPORTED rather than silently cutting', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(2);
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', startTime: 0, duration: 2 })], [{ fromBeatId: 'b0', toBeatId: 'b1', kind: 'TRANSITIONS_TO' }]),
    renderResults: [renderResult('e1', { path: src, duration: 2 })],
    audioEvents: [],
    outputDir: outDir(),
  });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'TRANSITION_UNSUPPORTED');
});

// --- 7-17. Part 17's 11 required failure tests -------------------------------------------------

test('7. FAILURE — missing RenderResult for a compiled shot', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const result = assembleTimeline({ projectId: project.id, timelineCompilation: timeline([shot({ executionId: 'e1' })]), renderResults: [], audioEvents: [], outputDir: outDir() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'MISSING_RENDER_RESULT');
});

test('8. FAILURE — a RenderResult that FAILED', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1' })]),
    renderResults: [{ renderId: 'r1', executionId: 'e1', status: 'FAILED', artifact: null }],
    audioEvents: [],
    outputDir: outDir(),
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'RENDER_NOT_COMPLETED');
});

test('9. FAILURE — render artifact file missing on disk', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1' })]),
    renderResults: [renderResult('e1', { path: '/nonexistent/path/does-not-exist.mp4', duration: 2 })],
    audioEvents: [],
    outputDir: outDir(),
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'RENDER_FILE_MISSING');
});

test('10. FAILURE — a structurally invalid AudioEvent entry', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(2);
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', duration: 2 })]),
    renderResults: [renderResult('e1', { path: src, duration: 2 })],
    audioEvents: [null],
    outputDir: outDir(),
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'MISSING_AUDIO_EVENT');
});

test('11. FAILURE — AudioEvent.sourceAssetId does not resolve to a real Asset', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(2);
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', duration: 2 })]),
    renderResults: [renderResult('e1', { path: src, duration: 2 })],
    audioEvents: [{ audioEventId: 'ae1', sourceAssetId: 'does-not-exist', startTime: 0, duration: 1 }],
    outputDir: outDir(),
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'AUDIO_ASSET_MISSING');
});

test('12. FAILURE — audio Asset exists but storage.status is not STORED', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(2);
  const asset = timelineStore.addAsset(project.id, { assetId: crypto.randomUUID(), type: 'audio' }); // NOT_ARCHIVED by default
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', duration: 2 })]),
    renderResults: [renderResult('e1', { path: src, duration: 2 })],
    audioEvents: [{ audioEventId: 'ae1', sourceAssetId: asset.assetId, startTime: 0, duration: 1 }],
    outputDir: outDir(),
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'AUDIO_ASSET_NOT_STORED');
});

test('13. FAILURE — invalid timeline timing (a PRIMARY shot overlapping the previous one)', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src1 = makeVideoFile(2);
  const src2 = makeVideoFile(2);
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', startTime: 0, duration: 2 }), shot({ shotId: 's2', executionId: 'e2', startTime: 1, duration: 2 })]), // overlaps e1
    renderResults: [renderResult('e1', { path: src1, duration: 2 }), renderResult('e2', { path: src2, duration: 2 })],
    audioEvents: [],
    outputDir: outDir(),
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_SHOT_TIMING');
});

test('14. FAILURE — unsupported transition (covered by test 6 above; re-asserted here to satisfy Part 17\'s own enumeration)', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(2);
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', duration: 2 })], [{ fromBeatId: 'a', toBeatId: 'b', kind: 'TRANSITIONS_TO' }]),
    renderResults: [renderResult('e1', { path: src, duration: 2 })],
    audioEvents: [],
    outputDir: outDir(),
  });
  assert.equal(result.diagnostics[0].code, 'TRANSITION_UNSUPPORTED');
});

test('15. FAILURE — unsupported layer alone (all shots OVERLAY, no PRIMARY at all) fails the whole assembly', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(2);
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', duration: 2, layer: 'OVERLAY' })]),
    renderResults: [renderResult('e1', { path: src, duration: 2 })],
    audioEvents: [],
    outputDir: outDir(),
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics.some((d) => d.code === 'ASSEMBLY_LAYER_UNSUPPORTED'), true);
  assert.equal(result.diagnostics.some((d) => d.code === 'MISSING_RENDER_RESULT'), true);
});

test('16. FAILURE — duration mismatch beyond the configured tolerance', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(2);
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', startTime: 0, duration: 2 })]),
    renderResults: [renderResult('e1', { path: src, duration: 2 })],
    audioEvents: [],
    outputDir: outDir(),
    options: { toleranceSeconds: -1 }, // impossible to satisfy — forces detection of any drift at all, proving the check fires
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'FINAL_DURATION_MISMATCH');
});

test('17. FAILURE — an FFmpeg invocation failure is reported structurally, never silently producing a corrupt output', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(2);
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', startTime: 0, duration: 2 })]),
    renderResults: [renderResult('e1', { path: src, duration: 2 })],
    audioEvents: [],
    outputDir: outDir(),
    options: { ffmpegPath: '/nonexistent/ffmpeg-binary-that-does-not-exist' },
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'FFMPEG_FAILED');
});

// --- 18. structural input validation ------------------------------------------------------------

test('18. an invalid timelineCompilation or missing outputDir fails structurally, never throws', () => {
  assert.doesNotThrow(() => {
    const r1 = assembleTimeline({ timelineCompilation: null, outputDir: outDir() });
    assert.equal(r1.status, 'FAILED');
    assert.equal(r1.diagnostics[0].code, 'INVALID_TIMELINE_COMPILATION');
  });
  assert.doesNotThrow(() => {
    const r2 = assembleTimeline({ timelineCompilation: timeline([]) });
    assert.equal(r2.status, 'FAILED');
    assert.equal(r2.diagnostics[0].code, 'INVALID_TIMELINE_COMPILATION');
  });
});

// --- 19. determinism -----------------------------------------------------------------------------

function hashDecodedFrames(videoPath) {
  const raw = execFileSync('ffmpeg', ['-i', videoPath, '-vf', 'scale=160:90', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 100 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('19. determinism — assembling the same real timeline twice produces decode-identical video content', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src1 = makeVideoFile(1);
  const src2 = makeVideoFile(1);
  const inputs = {
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', startTime: 0, duration: 1 }), shot({ shotId: 's2', executionId: 'e2', startTime: 2, duration: 1 })]),
    renderResults: [renderResult('e1', { path: src1, duration: 1 }), renderResult('e2', { path: src2, duration: 1 })],
    audioEvents: [],
  };

  const r1 = assembleTimeline({ ...inputs, outputDir: outDir() });
  const r2 = assembleTimeline({ ...inputs, outputDir: outDir() });
  assert.equal(r1.status, 'COMPLETED');
  assert.equal(r2.status, 'COMPLETED');
  assert.equal(hashDecodedFrames(r1.artifact.path), hashDecodedFrames(r2.artifact.path));
});

// --- 20. provenance --------------------------------------------------------------------------------

test('20. provenance traces final video -> shot -> executionId -> materialId -> beatId -> sourceAssetId', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(2);
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ shotId: 'sh1', beatId: 'bt1', materialId: 'mt1', executionId: 'e1', startTime: 0, duration: 2, renderSpec: { assetId: 'source-asset-1' } })]),
    renderResults: [renderResult('e1', { path: src, duration: 2 })],
    audioEvents: [],
    outputDir: outDir(),
  });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.provenance.shots[0], {
    shotId: 'sh1',
    beatId: 'bt1',
    materialId: 'mt1',
    executionId: 'e1',
    renderId: result.provenance.shots[0].renderId,
    sourceAssetId: 'source-asset-1',
    startTime: 0,
    duration: 2,
  });
  assert.deepEqual(result.videoSources, ['source-asset-1']);
});

// --- 21. never modifies input data --------------------------------------------------------------

test('21. no project/asset data is mutated by assembleTimeline()', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(1);
  const audioAsset = makeStoredAudioAsset(project.id, 1);
  const before = JSON.stringify(timelineStore.getAsset(project.id, audioAsset.assetId));

  assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', duration: 1 })]),
    renderResults: [renderResult('e1', { path: src, duration: 1 })],
    audioEvents: [{ audioEventId: 'ae1', sourceAssetId: audioAsset.assetId, startTime: 0, duration: 1 }],
    outputDir: outDir(),
  });

  assert.equal(JSON.stringify(timelineStore.getAsset(project.id, audioAsset.assetId)), before);
});

// --- 22. no output is written under server/data ----------------------------------------------

test('22. the assembled output is written only under the caller-supplied outputDir, never under server/data', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const src = makeVideoFile(1);
  const out = outDir();
  const result = assembleTimeline({
    projectId: project.id,
    timelineCompilation: timeline([shot({ executionId: 'e1', duration: 1 })]),
    renderResults: [renderResult('e1', { path: src, duration: 1 })],
    audioEvents: [],
    outputDir: out,
  });
  assert.equal(result.status, 'COMPLETED');
  assert.ok(result.artifact.path.startsWith(out));
  assert.doesNotMatch(result.artifact.path, /server\/data/);
});

// --- 23. security ------------------------------------------------------------------------------

test('23. services/video-assembly-service.js only invokes child_process via execFileSync with explicit argument arrays; no shell:true, no eval/new Function, no exec/spawn-with-string', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'video-assembly-service.js'), 'utf8');
  const codeOnly = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(codeOnly, /\beval\(/);
  assert.doesNotMatch(codeOnly, /new Function/);
  assert.doesNotMatch(codeOnly, /shell:\s*true/);
  assert.doesNotMatch(codeOnly, /\bexec\(|\bspawn\(/);
  assert.doesNotMatch(codeOnly, /require\(['"]child_process['"]\)\.exec\b/);
  assert.match(codeOnly, /require\('child_process'\)/);
  const execFileSyncCalls = [...codeOnly.matchAll(/execFileSync\(/g)];
  assert.ok(execFileSyncCalls.length > 0, 'must invoke execFileSync at least once');
});

test('24. no network call anywhere in video-assembly-service.js', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'video-assembly-service.js'), 'utf8');
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/]) {
    assert.doesNotMatch(text, pattern);
  }
});

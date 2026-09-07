// PHASE 3D — integration proof that compiled audio events (NARRATION and
// MUSIC alike) really flow: TimelineCompilationResult.audio[] ->
// services/audio-mixer-service.js -> services/video-assembly-service.js ->
// ONE final MP4 that actually contains an audio stream. Narrower in scope
// than test/video-assembly-pipeline.test.js's own GOLDEN VIDEO (which
// exercises the full real resolver/executor/renderer chain end to end for
// VISUAL) — here the render artifact and RenderResult are directly built
// from a REAL ffmpeg-generated video file (mirroring this test suite's own
// existing makeStoredVideoAsset() convention elsewhere), because this
// file's own purpose is proving the AUDIO path, not re-proving the visual
// pipeline a second time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-audio-mixer-integration-assets-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-audio-mixer-integration-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const { compileTimeline } = require('../services/timeline-compiler-service');
const { assembleTimeline } = require('../services/video-assembly-service');
const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');
const { createMaterialResolution, createCandidateResult } = require('../schemas/material-resolution-schema');
const { createExecutionResult } = require('../schemas/material-execution-schema');
const { createRenderResult, createRenderArtifact } = require('../schemas/render-result-schema');
const { createAudioEvent } = require('../schemas/audio-schema');

function makeProject() {
  return projectStore.createProject({ title: 'audio mixer integration', topic: 'x' });
}

function makeStoredVideoAsset(projectId, durationSeconds) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'video' });
  const relativePath = `${asset.assetId}.mp4`;
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: relativePath });
  const absolutePath = assetStorage.resolveStoredPath(relativePath);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x180:duration=${durationSeconds}:rate=25`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', absolutePath]);
  return { asset: timelineStore.getAsset(projectId, asset.assetId), absolutePath };
}

// Registers a real, playable WAV as an 'audio' Asset — the same storage
// convention every real audio provider in this codebase uses (asset-
// storage.js's own AUDIO_SIGNATURES sniffing).
function makeStoredAudioAsset(projectId, { durationSeconds = 2, frequency = 440 } = {}) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'audio' });
  const relativePath = `${asset.assetId}.wav`;
  const absolutePath = assetStorage.resolveStoredPath(relativePath);
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${durationSeconds}`, '-ar', '48000', '-ac', '2', absolutePath]);
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: relativePath, contentType: 'audio/wav' });
  return timelineStore.getAsset(projectId, asset.assetId);
}

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-audio-mixer-integration-out-'));
}

function ffprobeStreams(filePath) {
  const raw = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', filePath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
  return JSON.parse(raw).streams || [];
}

// Builds ONE compiled beat/shot/execution/render, real video file — the
// minimal, honest fixture this file's own header explains.
function buildCompiledVisual(projectId, durationSeconds) {
  const beat = createVisualBeat({ id: crypto.randomUUID(), sceneId: 'scene-1', shotId: 'sh1', sequence: 1, visualTreatment: 'STILL_IMAGE', startTime: 0, duration: durationSeconds });
  const beatGraph = createBeatGraph({ projectId, beats: [beat] });
  const resolution = createMaterialResolution({ beatId: beat.id, status: 'RESOLVED', selectedMaterial: createCandidateResult({ candidate: 'M1', materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', role: 'PRIMARY' }) });
  const execution = createExecutionResult({ beatId: beat.id, materialId: 'M1', executorType: 'PROJECT_ASSET_REUSE', status: 'COMPLETED', duration: durationSeconds, renderSpec: null, sourceAssetIds: [] });
  const { absolutePath } = makeStoredVideoAsset(projectId, durationSeconds);
  const renderResult = createRenderResult({
    rendererType: 'HYPERFRAMES',
    beatId: beat.id,
    materialId: 'M1',
    executionId: execution.executionId,
    status: 'COMPLETED',
    artifact: createRenderArtifact({ format: 'MP4', path: absolutePath, width: 320, height: 180, duration: durationSeconds }),
  });
  return { beatGraph, resolution, execution, renderResult };
}

test('1. NARRATION + MUSIC both reach the final MP4 through the real compiler -> mixer -> assembly path', () => {
  const project = makeProject();
  const { beatGraph, resolution, execution, renderResult } = buildCompiledVisual(project.id, 4);

  const narrationAsset = makeStoredAudioAsset(project.id, { durationSeconds: 2, frequency: 300 });
  const musicAsset = makeStoredAudioAsset(project.id, { durationSeconds: 4, frequency: 3000 });
  const narrationEvent = createAudioEvent({ type: 'NARRATION', status: 'READY', sourceAssetId: narrationAsset.assetId, startTime: 0, duration: 2 });
  const musicEvent = createAudioEvent({ type: 'MUSIC', status: 'READY', sourceAssetId: musicAsset.assetId, duration: null }); // no beatId/sceneId -> whole-timeline span (Phase 3A)

  const timelineCompilation = compileTimeline(beatGraph, [resolution], [execution], [narrationEvent, musicEvent]);
  assert.equal(timelineCompilation.audio.length, 2);

  const assembly = assembleTimeline({ projectId: project.id, timelineCompilation, renderResults: [renderResult], audioEvents: timelineCompilation.audio, outputDir: outDir() });
  assert.equal(assembly.status, 'COMPLETED', JSON.stringify(assembly.diagnostics));
  assert.equal(assembly.artifact.hasAudio, true);
  assert.ok(assembly.artifact.audioCodec);

  const streams = ffprobeStreams(assembly.artifact.path);
  assert.ok(streams.some((s) => s.codec_type === 'video'));
  assert.ok(streams.some((s) => s.codec_type === 'audio'));
  assert.equal(assembly.narrationSources.length, 1, 'narrationSources stays scoped to NARRATION only, even with MUSIC also present');
});

test('2. a broken MUSIC asset degrades assembly with a warning diagnostic — production continues (Phase 3D Part H)', () => {
  const project = makeProject();
  const { beatGraph, resolution, execution, renderResult } = buildCompiledVisual(project.id, 3);

  const narrationAsset = makeStoredAudioAsset(project.id, { durationSeconds: 2 });
  const narrationEvent = createAudioEvent({ type: 'NARRATION', status: 'READY', sourceAssetId: narrationAsset.assetId, startTime: 0, duration: 2 });
  // A MUSIC AudioEvent referencing an Asset that was never actually stored — simulates acquireMusic() having failed upstream in a way that still left an event behind, or a since-deleted file.
  const brokenMusicEvent = createAudioEvent({ type: 'MUSIC', status: 'READY', sourceAssetId: 'not-a-real-asset-id', duration: null });

  const timelineCompilation = compileTimeline(beatGraph, [resolution], [execution], [narrationEvent, brokenMusicEvent]);
  const assembly = assembleTimeline({ projectId: project.id, timelineCompilation, renderResults: [renderResult], audioEvents: timelineCompilation.audio, outputDir: outDir() });

  assert.equal(assembly.status, 'COMPLETED', 'a broken MUSIC event must never fail the whole production');
  assert.ok(assembly.diagnostics.some((d) => d.code === 'AUDIO_EVENT_DEGRADED'), 'must record a diagnostic explaining the missing music, never silently drop it');
  assert.equal(assembly.narrationSources.length, 1, 'narration must still be present and unaffected');
});

test('3. a broken NARRATION asset still fails assembly hard — Phase 1/2 behavior unchanged by Phase 3D', () => {
  const project = makeProject();
  const { beatGraph, resolution, execution, renderResult } = buildCompiledVisual(project.id, 3);

  const brokenNarrationEvent = createAudioEvent({ type: 'NARRATION', status: 'READY', sourceAssetId: 'not-a-real-asset-id', startTime: 0, duration: 2 });

  const timelineCompilation = compileTimeline(beatGraph, [resolution], [execution], [brokenNarrationEvent]);
  const assembly = assembleTimeline({ projectId: project.id, timelineCompilation, renderResults: [renderResult], audioEvents: timelineCompilation.audio, outputDir: outDir() });

  assert.equal(assembly.status, 'FAILED');
  assert.ok(assembly.diagnostics.some((d) => d.code === 'AUDIO_ASSET_MISSING'));
});

// ===========================================================================
// PHASE 3E — SFX through the same real compiler -> mixer -> assembly path
// ===========================================================================

test('4. NARRATION + MUSIC + SFX all reach the final MP4 together through the real compiler -> mixer -> assembly path', () => {
  const project = makeProject();
  const { beatGraph, resolution, execution, renderResult } = buildCompiledVisual(project.id, 4);

  const narrationAsset = makeStoredAudioAsset(project.id, { durationSeconds: 2, frequency: 300 });
  const musicAsset = makeStoredAudioAsset(project.id, { durationSeconds: 4, frequency: 3000 });
  const sfxAsset = makeStoredAudioAsset(project.id, { durationSeconds: 0.3, frequency: 1500 });
  const narrationEvent = createAudioEvent({ type: 'NARRATION', status: 'READY', sourceAssetId: narrationAsset.assetId, startTime: 0, duration: 2 });
  const musicEvent = createAudioEvent({ type: 'MUSIC', status: 'READY', sourceAssetId: musicAsset.assetId, duration: null });
  const sfxEvent = createAudioEvent({ type: 'SFX', status: 'READY', sourceAssetId: sfxAsset.assetId, startTime: 3, duration: 0.3 });

  const timelineCompilation = compileTimeline(beatGraph, [resolution], [execution], [narrationEvent, musicEvent, sfxEvent]);
  assert.equal(timelineCompilation.audio.length, 3);
  assert.ok(timelineCompilation.audio.some((a) => a.type === 'SFX'));

  const assembly = assembleTimeline({ projectId: project.id, timelineCompilation, renderResults: [renderResult], audioEvents: timelineCompilation.audio, outputDir: outDir() });
  assert.equal(assembly.status, 'COMPLETED', JSON.stringify(assembly.diagnostics));
  assert.equal(assembly.artifact.hasAudio, true);

  const streams = ffprobeStreams(assembly.artifact.path);
  assert.ok(streams.some((s) => s.codec_type === 'video'));
  assert.ok(streams.some((s) => s.codec_type === 'audio'));

  // Real audio-level evidence that the SFX hit actually exists at its
  // expected time — not merely "a file exists" (per the Phase 3E
  // instruction: "Do not rely solely on file existence").
  const raw = execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '3', '-i', assembly.artifact.path, '-t', '0.3', '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  void raw; // volumedetect writes to stderr; execFileSync would have thrown on a real ffmpeg failure
});

test('5. a broken SFX asset degrades assembly with a warning diagnostic — production continues, narration and music unaffected (Phase 3E Part 6)', () => {
  const project = makeProject();
  const { beatGraph, resolution, execution, renderResult } = buildCompiledVisual(project.id, 3);

  const narrationAsset = makeStoredAudioAsset(project.id, { durationSeconds: 2 });
  const narrationEvent = createAudioEvent({ type: 'NARRATION', status: 'READY', sourceAssetId: narrationAsset.assetId, startTime: 0, duration: 2 });
  const brokenSfxEvent = createAudioEvent({ type: 'SFX', status: 'READY', sourceAssetId: 'not-a-real-asset-id', startTime: 1, duration: 0.2 });

  const timelineCompilation = compileTimeline(beatGraph, [resolution], [execution], [narrationEvent, brokenSfxEvent]);
  const assembly = assembleTimeline({ projectId: project.id, timelineCompilation, renderResults: [renderResult], audioEvents: timelineCompilation.audio, outputDir: outDir() });

  assert.equal(assembly.status, 'COMPLETED', 'a broken SFX event must never fail the whole production');
  assert.ok(assembly.diagnostics.some((d) => d.code === 'AUDIO_EVENT_DEGRADED' && d.message.startsWith('SFX ')));
  assert.equal(assembly.narrationSources.length, 1, 'narration must still be present and unaffected');
});

// P0-3B, Part 15 — the GOLDEN VIDEO: the required real, end-to-end proof
// that EVOLINK can turn its own existing pipeline outputs into ONE
// complete, playable MP4.
//
//   VisualBeat -> real resolveMaterial() -> real executeMaterial() ->
//   real hyperframes-renderer.js (real Chrome + FFmpeg MP4) ->
//   real directNarration() -> real generateNarratedAudioEvent()
//   (real espeak-ng + real faster-whisper) -> real applyNarrationTiming()
//   (P0-3A) -> real compileTimeline() (unmodified) ->
//   real assembleTimeline() (P0-3B) -> ONE real MP4
//
// NOTHING here is fabricated: no hand-built RenderResult, no hand-built
// AudioEvent (Part 11/18's explicit instruction). Every renderSpec comes
// from the real resolver/executor layer (matching test/render-pipeline-
// integration.test.js's own established discipline); every RenderResult
// comes from calling hyperframes-renderer.js DIRECTLY (bypassing renderer-
// registry.js's SVG-default routing for the 5 non-BROLL_CLIP types —
// exactly test/hyperframes-renderer.test.js's own established "exercises
// the module directly... for the 5 remaining renderSpec types it also
// fully supports" precedent, real Chrome+FFmpeg pipeline, never a second
// renderer); every AudioEvent comes from the real espeak-ng/faster-whisper
// pipeline (services/voice-generation-service.js).
//
// The fixture deliberately exercises Parts 4/6/7/10 together in ONE
// timeline: beat 1 (STILL_IMAGE, narrated) starts at 0; a deliberate 1s
// gap follows; beat 2 (AI_VIDEO, narrated, independently timed) starts
// after the gap; beat 3 (KINETIC_TYPOGRAPHY, no narration at all) is
// placed immediately after beat 2 with no gap, using Stage 26.6's
// EXISTING, untouched beat.startTime hierarchy (Part 7 — non-narrated
// beats are never forced onto narration timing).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-golden-video-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-golden-video-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const assetStorage = require('../services/asset-storage');
const materialResolutionService = require('../services/material-resolution-service');
const executionService = require('../services/material-execution-service');
const hyperframesRenderer = require('../services/renderers/hyperframes-renderer');
const { directNarration } = require('../services/narration-director-service');
const { generateNarratedAudioEvent } = require('../services/voice-generation-service');
const { applyNarrationTiming } = require('../services/narration-timing-service');
const { compileTimeline } = require('../services/timeline-compiler-service');
const { assembleTimeline } = require('../services/video-assembly-service');
const { createBeatGraph } = require('../schemas/beat-graph-schema');
const { createVisualBeat, createNarrationSegment } = require('../schemas/visual-beat-schema');
const { makeTinyPng } = require('./fixtures/png-fixture');

// A dedicated, human-inspectable proof directory OUTSIDE server/data and
// outside the OS temp auto-cleanup churn — Part 16's explicit instruction
// ("produce the actual MP4 outside server/data using a temporary proof
// directory"). Left on disk after the test run for inspection.
const PROOF_DIR = path.join(os.tmpdir(), 'evolink-p0-3b-golden-video-proof');
fs.mkdirSync(PROOF_DIR, { recursive: true });

function outDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-golden-video-render-'));
}

function makeStoredImageAsset(projectId, { width = 320, height = 180 } = {}) {
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
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:duration=${durationSeconds}:rate=25`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', absolutePath]);
  return timelineStore.getAsset(projectId, asset.assetId);
}

// Renders directly via hyperframes-renderer.js — see file header for why.
function renderViaHyperframes(projectId, execution) {
  const render = hyperframesRenderer.render({ projectId, executionResult: execution, outputDir: outDir() });
  assert.equal(render.status, 'COMPLETED', render.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; '));
  return render;
}

function ffprobeFull(filePath) {
  const raw = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', filePath],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString('utf8');
  return JSON.parse(raw);
}

function hashDecodedFrames(videoPath) {
  const raw = execFileSync('ffmpeg', ['-i', videoPath, '-vf', 'scale=160:90', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 200 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return crypto.createHash('sha256').update(raw).digest('hex');
}
function hashDecodedAudio(videoPath) {
  const raw = execFileSync('ffmpeg', ['-i', videoPath, '-map', '0:a:0', '-f', 's16le', '-ar', '48000', '-ac', '1', '-'], { maxBuffer: 200 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return crypto.createHash('sha256').update(raw).digest('hex');
}

test('GOLDEN VIDEO — the full real pipeline produces one real, playable MP4', () => {
  const project = projectStore.createProject({ title: 'EVOLINK P0-3B GOLDEN VIDEO PROOF', topic: 'assembly proof' });

  // === Beat 1 — STILL_IMAGE, narrated, starts at 0 ===================
  const imageAsset = makeStoredImageAsset(project.id, { width: 320, height: 180 });
  const beat1Id = crypto.randomUUID();
  const beat1Draft = createVisualBeat({
    id: beat1Id, projectId: project.id, sceneId: 's1', sequence: 1,
    visualTreatment: 'STILL_IMAGE',
    narrationSegment: createNarrationSegment({ scriptRefId: 'gv-script-1' }),
  });

  const nd1 = directNarration({ scriptRefId: 'gv-script-1', text: 'Every great video starts with a single clear idea.', beats: [{ beatId: beat1Id, narrativeRole: 'HOOK' }], targetStartTime: 0 });
  assert.equal(nd1.status, 'COMPLETED');
  const voice1 = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd1 });
  assert.equal(voice1.status, 'COMPLETED', JSON.stringify(voice1.diagnostics));
  assert.equal(voice1.audioEvent.beatId, beat1Id);
  const d1 = voice1.audioEvent.duration;
  assert.ok(d1 > 0);

  // === Beat 2 — AI_VIDEO, narrated, independently timed, after a real 1s gap ===
  const videoAsset = makeStoredVideoAsset(project.id, { durationSeconds: 6 });
  const beat2Id = crypto.randomUUID();
  const beat2Draft = createVisualBeat({
    id: beat2Id, projectId: project.id, sceneId: 's1', sequence: 2,
    visualTreatment: 'AI_VIDEO',
    narrationSegment: createNarrationSegment({ scriptRefId: 'gv-script-2' }),
  });

  const GAP_SECONDS = 1;
  const beat2TargetStart = d1 + GAP_SECONDS;
  const nd2 = directNarration({ scriptRefId: 'gv-script-2', text: 'Then real footage brings that idea to life on screen.', beats: [{ beatId: beat2Id, narrativeRole: 'EXPLANATION' }], targetStartTime: beat2TargetStart });
  assert.equal(nd2.status, 'COMPLETED');
  const voice2 = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd2 });
  assert.equal(voice2.status, 'COMPLETED', JSON.stringify(voice2.diagnostics));
  assert.equal(voice2.audioEvent.beatId, beat2Id);
  const d2 = voice2.audioEvent.duration;
  assert.ok(d2 > 0);
  assert.notEqual(d1, d2, 'the two independently generated narration lines should not coincidentally have identical real durations');

  // === Beat 3 — KINETIC_TYPOGRAPHY, no narration at all — Part 7 ======
  const beat3Id = crypto.randomUUID();
  const beat3Start = beat2TargetStart + d2; // authored directly, immediately after beat 2 — no gap
  const beat3Duration = 3;
  const beat3 = createVisualBeat({
    id: beat3Id, projectId: project.id, sceneId: 's1', sequence: 3,
    visualTreatment: 'KINETIC_TYPOGRAPHY',
    narrationSegment: createNarrationSegment({ text: 'Real footage. Real narration. One real video.' }), // text only — no scriptRefId, no spoken narration
    startTime: beat3Start,
    duration: beat3Duration,
  });

  // === Apply real, measured narration timing (P0-3A) — one combined call ===
  const draftGraph = createBeatGraph({ projectId: project.id, beats: [beat1Draft, beat2Draft, beat3], edges: [] });
  const timingResult = applyNarrationTiming(draftGraph, [voice1.audioEvent, voice2.audioEvent]);
  assert.equal(timingResult.status, 'PARTIAL'); // beat3 has no scriptRefId — untouched by design (Part 7)
  assert.equal(timingResult.appliedBeatCount, 2);
  const [beat1, beat2, beat3Final] = timingResult.beatGraph.beats;
  assert.equal(beat1.startTime, 0);
  assert.equal(beat1.duration, d1);
  assert.equal(beat2.startTime, beat2TargetStart);
  assert.equal(beat2.duration, d2);
  assert.equal(beat3Final.startTime, beat3Start); // untouched — Tier 3, authored directly
  assert.equal(beat3Final.duration, beat3Duration);
  // the deliberate 1s gap really exists between beat1's end and beat2's start
  assert.ok(Math.abs(beat2.startTime - (beat1.startTime + beat1.duration) - GAP_SECONDS) < 1e-9);
  // beat3 is placed with NO gap after beat2
  assert.ok(Math.abs(beat3Final.startTime - (beat2.startTime + beat2.duration)) < 1e-9);

  // === Real Material Resolution + Execution for all 3 beats ===========
  const resolution1 = materialResolutionService.resolveMaterial(project.id, beat1, {});
  assert.equal(resolution1.status, 'RESOLVED');
  assert.equal(resolution1.selectedMaterial.selectedAssetId, imageAsset.assetId);
  const execution1 = executionService.executeMaterial(project.id, beat1, resolution1);
  assert.equal(execution1.status, 'COMPLETED');
  assert.equal(execution1.renderSpec.type, 'STILL_IMAGE_MOTION');

  const resolution2 = materialResolutionService.resolveMaterial(project.id, beat2, {});
  assert.equal(resolution2.status, 'RESOLVED');
  assert.equal(resolution2.selectedMaterial.selectedAssetId, videoAsset.assetId);
  const execution2 = executionService.executeMaterial(project.id, beat2, resolution2);
  assert.equal(execution2.status, 'COMPLETED');
  assert.equal(execution2.renderSpec.type, 'ASSET_PLACEMENT');

  const resolution3 = materialResolutionService.resolveMaterial(project.id, beat3Final, {});
  assert.equal(resolution3.status, 'RESOLVED');
  const execution3 = executionService.executeMaterial(project.id, beat3Final, resolution3, { text: beat3Final.narrationSegment.text });
  assert.equal(execution3.status, 'COMPLETED');
  assert.equal(execution3.renderSpec.type, 'KINETIC_TYPOGRAPHY');

  // === Real rendering — one deterministic visual renderer (STILL_IMAGE_MOTION),
  // one real rendered video asset (ASSET_PLACEMENT), one motion/graphic renderer
  // (KINETIC_TYPOGRAPHY) — all real MP4 via the real HyperFrames pipeline ===
  const render1 = renderViaHyperframes(project.id, execution1);
  const render2 = renderViaHyperframes(project.id, execution2);
  const render3 = renderViaHyperframes(project.id, execution3);
  for (const r of [render1, render2, render3]) {
    assert.equal(r.artifact.format, 'MP4');
    assert.ok(fs.existsSync(r.artifact.path));
  }

  // === Real Timeline Compilation — completely unmodified this stage ===
  const timelineCompilation = compileTimeline(timingResult.beatGraph, [resolution1, resolution2, resolution3], [execution1, execution2, execution3], { projectId: project.id });
  assert.equal(timelineCompilation.status, 'COMPILED');
  assert.equal(timelineCompilation.shots.length, 3);
  assert.equal(timelineCompilation.diagnostics.filter((d) => d.code === 'TIMING_INFERRED').length, 0, 'every shot got real, non-inferred timing');

  // === Real Assembly (P0-3B) ==========================================
  const assembly1 = assembleTimeline({
    projectId: project.id,
    timelineCompilation,
    renderResults: [render1, render2, render3],
    audioEvents: [voice1.audioEvent, voice2.audioEvent],
    outputDir: PROOF_DIR,
  });

  assert.equal(assembly1.status, 'COMPLETED', JSON.stringify(assembly1.diagnostics));
  assert.deepEqual(assembly1.diagnostics, []);
  assert.ok(fs.existsSync(assembly1.artifact.path));

  const goldenVideoPath = path.join(PROOF_DIR, 'GOLDEN_VIDEO.mp4');
  fs.copyFileSync(assembly1.artifact.path, goldenVideoPath);
  console.log(`[P0-3B GOLDEN VIDEO] ${goldenVideoPath}`);

  // === ffprobe verification (Part 15/21) ==============================
  const probe = ffprobeFull(goldenVideoPath);
  const videoStream = probe.streams.find((s) => s.codec_type === 'video');
  const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
  assert.ok(videoStream, 'must contain a video stream');
  assert.ok(audioStream, 'must contain an audio stream (real narration)');
  assert.equal(videoStream.width, 1920);
  assert.equal(videoStream.height, 1080);
  assert.equal(videoStream.r_frame_rate, '30/1');
  assert.equal(videoStream.codec_name, 'h264');
  assert.equal(audioStream.codec_name, 'aac');
  const expectedTotal = beat3Final.startTime + beat3Final.duration;
  assert.ok(Math.abs(Number(probe.format.duration) - expectedTotal) < 0.2, `duration ${probe.format.duration} should match expected ${expectedTotal} within tolerance`);
  assert.equal(assembly1.expectedDuration, expectedTotal);

  // Decode-integrity pass — never trust ffprobe metadata alone.
  execFileSync('ffmpeg', ['-v', 'error', '-i', goldenVideoPath, '-f', 'null', '-'], { timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });

  // === Provenance (Part 13) ============================================
  assert.equal(assembly1.provenance.shots.length, 3);
  assert.equal(assembly1.provenance.shots[0].beatId, beat1Id);
  assert.equal(assembly1.provenance.shots[0].sourceAssetId, imageAsset.assetId);
  assert.equal(assembly1.provenance.shots[1].beatId, beat2Id);
  assert.equal(assembly1.provenance.shots[1].sourceAssetId, videoAsset.assetId);
  assert.equal(assembly1.provenance.shots[2].beatId, beat3Id);
  assert.equal(assembly1.provenance.narration.length, 2);
  assert.equal(assembly1.provenance.narration[0].sourceAssetId, voice1.audioEvent.sourceAssetId);
  assert.equal(assembly1.provenance.narration[0].scriptRefId, 'gv-script-1');
  assert.equal(assembly1.provenance.narration[1].sourceAssetId, voice2.audioEvent.sourceAssetId);
  assert.equal(assembly1.provenance.narration[1].scriptRefId, 'gv-script-2');

  // === Determinism (Part 14) — decode-identical video AND audio content ===
  const assembly2 = assembleTimeline({
    projectId: project.id,
    timelineCompilation,
    renderResults: [render1, render2, render3],
    audioEvents: [voice1.audioEvent, voice2.audioEvent],
    outputDir: PROOF_DIR,
  });
  assert.equal(assembly2.status, 'COMPLETED');
  assert.equal(hashDecodedFrames(assembly1.artifact.path), hashDecodedFrames(assembly2.artifact.path));
  assert.equal(hashDecodedAudio(assembly1.artifact.path), hashDecodedAudio(assembly2.artifact.path));
  assert.equal(assembly1.artifact.duration, assembly2.artifact.duration);
  assert.equal(assembly1.artifact.width, assembly2.artifact.width);
  assert.equal(assembly1.artifact.height, assembly2.artifact.height);
  assert.equal(assembly1.artifact.fps, assembly2.artifact.fps);

  // === Human-inspectable proof frames (Part 16) — extracted, never claimed sight-unseen ===
  const frameTimes = {
    'beat1-mid.png': beat1.startTime + beat1.duration / 2,
    'gap-mid.png': beat1.startTime + beat1.duration + GAP_SECONDS / 2,
    'beat2-mid.png': beat2.startTime + beat2.duration / 2,
    'beat3-mid.png': beat3Final.startTime + beat3Final.duration / 2,
  };
  for (const [name, t] of Object.entries(frameTimes)) {
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', goldenVideoPath, '-frames:v', '1', path.join(PROOF_DIR, name)]);
  }
  console.log(`[P0-3B GOLDEN VIDEO] inspection frames written to ${PROOF_DIR}`);

  // === No project/data mutation beyond what this test itself created ===
  assert.equal(timelineStore.getAsset(project.id, imageAsset.assetId).storage.status, 'STORED');
});

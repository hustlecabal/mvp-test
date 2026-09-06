// PRODUCTION RELIABILITY LAYER — PHASE 3A: AUDIO TIMELINE + SCHEMA
// FOUNDATION. Tests services/timeline-compiler-service.js's new audio
// placement logic — TimelineCompilationResult.audio[]. This is the
// foundation stage only: no provider, no mixing, no ducking. These tests
// prove the compiled AUDIO representation is correct and deterministic,
// reusing the exact same one-authority timing model already proven for
// visual shots (Phase 2's own principle: timeline-compiler-service.js is
// the sole owner of final temporal placement — no second cursor anywhere
// in this file, including here).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');
const { createMaterialResolution, createCandidateResult } = require('../schemas/material-resolution-schema');
const { createExecutionResult } = require('../schemas/material-execution-schema');
const { createAudioEvent } = require('../schemas/audio-schema');
const { compileTimeline } = require('../services/timeline-compiler-service');

function makeBeat(overrides = {}) {
  return createVisualBeat({ id: crypto.randomUUID(), sceneId: 's1', shotId: 'sh1', sequence: 1, visualTreatment: 'STILL_IMAGE', ...overrides });
}

function makeResolution(beatId, materialId, overrides = {}) {
  return createMaterialResolution({
    beatId,
    status: 'RESOLVED',
    selectedMaterial: createCandidateResult({ candidate: materialId, materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', role: 'PRIMARY', ...overrides }),
  });
}

function makeExecution(beatId, materialId, { duration, renderSpec = null, sourceAssetIds = [], status = 'COMPLETED', diagnostics = [] } = {}) {
  return createExecutionResult({ beatId, materialId, executorType: 'PROJECT_ASSET_REUSE', status, duration, renderSpec, sourceAssetIds, diagnostics });
}

// ===========================================================================
// A. Empty audio — no behavior change from before Phase 3A
// ===========================================================================

test('A. a timeline with no audioInputs behaves exactly as before Phase 3A — audio: [], shots/status/diagnostics unaffected', () => {
  const beat = makeBeat({ sequence: 1, startTime: 0, duration: 5 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const result = compileTimeline(graph, [makeResolution(beat.id, 'M1')], [makeExecution(beat.id, 'M1', { duration: 5 })]);

  assert.equal(result.status, 'COMPILED');
  assert.equal(result.shots.length, 1);
  assert.deepEqual(result.audio, []);
  assert.deepEqual(result.diagnostics, []);
});

test('A2. omitting audioInputs entirely (3-arg call, the pre-Phase-3A signature) still works — audio defaults to []', () => {
  const beat = makeBeat({ sequence: 1, startTime: 0, duration: 5 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  // No 4th/5th argument at all.
  const result = compileTimeline(graph, [makeResolution(beat.id, 'M1')], [makeExecution(beat.id, 'M1', { duration: 5 })]);
  assert.deepEqual(result.audio, []);
});

// ===========================================================================
// B. Narration — explicit, already-resolved timing is registered verbatim
// ===========================================================================

test('B. a synthetic NARRATION AudioEvent with explicit startTime/duration is registered into audio[] with those exact values, unchanged', () => {
  const beat = makeBeat({ sequence: 1, startTime: 0, duration: 5 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const narration = createAudioEvent({ type: 'NARRATION', status: 'READY', startTime: 1.5, duration: 2.3, sourceAssetId: 'asset-1', beatId: beat.id });

  const result = compileTimeline(graph, [makeResolution(beat.id, 'M1')], [makeExecution(beat.id, 'M1', { duration: 5 })], [narration]);

  assert.equal(result.audio.length, 1);
  assert.equal(result.audio[0].audioEventId, narration.audioEventId);
  assert.equal(result.audio[0].startTime, 1.5);
  assert.equal(result.audio[0].duration, 2.3);
  assert.equal(result.audio[0].type, 'NARRATION');
  assert.equal(result.audio[0].sourceAssetId, 'asset-1');
  // No AUDIO_TIMING_INFERRED diagnostic — nothing was inferred, both fields were explicit.
  assert.equal(result.diagnostics.filter((d) => d.code === 'AUDIO_TIMING_INFERRED').length, 0);
});

// ===========================================================================
// C. Beat-attached SFX — derives placement from its own beat's compiled Shot
// ===========================================================================

test('C. a beat-attached SFX with no explicit timing resolves to its beat\'s own compiled startTime/duration', () => {
  const beat = makeBeat({ sequence: 1, startTime: 3, duration: 4 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const sfx = createAudioEvent({ type: 'SFX', status: 'READY', sourceAssetId: 'asset-sfx', beatId: beat.id }); // startTime/duration both null

  const result = compileTimeline(graph, [makeResolution(beat.id, 'M1')], [makeExecution(beat.id, 'M1', { duration: 4 })], [sfx]);

  assert.equal(result.audio.length, 1);
  const compiledSfx = result.audio[0];
  assert.equal(compiledSfx.startTime, 3);
  assert.equal(compiledSfx.duration, 4);
  assert.ok(result.diagnostics.some((d) => d.code === 'AUDIO_TIMING_INFERRED' && d.beatId === beat.id));
});

test('C2. a beat-attached audio event referencing a beat with NO compiled Shot is excluded with AUDIO_BEAT_NOT_COMPILED, never silently kept', () => {
  const graph = createBeatGraph({ projectId: 'p', beats: [] }); // no beats at all -> the referenced beatId can never compile
  const sfx = createAudioEvent({ type: 'SFX', status: 'READY', sourceAssetId: 'asset-sfx', beatId: 'nonexistent-beat' });

  const result = compileTimeline(graph, [], [], [sfx]);

  assert.equal(result.audio.length, 0);
  assert.ok(result.diagnostics.some((d) => d.code === 'AUDIO_BEAT_NOT_COMPILED'));
});

// ===========================================================================
// D. Scene/video-spanning music — no second cursor, derived from finalShots
// ===========================================================================

test('D1. a scene-spanning MUSIC event (sceneId, no beatId) spans exactly that scene\'s own compiled [min start, max end)', () => {
  const beat1 = makeBeat({ sceneId: 'sceneA', sequence: 1, startTime: 0, duration: 4 });
  const beat2 = makeBeat({ sceneId: 'sceneA', sequence: 2, startTime: 4, duration: 6 });
  const beat3 = makeBeat({ sceneId: 'sceneB', sequence: 1, startTime: 10, duration: 3 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat1, beat2, beat3] });
  const resolutions = [makeResolution(beat1.id, 'M1'), makeResolution(beat2.id, 'M2'), makeResolution(beat3.id, 'M3')];
  const executions = [makeExecution(beat1.id, 'M1', { duration: 4 }), makeExecution(beat2.id, 'M2', { duration: 6 }), makeExecution(beat3.id, 'M3', { duration: 3 })];
  const music = createAudioEvent({ type: 'MUSIC', status: 'READY', sourceAssetId: 'asset-music', sceneId: 'sceneA' });

  const result = compileTimeline(graph, resolutions, executions, [music]);

  assert.equal(result.audio.length, 1);
  assert.equal(result.audio[0].startTime, 0); // sceneA's own earliest compiled shot
  assert.equal(result.audio[0].duration, 10); // sceneA spans [0,10) — beat3 (sceneB) never included
});

test('D2. a whole-video-spanning MUSIC event (no beatId, no sceneId) spans the ENTIRE compiled timeline\'s own [0, max end) — no second cursor invented', () => {
  const beat1 = makeBeat({ sceneId: 'sceneA', sequence: 1, startTime: 0, duration: 4 });
  const beat2 = makeBeat({ sceneId: 'sceneB', sequence: 1, startTime: 4, duration: 6 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat1, beat2] });
  const resolutions = [makeResolution(beat1.id, 'M1'), makeResolution(beat2.id, 'M2')];
  const executions = [makeExecution(beat1.id, 'M1', { duration: 4 }), makeExecution(beat2.id, 'M2', { duration: 6 })];
  const music = createAudioEvent({ type: 'MUSIC', status: 'READY', sourceAssetId: 'asset-music' }); // no beatId, no sceneId

  const result = compileTimeline(graph, resolutions, executions, [music]);

  assert.equal(result.audio.length, 1);
  assert.equal(result.audio[0].startTime, 0);
  assert.equal(result.audio[0].duration, 10); // full compiled timeline span
});

test('D3. a sceneId referencing a scene with no compiled shots is excluded with AUDIO_SCENE_NOT_COMPILED', () => {
  const beat = makeBeat({ sceneId: 'sceneA', sequence: 1, startTime: 0, duration: 4 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const ambience = createAudioEvent({ type: 'AMBIENCE', status: 'READY', sourceAssetId: 'asset-amb', sceneId: 'sceneZ' });

  const result = compileTimeline(graph, [makeResolution(beat.id, 'M1')], [makeExecution(beat.id, 'M1', { duration: 4 })], [ambience]);

  assert.equal(result.audio.length, 0);
  assert.ok(result.diagnostics.some((d) => d.code === 'AUDIO_SCENE_NOT_COMPILED'));
});

// ===========================================================================
// E. Explicit timing precedence — mirrors the exact visual Tier-1 rule
// ===========================================================================

test('E. explicit startTime/duration on an audio event ALWAYS wins, even when beatId/sceneId are also set', () => {
  const beat = makeBeat({ sceneId: 's1', sequence: 1, startTime: 0, duration: 5 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  // beatId is set, but explicit startTime/duration must still win over the beat's own [0,5).
  const sfx = createAudioEvent({ type: 'SFX', status: 'READY', sourceAssetId: 'asset-sfx', beatId: beat.id, startTime: 100, duration: 0.5 });

  const result = compileTimeline(graph, [makeResolution(beat.id, 'M1')], [makeExecution(beat.id, 'M1', { duration: 5 })], [sfx]);

  assert.equal(result.audio[0].startTime, 100);
  assert.equal(result.audio[0].duration, 0.5);
  assert.equal(result.diagnostics.filter((d) => d.code === 'AUDIO_TIMING_INFERRED').length, 0);
});

test('E2. an explicit but INVALID startTime (negative) is rejected structurally, never silently repaired', () => {
  const beat = makeBeat({ sequence: 1, startTime: 0, duration: 5 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const sfx = createAudioEvent({ type: 'SFX', status: 'READY', sourceAssetId: 'asset-sfx', beatId: beat.id, startTime: -2, duration: 1 });

  const result = compileTimeline(graph, [makeResolution(beat.id, 'M1')], [makeExecution(beat.id, 'M1', { duration: 5 })], [sfx]);

  assert.equal(result.audio.length, 0);
  assert.ok(result.diagnostics.some((d) => d.code === 'NEGATIVE_AUDIO_START_TIME'));
});

test('E3. an unknown audio type is rejected with INVALID_AUDIO_TYPE, never silently accepted', () => {
  const beat = makeBeat({ sequence: 1, startTime: 0, duration: 5 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const bogus = { audioEventId: 'a1', type: 'LASER_SOUND', sourceAssetId: 'x', beatId: beat.id, startTime: 0, duration: 1 };

  const result = compileTimeline(graph, [makeResolution(beat.id, 'M1')], [makeExecution(beat.id, 'M1', { duration: 5 })], [bogus]);

  assert.equal(result.audio.length, 0);
  assert.ok(result.diagnostics.some((d) => d.code === 'INVALID_AUDIO_TYPE'));
});

// ===========================================================================
// F. Multiple audio events coexist without overwriting each other
// ===========================================================================

test('F. narration + music + SFX all coexist in audio[] — none overwritten, none dropped', () => {
  const beat1 = makeBeat({ sceneId: 's1', sequence: 1, startTime: 0, duration: 4 });
  const beat2 = makeBeat({ sceneId: 's1', sequence: 2, startTime: 4, duration: 6 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat1, beat2] });
  const resolutions = [makeResolution(beat1.id, 'M1'), makeResolution(beat2.id, 'M2')];
  const executions = [makeExecution(beat1.id, 'M1', { duration: 4 }), makeExecution(beat2.id, 'M2', { duration: 6 })];

  const narration = createAudioEvent({ type: 'NARRATION', status: 'READY', sourceAssetId: 'asset-narr', beatId: beat1.id, startTime: 0, duration: 3.5 });
  const music = createAudioEvent({ type: 'MUSIC', status: 'READY', sourceAssetId: 'asset-music' });
  const sfx = createAudioEvent({ type: 'SFX', status: 'READY', sourceAssetId: 'asset-sfx', beatId: beat2.id });

  const result = compileTimeline(graph, resolutions, executions, [narration, music, sfx]);

  assert.equal(result.audio.length, 3);
  const byType = Object.fromEntries(result.audio.map((a) => [a.type, a]));
  assert.equal(byType.NARRATION.startTime, 0);
  assert.equal(byType.NARRATION.duration, 3.5);
  assert.equal(byType.MUSIC.startTime, 0);
  assert.equal(byType.MUSIC.duration, 10); // whole timeline
  assert.equal(byType.SFX.startTime, 4);
  assert.equal(byType.SFX.duration, 6); // beat2's own window
});

// ===========================================================================
// G. Non-narrated visual beats — Phase 2's invariant must survive Phase 3A
// ===========================================================================

test('G. a non-narrated visual beat still receives correct deterministic Tier-3 sequential placement when audioInputs are present — Phase 2\'s fix is not resurrected', () => {
  // Mirrors the exact real-world shape Phase 2 fixed: beat1 is narrated
  // (explicit startTime from real narration timing), beat2 has NO
  // narration and NO explicit startTime at all — it must still get a
  // real, non-overlapping, sequentially-inferred visual placement, and
  // this must remain true even though a NARRATION AudioEvent is also
  // present in audioInputs for beat1.
  const beat1 = makeBeat({ sceneId: 's1', sequence: 1, startTime: 0, duration: 4 }); // narrated (explicit beat.startTime, as narration-timing-service.js would set)
  const beat2 = makeBeat({ sceneId: 's1', sequence: 2, startTime: null, duration: 5 }); // non-narrated — no beat.startTime at all
  const graph = createBeatGraph({ projectId: 'p', beats: [beat1, beat2] });
  const resolutions = [makeResolution(beat1.id, 'M1'), makeResolution(beat2.id, 'M2')];
  const executions = [makeExecution(beat1.id, 'M1', { duration: 4 }), makeExecution(beat2.id, 'M2', { duration: 5 })];
  const narration = createAudioEvent({ type: 'NARRATION', status: 'READY', sourceAssetId: 'asset-narr', beatId: beat1.id, startTime: 0, duration: 4 });

  const result = compileTimeline(graph, resolutions, executions, [narration]);

  assert.equal(result.shots.length, 2);
  const shotByBeat = Object.fromEntries(result.shots.map((s) => [s.beatId, s]));
  assert.equal(shotByBeat[beat1.id].startTime, 0);
  assert.equal(shotByBeat[beat2.id].startTime, 4); // Tier-3 sequential inference, unaffected by audioInputs
  assert.equal(shotByBeat[beat2.id].duration, 5);
  assert.ok(result.diagnostics.some((d) => d.code === 'TIMING_INFERRED' && d.beatId === beat2.id));
  assert.equal(result.status, 'COMPILED');
});

// ===========================================================================
// H. Determinism
// ===========================================================================

test('H. compiling the same BeatGraph + resolutions + executions + audioInputs twice produces identical audio placement', () => {
  const beat1 = makeBeat({ sceneId: 's1', sequence: 1, startTime: 0, duration: 4 });
  const beat2 = makeBeat({ sceneId: 's1', sequence: 2, duration: 5 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat1, beat2] });
  const resolutions = [makeResolution(beat1.id, 'M1'), makeResolution(beat2.id, 'M2')];
  const executions = [makeExecution(beat1.id, 'M1', { duration: 4 }), makeExecution(beat2.id, 'M2', { duration: 5 })];
  const narration = createAudioEvent({ type: 'NARRATION', status: 'READY', sourceAssetId: 'asset-narr', beatId: beat1.id, startTime: 0, duration: 4 });
  const music = createAudioEvent({ type: 'MUSIC', status: 'READY', sourceAssetId: 'asset-music' });
  const sfx = createAudioEvent({ type: 'SFX', status: 'READY', sourceAssetId: 'asset-sfx', beatId: beat2.id });

  const first = compileTimeline(graph, resolutions, executions, [narration, music, sfx]);
  const second = compileTimeline(graph, resolutions, executions, [narration, music, sfx]);

  assert.deepEqual(first.audio, second.audio);
  assert.deepEqual(
    first.diagnostics.filter((d) => d.code.startsWith('AUDIO_')),
    second.diagnostics.filter((d) => d.code.startsWith('AUDIO_'))
  );
});

test('H2. audio placement never mutates its own inputs — audioInputs entries are untouched after compilation', () => {
  const beat = makeBeat({ sequence: 1, startTime: 0, duration: 4 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const sfx = createAudioEvent({ type: 'SFX', status: 'READY', sourceAssetId: 'asset-sfx', beatId: beat.id });
  const before = JSON.stringify(sfx);

  compileTimeline(graph, [makeResolution(beat.id, 'M1')], [makeExecution(beat.id, 'M1', { duration: 4 })], [sfx]);

  assert.equal(JSON.stringify(sfx), before, 'the input AudioEvent object must never be mutated — startTime/duration were still null on the input');
});

// Tests for services/narration-timing-service.js — P0-3A, the
// AudioEvent/Whisper-timing -> VisualBeat/BeatGraph-timing bridge. Items 1-9
// and the pure-function/negative-path tests use hand-built fixtures
// (schema factories only — never real audio, exactly like every other
// schema-level test in this codebase). The "REAL PIPELINE PROOF" section
// uses the real espeak-ng/faster-whisper pipeline (services/voice-
// generation-service.js), per the task's explicit "do not fabricate
// AudioEvents" instruction for that section only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-narration-timing-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-narration-timing-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const { createBeatGraph } = require('../schemas/beat-graph-schema');
const { createVisualBeat, createNarrationSegment } = require('../schemas/visual-beat-schema');
const { createAudioEvent, createWordTimestamp } = require('../schemas/audio-schema');
const { createCandidateResult, createMaterialResolution } = require('../schemas/material-resolution-schema');
const { createExecutionResult } = require('../schemas/material-execution-schema');
const { applyNarrationTiming } = require('../services/narration-timing-service');
const { compileTimeline } = require('../services/timeline-compiler-service');
const { directNarration } = require('../services/narration-director-service');
const { generateNarratedAudioEvent } = require('../services/voice-generation-service');

function beat(overrides = {}) {
  return createVisualBeat({ sceneId: 's1', sequence: 1, ...overrides });
}
function narrated(scriptRefId, segOverrides = {}) {
  return createNarrationSegment({ scriptRefId, ...segOverrides });
}

// --- 1-2. determinism ------------------------------------------------------------------

test('1. identical inputs produce identical timing output (excluding beatGraph.updatedAt/result.createdAt)', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae = createAudioEvent({ scriptRefId: 's1', beatId: 'b1', startTime: 0, duration: 4.8 });

  const r1 = applyNarrationTiming(bg, [ae]);
  const r2 = applyNarrationTiming(bg, [ae]);

  assert.equal(r1.status, r2.status);
  assert.equal(r1.appliedBeatCount, r2.appliedBeatCount);
  assert.deepEqual(r1.diagnostics, r2.diagnostics);
  assert.equal(r1.beatGraph.beats[0].startTime, r2.beatGraph.beats[0].startTime);
  assert.equal(r1.beatGraph.beats[0].duration, r2.beatGraph.beats[0].duration);
});

test('2. running the same calculation 5 times in a row produces the same result every time', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae = createAudioEvent({ scriptRefId: 's1', beatId: 'b1', startTime: 0.5, duration: 3.2 });

  const results = Array.from({ length: 5 }, () => applyNarrationTiming(bg, [ae]));
  for (const r of results) {
    assert.equal(r.beatGraph.beats[0].startTime, 0.5);
    assert.equal(r.beatGraph.beats[0].duration, 3.2);
    assert.equal(r.status, 'APPLIED');
  }
});

// --- 3-8. Tier 1 — measured audio ------------------------------------------------------

test('3. a valid measured AudioEvent applies both duration and startTime, tagged MEASURED_AUDIO', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae = createAudioEvent({ scriptRefId: 's1', beatId: 'b1', startTime: 0, duration: 4.8 });

  const result = applyNarrationTiming(bg, [ae]);

  assert.equal(result.status, 'APPLIED');
  assert.equal(result.appliedBeatCount, 1);
  assert.equal(result.beatGraph.beats[0].startTime, 0);
  assert.equal(result.beatGraph.beats[0].duration, 4.8);
  const applied = result.diagnostics.find((d) => d.code === 'NARRATION_TIMING_APPLIED');
  assert.equal(applied.source, 'MEASURED_AUDIO');
  assert.equal(applied.audioEventId, ae.audioEventId);
});

test('4. invalid (negative) duration fails with INVALID_AUDIO_DURATION, nothing applied', () => {
  const b = beat({ id: 'b1', duration: 9, narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae = createAudioEvent({ scriptRefId: 's1', beatId: 'b1', duration: -3 });

  const result = applyNarrationTiming(bg, [ae]);

  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.appliedBeatCount, 0);
  assert.equal(result.diagnostics[0].code, 'INVALID_AUDIO_DURATION');
  assert.equal(result.beatGraph.beats[0].duration, 9); // untouched — falls through to Tier 3
});

test('5. absent duration (still PLANNED / not yet measured) fails with NARRATION_TIMING_MISSING', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae = createAudioEvent({ scriptRefId: 's1', beatId: 'b1', duration: null });

  const result = applyNarrationTiming(bg, [ae]);

  assert.equal(result.diagnostics[0].code, 'NARRATION_TIMING_MISSING');
  assert.equal(result.appliedBeatCount, 0);
});

test('6. invalid (negative) startTime reuses the compiler\'s own NEGATIVE_START_TIME code, but duration is still applied', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae = createAudioEvent({ scriptRefId: 's1', beatId: 'b1', startTime: -1, duration: 5 });

  const result = applyNarrationTiming(bg, [ae]);

  assert.equal(result.diagnostics.some((d) => d.code === 'NEGATIVE_START_TIME'), true);
  assert.equal(result.diagnostics.some((d) => d.code === 'NARRATION_TIMING_APPLIED'), true);
  assert.equal(result.beatGraph.beats[0].duration, 5);
  assert.equal(result.beatGraph.beats[0].startTime, null); // unchanged, not the invalid -1
});

test('7. absent startTime leaves the beat\'s startTime untouched but still applies duration', () => {
  const b = beat({ id: 'b1', startTime: null, narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae = createAudioEvent({ scriptRefId: 's1', beatId: 'b1', startTime: null, duration: 5 });

  const result = applyNarrationTiming(bg, [ae]);

  assert.equal(result.beatGraph.beats[0].startTime, null);
  assert.equal(result.beatGraph.beats[0].duration, 5);
});

test('8. malformed word timestamps flag INVALID_WORD_TIMESTAMP but do not block applying the independently-measured duration', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae = createAudioEvent({
    scriptRefId: 's1',
    beatId: 'b1',
    duration: 4,
    transcript: { text: 'hi', words: [createWordTimestamp({ word: 'hi', startTime: 2, endTime: 1 })] }, // end before start
  });

  const result = applyNarrationTiming(bg, [ae]);

  assert.equal(result.diagnostics.some((d) => d.code === 'INVALID_WORD_TIMESTAMP'), true);
  assert.equal(result.beatGraph.beats[0].duration, 4);
});

// --- 9-11. conflicts ---------------------------------------------------------------------

test('9. two AudioEvents directly claiming the same beat fail with NARRATION_TIMING_CONFLICT, neither applied', () => {
  const b = beat({ id: 'b1', duration: 7, narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae1 = createAudioEvent({ scriptRefId: 's1', beatId: 'b1', duration: 4 });
  const ae2 = createAudioEvent({ scriptRefId: 's1', beatId: 'b1', duration: 5 });

  const result = applyNarrationTiming(bg, [ae1, ae2]);

  assert.equal(result.diagnostics[0].code, 'NARRATION_TIMING_CONFLICT');
  assert.equal(result.beatGraph.beats[0].duration, 7);
});

test('10. a directly-matched AudioEvent whose scriptRefId disagrees with the beat\'s own narrationSegment fails with NARRATION_TIMING_CONFLICT', () => {
  const b = beat({ id: 'b1', duration: 7, narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae = createAudioEvent({ scriptRefId: 's-other', beatId: 'b1', duration: 4 });

  const result = applyNarrationTiming(bg, [ae]);

  assert.equal(result.diagnostics[0].code, 'NARRATION_TIMING_CONFLICT');
  assert.equal(result.beatGraph.beats[0].duration, 7);
});

test('11. no AudioEvent at all for a beat\'s scriptRefId fails with NARRATION_TIMING_MISSING', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s-missing') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });

  const result = applyNarrationTiming(bg, []);

  assert.equal(result.diagnostics[0].code, 'NARRATION_TIMING_MISSING');
});

// --- 12-13. multi-beat ambiguity ----------------------------------------------------------

test('12. a scriptRefId shared by two beats, with an ambiguous (beatId: null) AudioEvent, fails MULTI_BEAT_TIMING_UNRESOLVED + NARRATION_TIMING_UNRESOLVABLE per beat', () => {
  const bA = beat({ id: 'bA', narrationSegment: narrated('multi-1') });
  const bB = beat({ id: 'bB', sequence: 2, narrationSegment: narrated('multi-1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [bA, bB], edges: [] });
  const ae = createAudioEvent({ scriptRefId: 'multi-1', beatId: null, duration: 9 });

  const result = applyNarrationTiming(bg, [ae]);

  assert.equal(result.diagnostics.filter((d) => d.code === 'MULTI_BEAT_TIMING_UNRESOLVED').length, 1);
  assert.equal(result.diagnostics.filter((d) => d.code === 'NARRATION_TIMING_UNRESOLVABLE').length, 2);
  assert.equal(result.beatGraph.beats[0].duration, null);
  assert.equal(result.beatGraph.beats[1].duration, null);
  assert.equal(result.status, 'PARTIAL');
});

test('13. a single beat matching a scriptRefId whose only AudioEvent has beatId: null is still refused (upstream ambiguity trusted over graph coincidence)', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae = createAudioEvent({ scriptRefId: 's1', beatId: null, duration: 4 });

  const result = applyNarrationTiming(bg, [ae]);

  assert.equal(result.diagnostics[0].code, 'NARRATION_TIMING_UNRESOLVABLE');
  assert.equal(result.beatGraph.beats[0].duration, null);
});

// --- 14-16. Tier 2 — narrationSegment offsets ----------------------------------------------

test('14. Tier 2 applies duration from narrationSegment.startOffset/endOffset when Tier 1 has no audio', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s-none', { startOffset: 2, endOffset: 6.5 }) });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });

  const result = applyNarrationTiming(bg, []);

  const applied = result.diagnostics.find((d) => d.code === 'NARRATION_TIMING_APPLIED');
  assert.equal(applied.source, 'NARRATION_SEGMENT_OFFSET');
  assert.equal(result.beatGraph.beats[0].duration, 4.5);
});

test('15. Tier 1 wins over Tier 2 when both are available', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s1', { startOffset: 0, endOffset: 100 }) });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae = createAudioEvent({ scriptRefId: 's1', beatId: 'b1', duration: 4.8 });

  const result = applyNarrationTiming(bg, [ae]);

  assert.equal(result.beatGraph.beats[0].duration, 4.8);
  assert.equal(result.diagnostics.find((d) => d.source === 'NARRATION_SEGMENT_OFFSET'), undefined);
});

test('16. invalid narrationSegment offsets (endOffset <= startOffset) leave the beat untouched — falls through to Tier 3', () => {
  const b = beat({ id: 'b1', duration: 11, narrationSegment: narrated('s-none', { startOffset: 5, endOffset: 5 }) });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });

  const result = applyNarrationTiming(bg, []);

  assert.equal(result.beatGraph.beats[0].duration, 11);
});

// --- 17. non-narrated beats are untouched (Part 7) ------------------------------------------

test('17. a beat with no narrationSegment is completely untouched, no diagnostics — the existing Stage 26.6 hierarchy applies unchanged', () => {
  const narrationless = beat({ id: 'b1', startTime: 2, duration: 3 });
  const bg = createBeatGraph({ projectId: 'p1', beats: [narrationless], edges: [] });

  const result = applyNarrationTiming(bg, [createAudioEvent({ scriptRefId: 'irrelevant', duration: 99 })]);

  assert.equal(result.status, 'UNCHANGED');
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.beatGraph.beats[0].startTime, 2);
  assert.equal(result.beatGraph.beats[0].duration, 3);
});

// --- 18-19. purity / never mutates inputs ----------------------------------------------------

test('18. the input BeatGraph and its beats are never mutated', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const before = JSON.stringify(bg);
  const ae = createAudioEvent({ scriptRefId: 's1', beatId: 'b1', duration: 4.8 });

  applyNarrationTiming(bg, [ae]);

  assert.equal(JSON.stringify(bg), before);
});

test('19. the input audioEvents array/entries are never mutated', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae = createAudioEvent({ scriptRefId: 's1', beatId: 'b1', duration: 4.8 });
  const before = JSON.stringify(ae);

  applyNarrationTiming(bg, [ae]);

  assert.equal(JSON.stringify(ae), before);
});

// --- 20-21. structural failure handling -------------------------------------------------------

test('20. an invalid BeatGraph fails with INVALID_BEAT_GRAPH rather than throwing', () => {
  assert.doesNotThrow(() => {
    const result = applyNarrationTiming(null, []);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'INVALID_BEAT_GRAPH');
  });
});

test('21. non-array audioEvents (undefined, a string, garbage entries) never throws', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });

  assert.doesNotThrow(() => applyNarrationTiming(bg));
  assert.doesNotThrow(() => applyNarrationTiming(bg, 'not-an-array'));
  assert.doesNotThrow(() => applyNarrationTiming(bg, [null, 42, 'x', undefined]));
});

// --- 22. security ------------------------------------------------------------------------------

test('22. services/narration-timing-service.js has no eval/new Function/shell/network call and requires only the beat-graph schema', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'narration-timing-service.js'), 'utf8');
  const codeOnly = text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(codeOnly, /\beval\(/);
  assert.doesNotMatch(codeOnly, /new Function/);
  assert.doesNotMatch(codeOnly, /child_process|execSync|spawn/);
  assert.doesNotMatch(codeOnly, /fetch\(|http\.request|https\.request/);
  const requires = [...codeOnly.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['../schemas/beat-graph-schema']);
});

// --- 23-24. backward compatibility with the existing compiler ----------------------------------

test('23. an all-non-narrated BeatGraph compiles identically whether or not it is first passed through applyNarrationTiming', () => {
  const b = beat({ id: 'b1', startTime: 0, duration: 5 });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const material = createCandidateResult({ candidate: 'PROJECT_ASSET_REUSE+STILL_IMAGE', materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', selectedAssetId: 'asset-1' });
  const resolution = createMaterialResolution({ beatId: 'b1', status: 'RESOLVED', selectedMaterial: material });
  const execution = createExecutionResult({ beatId: 'b1', materialId: material.candidate, executorType: 'PROJECT_ASSET_REUSE', status: 'COMPLETED', duration: 5, renderSpec: { type: 'ASSET_PLACEMENT', assetId: 'asset-1' }, sourceAssetIds: ['asset-1'] });

  const directCompile = compileTimeline(bg, [resolution], [execution]);
  const timingResult = applyNarrationTiming(bg, []);
  const afterPassCompile = compileTimeline(timingResult.beatGraph, [resolution], [execution]);

  assert.deepEqual(
    directCompile.shots.map((s) => ({ startTime: s.startTime, duration: s.duration })),
    afterPassCompile.shots.map((s) => ({ startTime: s.startTime, duration: s.duration }))
  );
  assert.equal(directCompile.status, afterPassCompile.status);
});

test('24. a beat whose measured timing WAS applied compiles into a Shot with that exact duration, via the compiler\'s own unmodified Tier-2 (beat.startTime) precedence', () => {
  const b = beat({ id: 'b1', narrationSegment: narrated('s1') });
  const bg = createBeatGraph({ projectId: 'p1', beats: [b], edges: [] });
  const ae = createAudioEvent({ scriptRefId: 's1', beatId: 'b1', startTime: 0, duration: 6.25 });
  const timingResult = applyNarrationTiming(bg, [ae]);

  const material = createCandidateResult({ candidate: 'PROJECT_ASSET_REUSE+STILL_IMAGE', materialSource: 'PROJECT_ASSET_REUSE', visualTreatment: 'STILL_IMAGE', selectedAssetId: 'asset-1' });
  const resolution = createMaterialResolution({ beatId: 'b1', status: 'RESOLVED', selectedMaterial: material });
  // The executor reads beat.duration as its own fallback source (see e.g.
  // still-image-motion-executor.js's `options.duration !== undefined ?
  // options.duration : beat && beat.duration`) — simulated here directly by
  // building the ExecutionResult with the now-measured beat.duration, since
  // this test's job is to prove the COMPILER's own existing precedence
  // (beat.startTime), not re-prove Material Execution.
  const execution = createExecutionResult({
    beatId: 'b1',
    materialId: material.candidate,
    executorType: 'PROJECT_ASSET_REUSE',
    status: 'COMPLETED',
    duration: timingResult.beatGraph.beats[0].duration,
    renderSpec: { type: 'ASSET_PLACEMENT', assetId: 'asset-1' },
    sourceAssetIds: ['asset-1'],
  });

  const compiled = compileTimeline(timingResult.beatGraph, [resolution], [execution]);

  assert.equal(compiled.shots[0].startTime, 0);
  assert.equal(compiled.shots[0].duration, 6.25);
  assert.equal(compiled.diagnostics.some((d) => d.code === 'TIMING_INFERRED'), false);
});

// ================================================================================================
// REAL PIPELINE PROOF (Part 10) — VisualBeat -> NarrationDirection -> real
// voice provider -> real audio Asset -> real Whisper alignment -> AudioEvent
// -> narration timing -> BeatGraph timing. No fabricated AudioEvents in
// this section.
// ================================================================================================

function newProject() {
  return projectStore.createProject({ title: 'P0-3A real pipeline proof', topic: 'narration timing' });
}

test('25. REAL PIPELINE — single-beat narration: real measured duration becomes the beat\'s real duration', () => {
  const project = newProject();
  const b = beat({ id: 'p3a-b1', narrationSegment: narrated('p3a-script-1') });
  const bg = createBeatGraph({ projectId: project.id, beats: [b], edges: [] });

  const nd = directNarration({ scriptRefId: 'p3a-script-1', text: 'The narrator explains exactly what happens in this single shot.', beats: [{ beatId: 'p3a-b1', narrativeRole: 'EXPLANATION' }] });
  assert.equal(nd.status, 'COMPLETED');
  const voiceResult = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd });
  assert.equal(voiceResult.status, 'COMPLETED');
  assert.equal(voiceResult.audioEvent.beatId, 'p3a-b1');

  const result = applyNarrationTiming(bg, [voiceResult.audioEvent]);

  assert.equal(result.status, 'APPLIED');
  assert.equal(result.beatGraph.beats[0].duration, voiceResult.audioEvent.duration);
  assert.ok(result.beatGraph.beats[0].duration > 0);
});

test('26. REAL PIPELINE — two beats with independently, separately generated narration each get their own distinct measured duration', () => {
  const project = newProject();
  const bX = beat({ id: 'p3a-bX', narrationSegment: narrated('p3a-script-x') });
  const bY = beat({ id: 'p3a-bY', sequence: 2, narrationSegment: narrated('p3a-script-y') });
  const bg = createBeatGraph({ projectId: project.id, beats: [bX, bY], edges: [] });

  const ndX = directNarration({ scriptRefId: 'p3a-script-x', text: 'Short line for the first beat.', beats: [{ beatId: 'p3a-bX' }] });
  const ndY = directNarration({ scriptRefId: 'p3a-script-y', text: 'This second beat has a noticeably longer narration line than the first one.', beats: [{ beatId: 'p3a-bY' }] });
  const voiceX = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: ndX });
  const voiceY = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: ndY });
  assert.equal(voiceX.status, 'COMPLETED');
  assert.equal(voiceY.status, 'COMPLETED');

  const result = applyNarrationTiming(bg, [voiceX.audioEvent, voiceY.audioEvent]);

  assert.equal(result.status, 'APPLIED');
  assert.equal(result.appliedBeatCount, 2);
  assert.equal(result.beatGraph.beats[0].duration, voiceX.audioEvent.duration);
  assert.equal(result.beatGraph.beats[1].duration, voiceY.audioEvent.duration);
  assert.notEqual(result.beatGraph.beats[0].duration, result.beatGraph.beats[1].duration);
});

test('27. REAL PIPELINE — a non-narrated beat mixed into the same graph as real narrated beats stays completely untouched', () => {
  const project = newProject();
  const narratedBeat = beat({ id: 'p3a-bN', narrationSegment: narrated('p3a-script-n') });
  const silentBeat = beat({ id: 'p3a-bS', sequence: 2, startTime: 40, duration: 7 });
  const bg = createBeatGraph({ projectId: project.id, beats: [narratedBeat, silentBeat], edges: [] });

  const nd = directNarration({ scriptRefId: 'p3a-script-n', text: 'This beat has real narration.', beats: [{ beatId: 'p3a-bN' }] });
  const voice = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd });

  const result = applyNarrationTiming(bg, [voice.audioEvent]);

  const silent = result.beatGraph.beats.find((b) => b.id === 'p3a-bS');
  assert.equal(silent.startTime, 40);
  assert.equal(silent.duration, 7);
});

test('28. REAL PIPELINE — a real AudioEvent from a multi-beat NarrationDirection resolves to beatId: null and is correctly refused as unresolvable', () => {
  const project = newProject();
  const bM1 = beat({ id: 'p3a-mb1', narrationSegment: narrated('p3a-script-multi') });
  const bM2 = beat({ id: 'p3a-mb2', sequence: 2, narrationSegment: narrated('p3a-script-multi') });
  const bg = createBeatGraph({ projectId: project.id, beats: [bM1, bM2], edges: [] });

  const nd = directNarration({
    scriptRefId: 'p3a-script-multi',
    text: 'This single narration line is deliberately meant to cover two separate visual beats at once.',
    beats: [{ beatId: 'p3a-mb1', narrativeRole: 'EXPLANATION' }, { beatId: 'p3a-mb2', narrativeRole: 'REVEAL' }],
  });
  assert.deepEqual(nd.beatIds, ['p3a-mb1', 'p3a-mb2']);
  const voice = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd });
  assert.equal(voice.status, 'COMPLETED');
  assert.equal(voice.audioEvent.beatId, null); // real, upstream-confirmed ambiguity

  const result = applyNarrationTiming(bg, [voice.audioEvent]);

  assert.equal(result.diagnostics.some((d) => d.code === 'MULTI_BEAT_TIMING_UNRESOLVED'), true);
  assert.equal(result.diagnostics.filter((d) => d.code === 'NARRATION_TIMING_UNRESOLVABLE').length, 2);
  assert.equal(result.beatGraph.beats[0].duration, null);
  assert.equal(result.beatGraph.beats[1].duration, null);
});

// Stage 26.7, Part 15 — the required integration proof:
//
//   audio metadata -> timing representation -> Beat/Timeline relationship
//
// No network call, no TTS, no Whisper, no FFmpeg, no rendered file. This
// proves the DATA MODEL correctly connects a real VisualBeat, a real Asset
// (type: 'audio'), and a real AudioEvent — using lightweight synthetic
// metadata fixtures, since no real audio-producing infrastructure exists
// yet (confirmed by this stage's own audit). It also proves Part 16's
// backward-compatibility requirement: an existing, purely visual
// VisualBeat/Timeline Compiler path is completely unaffected by any of
// this — audio is additive, never mandatory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-audio-timing-proof-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const timelineStore = require('../services/timeline-store');
const { createVisualBeat, createNarrationSegment } = require('../schemas/visual-beat-schema');
const { createAudioEvent } = require('../schemas/audio-schema');
const { createBeatGraph } = require('../schemas/beat-graph-schema');
const { createMaterialResolution, createCandidateResult } = require('../schemas/material-resolution-schema');
const { createExecutionResult } = require('../schemas/material-execution-schema');
const { compileTimeline } = require('../services/timeline-compiler-service');

function makeStoredAudioAsset(projectId, overrides = {}) {
  const asset = timelineStore.addAsset(projectId, { assetId: crypto.randomUUID(), type: 'audio', ...overrides });
  timelineStore.updateAssetStorage(projectId, asset.assetId, { status: 'STORED', provider: 'local', path: `${asset.assetId}.wav`, contentType: 'audio/wav' });
  return timelineStore.getAsset(projectId, asset.assetId);
}

test('audio metadata -> timing representation -> Beat relationship — Case A: one beat covers the whole narration segment', () => {
  const project = projectStore.createProject({ title: 'EVOLINK STAGE 26.7 DISPOSABLE PROOF', topic: 'audio timing proof' });
  const audioAsset = makeStoredAudioAsset(project.id);

  // A real VisualBeat whose narrationSegment IS its timing contract —
  // docs/architecture/stage-26.2-visual-production-master-spec.md, Section
  // 15's Case A, already-existing schema, unchanged by this stage.
  const beat = createVisualBeat({
    sceneId: 's1',
    shotId: 'sh1',
    sequence: 1,
    startTime: 0,
    duration: 6.42,
    visualTreatment: 'STILL_IMAGE',
    narrationSegment: createNarrationSegment({ text: "The problem is bigger than you think.", scriptRefId: 'line-1', startOffset: 0, endOffset: 6.42 }),
  });

  // A real AudioEvent, joined to the SAME beat via beatId AND the SAME
  // scriptRefId narrationSegment already carries — the join key a future
  // sync stage (Part 7) would use.
  const audioEvent = createAudioEvent({
    type: 'NARRATION',
    status: 'READY',
    startTime: 0,
    duration: 6.42, // happens to match the plan here — Case B below shows a genuine mismatch
    sourceAssetId: audioAsset.assetId,
    scriptRefId: beat.narrationSegment.scriptRefId,
    beatId: beat.id,
    sceneId: beat.sceneId,
    transcript: { text: beat.narrationSegment.text },
  });

  // --- the correlation Part 7's future sync model depends on ---
  assert.equal(audioEvent.scriptRefId, beat.narrationSegment.scriptRefId, 'AudioEvent and VisualBeat must share the same scriptRefId join key');
  assert.equal(audioEvent.beatId, beat.id);
  assert.equal(audioEvent.sceneId, beat.sceneId);

  // --- the audio asset is a REAL, STORED Asset — never a second asset model ---
  const resolvedAsset = timelineStore.getAsset(project.id, audioEvent.sourceAssetId);
  assert.ok(resolvedAsset, 'AudioEvent.sourceAssetId must resolve to a real Asset');
  assert.equal(resolvedAsset.type, 'audio');
  assert.equal(resolvedAsset.storage.status, 'STORED');

  // --- PLANNED (beat) vs ACTUAL (AudioEvent) stay two distinct fields, never conflated ---
  assert.equal(beat.duration, 6.42);
  assert.equal(audioEvent.duration, 6.42);
  assert.equal('plannedDuration' in audioEvent, false);
  assert.equal('duration' in beat.narrationSegment === false, true, 'narrationSegment has no duration field of its own — only startOffset/endOffset');
});

test('audio metadata -> timing representation -> Beat relationship — Case B: PLANNED vs ACTUAL genuinely diverge, never silently reconciled', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const audioAsset = makeStoredAudioAsset(project.id);

  const beat = createVisualBeat({
    sceneId: 's1',
    shotId: 'sh1',
    sequence: 1,
    startTime: 0,
    duration: 5.0, // PLANNED
    visualTreatment: 'STILL_IMAGE',
    narrationSegment: createNarrationSegment({ text: 'A slightly longer sentence than planned.', scriptRefId: 'line-2', startOffset: 0, endOffset: 5.0 }),
  });

  const audioEvent = createAudioEvent({
    type: 'NARRATION',
    status: 'READY',
    startTime: 0,
    duration: 5.72, // ACTUAL measured — genuinely different from the plan
    sourceAssetId: audioAsset.assetId,
    scriptRefId: beat.narrationSegment.scriptRefId,
    beatId: beat.id,
    sceneId: beat.sceneId,
  });

  assert.notEqual(beat.duration, audioEvent.duration, 'planned and actual duration are allowed to genuinely diverge');
  // The schema itself performs NO reconciliation — that is a future Timeline
  // Compiler extension's job (see schemas/audio-schema.js's own header
  // comment), not implemented this stage. This test proves only that the
  // two numbers are stored independently and neither silently overwrites
  // the other.
  assert.equal(beat.duration, 5.0);
  assert.equal(audioEvent.duration, 5.72);
});

test('audio metadata -> timing representation -> Beat relationship — Case B (Section 15): multiple beats subdividing ONE narration segment share the same scriptRefId', () => {
  const project = projectStore.createProject({ title: 'x', topic: 'y' });
  const audioAsset = makeStoredAudioAsset(project.id);

  const scriptRefId = 'line-3';
  const beat1 = createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 1.4, visualTreatment: 'STILL_IMAGE', narrationSegment: createNarrationSegment({ text: 'Part one.', scriptRefId, startOffset: 0, endOffset: 1.4 }) });
  const beat2 = createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 2, startTime: 1.4, duration: 1.4, visualTreatment: 'STILL_IMAGE', narrationSegment: createNarrationSegment({ text: 'Part two.', scriptRefId, startOffset: 1.4, endOffset: 2.8 }) });
  const beat3 = createVisualBeat({ sceneId: 's1', shotId: 'sh1', sequence: 3, startTime: 2.8, duration: 1.4, visualTreatment: 'STILL_IMAGE', narrationSegment: createNarrationSegment({ text: 'Part three.', scriptRefId, startOffset: 2.8, endOffset: 4.2 }) });

  // ONE AudioEvent for the whole segment — beats subdivide it, per Section 15.
  const audioEvent = createAudioEvent({
    type: 'NARRATION',
    status: 'READY',
    startTime: 0,
    duration: 4.2,
    sourceAssetId: audioAsset.assetId,
    scriptRefId,
    sceneId: 's1',
    // beatId stays null deliberately — this event spans THREE beats, not one;
    // correlation for a subdivided segment happens via scriptRefId, not beatId.
  });

  for (const beat of [beat1, beat2, beat3]) {
    assert.equal(beat.narrationSegment.scriptRefId, audioEvent.scriptRefId, `${beat.id} must share the AudioEvent's scriptRefId to be correlated`);
  }
  assert.equal(audioEvent.beatId, null, 'a segment-spanning AudioEvent legitimately has no single owning beat');
});

test('Part 16 backward compatibility — an existing, purely visual VisualBeat/Timeline Compiler path is completely unaffected by audio-schema.js', () => {
  const beat = createVisualBeat({ id: crypto.randomUUID(), sceneId: 's1', shotId: 'sh1', sequence: 1, startTime: 0, duration: 5, visualTreatment: 'MOTION_GRAPHIC' });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const resolution = createMaterialResolution({
    beatId: beat.id,
    status: 'RESOLVED',
    selectedMaterial: createCandidateResult({ candidate: 'M1', materialSource: 'DETERMINISTIC_TEMPLATE', visualTreatment: 'MOTION_GRAPHIC', role: 'PRIMARY' }),
  });
  const execution = createExecutionResult({ beatId: beat.id, materialId: 'M1', executorType: 'MOTION_GRAPHIC', status: 'COMPLETED', duration: 5, renderSpec: { type: 'MOTION_GRAPHIC', duration: 5 }, sourceAssetIds: [] });

  const result = compileTimeline(graph, [resolution], [execution]);

  assert.equal(result.status, 'COMPILED');
  assert.equal(result.shots.length, 1);
  // no audioEvents were ever supplied, and none is expected — TimelineIR's
  // own audio[] field is untouched by this compilation, exactly as before
  // this stage existed.
  assert.equal(result.shots[0].beatId, beat.id);
  assert.equal(result.shots[0].renderSpec.type, 'MOTION_GRAPHIC');
});

test('no network/provider/generation call anywhere in this fixture — static scan', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'audio-schema.js'), 'utf8');
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
});

// Tests for services/timeline-compiler-service.js — Stage 26.6, Part 2.
// Pure aggregation: BeatGraph + MaterialResolution[] + ExecutionResult[] ->
// compiled Shot[] (schemas/production-schema.js's EXISTING Shot shape).
// Never re-resolves, never re-executes, never persists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createVisualBeat } = require('../schemas/visual-beat-schema');
const { createBeatGraph, createBeatEdge } = require('../schemas/beat-graph-schema');
const { createMaterialResolution, createCandidateResult } = require('../schemas/material-resolution-schema');
const { createExecutionResult } = require('../schemas/material-execution-schema');
const { compileTimeline } = require('../services/timeline-compiler-service');

// --- fixture helpers -------------------------------------------------------------------

function makeBeat(overrides = {}) {
  return createVisualBeat({ id: crypto.randomUUID(), sceneId: 's1', shotId: 'sh1', sequence: 1, visualTreatment: 'STILL_IMAGE', ...overrides });
}

function makeResolution(beatId, materialId, overrides = {}) {
  return createMaterialResolution({
    beatId,
    status: 'RESOLVED',
    selectedMaterial: createCandidateResult({
      candidate: materialId,
      materialSource: 'PROJECT_ASSET_REUSE',
      visualTreatment: 'STILL_IMAGE',
      role: 'PRIMARY',
      ...overrides,
    }),
  });
}

function makeExecution(beatId, materialId, { duration, renderSpec, sourceAssetIds = [], status = 'COMPLETED', diagnostics = [] } = {}) {
  return createExecutionResult({
    beatId,
    materialId,
    executorType: 'PROJECT_ASSET_REUSE',
    status,
    duration,
    renderSpec,
    sourceAssetIds,
    diagnostics,
  });
}

// Strips the fields that are legitimately fresh on every call (shotId,
// executionId is NOT stripped — it must be PRESERVED, see Q/U below) so two
// separate compileTimeline() calls can be compared for logical equivalence.
function normalizeShot(shot) {
  const { shotId, ...rest } = shot;
  return rest;
}
function normalizeResult(result) {
  const { id, createdAt, shots, ...rest } = result;
  return { ...rest, shots: shots.map(normalizeShot) };
}

// ===========================================================================
// A. Single beat, explicit start/duration
// ===========================================================================

test('A. a single beat with explicit execution-level start/duration compiles to one Shot with exactly those values', () => {
  const beat = makeBeat({ startTime: 99, duration: 99 }); // deliberately WRONG at beat level, to prove tier 1 (execution) wins
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const resolution = makeResolution(beat.id, 'M1');
  const execution = makeExecution(beat.id, 'M1', { duration: 4, renderSpec: { type: 'ASSET_PLACEMENT', assetId: 'a1', startTime: 2, duration: 4 }, sourceAssetIds: ['a1'] });

  const result = compileTimeline(graph, [resolution], [execution]);

  assert.equal(result.status, 'COMPILED');
  assert.equal(result.shots.length, 1);
  assert.equal(result.shots[0].startTime, 2);
  assert.equal(result.shots[0].duration, 4);
});

// ===========================================================================
// B. Multiple sequential beats
// ===========================================================================

test('B. multiple sequential beats (explicit beat-level timing) each compile to their own contiguous Shot', () => {
  const beat1 = makeBeat({ sequence: 1, startTime: 0, duration: 5 });
  const beat2 = makeBeat({ sequence: 2, startTime: 5, duration: 3 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat1, beat2] });

  const resolutions = [makeResolution(beat1.id, 'M1'), makeResolution(beat2.id, 'M2')];
  const executions = [
    makeExecution(beat1.id, 'M1', { duration: 5, renderSpec: { type: 'MOTION_GRAPHIC', duration: 5 } }),
    makeExecution(beat2.id, 'M2', { duration: 3, renderSpec: { type: 'MOTION_GRAPHIC', duration: 3 } }),
  ];

  const result = compileTimeline(graph, resolutions, executions);

  assert.equal(result.status, 'COMPILED');
  assert.equal(result.shots.length, 2);
  const byBeat = Object.fromEntries(result.shots.map((s) => [s.beatId, s]));
  assert.equal(byBeat[beat1.id].startTime, 0);
  assert.equal(byBeat[beat2.id].startTime, 5);
  assert.equal(result.diagnostics.some((d) => d.code === 'TIMELINE_GAP'), false, 'contiguous beats must not report a gap');
});

// ===========================================================================
// C/D. Hybrid beat — three overlapping materials on different layers
// ===========================================================================

test('C/D. a hybrid beat with three materials (PRIMARY/OVERLAY/OVERLAY) all share the same beat-level time window — intentional overlap', () => {
  const beat = makeBeat({ startTime: 10, duration: 5 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });

  const resolutions = [
    makeResolution(beat.id, 'M-PRIMARY', { role: 'PRIMARY', materialSource: 'BROLL_LIBRARY', visualTreatment: 'BROLL_CLIP' }),
    makeResolution(beat.id, 'M-OVERLAY-1', { role: 'OVERLAY', materialSource: 'DETERMINISTIC_TEMPLATE', visualTreatment: 'MOTION_GRAPHIC' }),
    makeResolution(beat.id, 'M-OVERLAY-2', { role: 'OVERLAY', materialSource: 'DETERMINISTIC_TEMPLATE', visualTreatment: 'KINETIC_TYPOGRAPHY' }),
  ];
  const executions = [
    makeExecution(beat.id, 'M-PRIMARY', { duration: 5, renderSpec: { type: 'BROLL_CLIP', duration: 5 } }),
    makeExecution(beat.id, 'M-OVERLAY-1', { duration: 5, renderSpec: { type: 'MOTION_GRAPHIC', duration: 5 } }),
    makeExecution(beat.id, 'M-OVERLAY-2', { duration: 5, renderSpec: { type: 'KINETIC_TYPOGRAPHY', duration: 5 } }),
  ];

  const result = compileTimeline(graph, resolutions, executions);

  assert.equal(result.status, 'COMPILED');
  assert.equal(result.shots.length, 3);
  assert.deepEqual(result.shots.map((s) => s.layer).sort(), ['OVERLAY', 'OVERLAY', 'PRIMARY']);
  for (const shot of result.shots) {
    assert.equal(shot.startTime, 10);
    assert.equal(shot.duration, 5);
  }
  assert.equal(result.diagnostics.some((d) => d.code === 'PRIMARY_OVERLAP_FORBIDDEN'), false, 'overlap across DIFFERENT layers is intentional, never forbidden');
});

// ===========================================================================
// E. PRIMARY overlap rejection
// ===========================================================================

test('E. two different beats both claiming PRIMARY over an overlapping window are BOTH excluded, with PRIMARY_OVERLAP_FORBIDDEN diagnostics', () => {
  const beat1 = makeBeat({ sequence: 1, startTime: 0, duration: 10 });
  const beat2 = makeBeat({ sequence: 2, startTime: 5, duration: 5 }); // overlaps beat1's [0,10)
  const graph = createBeatGraph({ projectId: 'p', beats: [beat1, beat2] });

  const resolutions = [makeResolution(beat1.id, 'M1'), makeResolution(beat2.id, 'M2')];
  const executions = [
    makeExecution(beat1.id, 'M1', { duration: 10, renderSpec: { type: 'MOTION_GRAPHIC', duration: 10 } }),
    makeExecution(beat2.id, 'M2', { duration: 5, renderSpec: { type: 'MOTION_GRAPHIC', duration: 5 } }),
  ];

  const result = compileTimeline(graph, resolutions, executions);

  assert.equal(result.shots.length, 0, 'neither overlapping PRIMARY shot is arbitrarily kept as a winner');
  assert.equal(result.status, 'FAILED', 'nothing executable survived');
  const codes = result.diagnostics.map((d) => d.code);
  assert.equal(codes.filter((c) => c === 'PRIMARY_OVERLAP_FORBIDDEN').length, 2);
});

// ===========================================================================
// F/G/H/I. Timing invariant rejections
// ===========================================================================

test('F. a negative startTime (explicit at execution level) is rejected with NEGATIVE_START_TIME, never silently clamped to 0', () => {
  const beat = makeBeat();
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const resolution = makeResolution(beat.id, 'M1');
  const execution = makeExecution(beat.id, 'M1', { duration: 4, renderSpec: { type: 'ASSET_PLACEMENT', duration: 4, startTime: -1 } });

  const result = compileTimeline(graph, [resolution], [execution]);
  assert.equal(result.shots.length, 0);
  assert.equal(result.diagnostics[0].code, 'NEGATIVE_START_TIME');
});

test('G. a zero duration is rejected with INVALID_DURATION', () => {
  const beat = makeBeat();
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const resolution = makeResolution(beat.id, 'M1');
  const execution = makeExecution(beat.id, 'M1', { duration: 0, renderSpec: { type: 'MOTION_GRAPHIC', duration: 0 } });

  const result = compileTimeline(graph, [resolution], [execution]);
  assert.equal(result.shots.length, 0);
  assert.equal(result.diagnostics[0].code, 'INVALID_DURATION');
});

test('H. NaN duration and NaN startTime are both rejected structurally, never propagated', () => {
  const durationBeat = makeBeat({ sequence: 1 });
  const durationGraph = createBeatGraph({ projectId: 'p', beats: [durationBeat] });
  const nanDuration = compileTimeline(
    durationGraph,
    [makeResolution(durationBeat.id, 'M1')],
    [makeExecution(durationBeat.id, 'M1', { duration: NaN, renderSpec: { type: 'MOTION_GRAPHIC', duration: NaN } })]
  );
  assert.equal(nanDuration.shots.length, 0);
  assert.equal(nanDuration.diagnostics.find((d) => d.beatId === durationBeat.id).code, 'INVALID_DURATION');

  const startBeat = makeBeat({ sequence: 1 });
  const startGraph = createBeatGraph({ projectId: 'p', beats: [startBeat] });
  const nanStart = compileTimeline(
    startGraph,
    [makeResolution(startBeat.id, 'M2')],
    [makeExecution(startBeat.id, 'M2', { duration: 3, renderSpec: { type: 'ASSET_PLACEMENT', duration: 3, startTime: NaN } })]
  );
  assert.equal(nanStart.shots.length, 0);
  assert.equal(nanStart.diagnostics.find((d) => d.beatId === startBeat.id).code, 'NEGATIVE_START_TIME');
});

test('I. Infinity duration and Infinity startTime are both rejected structurally', () => {
  const durationBeat = makeBeat({ sequence: 1 });
  const durationGraph = createBeatGraph({ projectId: 'p', beats: [durationBeat] });
  const infDuration = compileTimeline(
    durationGraph,
    [makeResolution(durationBeat.id, 'M1')],
    [makeExecution(durationBeat.id, 'M1', { duration: Infinity, renderSpec: { type: 'MOTION_GRAPHIC', duration: Infinity } })]
  );
  assert.equal(infDuration.shots.length, 0);
  assert.equal(infDuration.diagnostics.find((d) => d.beatId === durationBeat.id).code, 'INVALID_DURATION');

  const startBeat = makeBeat({ sequence: 1 });
  const startGraph = createBeatGraph({ projectId: 'p', beats: [startBeat] });
  const infStart = compileTimeline(
    startGraph,
    [makeResolution(startBeat.id, 'M2')],
    [makeExecution(startBeat.id, 'M2', { duration: 3, renderSpec: { type: 'ASSET_PLACEMENT', duration: 3, startTime: Infinity } })]
  );
  assert.equal(infStart.shots.length, 0);
  assert.equal(infStart.diagnostics.find((d) => d.beatId === startBeat.id).code, 'NEGATIVE_START_TIME');
});

// ===========================================================================
// J. Explicit timing preserved exactly
// ===========================================================================

test('J. explicit timing is preserved exactly — no rounding, no unit conversion', () => {
  const beat = makeBeat({ startTime: 12.345, duration: 6.789 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const resolution = makeResolution(beat.id, 'M1');
  const execution = makeExecution(beat.id, 'M1', { duration: 6.789, renderSpec: { type: 'MOTION_GRAPHIC', duration: 6.789 } }); // no renderSpec.startTime -> falls to beat.startTime

  const result = compileTimeline(graph, [resolution], [execution]);
  assert.equal(result.shots[0].startTime, 12.345);
  assert.equal(result.shots[0].duration, 6.789);
});

// ===========================================================================
// K. Deterministic inferred timing
// ===========================================================================

test('K. inferred timing is deterministic — three unplaced beats in a row each start exactly where the previous one ended', () => {
  const beat1 = makeBeat({ sequence: 1, startTime: null, duration: 4 });
  const beat2 = makeBeat({ sequence: 2, startTime: null, duration: 3 });
  const beat3 = makeBeat({ sequence: 3, startTime: null, duration: 2 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat1, beat2, beat3] });

  const resolutions = [makeResolution(beat1.id, 'M1'), makeResolution(beat2.id, 'M2'), makeResolution(beat3.id, 'M3')];
  const executions = [
    makeExecution(beat1.id, 'M1', { duration: 4, renderSpec: { type: 'MOTION_GRAPHIC', duration: 4 } }),
    makeExecution(beat2.id, 'M2', { duration: 3, renderSpec: { type: 'MOTION_GRAPHIC', duration: 3 } }),
    makeExecution(beat3.id, 'M3', { duration: 2, renderSpec: { type: 'MOTION_GRAPHIC', duration: 2 } }),
  ];

  const result = compileTimeline(graph, resolutions, executions);
  const byBeat = Object.fromEntries(result.shots.map((s) => [s.beatId, s]));
  assert.equal(byBeat[beat1.id].startTime, 0);
  assert.equal(byBeat[beat2.id].startTime, 4);
  assert.equal(byBeat[beat3.id].startTime, 7);
  assert.equal(result.diagnostics.filter((d) => d.code === 'TIMING_INFERRED').length, 3);
});

// ===========================================================================
// L. Gaps allowed
// ===========================================================================

test('L. a legitimate gap between two beats is allowed and reported, never filled with an invented shot', () => {
  const beat1 = makeBeat({ sequence: 1, startTime: 0, duration: 5 });
  const beat2 = makeBeat({ sequence: 2, startTime: 7, duration: 5 }); // gap [5,7)
  const graph = createBeatGraph({ projectId: 'p', beats: [beat1, beat2] });

  const resolutions = [makeResolution(beat1.id, 'M1'), makeResolution(beat2.id, 'M2')];
  const executions = [
    makeExecution(beat1.id, 'M1', { duration: 5, renderSpec: { type: 'MOTION_GRAPHIC', duration: 5 } }),
    makeExecution(beat2.id, 'M2', { duration: 5, renderSpec: { type: 'MOTION_GRAPHIC', duration: 5 } }),
  ];

  const result = compileTimeline(graph, resolutions, executions);
  assert.equal(result.shots.length, 2, 'exactly the two real shots — no filler inserted');
  assert.equal(result.status, 'COMPILED');
  const gapDiag = result.diagnostics.find((d) => d.code === 'TIMELINE_GAP');
  assert.ok(gapDiag);
  assert.match(gapDiag.message, /2s/);
});

// ===========================================================================
// M/N/O. Failure isolation
// ===========================================================================

test('M. a failed/unresolved beat in the middle does not stop earlier or later beats from compiling', () => {
  const beat1 = makeBeat({ sequence: 1, startTime: 0, duration: 3 });
  const beat2 = makeBeat({ sequence: 2, startTime: 3, duration: 3 });
  const beat3 = makeBeat({ sequence: 3, startTime: 6, duration: 3 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat1, beat2, beat3] });

  const resolutions = [makeResolution(beat1.id, 'M1'), makeResolution(beat2.id, 'M2'), makeResolution(beat3.id, 'M3')];
  const executions = [
    makeExecution(beat1.id, 'M1', { duration: 3, renderSpec: { type: 'MOTION_GRAPHIC', duration: 3 } }),
    makeExecution(beat2.id, 'M2', { duration: 3, renderSpec: { type: 'MOTION_GRAPHIC', duration: 3 }, status: 'FAILED', diagnostics: [{ code: 'EXECUTOR_THREW', message: 'boom' }] }),
    makeExecution(beat3.id, 'M3', { duration: 3, renderSpec: { type: 'MOTION_GRAPHIC', duration: 3 } }),
  ];

  const result = compileTimeline(graph, resolutions, executions);

  assert.equal(result.status, 'PARTIAL');
  const compiledBeatIds = result.shots.map((s) => s.beatId).sort();
  assert.deepEqual(compiledBeatIds.sort(), [beat1.id, beat3.id].sort());
  assert.equal(result.diagnostics.some((d) => d.code === 'EXECUTION_FAILED' && d.beatId === beat2.id), true);
});

test('N. an UNRESOLVED MaterialResolution never produces a Shot', () => {
  const beat = makeBeat();
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const resolution = createMaterialResolution({ beatId: beat.id, status: 'UNRESOLVED', selectedMaterial: null });

  const result = compileTimeline(graph, [resolution], []);
  assert.equal(result.shots.length, 0);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'UNRESOLVED_BEAT');
});

test('O. an execution with status FAILED never produces a Shot', () => {
  const beat = makeBeat();
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const resolution = makeResolution(beat.id, 'M1');
  const execution = makeExecution(beat.id, 'M1', { duration: null, renderSpec: null, status: 'FAILED', diagnostics: [{ code: 'ASSET_NOT_FOUND', message: 'x' }] });

  const result = compileTimeline(graph, [resolution], [execution]);
  assert.equal(result.shots.length, 0);
  assert.equal(result.diagnostics[0].code, 'EXECUTION_FAILED');
  assert.match(result.diagnostics[0].message, /ASSET_NOT_FOUND/);
});

// ===========================================================================
// P. renderSpec copied verbatim
// ===========================================================================

test('P. renderSpec is copied onto the Shot verbatim — same object identity is not required, but deep equality must be exact, nothing added or removed', () => {
  const beat = makeBeat();
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const resolution = makeResolution(beat.id, 'M1', { materialSource: 'BROLL_LIBRARY', visualTreatment: 'BROLL_CLIP' });
  const renderSpec = {
    type: 'BROLL_CLIP',
    sourceAssetId: 'a1',
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
  };
  const execution = makeExecution(beat.id, 'M1', { duration: 5, renderSpec, sourceAssetIds: ['a1'] });

  const result = compileTimeline(graph, [resolution], [execution]);
  assert.deepEqual(result.shots[0].renderSpec, renderSpec);
  assert.deepEqual(Object.keys(result.shots[0].renderSpec).sort(), Object.keys(renderSpec).sort());
});

// ===========================================================================
// Q. Provenance preserved
// ===========================================================================

test('Q. beatId/materialId/executionId provenance is preserved exactly', () => {
  const beat = makeBeat();
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const resolution = makeResolution(beat.id, 'THE-MATERIAL-ID');
  const execution = createExecutionResult({
    beatId: beat.id,
    materialId: 'THE-MATERIAL-ID',
    executorType: 'PROJECT_ASSET_REUSE',
    status: 'COMPLETED',
    duration: 5,
    renderSpec: { type: 'ASSET_PLACEMENT', duration: 5 },
    sourceAssetIds: [],
  });

  const result = compileTimeline(graph, [resolution], [execution]);
  assert.equal(result.shots[0].beatId, beat.id);
  assert.equal(result.shots[0].materialId, 'THE-MATERIAL-ID');
  assert.equal(result.shots[0].executionId, execution.executionId);
});

// ===========================================================================
// R/S. Transitions
// ===========================================================================

test('R. a TRANSITIONS_TO edge between two compiled beats converts into timeline.transitions[]', () => {
  const beat1 = makeBeat({ sequence: 1, startTime: 0, duration: 3 });
  const beat2 = makeBeat({ sequence: 2, startTime: 3, duration: 3 });
  const edge = createBeatEdge({ fromBeatId: beat1.id, toBeatId: beat2.id, kind: 'TRANSITIONS_TO', note: 'cross-fade' });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat1, beat2], edges: [edge] });

  const resolutions = [makeResolution(beat1.id, 'M1'), makeResolution(beat2.id, 'M2')];
  const executions = [
    makeExecution(beat1.id, 'M1', { duration: 3, renderSpec: { type: 'MOTION_GRAPHIC', duration: 3 } }),
    makeExecution(beat2.id, 'M2', { duration: 3, renderSpec: { type: 'MOTION_GRAPHIC', duration: 3 } }),
  ];

  const result = compileTimeline(graph, resolutions, executions);
  assert.equal(result.transitions.length, 1);
  assert.equal(result.transitions[0].fromBeatId, beat1.id);
  assert.equal(result.transitions[0].toBeatId, beat2.id);
  assert.equal(result.transitions[0].kind, 'TRANSITIONS_TO');
  assert.equal(result.transitions[0].note, 'cross-fade');
});

test('S. a TRANSITIONS_TO edge referencing a nonexistent beat produces INVALID_TRANSITION, no fabricated transition', () => {
  const beat1 = makeBeat({ sequence: 1, startTime: 0, duration: 3 });
  const edge = createBeatEdge({ fromBeatId: beat1.id, toBeatId: 'does-not-exist', kind: 'TRANSITIONS_TO' });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat1], edges: [edge] });

  const result = compileTimeline(graph, [makeResolution(beat1.id, 'M1')], [makeExecution(beat1.id, 'M1', { duration: 3, renderSpec: { type: 'MOTION_GRAPHIC', duration: 3 } })]);
  assert.equal(result.transitions.length, 0);
  assert.equal(result.diagnostics.some((d) => d.code === 'INVALID_TRANSITION'), true);
});

test('S2. a TRANSITIONS_TO edge referencing a beat that exists but produced no compiled Shot also produces INVALID_TRANSITION', () => {
  const beat1 = makeBeat({ sequence: 1, startTime: 0, duration: 3 });
  const beat2 = makeBeat({ sequence: 2 }); // never resolved
  const edge = createBeatEdge({ fromBeatId: beat1.id, toBeatId: beat2.id, kind: 'TRANSITIONS_TO' });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat1, beat2], edges: [edge] });

  const result = compileTimeline(graph, [makeResolution(beat1.id, 'M1')], [makeExecution(beat1.id, 'M1', { duration: 3, renderSpec: { type: 'MOTION_GRAPHIC', duration: 3 } })]);
  assert.equal(result.transitions.length, 0);
  assert.equal(result.diagnostics.some((d) => d.code === 'INVALID_TRANSITION'), true);
});

// ===========================================================================
// T/U. Determinism
// ===========================================================================

test('T. deterministic ordering regardless of input array order — shuffled resolutions/executions produce the identical logical shots array', () => {
  const beats = [1, 2, 3, 4].map((n) => makeBeat({ sequence: n, startTime: (n - 1) * 2, duration: 2 }));
  const graph = createBeatGraph({ projectId: 'p', beats });
  const resolutions = beats.map((b, i) => makeResolution(b.id, `M${i}`));
  const executions = beats.map((b, i) => makeExecution(b.id, `M${i}`, { duration: 2, renderSpec: { type: 'MOTION_GRAPHIC', duration: 2 } }));

  const forward = compileTimeline(graph, resolutions, executions);
  const shuffled = compileTimeline(graph, [...resolutions].reverse(), [...executions].sort(() => 0.5 - Math.random()));

  assert.deepEqual(forward.shots.map(normalizeShot), shuffled.shots.map(normalizeShot));
});

test('U. repeated compilation with identical inputs produces logically equivalent output', () => {
  const beat = makeBeat({ startTime: 1, duration: 2 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const resolution = makeResolution(beat.id, 'M1');
  const execution = makeExecution(beat.id, 'M1', { duration: 2, renderSpec: { type: 'MOTION_GRAPHIC', duration: 2 } });

  const first = compileTimeline(graph, [resolution], [execution]);
  const second = compileTimeline(graph, [resolution], [execution]);

  assert.deepEqual(normalizeResult(first), normalizeResult(second));
  assert.equal(first.shots[0].executionId, second.shots[0].executionId, 'a pre-existing executionId must be preserved identically, never regenerated');
});

// ===========================================================================
// V. No input mutation
// ===========================================================================

test('V. compileTimeline never mutates beatGraph, resolutions, or executions', () => {
  const beat = makeBeat({ startTime: 0, duration: 5 });
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const resolution = makeResolution(beat.id, 'M1');
  const execution = makeExecution(beat.id, 'M1', { duration: 5, renderSpec: { type: 'MOTION_GRAPHIC', duration: 5 } });

  const graphBefore = JSON.stringify(graph);
  const resolutionBefore = JSON.stringify(resolution);
  const executionBefore = JSON.stringify(execution);

  compileTimeline(graph, [resolution], [execution]);

  assert.equal(JSON.stringify(graph), graphBefore);
  assert.equal(JSON.stringify(resolution), resolutionBefore);
  assert.equal(JSON.stringify(execution), executionBefore);
});

// ===========================================================================
// W. Empty graph
// ===========================================================================

test('W. an empty BeatGraph (beats: []) is a valid COMPILED result, never a failure', () => {
  const graph = createBeatGraph({ projectId: 'p', beats: [] });
  const result = compileTimeline(graph, [], []);
  assert.equal(result.status, 'COMPILED');
  assert.deepEqual(result.shots, []);
  assert.deepEqual(result.diagnostics, []);
});

// ===========================================================================
// X. Mixed valid/invalid beats
// ===========================================================================

test('X. a mix of valid, unresolved, and execution-failed beats produces PARTIAL with precise per-beat diagnostics', () => {
  const valid = makeBeat({ sequence: 1, startTime: 0, duration: 2 });
  const unresolved = makeBeat({ sequence: 2 });
  const failed = makeBeat({ sequence: 3, startTime: 2, duration: 2 });
  const graph = createBeatGraph({ projectId: 'p', beats: [valid, unresolved, failed] });

  const resolutions = [
    makeResolution(valid.id, 'MV'),
    createMaterialResolution({ beatId: unresolved.id, status: 'UNRESOLVED', selectedMaterial: null }),
    makeResolution(failed.id, 'MF'),
  ];
  const executions = [
    makeExecution(valid.id, 'MV', { duration: 2, renderSpec: { type: 'MOTION_GRAPHIC', duration: 2 } }),
    makeExecution(failed.id, 'MF', { duration: null, renderSpec: null, status: 'FAILED' }),
  ];

  const result = compileTimeline(graph, resolutions, executions);
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.shots.length, 1);
  assert.equal(result.shots[0].beatId, valid.id);
  assert.equal(result.diagnostics.some((d) => d.code === 'UNRESOLVED_BEAT' && d.beatId === unresolved.id), true);
  assert.equal(result.diagnostics.some((d) => d.code === 'EXECUTION_FAILED' && d.beatId === failed.id), true);
});

// ===========================================================================
// Additional required coverage: MISSING_SOURCE_ASSET, INVALID_LAYER_ORDER,
// INVALID_BEAT_GRAPH, legacy asset routing, purity/security scan
// ===========================================================================

test('MISSING_SOURCE_ASSET fires when renderSpec references an asset absent from sourceAssetIds', () => {
  const beat = makeBeat();
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const resolution = makeResolution(beat.id, 'M1');
  const execution = makeExecution(beat.id, 'M1', { duration: 5, renderSpec: { type: 'ASSET_PLACEMENT', assetId: 'a1', duration: 5 }, sourceAssetIds: [] });

  const result = compileTimeline(graph, [resolution], [execution]);
  assert.equal(result.shots.length, 0);
  assert.equal(result.diagnostics[0].code, 'MISSING_SOURCE_ASSET');
});

test('INVALID_LAYER_ORDER fires when selectedMaterial.role is not a recognized MATERIAL_ROLES value', () => {
  const beat = makeBeat();
  const graph = createBeatGraph({ projectId: 'p', beats: [beat] });
  const resolution = makeResolution(beat.id, 'M1', { role: 'MAIN_TRACK' }); // not a real role
  const execution = makeExecution(beat.id, 'M1', { duration: 5, renderSpec: { type: 'MOTION_GRAPHIC', duration: 5 } });

  const result = compileTimeline(graph, [resolution], [execution]);
  assert.equal(result.shots.length, 0);
  assert.equal(result.diagnostics[0].code, 'INVALID_LAYER_ORDER');
});

test('INVALID_BEAT_GRAPH fires for a null/malformed BeatGraph rather than throwing', () => {
  assert.doesNotThrow(() => {
    const r1 = compileTimeline(null, [], []);
    assert.equal(r1.status, 'FAILED');
    assert.equal(r1.diagnostics[0].code, 'INVALID_BEAT_GRAPH');

    const r2 = compileTimeline({ projectId: 'p' }, [], []); // no .beats array
    assert.equal(r2.status, 'FAILED');
    assert.equal(r2.diagnostics[0].code, 'INVALID_BEAT_GRAPH');
  });
});

test('legacy keyframeAssetId/videoAssetId routing mirrors toTimelineShotFields exactly, for backward compatibility', () => {
  const stillBeat = makeBeat({ sequence: 1, visualTreatment: 'STILL_IMAGE', startTime: 0, duration: 3 });
  const videoBeat = makeBeat({ sequence: 2, visualTreatment: 'AI_VIDEO', startTime: 3, duration: 3 });
  const graphicBeat = makeBeat({ sequence: 3, visualTreatment: 'MOTION_GRAPHIC', startTime: 6, duration: 3 });
  const graph = createBeatGraph({ projectId: 'p', beats: [stillBeat, videoBeat, graphicBeat] });

  const resolutions = [
    makeResolution(stillBeat.id, 'M1', { visualTreatment: 'STILL_IMAGE' }),
    makeResolution(videoBeat.id, 'M2', { visualTreatment: 'AI_VIDEO' }),
    makeResolution(graphicBeat.id, 'M3', { visualTreatment: 'MOTION_GRAPHIC' }),
  ];
  const executions = [
    makeExecution(stillBeat.id, 'M1', { duration: 3, renderSpec: { type: 'STILL_IMAGE_MOTION', assetId: 'img1', duration: 3 }, sourceAssetIds: ['img1'] }),
    makeExecution(videoBeat.id, 'M2', { duration: 3, renderSpec: { type: 'ASSET_PLACEMENT', assetId: 'vid1', duration: 3 }, sourceAssetIds: ['vid1'] }),
    makeExecution(graphicBeat.id, 'M3', { duration: 3, renderSpec: { type: 'MOTION_GRAPHIC', duration: 3 }, sourceAssetIds: [] }),
  ];

  const result = compileTimeline(graph, resolutions, executions);
  const byBeat = Object.fromEntries(result.shots.map((s) => [s.beatId, s]));
  assert.equal(byBeat[stillBeat.id].keyframeAssetId, 'img1');
  assert.equal(byBeat[stillBeat.id].videoAssetId, null);
  assert.equal(byBeat[videoBeat.id].videoAssetId, 'vid1');
  assert.equal(byBeat[videoBeat.id].keyframeAssetId, null);
  assert.equal(byBeat[graphicBeat.id].keyframeAssetId, null);
  assert.equal(byBeat[graphicBeat.id].videoAssetId, null);
});

test('no provider/network/generation/credit calls — services/timeline-compiler-service.js requires only its own schema dependencies', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'timeline-compiler-service.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ['../schemas/production-schema', '../schemas/visual-beat-schema', '../schemas/timeline-compilation-schema'].sort());
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
  assert.doesNotMatch(text, /require\(\s*['"`][^'"`]*(approval-gate|timeline-store|material-resolution-service|material-execution-service)[^'"`]*['"`]\s*\)/);
});

test('never mentions a specific provider/model/rendering-engine name', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'timeline-compiler-service.js'), 'utf8');
  for (const forbidden of ['evolink', 'seedance', 'google', 'gemini', 'openai', 'ffmpeg', 'hyperframes', 'gsap']) {
    assert.doesNotMatch(text.toLowerCase(), new RegExp(forbidden), `must not reference "${forbidden}"`);
  }
});

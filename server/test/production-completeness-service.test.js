// PRODUCTION RELIABILITY LAYER — production-completeness-service.js.
//
// Proves the one thing this stage exists for: a job whose final assembly is
// missing a beat/narration that was clearly intended must NEVER compute as
// FULL_CONTENT. Uses hand-built, schema-shaped fixtures (not a real
// end-to-end production run) so each scenario is exact and deterministic —
// the real-pipeline proof lives in production-orchestrator-service.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeContentCompleteness } = require('../services/production-completeness-service');

function beat({ id, text = '' }) {
  return { id, narrationSegment: text ? { text } : null };
}

function shotProvenance({ beatId }) {
  return { beatId, materialId: `mat-${beatId}`, executionId: `exec-${beatId}`, renderId: `render-${beatId}`, sourceAssetId: `asset-${beatId}`, startTime: 0, duration: 3 };
}

function job({ beats = [], assembledBeatIds = [], narratedBeatIds = [], diagnostics = [] }) {
  return {
    beatGraph: { beats },
    diagnostics,
    beatProgress: narratedBeatIds.map((beatId) => ({ beatId, audioEvent: { status: 'COMPLETED' } })),
    assemblyResult: { status: 'COMPLETED', provenance: { shots: assembledBeatIds.map((beatId) => shotProvenance({ beatId })) }, expectedDuration: 9, artifact: { duration: 9 } },
  };
}

test('all expected beats assembled and narrated -> FULL_CONTENT', () => {
  const j = job({
    beats: [beat({ id: 'b1', text: 'hello' }), beat({ id: 'b2' }), beat({ id: 'b3' })],
    assembledBeatIds: ['b1', 'b2', 'b3'],
    narratedBeatIds: ['b1'],
  });
  const result = computeContentCompleteness(j);
  assert.equal(result.overall, 'FULL_CONTENT');
  assert.deepEqual(result.missingBeatIds, []);
  assert.deepEqual(result.missingNarrationBeatIds, []);
  assert.equal(result.expectedBeatCount, 3);
  assert.equal(result.assembledBeatCount, 3);
});

test('one beat missing from the final assembly -> PARTIAL_CONTENT, beat identified', () => {
  const j = job({
    beats: [beat({ id: 'b1' }), beat({ id: 'b2' }), beat({ id: 'b3' })],
    assembledBeatIds: ['b1', 'b3'], // b2 silently dropped (e.g. PRIMARY_OVERLAP_FORBIDDEN / ASSEMBLY_LAYER_UNSUPPORTED)
  });
  const result = computeContentCompleteness(j);
  assert.equal(result.overall, 'PARTIAL_CONTENT');
  assert.deepEqual(result.missingBeatIds, ['b2']);
});

test('multiple beats missing from the final assembly -> PARTIAL_CONTENT, all identified', () => {
  const j = job({
    beats: [beat({ id: 'b1' }), beat({ id: 'b2' }), beat({ id: 'b3' }), beat({ id: 'b4' })],
    assembledBeatIds: ['b1'],
  });
  const result = computeContentCompleteness(j);
  assert.equal(result.overall, 'PARTIAL_CONTENT');
  assert.deepEqual(result.missingBeatIds.sort(), ['b2', 'b3', 'b4']);
});

test('a beat excluded before the beat graph even existed (BEATGRAPH exclusion diagnostic) still counts as expected and missing', () => {
  const j = job({
    beats: [beat({ id: 'b1' }), beat({ id: 'b2' })], // only 2 beats actually exist
    assembledBeatIds: ['b1', 'b2'],
    diagnostics: [{ stage: 'BEATGRAPH', code: 'UNKNOWN_CHARACTER_REFERENCE', beatId: 'b3-rejected', message: 'unknown character' }],
  });
  const result = computeContentCompleteness(j);
  assert.equal(result.overall, 'PARTIAL_CONTENT');
  assert.deepEqual(result.missingBeatIds, ['b3-rejected']);
  assert.equal(result.expectedBeatCount, 3);
});

test('missing narration coverage -> PARTIAL_CONTENT even when every beat is visually assembled', () => {
  const j = job({
    beats: [beat({ id: 'b1', text: 'narrate me' }), beat({ id: 'b2' })],
    assembledBeatIds: ['b1', 'b2'],
    narratedBeatIds: [], // b1 needed narration but never got a real audioEvent
  });
  const result = computeContentCompleteness(j);
  assert.equal(result.overall, 'PARTIAL_CONTENT');
  assert.deepEqual(result.missingNarrationBeatIds, ['b1']);
  assert.deepEqual(result.missingBeatIds, []);
});

test('empty production (nothing intended, nothing assembled) -> NO_CONTENT, not FULL_CONTENT', () => {
  const j = job({ beats: [], assembledBeatIds: [] });
  const result = computeContentCompleteness(j);
  assert.equal(result.overall, 'NO_CONTENT');
});

test('beats intended but nothing reached assembly -> NO_CONTENT', () => {
  const j = job({ beats: [beat({ id: 'b1' }), beat({ id: 'b2' })], assembledBeatIds: [] });
  const result = computeContentCompleteness(j);
  assert.equal(result.overall, 'NO_CONTENT');
  assert.deepEqual(result.missingBeatIds.sort(), ['b1', 'b2']);
});

// Tests for services/voice/alignment-provider-interface.js — Stage 26.9B,
// Part 8/16.1. Contract only — no real alignment here (see
// whisper-alignment-provider.test.js for that).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_METHODS,
  ALIGNMENT_STATUSES,
  createAlignedWord,
  createAlignmentDiagnostic,
  createAlignmentResult,
  assertImplementsAlignmentProviderInterface,
} = require('../services/voice/alignment-provider-interface');

test('1. REQUIRED_METHODS is exactly alignAudio', () => {
  assert.deepEqual(REQUIRED_METHODS, ['alignAudio']);
});

test('2. ALIGNMENT_STATUSES is exactly COMPLETED/FAILED', () => {
  assert.deepEqual(ALIGNMENT_STATUSES, ['COMPLETED', 'FAILED']);
});

test('3. createAlignedWord defaults', () => {
  const w = createAlignedWord();
  assert.equal(w.word, '');
  assert.equal(w.start, null);
  assert.equal(w.end, null);
  assert.equal(w.confidence, null);
});

test('4. createAlignmentResult defaults', () => {
  const r = createAlignmentResult();
  assert.equal(r.status, null);
  assert.equal(r.language, null);
  assert.deepEqual(r.words, []);
  assert.deepEqual(r.diagnostics, []);
});

test('5. createAlignmentResult has no provider-specific field', () => {
  const r = createAlignmentResult();
  for (const forbidden of ['provider', 'model', 'apiKey', 'modelPath']) {
    assert.equal(forbidden in r, false, `AlignmentResult must not have a "${forbidden}" field`);
  }
});

test('6. assertImplementsAlignmentProviderInterface accepts a conforming object, rejects a non-conforming one', () => {
  assert.doesNotThrow(() => assertImplementsAlignmentProviderInterface({ alignAudio: () => {} }));
  assert.throws(() => assertImplementsAlignmentProviderInterface({}), /alignAudio/);
});

test('7. the real whisper-alignment-provider module satisfies the interface', () => {
  const whisper = require('../services/voice/whisper-alignment-provider');
  assert.doesNotThrow(() => assertImplementsAlignmentProviderInterface(whisper));
});

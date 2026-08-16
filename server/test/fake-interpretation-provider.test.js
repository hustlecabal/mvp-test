// Tests for services/reference-video/fake-interpretation-provider.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeInterpretationProvider } = require('../services/reference-video/fake-interpretation-provider');
const { createInterpretationInput } = require('../services/reference-video/interpretation-provider-interface');

test('1. the default responder cites the first supplied observation and proposes an alternative when a second exists', async () => {
  const provider = createFakeInterpretationProvider();
  const input = createInterpretationInput({
    questionId: 'X',
    question: 'x?',
    observations: [
      { observationId: 'obs-1', category: 'PACING', statement: 'first', confidence: 'MEDIUM' },
      { observationId: 'obs-2', category: 'PACING', statement: 'second', confidence: 'MEDIUM' },
    ],
  });
  const result = await provider.interpret(input);
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.supportingObservationIds, ['obs-1']);
  assert.deepEqual(result.counterObservationIds, ['obs-2']);
  assert.equal(result.alternativeHypotheses.length, 1);
  assert.equal(result.confidence, 'MEDIUM'); // never HIGH
});

test('2. the default responder handles zero supplied observations without crashing, returning no hypothesis', async () => {
  const provider = createFakeInterpretationProvider();
  const result = await provider.interpret(createInterpretationInput({ questionId: 'X', question: 'x?', observations: [] }));
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.hypothesis, null);
  assert.deepEqual(result.supportingObservationIds, []);
});

test('3. a custom respond() function fully overrides the default behavior', async () => {
  const provider = createFakeInterpretationProvider({ respond: () => ({ status: 'UNAVAILABLE' }) });
  const result = await provider.interpret(createInterpretationInput());
  assert.equal(result.status, 'UNAVAILABLE');
});

test('4. this file makes no network call and imports nothing from Apify/FFmpeg/Whisper modules', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../services/reference-video/fake-interpretation-provider.js'), 'utf8');
  assert.doesNotMatch(source, /\bfetch\(/);
  assert.doesNotMatch(source, /apify|ffmpeg|whisper/i);
});

// Tests for services/reference-video/interpretation-provider-interface.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const iface = require('../services/reference-video/interpretation-provider-interface');

test('1. assertImplementsInterpretationProviderInterface throws for a provider missing interpret()', () => {
  assert.throws(() => iface.assertImplementsInterpretationProviderInterface({}), /interpret/);
  assert.throws(() => iface.assertImplementsInterpretationProviderInterface(null), /interpret/);
});

test('2. assertImplementsInterpretationProviderInterface accepts a provider with interpret()', () => {
  assert.doesNotThrow(() => iface.assertImplementsInterpretationProviderInterface({ interpret: async () => {} }));
});

test('3. createInterpretationInput defaults constraints to the full canonical INTERPRETATION_CONSTRAINTS list', () => {
  const input = iface.createInterpretationInput({ questionId: 'X', question: 'x?' });
  assert.deepEqual(input.constraints, iface.INTERPRETATION_CONSTRAINTS);
});

test('4. INTERPRETATION_CONSTRAINTS covers every one of Part 15\'s 10 required points', () => {
  const text = iface.INTERPRETATION_CONSTRAINTS.join(' ').toLowerCase();
  for (const phrase of ['supplied evidence', 'cite', 'distinguish', 'uncertainty', 'alternative', 'counter-evidence', 'creator intent', 'quality judgment', 'recommendation', 'invent']) {
    assert.ok(text.includes(phrase), `constraints must mention "${phrase}"`);
  }
});

test('5. createInterpretationInput.referenceVideo carries only display metadata fields — never a credential or file path', () => {
  const input = iface.createInterpretationInput();
  assert.deepEqual(Object.keys(input.referenceVideo).sort(), ['title', 'description', 'platform'].sort());
});

test('6. createInterpretationProviderResult defaults confidence to null and every array to empty — nothing pre-filled', () => {
  const result = iface.createInterpretationProviderResult();
  assert.equal(result.confidence, null);
  assert.deepEqual(result.supportingObservationIds, []);
  assert.deepEqual(result.alternativeHypotheses, []);
});

test('7. PROVIDER_RESULT_STATUSES is exactly COMPLETED/UNAVAILABLE/INVALID/TIMEOUT/FAILED', () => {
  assert.deepEqual(iface.PROVIDER_RESULT_STATUSES.slice().sort(), ['COMPLETED', 'FAILED', 'INVALID', 'TIMEOUT', 'UNAVAILABLE'].sort());
});

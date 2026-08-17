// Tests for services/reference-video/recommendation-math.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { combineConfidence } = require('../services/reference-video/recommendation-math');

test('1. combineConfidence([MEDIUM]) returns MEDIUM — single-pattern identity case', () => {
  const result = combineConfidence(['MEDIUM']);
  assert.equal(result.combinedConfidence, 'MEDIUM');
});

test('2. combineConfidence([LOW]) returns LOW', () => {
  assert.equal(combineConfidence(['LOW']).combinedConfidence, 'LOW');
});

test('3. combineConfidence([MEDIUM, MEDIUM]) returns MEDIUM — all sources must agree', () => {
  assert.equal(combineConfidence(['MEDIUM', 'MEDIUM']).combinedConfidence, 'MEDIUM');
});

test('4. combineConfidence([MEDIUM, LOW]) returns LOW — conservative minimum, never an average', () => {
  assert.equal(combineConfidence(['MEDIUM', 'LOW']).combinedConfidence, 'LOW');
});

test('5. combineConfidence([LOW, MEDIUM, MEDIUM]) returns LOW regardless of order or majority', () => {
  assert.equal(combineConfidence(['LOW', 'MEDIUM', 'MEDIUM']).combinedConfidence, 'LOW');
});

test('6. combineConfidence never returns HIGH under any input', () => {
  const combos = [['MEDIUM'], ['LOW'], ['MEDIUM', 'MEDIUM'], ['MEDIUM', 'LOW'], []];
  for (const combo of combos) assert.notEqual(combineConfidence(combo).combinedConfidence, 'HIGH');
});

test('7. combineConfidence([]) (no source confidence) defaults to LOW, never invented as MEDIUM/HIGH', () => {
  assert.equal(combineConfidence([]).combinedConfidence, 'LOW');
});

test('8. combineConfidence always returns a documented formula string alongside the result', () => {
  const result = combineConfidence(['MEDIUM']);
  assert.equal(typeof result.formula, 'string');
  assert.ok(result.formula.length > 0);
  assert.equal(result.rule, 'conservative-minimum');
});

test('9. combineConfidence preserves the exact source confidences it was given, unmodified', () => {
  const sources = ['MEDIUM', 'LOW'];
  const result = combineConfidence(sources);
  assert.deepEqual(result.sourceConfidences, ['MEDIUM', 'LOW']);
});

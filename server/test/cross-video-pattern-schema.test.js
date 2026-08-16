// Tests for schemas/cross-video-pattern-schema.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../schemas/cross-video-pattern-schema');

test('1. createPattern defaults to a CANDIDATE, evidence-free record', () => {
  const p = schema.createPattern();
  assert.match(p.id, /^[0-9a-f-]{36}$/);
  assert.equal(p.status, 'CANDIDATE');
  assert.deepEqual(p.support, []);
  assert.equal(p.meetsMinimumEvidenceThreshold, false);
  assert.deepEqual(p.reviews, []);
});

test('2. PATTERN_CONFIDENCE_LEVELS is exactly MEDIUM/LOW — HIGH is structurally impossible, mirroring Interpretation', () => {
  assert.deepEqual(schema.PATTERN_CONFIDENCE_LEVELS.slice().sort(), ['LOW', 'MEDIUM']);
  assert.ok(!schema.PATTERN_CONFIDENCE_LEVELS.includes('HIGH'));
});

test('3. PATTERN_CATEGORIES excludes VIRALITY/ENGAGEMENT/QUALITY/SUCCESS (Part 21)', () => {
  for (const forbidden of ['VIRALITY', 'ENGAGEMENT', 'QUALITY', 'SUCCESS']) {
    assert.ok(!schema.PATTERN_CATEGORIES.includes(forbidden), `must not include "${forbidden}"`);
  }
});

test('4. PATTERN_TYPES has no CAUSATION value — only RECURRING_OBSERVATION/NUMERIC_DISTRIBUTION/CO_OCCURRENCE/OUTLIER', () => {
  assert.deepEqual(schema.PATTERN_TYPES.slice().sort(), ['CO_OCCURRENCE', 'NUMERIC_DISTRIBUTION', 'OUTLIER', 'RECURRING_OBSERVATION'].sort());
  assert.ok(!schema.PATTERN_TYPES.includes('CAUSATION'));
});

test('5. createPrevalence defaults to zero — never a fabricated count', () => {
  assert.deepEqual(schema.createPrevalence(), { supportingCount: 0, totalCount: 0, percentage: 0 });
});

test('6. createHomogeneityReport defaults metadataAvailable to [] and every consistency flag to null (not evaluable), never assuming homogeneity', () => {
  const report = schema.createHomogeneityReport();
  assert.deepEqual(report.metadataAvailable, []);
  assert.equal(report.platformConsistent, null);
  assert.equal(report.durationCoefficientOfVariation, null);
});

test('7. createPatternSet defaults to zero patterns and null status', () => {
  const set = schema.createPatternSet();
  assert.deepEqual(set.patterns, []);
  assert.equal(set.status, null);
});

test('8. PATTERN_REVIEW_DECISIONS is exactly ACCEPT/REJECT/FLAG/REQUEST_REVIEW', () => {
  assert.deepEqual(schema.PATTERN_REVIEW_DECISIONS.slice().sort(), ['ACCEPT', 'FLAG', 'REJECT', 'REQUEST_REVIEW'].sort());
});

test('9. createPatternSupport defaults every field to null — never a placeholder value or id', () => {
  assert.deepEqual(schema.createPatternSupport(), { referenceVideoId: null, measurementsId: null, observationId: null, value: null });
});

test('10. createPattern never mutates a nested support array passed in', () => {
  const supportInput = [{ referenceVideoId: 'rv1', value: 5 }];
  const p = schema.createPattern({ support: supportInput });
  p.support[0].value = 999;
  assert.equal(supportInput[0].value, 5);
});

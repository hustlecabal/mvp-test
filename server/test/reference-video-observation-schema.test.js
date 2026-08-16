// Tests for schemas/reference-video-observation-schema.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../schemas/reference-video-observation-schema');

test('1. createObservation defaults to an empty-but-valid record with generated id/timestamps and no evidence', () => {
  const o = schema.createObservation();
  assert.match(o.id, /^[0-9a-f-]{36}$/);
  assert.equal(o.referenceVideoId, null);
  assert.equal(o.measurementsId, null);
  assert.equal(o.category, null);
  assert.equal(o.statement, '');
  assert.deepEqual(o.evidence, []);
  assert.equal(o.confidence, null);
  assert.ok(o.createdAt);
});

test('2. createObservation applies overrides and nests evidence through createEvidenceLink', () => {
  const o = schema.createObservation({
    category: 'TIMING',
    statement: 'x',
    evidence: [{ measurementsId: 'm1', metricPath: 'video.technical.duration', value: 10, unit: 'seconds' }],
    confidence: 'HIGH',
  });
  assert.equal(o.evidence.length, 1);
  assert.equal(o.evidence[0].metricPath, 'video.technical.duration');
  assert.equal(o.evidence[0].value, 10);
});

test('3. createEvidenceLink defaults to a fully-null pointer — never a placeholder value', () => {
  assert.deepEqual(schema.createEvidenceLink(), { measurementsId: null, metricPath: null, value: null, unit: null });
});

test('4. createObservationMethodology carries ruleId/description/limitations, all defaulting to empty/null', () => {
  const methodology = schema.createObservationMethodology({ ruleId: 'RULE_X' });
  assert.equal(methodology.ruleId, 'RULE_X');
  assert.equal(methodology.description, '');
  assert.equal(methodology.limitations, '');
});

test('5. createObservationSet defaults to zero observations, zero diagnostics, and null status', () => {
  const set = schema.createObservationSet();
  assert.deepEqual(set.observations, []);
  assert.deepEqual(set.diagnostics, []);
  assert.equal(set.status, null);
});

test('6. createObservationSet nests observations through createObservation', () => {
  const set = schema.createObservationSet({ observations: [{ category: 'TIMING', statement: 'x' }] });
  assert.equal(set.observations.length, 1);
  assert.match(set.observations[0].id, /^[0-9a-f-]{36}$/);
});

test('7. OBSERVATION_CATEGORIES is exactly the ten categories the task specification names, no more', () => {
  assert.deepEqual(
    schema.OBSERVATION_CATEGORIES.slice().sort(),
    ['TIMING', 'PACING', 'SHOT_RHYTHM', 'NARRATION', 'SPEECH_DENSITY', 'SILENCE', 'OPENING', 'VISUAL_CHANGE', 'TEXT_PRESENCE', 'STRUCTURE'].sort()
  );
});

test('8. OBSERVATION_DIAGNOSTIC_CODES includes the two capability-unavailable codes the task specification requires', () => {
  assert.ok(schema.OBSERVATION_DIAGNOSTIC_CODES.includes('OCR_UNAVAILABLE'));
  assert.ok(schema.OBSERVATION_DIAGNOSTIC_CODES.includes('SCENE_OBSERVATION_UNAVAILABLE'));
});

test('9. createObservationDiagnostic defaults to null code/ruleId and empty message', () => {
  assert.deepEqual(schema.createObservationDiagnostic(), { code: null, ruleId: null, message: '' });
});

test('10. createObservation never mutates a nested evidence array passed in', () => {
  const evidenceInput = [{ metricPath: 'x', value: 1 }];
  const o = schema.createObservation({ evidence: evidenceInput });
  o.evidence[0].value = 999;
  assert.equal(evidenceInput[0].value, 1);
});

test('11. no field on a fresh Observation is capable of holding a canned qualitative verdict — statement is the only free-text field, and it starts empty, never pre-filled with a judgment word', () => {
  const o = schema.createObservation();
  assert.equal(o.statement, '');
  const keys = Object.keys(o);
  assert.deepEqual(keys.sort(), ['id', 'referenceVideoId', 'measurementsId', 'category', 'statement', 'evidence', 'confidence', 'methodology', 'createdAt'].sort());
});

// Tests for schemas/recommendation-schema.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../schemas/recommendation-schema');

test('1. createRecommendation defaults to a CANDIDATE, evidence-free record with distinct statement/rationale/action', () => {
  const r = schema.createRecommendation();
  assert.match(r.id, /^[0-9a-f-]{36}$/);
  assert.equal(r.status, 'CANDIDATE');
  assert.equal(r.statement, '');
  assert.equal(r.rationale, '');
  assert.equal(r.action, null);
  assert.deepEqual(r.sourcePatternIds, []);
  assert.deepEqual(r.supportingReferenceVideoIds, []);
  assert.deepEqual(r.reviews, []);
  assert.equal(r.meetsMinimumEvidenceThreshold, false);
});

test('2. RECOMMENDATION_CONFIDENCE_LEVELS is exactly MEDIUM/LOW — HIGH is structurally impossible, mirroring Pattern/Interpretation', () => {
  assert.deepEqual(schema.RECOMMENDATION_CONFIDENCE_LEVELS.slice().sort(), ['LOW', 'MEDIUM']);
  assert.ok(!schema.RECOMMENDATION_CONFIDENCE_LEVELS.includes('HIGH'));
});

test('3. BANNED_OUTCOME_CATEGORIES excludes VIRALITY/ENGAGEMENT/QUALITY/RETENTION/SUCCESS as a real, checkable list (Part 3)', () => {
  for (const banned of ['VIRALITY', 'ENGAGEMENT', 'QUALITY', 'RETENTION', 'SUCCESS']) {
    assert.ok(schema.BANNED_OUTCOME_CATEGORIES.includes(banned), `must list "${banned}" as banned`);
  }
});

test('4. RECOMMENDATION_TYPES has no VIRALITY_PREDICTION/RETENTION_PREDICTION — only the five real generated types', () => {
  assert.deepEqual(
    schema.RECOMMENDATION_TYPES.slice().sort(),
    ['ALTERNATIVE_STRATEGY', 'CAUTION', 'CO_OCCURRENCE_APPLICATION', 'RECURRING_PATTERN_APPLICATION', 'TESTING_OPPORTUNITY'].sort()
  );
});

test('5. RECOMMENDATION_DERIVATION_TYPES includes MULTI_PATTERN_EVIDENCE as a schema-level value even though the generator never produces one', () => {
  assert.deepEqual(schema.RECOMMENDATION_DERIVATION_TYPES.slice().sort(), ['CO_OCCURRENCE_PATTERN', 'MULTI_PATTERN_EVIDENCE', 'SINGLE_PATTERN'].sort());
});

test('6. RECOMMENDATION_EVIDENCE_SUFFICIENCY is exactly SUFFICIENT/INSUFFICIENT_EVIDENCE', () => {
  assert.deepEqual(schema.RECOMMENDATION_EVIDENCE_SUFFICIENCY.slice().sort(), ['INSUFFICIENT_EVIDENCE', 'SUFFICIENT'].sort());
});

test('7. RECOMMENDATION_REVIEW_DECISIONS is exactly ACCEPT/REJECT/EDIT/REQUEST_ALTERNATIVE/FLAG', () => {
  assert.deepEqual(schema.RECOMMENDATION_REVIEW_DECISIONS.slice().sort(), ['ACCEPT', 'EDIT', 'FLAG', 'REJECT', 'REQUEST_ALTERNATIVE'].sort());
});

test('8. createRecommendationSet defaults to zero recommendations and null status', () => {
  const set = schema.createRecommendationSet();
  assert.deepEqual(set.recommendations, []);
  assert.equal(set.status, null);
});

test('9. createRecommendation never mutates a nested sourcePatternIds/supportingReferenceVideoIds array passed in', () => {
  const sourcePatternIdsInput = ['p1'];
  const supportingInput = ['rv1'];
  const r = schema.createRecommendation({ sourcePatternIds: sourcePatternIdsInput, supportingReferenceVideoIds: supportingInput });
  r.sourcePatternIds.push('p2');
  r.supportingReferenceVideoIds.push('rv2');
  assert.deepEqual(sourcePatternIdsInput, ['p1']);
  assert.deepEqual(supportingInput, ['rv1']);
});

test('10. createRecommendationSet never mutates a nested recommendations array passed in', () => {
  const recsInput = [{ statement: 'original' }];
  const set = schema.createRecommendationSet({ recommendations: recsInput });
  set.recommendations[0].statement = 'CORRUPTED';
  assert.equal(recsInput[0].statement, 'original');
});

test('11. createRecommendationReview defaults resultingRecommendationId to null (only set for an EDIT decision)', () => {
  const review = schema.createRecommendationReview({ decision: 'ACCEPT' });
  assert.equal(review.resultingRecommendationId, null);
});

test('12. createRecommendationTargetContext defaults to GENERAL mode with no CreativeBrief reference (Part 15)', () => {
  assert.deepEqual(schema.createRecommendationTargetContext(), { mode: 'GENERAL', creativeBriefId: null });
});

test('13. createRecommendation has no field capable of storing raw video/transcript/measurement bytes — only id-based provenance pointers', () => {
  const r = schema.createRecommendation({ sourcePatternIds: ['p1'], supportingReferenceVideoIds: ['rv1'] });
  assert.ok(!('transcript' in r));
  assert.ok(!('videoBytes' in r));
  assert.ok(!('rawMeasurements' in r));
});

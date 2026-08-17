// Tests for schemas/creative-blueprint-schema.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../schemas/creative-blueprint-schema');

test('1. createCreativeBlueprint defaults to a DRAFT record with distinct statement-level fields empty and no fabricated provenance', () => {
  const b = schema.createCreativeBlueprint();
  assert.match(b.id, /^[0-9a-f-]{36}$/);
  assert.equal(b.status, 'DRAFT');
  assert.equal(b.concept, '');
  assert.equal(b.corePromise, '');
  assert.deepEqual(b.recommendationDecisions, []);
  assert.deepEqual(b.sourceRecommendationIds, []);
  assert.deepEqual(b.sourcePatternIds, []);
  assert.deepEqual(b.reviews, []);
  assert.equal(b.supersedesBlueprintId, null);
});

test('2. CREATIVE_BLUEPRINT_STATUSES includes FAILED beyond Part 3\'s own 5-value list, and includes SUPERSEDED for the revision chain', () => {
  assert.deepEqual(schema.CREATIVE_BLUEPRINT_STATUSES.slice().sort(), ['APPROVED', 'DRAFT', 'FAILED', 'PENDING_REVIEW', 'REJECTED', 'SUPERSEDED'].sort());
});

test('3. CREATIVE_BLUEPRINT_REVIEW_DECISIONS is exactly APPROVE/REJECT/REQUEST_REVISION — distinct from RECOMMENDATION_DECISION_TYPES', () => {
  assert.deepEqual(schema.CREATIVE_BLUEPRINT_REVIEW_DECISIONS.slice().sort(), ['APPROVE', 'REJECT', 'REQUEST_REVISION'].sort());
  assert.deepEqual(schema.RECOMMENDATION_DECISION_TYPES.slice().sort(), ['ACCEPT', 'DEFER', 'EDIT', 'REJECT'].sort());
});

test('4. createRecommendationDecision keeps recommendationId/decision/finalCreativeDecision as three distinct fields (Part 4)', () => {
  const d = schema.createRecommendationDecision({ recommendationId: 'r1', decision: 'ACCEPT', finalCreativeDecision: 'Open with a question.' });
  assert.equal(d.recommendationId, 'r1');
  assert.equal(d.decision, 'ACCEPT');
  assert.equal(d.finalCreativeDecision, 'Open with a question.');
});

test('5. createRecommendationDecision defaults finalCreativeDecision to null — never fabricated for an unset decision', () => {
  const d = schema.createRecommendationDecision({ recommendationId: 'r1' });
  assert.equal(d.finalCreativeDecision, null);
});

test('6. BLOCKING_DIAGNOSTIC_CODES never includes CREATIVE_BRIEF_MISMATCH or INSUFFICIENT_EVIDENCE_RECOMMENDATION (informational only)', () => {
  assert.ok(!schema.BLOCKING_DIAGNOSTIC_CODES.includes('CREATIVE_BRIEF_MISMATCH'));
  assert.ok(!schema.BLOCKING_DIAGNOSTIC_CODES.includes('INSUFFICIENT_EVIDENCE_RECOMMENDATION'));
});

test('7. createStructuralDirection defaults to null plannedSectionCount/minimumSectionDurationSeconds — never invented numbers', () => {
  const s = schema.createStructuralDirection();
  assert.equal(s.plannedSectionCount, null);
  assert.equal(s.minimumSectionDurationSeconds, null);
});

test('8. createNarrationDirection defaults voiceProfile to null (Part 10 — never invented; only populated when a real VoiceProfile is supplied)', () => {
  assert.equal(schema.createNarrationDirection().voiceProfile, null);
});

test('9. createContinuityRequirement references an entity by id only — no field capable of storing a duplicated Bible description', () => {
  const cr = schema.createContinuityRequirement({ entityType: 'CHARACTER', entityId: 'char-1', requirement: 'must remain consistent' });
  assert.deepEqual(Object.keys(cr).sort(), ['entityId', 'entityType', 'requirement'].sort());
});

test('10. createCreativeBlueprintReview defaults resultingBlueprintId to null (only set for REQUEST_REVISION)', () => {
  assert.equal(schema.createCreativeBlueprintReview({ decision: 'APPROVE' }).resultingBlueprintId, null);
});

test('11. createCreativeBlueprint never mutates nested arrays passed in (recommendationDecisions, constraints, continuityRequirements)', () => {
  const decisionsInput = [{ recommendationId: 'r1', decision: 'ACCEPT' }];
  const constraintsInput = ['no music'];
  const b = schema.createCreativeBlueprint({ recommendationDecisions: decisionsInput, constraints: constraintsInput });
  b.recommendationDecisions[0].decision = 'REJECT';
  b.constraints.push('CORRUPTED');
  assert.equal(decisionsInput[0].decision, 'ACCEPT');
  assert.deepEqual(constraintsInput, ['no music']);
});

test('12. createCreativeBlueprint keeps title/concept/corePromise/format/targetAudience/targetDuration as distinct top-level fields (never collapsed)', () => {
  const b = schema.createCreativeBlueprint({ title: 't', concept: 'c', corePromise: 'p', format: 'short-form', targetAudience: 'devs', targetDuration: 100 });
  assert.equal(b.title, 't');
  assert.equal(b.concept, 'c');
  assert.equal(b.corePromise, 'p');
  assert.equal(b.format, 'short-form');
  assert.equal(b.targetAudience, 'devs');
  assert.equal(b.targetDuration, 100);
});

test('13. REFERENCE_ENTITY_TYPES mirrors schemas/creative-schema.js\'s own CHARACTER/LOCATION/PROP vocabulary', () => {
  assert.deepEqual(schema.REFERENCE_ENTITY_TYPES.slice().sort(), ['CHARACTER', 'LOCATION', 'PROP'].sort());
});

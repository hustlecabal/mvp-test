// Tests for schemas/reference-video-interpretation-schema.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../schemas/reference-video-interpretation-schema');

test('1. createInterpretation defaults to a valid, evidence-free record with generated id/timestamps and PENDING_REVIEW status', () => {
  const i = schema.createInterpretation();
  assert.match(i.id, /^[0-9a-f-]{36}$/);
  assert.equal(i.hypothesis, '');
  assert.equal(i.reasoning, '');
  assert.deepEqual(i.supportingEvidence, []);
  assert.deepEqual(i.counterEvidence, []);
  assert.deepEqual(i.alternativeHypotheses, []);
  assert.equal(i.confidence, null);
  assert.equal(i.status, 'PENDING_REVIEW');
  assert.deepEqual(i.reviews, []);
  assert.equal(i.supersedesInterpretationId, null);
});

test('2. INTERPRETATION_CONFIDENCE_LEVELS is exactly MEDIUM/LOW — HIGH is structurally impossible (Part 8)', () => {
  assert.deepEqual(schema.INTERPRETATION_CONFIDENCE_LEVELS.slice().sort(), ['LOW', 'MEDIUM']);
  assert.ok(!schema.INTERPRETATION_CONFIDENCE_LEVELS.includes('HIGH'));
});

test('3. INTERPRETATION_QUESTIONS is a closed set with the task-specified structural questions, each carrying relevantCategories drawn from real Observation categories', () => {
  const { OBSERVATION_CATEGORIES } = require('../schemas/reference-video-observation-schema');
  assert.equal(schema.INTERPRETATION_QUESTION_IDS.length, 7);
  for (const id of schema.INTERPRETATION_QUESTION_IDS) {
    const q = schema.INTERPRETATION_QUESTIONS[id];
    assert.ok(q.text.length > 10);
    assert.ok(Array.isArray(q.relevantCategories) && q.relevantCategories.length > 0);
    for (const c of q.relevantCategories) assert.ok(OBSERVATION_CATEGORIES.includes(c), `"${c}" must be a real observation category`);
  }
});

test('4. no interpretation question asks the broad "why is this successful" framing', () => {
  const banned = /successful|why does this work|viral|good video/i;
  for (const id of schema.INTERPRETATION_QUESTION_IDS) {
    assert.doesNotMatch(schema.INTERPRETATION_QUESTIONS[id].text, banned);
  }
});

test('5. INTERPRETATION_DIAGNOSTIC_CODES contains exactly the 8 codes the task specification requires', () => {
  assert.deepEqual(
    schema.INTERPRETATION_DIAGNOSTIC_CODES.slice().sort(),
    ['INTERPRETATION_INPUT_INVALID', 'INTERPRETATION_EVIDENCE_MISSING', 'INTERPRETATION_PROVIDER_UNAVAILABLE', 'INTERPRETATION_COST_BLOCKED', 'INTERPRETATION_FAILED', 'INTERPRETATION_INVALID', 'INTERPRETATION_UNSUPPORTED', 'INTERPRETATION_TIMEOUT'].sort()
  );
});

test('6. createEvidenceReference defaults to a fully-null pointer — never a placeholder statement', () => {
  assert.deepEqual(schema.createEvidenceReference(), { observationId: null, category: null, statement: null });
});

test('7. createAlternativeHypothesis / createCounterEvidence default to empty strings, never pre-filled text', () => {
  assert.deepEqual(schema.createAlternativeHypothesis(), { hypothesis: '', reasoning: '' });
  assert.deepEqual(schema.createCounterEvidence(), { observationId: null, note: '' });
});

test('8. createInterpretationAuditTrail defaults every field to null/[] — nothing pre-filled, no credential field exists at all', () => {
  const audit = schema.createInterpretationAuditTrail();
  // P0-HARDENING-2, Part 12 — actualInputTokens/actualOutputTokens/
  // actualCostUsd are additive fields alongside the pre-existing estimate,
  // never replacing it (see createInterpretationAuditTrail's own comment).
  assert.deepEqual(
    Object.keys(audit).sort(),
    ['questionId', 'suppliedObservationIds', 'provider', 'model', 'requestedAt', 'respondedAt', 'estimatedCostUsd', 'actualInputTokens', 'actualOutputTokens', 'actualCostUsd'].sort()
  );
  assert.equal(audit.actualInputTokens, null);
  assert.equal(audit.actualOutputTokens, null);
  assert.equal(audit.actualCostUsd, null);
  // "token" alone would also flag actualInputTokens/actualOutputTokens —
  // real LLM usage COUNTS (P0-HARDENING-2, Part 12), not credentials. The
  // check below still catches an actual credential-shaped field name
  // (apiToken, authToken, bearerToken, a bare "token") without flagging a
  // "*Tokens" usage-count field.
  const CREDENTIAL_TOKEN_PATTERN = /(^|[a-z])token(?!s)/i;
  for (const key of Object.keys(audit)) {
    for (const forbidden of ['apiKey', 'api_key', 'secret', 'chainOfThought', 'chain_of_thought']) {
      assert.ok(!key.toLowerCase().includes(forbidden.toLowerCase()), `audit trail must never have a "${forbidden}" field (found "${key}")`);
    }
    assert.ok(!CREDENTIAL_TOKEN_PATTERN.test(key), `audit trail must never have a credential-shaped "token" field (found "${key}")`);
  }
});

test('9. REVIEW_DECISIONS is exactly ACCEPT/REJECT/EDIT/REQUEST_ALTERNATIVE', () => {
  assert.deepEqual(schema.REVIEW_DECISIONS.slice().sort(), ['ACCEPT', 'EDIT', 'REJECT', 'REQUEST_ALTERNATIVE'].sort());
});

test('10. createInterpretationReview defaults resultingInterpretationId to null (only ever set by an EDIT)', () => {
  const review = schema.createInterpretationReview({ decision: 'ACCEPT' });
  assert.equal(review.resultingInterpretationId, null);
  assert.ok(review.reviewedAt);
});

test('11. createInterpretation never mutates a nested override object passed in', () => {
  const evidenceInput = [{ observationId: 'o1', statement: 'x' }];
  const i = schema.createInterpretation({ supportingEvidence: evidenceInput });
  i.supportingEvidence[0].statement = 'CORRUPTED';
  assert.equal(evidenceInput[0].statement, 'x');
});

test('12. no field name anywhere on Interpretation could be mistaken for a fact/observation field — the epistemic-level naming discipline (Part 2)', () => {
  const i = schema.createInterpretation();
  const keys = Object.keys(i);
  for (const forbidden of ['fact', 'measurement', 'observation']) {
    // "observationSetId"/"supportingEvidence" reference observations by id — allowed;
    // a bare "observation"/"fact"/"measurement" field name would blur the boundary and is not present.
    assert.ok(!keys.includes(forbidden), `must not have a bare "${forbidden}" field`);
  }
  assert.ok(keys.includes('hypothesis'));
  assert.ok(keys.includes('reasoning'));
});

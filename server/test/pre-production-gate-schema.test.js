// Tests for schemas/pre-production-gate-schema.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../schemas/pre-production-gate-schema');

test('1. createPreProductionGateResult defaults to null machineAssessment, empty finding lists, and no human decision yet', () => {
  const g = schema.createPreProductionGateResult();
  assert.match(g.id, /^[0-9a-f-]{36}$/);
  assert.equal(g.machineAssessment, null);
  assert.deepEqual(g.blockers, []);
  assert.deepEqual(g.warnings, []);
  assert.deepEqual(g.information, []);
  assert.equal(g.humanDecision, null);
  assert.equal(g.humanRationale, null);
});

test('2. GATE_ASSESSMENT_VALUES is exactly PROCEED/REVISE/REJECT — no fourth value, no numeric score field anywhere', () => {
  assert.deepEqual(schema.GATE_ASSESSMENT_VALUES.slice().sort(), ['PROCEED', 'REJECT', 'REVISE'].sort());
  const g = schema.createPreProductionGateResult();
  assert.ok(!Object.keys(g).some((k) => /score|rating|percent/i.test(k)));
});

test('3. HUMAN_DECISION_VALUES is exactly ACCEPT/OVERRIDE/REQUEST_REVISION/REJECT — distinct from GATE_ASSESSMENT_VALUES', () => {
  assert.deepEqual(schema.HUMAN_DECISION_VALUES.slice().sort(), ['ACCEPT', 'OVERRIDE', 'REJECT', 'REQUEST_REVISION'].sort());
});

test('4. GATE_BLOCKER_CODES / GATE_WARNING_CODES / GATE_INFORMATION_CODES never share a code across tiers', () => {
  const b = new Set(schema.GATE_BLOCKER_CODES);
  const w = new Set(schema.GATE_WARNING_CODES);
  const i = new Set(schema.GATE_INFORMATION_CODES);
  for (const code of b) assert.ok(!w.has(code) && !i.has(code), `${code} appears in more than one tier`);
  for (const code of w) assert.ok(!b.has(code) && !i.has(code), `${code} appears in more than one tier`);
});

test('5. GATE_BLOCKER_CODES includes INVALID_RECOMMENDATION_PROVENANCE (Part 2A — stricter than INT-2 itself, deliberately)', () => {
  assert.ok(schema.GATE_BLOCKER_CODES.includes('INVALID_RECOMMENDATION_PROVENANCE'));
});

test('6. GATE_WARNING_CODES includes INVALID_ENTITY_REFERENCE (Part 2A — kept non-blocking, still surfaced)', () => {
  assert.ok(schema.GATE_WARNING_CODES.includes('INVALID_ENTITY_REFERENCE'));
  assert.ok(!schema.GATE_BLOCKER_CODES.includes('INVALID_ENTITY_REFERENCE'));
});

test('7. createGateFinding defaults code/category to null, message to empty string', () => {
  const f = schema.createGateFinding();
  assert.equal(f.code, null);
  assert.equal(f.category, null);
  assert.equal(f.message, '');
});

test('8. createGateInformation has no category field (information is a simpler shape than a finding)', () => {
  const i = schema.createGateInformation({ code: 'X', message: 'y' });
  assert.deepEqual(Object.keys(i).sort(), ['code', 'message'].sort());
});

test('9. COST_STATUS_VALUES is exactly KNOWN/ESTIMATED/UNKNOWN — never a monetary figure enum', () => {
  assert.deepEqual(schema.COST_STATUS_VALUES.slice().sort(), ['ESTIMATED', 'KNOWN', 'UNKNOWN'].sort());
});

test('10. CAPABILITY_STATUS_VALUES includes UNKNOWN as a first-class value, distinct from SUPPORTED', () => {
  assert.deepEqual(schema.CAPABILITY_STATUS_VALUES.slice().sort(), ['PARTIALLY_SUPPORTED', 'SUPPORTED', 'UNKNOWN', 'UNSUPPORTED'].sort());
});

test('11. humanRationale defaults to null and is never required by the factory itself (enforcement is the service\'s job, not the schema\'s)', () => {
  const g = schema.createPreProductionGateResult({ humanDecision: 'OVERRIDE' });
  assert.equal(g.humanRationale, null);
});

test('12. blueprintRevision and blueprintId are distinct top-level fields (never collapsed)', () => {
  const g = schema.createPreProductionGateResult({ blueprintId: 'b1', blueprintRevision: 'b1' });
  assert.equal(g.blueprintId, 'b1');
  assert.equal(g.blueprintRevision, 'b1');
});

test('13. createPreProductionGateResult never mutates a passed-in blockers/warnings/information array', () => {
  const blockersInput = [{ code: 'X', message: 'm', category: 'c' }];
  const g = schema.createPreProductionGateResult({ blockers: blockersInput });
  g.blockers[0].code = 'CORRUPTED';
  assert.equal(blockersInput[0].code, 'X');
});

test('14. gateVersion defaults to 1', () => {
  assert.equal(schema.createPreProductionGateResult().gateVersion, 1);
});

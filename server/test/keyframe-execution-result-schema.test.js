// Tests for schemas/keyframe-execution-result-schema.js — Stage 13C,
// Part 5's normalized KeyframeExecutionResult contract. Pure factory, no
// I/O.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EXECUTION_STATUSES, createKeyframeExecutionResult } = require('../schemas/keyframe-execution-result-schema');

// --- 3. execution-result schema -----------------------------------------------------

test('3. createKeyframeExecutionResult fills in every field with a safe default', () => {
  const result = createKeyframeExecutionResult();
  assert.ok(result.executionId);
  assert.equal(result.keyframeId, null);
  assert.equal(result.packageId, null);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.provider, null);
  assert.equal(result.model, null);
  assert.equal(result.skillId, null);
  assert.equal(result.artifactType, null);
  assert.equal(result.artifactPath, null);
  assert.equal(result.artifactUrl, null, 'never invents a URL by default');
  assert.deepEqual(result.metadata, {});
  assert.deepEqual(result.warnings, []);
  assert.ok(result.createdAt);
});

test('createKeyframeExecutionResult overrides only the fields given', () => {
  const result = createKeyframeExecutionResult({ status: 'COMPLETED', artifactPath: 'x.png' });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.artifactPath, 'x.png');
  assert.equal(result.provider, null, 'unrelated defaults must still apply');
});

test('EXECUTION_STATUSES is exactly BLOCKED/IN_PROGRESS/COMPLETED/FAILED', () => {
  assert.deepEqual(EXECUTION_STATUSES, ['BLOCKED', 'IN_PROGRESS', 'COMPLETED', 'FAILED']);
});

test('schemas/keyframe-execution-result-schema.js has no require() of any provider, generation, or approval module', () => {
  const fs = require('fs');
  const path = require('path');
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'keyframe-execution-result-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  for (const req of requires) {
    assert.ok(!/evolink|generation-service|approval-gate/i.test(req), `unexpected import: ${req}`);
  }
});

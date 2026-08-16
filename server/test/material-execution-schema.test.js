// Tests for schemas/material-execution-schema.js — plain object factories
// only, no file I/O, no provider knowledge.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EXECUTION_STATUSES, EXECUTOR_TYPES, createDiagnostic, createExecutionResult } = require('../schemas/material-execution-schema');

test('1a. EXECUTION_STATUSES is the exact fixed vocabulary', () => {
  assert.deepEqual(EXECUTION_STATUSES, ['COMPLETED', 'FAILED']);
});

test('1b. EXECUTOR_TYPES is the exact fixed vocabulary — the five Stage 26.5A executors, Stage 26.5B Part 5\'s BROLL_CLIP, and P0-2\'s GENERATED_NEW bridge pair', () => {
  assert.deepEqual(EXECUTOR_TYPES, ['PROJECT_ASSET_REUSE', 'STILL_IMAGE_MOTION', 'KINETIC_TYPOGRAPHY', 'MOTION_GRAPHIC', 'WHITEBOARD', 'BROLL_CLIP', 'GENERATED_NEW_STILL_IMAGE', 'GENERATED_NEW_VIDEO']);
});

test('2a. createDiagnostic fills in every field with a safe default', () => {
  const diagnostic = createDiagnostic();
  assert.equal(diagnostic.code, null);
  assert.equal(diagnostic.message, '');
});

test('3a. createExecutionResult fills in every field with a safe default', () => {
  const result = createExecutionResult();
  assert.ok(result.executionId);
  assert.equal(result.beatId, null);
  assert.equal(result.materialId, null);
  assert.equal(result.executorType, null);
  assert.equal(result.status, null);
  assert.equal(result.duration, null);
  assert.equal(result.renderSpec, null);
  assert.deepEqual(result.sourceAssetIds, []);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.createdAt);
});

test('3b. createExecutionResult assigns a fresh, unique executionId every call', () => {
  const a = createExecutionResult();
  const b = createExecutionResult();
  assert.notEqual(a.executionId, b.executionId);
});

test('3c. createExecutionResult has no version/history/cost/provider fields — a computed snapshot, not a spend record', () => {
  const result = createExecutionResult();
  for (const key of ['version', 'history', 'updatedBy', 'changeNote', 'provider', 'model', 'cost', 'reservedCredits', 'estimatedCost']) {
    assert.equal(key in result, false, `unexpected field "${key}"`);
  }
});

test('4. schemas/material-execution-schema.js has no require() of any provider, generation, or approval module — the only require is crypto', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'material-execution-schema.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['crypto']);
});

test('5. schemas/material-execution-schema.js never mentions a specific provider or model name', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'schemas', 'material-execution-schema.js'), 'utf8');
  for (const forbidden of ['evolink', 'seedance', 'google', 'gemini', 'openai']) {
    assert.doesNotMatch(text.toLowerCase(), new RegExp(forbidden), `must not reference provider/model "${forbidden}"`);
  }
});

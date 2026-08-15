// Tests for services/material-executor-registry.js — a pure lookup, no
// material/provider selection, no generation, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const registry = require('../services/material-executor-registry');
const { EXECUTOR_TYPES } = require('../schemas/material-execution-schema');

test('A1. every EXECUTOR_TYPES value is registered', () => {
  for (const executorType of EXECUTOR_TYPES) {
    const executor = registry.getExecutor(executorType);
    assert.ok(executor, `${executorType} must be registered`);
    assert.equal(typeof executor.execute, 'function');
  }
});

test('A2. listExecutorTypes returns the exact EXECUTOR_TYPES list', () => {
  assert.deepEqual(registry.listExecutorTypes(), EXECUTOR_TYPES);
});

test('A3. an unknown material/executorType fails safely — returns null, never throws', () => {
  assert.doesNotThrow(() => {
    const executor = registry.getExecutor('NOT_A_REAL_EXECUTOR_TYPE');
    assert.equal(executor, null);
  });
  assert.equal(registry.getExecutor(undefined), null);
  assert.equal(registry.getExecutor(null), null);
});

test('A4. services/material-executor-registry.js has no require() of any provider, generation, or approval module', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'material-executor-registry.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ['./material-executors', '../schemas/material-execution-schema'].sort());
  for (const req of requires) {
    assert.ok(!/evolink|generation-service|approval-gate|google/i.test(req), `unexpected import: ${req}`);
  }
});

test('A5. services/material-executor-registry.js makes no network calls (no fetch/http/axios)', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'material-executor-registry.js'), 'utf8');
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/]) {
    assert.doesNotMatch(text, pattern);
  }
});

test('A6. services/material-executors/index.js registers exactly the EXECUTOR_TYPES modules, nothing else', () => {
  const map = require('../services/material-executors');
  assert.deepEqual(Object.keys(map).sort(), [...EXECUTOR_TYPES].sort());
});

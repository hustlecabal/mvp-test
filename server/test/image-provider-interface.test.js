// Tests for providers/image-provider-interface.js — the generic contract
// every image provider adapter must implement. Pure/no I/O.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_METHODS,
  GENERATION_STATUSES,
  createGenerationStatus,
  assertImplementsImageProviderInterface,
} = require('../providers/image-provider-interface');

// --- 1. image-provider interface -------------------------------------------------

test('1. REQUIRED_METHODS is exactly createImageGeneration/getGenerationStatus', () => {
  assert.deepEqual(REQUIRED_METHODS, ['createImageGeneration', 'getGenerationStatus']);
});

test('assertImplementsImageProviderInterface accepts a conforming provider', () => {
  const provider = { createImageGeneration: () => {}, getGenerationStatus: () => {} };
  assert.doesNotThrow(() => assertImplementsImageProviderInterface(provider));
});

test('assertImplementsImageProviderInterface rejects a provider missing a required method', () => {
  assert.throws(() => assertImplementsImageProviderInterface({ createImageGeneration: () => {} }), /getGenerationStatus/);
});

test('reuses the video provider interface\'s generic status shape rather than inventing a new one', () => {
  const status = createGenerationStatus({ generationId: 'x' });
  assert.ok('provider' in status && 'model' in status && 'status' in status && 'progress' in status);
  assert.ok('reservedCost' in status && 'results' in status && 'error' in status);
  assert.ok(Array.isArray(GENERATION_STATUSES) && GENERATION_STATUSES.includes('COMPLETED'));
});

test('image-provider-interface.js has no provider-specific field names or network calls', () => {
  const fs = require('fs');
  const path = require('path');
  const text = fs.readFileSync(path.join(__dirname, '..', 'providers', 'image-provider-interface.js'), 'utf8');
  assert.doesNotMatch(text, /evolink/i);
  assert.doesNotMatch(text, /fetch\(/);
});

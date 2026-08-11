// Tests for providers/provider-interface.js — the generic contract every
// provider adapter must satisfy.

const test = require('node:test');
const assert = require('node:assert/strict');
const providerInterface = require('../providers/provider-interface');

test('1. GENERATION_STATUSES defines the documented lifecycle', () => {
  assert.deepEqual(providerInterface.GENERATION_STATUSES, [
    'REQUESTED',
    'SUBMITTED',
    'PROCESSING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ]);
});

test('assertImplementsProviderInterface accepts a complete provider', () => {
  const fakeProvider = {
    createGeneration: () => {},
    getGenerationStatus: () => {},
    getGenerationResult: () => {},
  };
  assert.doesNotThrow(() => providerInterface.assertImplementsProviderInterface(fakeProvider));
});

test('assertImplementsProviderInterface rejects a provider missing a required method', () => {
  const incompleteProvider = {
    createGeneration: () => {},
    getGenerationStatus: () => {},
    // getGenerationResult missing
  };
  assert.throws(
    () => providerInterface.assertImplementsProviderInterface(incompleteProvider),
    /getGenerationResult/
  );
});

test('createGenerationStatus fills in generic defaults', () => {
  const status = providerInterface.createGenerationStatus();
  assert.equal(status.status, 'REQUESTED');
  assert.equal(status.generationId, null);
  assert.deepEqual(status.results, []);
  assert.equal(status.error, null);
});

test('the real EvoLink provider satisfies the interface', () => {
  const evolinkProvider = require('../providers/evolink/evolink-provider');
  assert.doesNotThrow(() => providerInterface.assertImplementsProviderInterface(evolinkProvider));
});

// Tests for services/reference-video/acquisition-provider-interface.js —
// INT-1A, Part 18/22. The provider-boundary contract itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_METHODS,
  OPTIONAL_METHODS,
  createSourceResolution,
  createMetadataAcquisitionResult,
  createVideoAcquisitionResult,
  createTranscriptAcquisitionResult,
  assertImplementsAcquisitionProviderInterface,
} = require('../services/reference-video/acquisition-provider-interface');

function fullProvider() {
  return { resolveSource: () => {}, acquireMetadata: () => {}, acquireVideo: () => {}, acquireTranscript: () => {} };
}

test('1. resolveSource is required; the other three are asserted present too', () => {
  assert.deepEqual(REQUIRED_METHODS, ['resolveSource']);
  assert.deepEqual(OPTIONAL_METHODS.sort(), ['acquireMetadata', 'acquireTranscript', 'acquireVideo'].sort());
});

test('2. a provider missing resolveSource throws', () => {
  assert.throws(() => assertImplementsAcquisitionProviderInterface({ acquireMetadata: () => {}, acquireVideo: () => {}, acquireTranscript: () => {} }), /resolveSource/);
});

test('3. a provider missing an optional method still throws (present-but-UNSUPPORTED is required, not present-or-absent)', () => {
  assert.throws(() => assertImplementsAcquisitionProviderInterface({ resolveSource: () => {} }), /acquireMetadata|acquireVideo|acquireTranscript/);
});

test('4. a fully-implementing provider passes', () => {
  assert.doesNotThrow(() => assertImplementsAcquisitionProviderInterface(fullProvider()));
});

test('5. null/undefined provider fails clearly rather than throwing a TypeError about property access', () => {
  assert.throws(() => assertImplementsAcquisitionProviderInterface(null), /resolveSource/);
  assert.throws(() => assertImplementsAcquisitionProviderInterface(undefined), /resolveSource/);
});

test('6. every result factory is provider-neutral — never a field for provider name/API key/raw response', () => {
  const results = [createSourceResolution(), createMetadataAcquisitionResult(), createVideoAcquisitionResult(), createTranscriptAcquisitionResult()];
  for (const r of results) {
    const keys = Object.keys(r).join(',').toLowerCase();
    for (const forbidden of ['apikey', 'api_key', 'token', 'credential', 'apify']) {
      assert.doesNotMatch(keys, new RegExp(forbidden));
    }
  }
});

test('7. createVideoAcquisitionResult carries resultUrl, never a local path — downloading is the ingestion service\'s job', () => {
  const r = createVideoAcquisitionResult({ status: 'COMPLETED', resultUrl: 'https://example.com/x.mp4' });
  assert.equal(r.resultUrl, 'https://example.com/x.mp4');
  assert.ok(!('path' in r));
});

test('8. diagnostics default to an empty array on every result shape', () => {
  for (const factory of [createSourceResolution, createMetadataAcquisitionResult, createVideoAcquisitionResult, createTranscriptAcquisitionResult]) {
    assert.deepEqual(factory().diagnostics, []);
  }
});

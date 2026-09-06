// Tests for services/music/music-provider-interface.js — PHASE 3B.
// Mirrors this codebase's existing provider-interface test discipline
// (see test/stock-media-providers.test.js/test/media-acquisition-
// service.test.js for the analogous visual-provider coverage this file
// intentionally parallels without touching).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MUSIC_SEARCH_STATUSES,
  createMusicSearchResult,
  createMusicSearchDiagnostic,
  assertImplementsMusicProviderInterface,
} = require('../services/music/music-provider-interface');
const { createMusicCandidate } = require('../schemas/music-acquisition-schema');

// --- valid implementation -------------------------------------------------------------------

test('A. assertImplementsMusicProviderInterface accepts a provider with a real search() method', () => {
  assert.doesNotThrow(() => assertImplementsMusicProviderInterface({ search: async () => {} }));
});

// --- missing required method -------------------------------------------------------------------

test('B. assertImplementsMusicProviderInterface throws for a provider missing search()', () => {
  assert.throws(() => assertImplementsMusicProviderInterface({}), /missing required method: search/);
});

test('B2. assertImplementsMusicProviderInterface throws for a null/undefined provider, never crashes with a different error', () => {
  assert.throws(() => assertImplementsMusicProviderInterface(null), /missing required method: search/);
  assert.throws(() => assertImplementsMusicProviderInterface(undefined), /missing required method: search/);
});

// --- malformed result -------------------------------------------------------------------

test('C. createMusicSearchResult normalizes candidates through createMusicCandidate — a malformed/partial candidate is filled to the full defaulted shape, never left partial', () => {
  const result = createMusicSearchResult({ status: 'COMPLETED', candidates: [{ providerAssetId: 'x' }] });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].providerAssetId, 'x');
  assert.equal(result.candidates[0].downloadUrl, null);
  assert.equal(result.candidates[0].durationSeconds, null);
  assert.equal(result.candidates[0].format, null);
});

test('C2. createMusicSearchResult defaults candidates/diagnostics to empty arrays, never null/undefined', () => {
  const result = createMusicSearchResult({ status: 'FAILED' });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.diagnostics, []);
});

test('D. MUSIC_SEARCH_STATUSES mirrors the stock-media interface\'s own four-value vocabulary exactly', () => {
  assert.deepEqual(MUSIC_SEARCH_STATUSES, ['COMPLETED', 'UNAVAILABLE', 'UNSUPPORTED', 'FAILED']);
});

test('E. createMusicSearchDiagnostic / createMusicCandidate produce exactly their documented fields', () => {
  const diag = createMusicSearchDiagnostic({ code: 'X', message: 'y' });
  assert.deepEqual(Object.keys(diag).sort(), ['code', 'message'].sort());

  const candidate = createMusicCandidate();
  assert.deepEqual(
    Object.keys(candidate).sort(),
    ['providerAssetId', 'sourceUrl', 'downloadUrl', 'durationSeconds', 'format', 'attribution', 'licenseSummary'].sort()
  );
});

// --- no network/provider knowledge in the interface file itself -------------------------------------------------------------------

test('F. music-provider-interface.js requires nothing but the music-acquisition schema — no file I/O, no network, no provider adapter', () => {
  const fs = require('fs');
  const path = require('path');
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'music', 'music-provider-interface.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['../../schemas/music-acquisition-schema']);
  for (const pattern of [/\bfetch\(/, /axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
});

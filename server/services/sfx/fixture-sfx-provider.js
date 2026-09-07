// fixture-sfx-provider.js
//
// PHASE 3E — the deterministic SFX provider this stage's tests require.
// Mirrors services/music/fixture-music-provider.js's exact discipline: no
// network, no API key, in-memory, hand-synthesized WAV bytes (same
// dependency-free-fixture convention, test/fixtures/png-fixture.js's own
// header precedent). 'fixture' is never a real production provider name a
// caller would reach by name collision — see schemas/sfx-acquisition-
// schema.js's own SFX_PROVIDERS comment.
//
// A real SFX hit is short — this fixture is deliberately much shorter
// than fixture-music-provider.js's own 2s bed (0.4s), matching a one-shot
// click/whoosh's real, typical length rather than reusing music's own
// duration as if SFX and MUSIC fixtures should look alike.

const { createSfxSearchResult, createSfxSearchDiagnostic } = require('./sfx-provider-interface');
const { createSfxCandidate } = require('../../schemas/sfx-acquisition-schema');

const PROVIDER_NAME = 'fixture';

const FIXTURE_DURATION_SECONDS = 0.4;
const SAMPLE_RATE = 8000;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

function buildFixtureWavBuffer() {
  const numSamples = Math.round(FIXTURE_DURATION_SECONDS * SAMPLE_RATE);
  const blockAlign = (NUM_CHANNELS * BITS_PER_SAMPLE) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const dataSize = numSamples * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(NUM_CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

const FIXTURE_URL = 'https://fixture-sfx-provider.local/fixtures/sample-sfx.wav';

async function search(request) {
  if (!request || typeof request.searchQuery !== 'string' || request.searchQuery.trim().length === 0) {
    return createSfxSearchResult({ status: 'FAILED', diagnostics: [createSfxSearchDiagnostic({ code: 'INVALID_REQUEST', message: 'searchQuery is required' })] });
  }
  return createSfxSearchResult({
    status: 'COMPLETED',
    candidates: [
      createSfxCandidate({
        providerAssetId: 'fixture-sfx-1',
        sourceUrl: FIXTURE_URL,
        downloadUrl: FIXTURE_URL,
        durationSeconds: FIXTURE_DURATION_SECONDS,
        format: 'wav',
        attribution: 'Fixture SFX Provider (test fixture)',
        licenseSummary: 'Test fixture — not a real license',
      }),
    ],
  });
}

async function fakeFetchImpl(url) {
  if (url === FIXTURE_URL) {
    const buffer = buildFixtureWavBuffer();
    return new Response(buffer, { status: 200, headers: { 'content-type': 'audio/wav', 'content-length': String(buffer.length) } });
  }
  throw new Error(`FixtureSfxProvider's fetchImpl only recognizes its own fixture URL, got: "${url}"`);
}

function credential() {
  return 'fixture-sfx-no-credential-required';
}

module.exports = {
  PROVIDER_NAME,
  search,
  credential,
  fakeFetchImpl,
  buildFixtureWavBuffer,
  FIXTURE_URL,
  FIXTURE_DURATION_SECONDS,
};

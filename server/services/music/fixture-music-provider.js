// fixture-music-provider.js
//
// PHASE 3B — the deterministic Music provider this stage requires for
// testing. Implements ../music-provider-interface.js entirely in memory:
// no network, no API key, no external file. Mirrors services/media-
// acquisition/fake-stock-media-provider.js's exact discipline:
//
// - search() is synchronous/in-memory — never calls fetch/http/any
//   network API, and always returns the SAME candidate, so test
//   assertions are deterministic.
// - the returned candidate's downloadUrl always resolves (via
//   fakeFetchImpl below) to the SAME hand-synthesized WAV bytes.
// - NEVER registered as a real MUSIC_PROVIDERS entry a production caller
//   would reach by name collision with a real provider — 'fixture' is
//   its own, explicitly test-only name (see services/music-acquisition-
//   service.js's own header for why it is still listed in
//   schemas/music-acquisition-schema.js's MUSIC_PROVIDERS: no real
//   provider exists yet, so 'fixture' is — honestly — the only entry).
//
// WHY A HAND-SYNTHESIZED WAV, NOT A BUNDLED FIXTURE FILE: this codebase's
// own established convention for a dependency-free binary test fixture is
// to build the bytes in code (test/fixtures/png-fixture.js's own header:
// "hand-built, dependency-free... no third-party library"), not to check
// in a new binary asset. A minimal valid WAV (RIFF/WAVE header + raw PCM
// silence) is simpler to hand-build correctly than a PNG — no compression,
// no CRC — so that convention is followed here rather than bundling a new
// audio file the repository has never needed before.

const { createMusicSearchResult, createMusicSearchDiagnostic } = require('./music-provider-interface');
const { createMusicCandidate } = require('../../schemas/music-acquisition-schema');

const PROVIDER_NAME = 'fixture';

// Deterministic, minimal, real audio: mono, 8kHz, 16-bit PCM silence.
// Small (32,044 bytes for 2s) but a genuinely valid, decodable WAV file —
// real bytes services/asset-storage.js's own sniffAudioFormat() and any
// real ffprobe/decoder would recognize as WAVE audio, never a fake/opaque
// placeholder.
const FIXTURE_DURATION_SECONDS = 2;
const SAMPLE_RATE = 8000;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

function buildFixtureWavBuffer() {
  const numSamples = FIXTURE_DURATION_SECONDS * SAMPLE_RATE;
  const blockAlign = (NUM_CHANNELS * BITS_PER_SAMPLE) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const dataSize = numSamples * blockAlign; // all-zero samples — deterministic silence, never randomized content

  const buffer = Buffer.alloc(44 + dataSize); // standard 44-byte PCM WAV header, data already zero-filled by Buffer.alloc
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt subchunk size (PCM)
  buffer.writeUInt16LE(1, 20); // audio format: 1 = PCM
  buffer.writeUInt16LE(NUM_CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  // bytes 44..44+dataSize already zero (silence) via Buffer.alloc

  return buffer;
}

// Syntactically valid https URL, never actually requested over the
// network — fakeFetchImpl below intercepts it, exactly like
// fake-stock-media-provider.js's own FIXTURE_URL convention.
const FIXTURE_URL = 'https://fixture-music-provider.local/fixtures/sample-music.wav';

async function search(request) {
  if (!request || typeof request.searchQuery !== 'string' || request.searchQuery.trim().length === 0) {
    return createMusicSearchResult({ status: 'FAILED', diagnostics: [createMusicSearchDiagnostic({ code: 'INVALID_REQUEST', message: 'searchQuery is required' })] });
  }
  return createMusicSearchResult({
    status: 'COMPLETED',
    candidates: [
      createMusicCandidate({
        providerAssetId: 'fixture-music-1',
        sourceUrl: FIXTURE_URL,
        downloadUrl: FIXTURE_URL,
        durationSeconds: FIXTURE_DURATION_SECONDS,
        format: 'wav',
        attribution: 'Fixture Music Provider (test fixture)',
        licenseSummary: 'Test fixture — not a real license',
      }),
    ],
  });
}

// Given to services/asset-storage.js's downloadAsset() IN PLACE OF the
// real `fetch` global — builds the fixture WAV in memory and hands back a
// real Response object, so download/storage runs exactly as it does for a
// real provider, but nothing ever leaves this machine.
async function fakeFetchImpl(url) {
  if (url === FIXTURE_URL) {
    const buffer = buildFixtureWavBuffer();
    return new Response(buffer, { status: 200, headers: { 'content-type': 'audio/wav', 'content-length': String(buffer.length) } });
  }
  throw new Error(`FixtureMusicProvider's fetchImpl only recognizes its own fixture URL, got: "${url}"`);
}

// This fixture provider needs no credential — credential() always returns
// a non-null placeholder so services/music-acquisition-service.js's
// MISSING_CREDENTIAL gate never blocks it.
function credential() {
  return 'fixture-music-no-credential-required';
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

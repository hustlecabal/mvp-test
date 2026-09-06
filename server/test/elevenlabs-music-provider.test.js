// Tests for services/music/elevenlabs-music-provider.js — PHASE 3D.
//
// Unlike ai33-music-provider.js (Phase 3C, always UNAVAILABLE — no
// confirmed endpoint), this provider's real contract DOES work — verified
// directly against the live API reference (see that file's own header).
// These tests exercise the real module with an injected fetchImpl, never
// a live network call, mirroring every other real-provider test in this
// codebase (test/media-acquisition/*.test.js's own convention).

const test = require('node:test');
const assert = require('node:assert/strict');

const elevenlabsMusicProvider = require('../services/music/elevenlabs-music-provider');
const { assertImplementsMusicProviderInterface } = require('../services/music/music-provider-interface');
const { createMusicAcquisitionRequest } = require('../schemas/music-acquisition-schema');

function musicRequest(overrides = {}) {
  return createMusicAcquisitionRequest({ projectId: 'p1', provider: 'elevenlabs', searchQuery: 'uplifting corporate background music', ...overrides });
}

function withEnv(key, value, fn) {
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

// A real MP3 signature (bare MPEG frame sync) — matches services/asset-
// storage.js's own AUDIO_SIGNATURES fallback check.
function buildFixtureMp3Buffer() {
  return Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Buffer.alloc(64, 0)]);
}

// ===========================================================================
// A. provider interface compliance
// ===========================================================================

test('A. elevenlabs-music-provider.js implements the Phase 3B MusicProvider interface', () => {
  assert.doesNotThrow(() => assertImplementsMusicProviderInterface(elevenlabsMusicProvider));
  assert.equal(elevenlabsMusicProvider.PROVIDER_NAME, 'elevenlabs');
});

// ===========================================================================
// B. credential handling — a BRAND NEW credential, never AI33's
// ===========================================================================

test('B. credential() reads EVOLINK_ELEVENLABS_API_KEY, a brand-new credential never shared with AI33', async () => {
  await withEnv('EVOLINK_ELEVENLABS_API_KEY', undefined, async () => {
    await withEnv('EVOLINK_AI33_API_KEY', 'ai33-key-should-never-be-read-here', async () => {
      assert.equal(elevenlabsMusicProvider.credential(), null, 'must never fall back to the AI33 credential');
    });
  });
  await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'eleven-key-1', () => {
    assert.equal(elevenlabsMusicProvider.credential(), 'eleven-key-1');
  });
});

test('C. search() reports MISSING_CREDENTIAL (UNAVAILABLE) when EVOLINK_ELEVENLABS_API_KEY is not set, never throws, never calls fetch', async () => {
  await withEnv('EVOLINK_ELEVENLABS_API_KEY', undefined, async () => {
    let fetchCalled = false;
    const result = await elevenlabsMusicProvider.search(musicRequest(), { fetchImpl: async () => { fetchCalled = true; throw new Error('must not be called'); } });
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.diagnostics[0].code, 'MISSING_CREDENTIAL');
    assert.equal(fetchCalled, false);
  });
});

// ===========================================================================
// D. invalid request
// ===========================================================================

test('D. search() rejects an invalid request (empty searchQuery) with FAILED, before any credential/network check', async () => {
  const result = await elevenlabsMusicProvider.search(createMusicAcquisitionRequest({ provider: 'elevenlabs', searchQuery: '' }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_REQUEST');
});

// ===========================================================================
// E. successful API response — real contract, binary-response handling
// ===========================================================================

test('E. a successful HTTP 200 with real binary bytes produces a COMPLETED result with an audioBuffer candidate (no downloadUrl — Phase 3D\'s own binary-response mode)', async () => {
  const mp3Bytes = buildFixtureMp3Buffer();
  let capturedUrl = null;
  let capturedInit = null;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(mp3Bytes, { status: 200, headers: { 'content-type': 'audio/mpeg', 'song-id': 'song-abc123' } });
  };

  const result = await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'real-key-1', () => elevenlabsMusicProvider.search(musicRequest(), { fetchImpl }));

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.downloadUrl, null, 'a generative provider with finished bytes in hand must never carry a downloadUrl');
  assert.ok(Buffer.isBuffer(candidate.audioBuffer), 'the real response bytes must be exposed as a Buffer');
  assert.ok(candidate.audioBuffer.equals(mp3Bytes));
  assert.equal(candidate.providerAssetId, 'song-abc123', 'the real song-id response header, when present');
  assert.equal(candidate.format, 'mp3', 'derived from the REAL content-type header, never guessed');
  assert.equal(candidate.durationSeconds, null, 'requested, never claimed as a confirmed/measured fact — see file header');

  // --- real, verified request contract ---
  assert.equal(capturedUrl, 'https://api.elevenlabs.io/v1/music');
  assert.equal(capturedInit.method, 'POST');
  assert.equal(capturedInit.headers['xi-api-key'], 'real-key-1');
  assert.equal(capturedInit.headers['Content-Type'], 'application/json');
  const body = JSON.parse(capturedInit.body);
  assert.equal(body.prompt, 'uplifting corporate background music');
  assert.equal(body.force_instrumental, true, 'EvoLink background music must default to instrumental');
});

test('E2. EVOLINK_ELEVENLABS_BASE_URL overrides the default base URL — same override convention every real provider in this codebase already uses', async () => {
  await withEnv('EVOLINK_ELEVENLABS_BASE_URL', 'https://elevenlabs.example.test', async () => {
    delete require.cache[require.resolve('../services/music/elevenlabs-music-provider')];
    const reloaded = require('../services/music/elevenlabs-music-provider');
    assert.equal(reloaded.DEFAULT_BASE_URL, 'https://elevenlabs.example.test');
  });
  delete require.cache[require.resolve('../services/music/elevenlabs-music-provider')];
});

// ===========================================================================
// F. duration mapping (Part B) — reuses EXISTING request fields, clamps to
// the real, verified 3000-600000ms contract
// ===========================================================================

test('F. maxDurationSeconds maps to music_length_ms (clamped to the documented 3000-600000ms range), preferred over minDurationSeconds', async () => {
  let capturedBody = null;
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return new Response(buildFixtureMp3Buffer(), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsMusicProvider.search(musicRequest({ minDurationSeconds: 10, maxDurationSeconds: 20 }), { fetchImpl }));
  assert.equal(capturedBody.music_length_ms, 20000);

  await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsMusicProvider.search(musicRequest({ maxDurationSeconds: 10000 }), { fetchImpl }));
  assert.equal(capturedBody.music_length_ms, 600000, 'clamped to the documented maximum, never sent out of range');

  await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsMusicProvider.search(musicRequest({ maxDurationSeconds: 1 }), { fetchImpl }));
  assert.equal(capturedBody.music_length_ms, 3000, 'clamped to the documented minimum, never sent out of range');

  await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsMusicProvider.search(musicRequest(), { fetchImpl }));
  assert.equal(capturedBody.music_length_ms, undefined, 'omitted entirely when no duration is requested — matches the documented "model chooses a length" default');
});

// ===========================================================================
// G. malformed response
// ===========================================================================

test('G. a response whose body cannot be read is a structured FAILED/INVALID_RESPONSE result, never a thrown error', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => {
      throw new Error('stream error');
    },
  });
  const result = await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsMusicProvider.search(musicRequest(), { fetchImpl }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_RESPONSE');
});

test('G2. an empty response body is a structured FAILED/EMPTY_RESPONSE result', async () => {
  const fetchImpl = async () => new Response(Buffer.alloc(0), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  const result = await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsMusicProvider.search(musicRequest(), { fetchImpl }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'EMPTY_RESPONSE');
});

// ===========================================================================
// H. provider HTTP failure — the real, documented 422 shape
// ===========================================================================

test('H. a real HTTP 422 validation error is a structured FAILED/PROVIDER_HTTP_ERROR result carrying the real error detail, never a crash', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ detail: 'music_length_ms must be between 3000 and 600000' }), { status: 422, headers: { 'content-type': 'application/json' } });
  const result = await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsMusicProvider.search(musicRequest(), { fetchImpl }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'PROVIDER_HTTP_ERROR');
  assert.match(result.diagnostics[0].message, /422/);
  assert.match(result.diagnostics[0].message, /music_length_ms must be between/);
});

// ===========================================================================
// I. network error
// ===========================================================================

test('I. a network-level fetch failure is a structured UNAVAILABLE/NETWORK_ERROR result, never a thrown error', async () => {
  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.elevenlabs.io');
  };
  const result = await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsMusicProvider.search(musicRequest(), { fetchImpl }));
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.diagnostics[0].code, 'NETWORK_ERROR');
});

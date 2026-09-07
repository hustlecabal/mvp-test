// Tests for services/sfx/elevenlabs-sfx-provider.js — PHASE 3E.
//
// Mirrors test/elevenlabs-music-provider.test.js's exact discipline: the
// real module, exercised with an injected fetchImpl, never a live network
// call in these tests (the real, live smoke test is separate — see the
// Phase 3E final report).

const test = require('node:test');
const assert = require('node:assert/strict');

const elevenlabsSfxProvider = require('../services/sfx/elevenlabs-sfx-provider');
const { assertImplementsSfxProviderInterface } = require('../services/sfx/sfx-provider-interface');
const { createSfxAcquisitionRequest } = require('../schemas/sfx-acquisition-schema');

function sfxRequest(overrides = {}) {
  return createSfxAcquisitionRequest({ projectId: 'p1', provider: 'elevenlabs', searchQuery: 'soft UI click', ...overrides });
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

function buildFixtureMp3Buffer() {
  return Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Buffer.alloc(64, 0)]);
}

// ===========================================================================
// A. provider interface compliance
// ===========================================================================

test('A. elevenlabs-sfx-provider.js implements the Phase 3E SfxProvider interface', () => {
  assert.doesNotThrow(() => assertImplementsSfxProviderInterface(elevenlabsSfxProvider));
  assert.equal(elevenlabsSfxProvider.PROVIDER_NAME, 'elevenlabs');
});

// ===========================================================================
// B. credential handling — the SAME ElevenLabs account credential Music uses
// ===========================================================================

test('B. credential() reads EVOLINK_ELEVENLABS_API_KEY — the same real ElevenLabs account credential services/music/elevenlabs-music-provider.js uses, since both are endpoints of the same account', async () => {
  await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'shared-eleven-key', () => {
    assert.equal(elevenlabsSfxProvider.credential(), 'shared-eleven-key');
  });
});

test('C. search() reports MISSING_CREDENTIAL (UNAVAILABLE) when EVOLINK_ELEVENLABS_API_KEY is not set, never throws, never calls fetch', async () => {
  await withEnv('EVOLINK_ELEVENLABS_API_KEY', undefined, async () => {
    let fetchCalled = false;
    const result = await elevenlabsSfxProvider.search(sfxRequest(), { fetchImpl: async () => { fetchCalled = true; throw new Error('must not be called'); } });
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.diagnostics[0].code, 'MISSING_CREDENTIAL');
    assert.equal(fetchCalled, false);
  });
});

// ===========================================================================
// D. invalid request
// ===========================================================================

test('D. search() rejects an invalid request (empty searchQuery) with FAILED, before any credential/network check', async () => {
  const result = await elevenlabsSfxProvider.search(createSfxAcquisitionRequest({ provider: 'elevenlabs', searchQuery: '' }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_REQUEST');
});

// ===========================================================================
// E. successful API response — real contract, binary-response handling
// ===========================================================================

test('E. a successful HTTP 200 with real binary bytes produces a COMPLETED result with an audioBuffer candidate (no downloadUrl)', async () => {
  const mp3Bytes = buildFixtureMp3Buffer();
  let capturedUrl = null;
  let capturedInit = null;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(mp3Bytes, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };

  const result = await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'real-key-1', () => elevenlabsSfxProvider.search(sfxRequest(), { fetchImpl }));

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.downloadUrl, null, 'a generative provider with finished bytes in hand must never carry a downloadUrl');
  assert.ok(Buffer.isBuffer(candidate.audioBuffer));
  assert.ok(candidate.audioBuffer.equals(mp3Bytes));
  assert.equal(candidate.format, 'mp3', 'derived from the REAL content-type header, never guessed');
  assert.equal(candidate.durationSeconds, null, 'requested, never claimed as a confirmed/measured fact');

  // --- real, verified request contract ---
  assert.equal(capturedUrl, 'https://api.elevenlabs.io/v1/sound-generation');
  assert.equal(capturedInit.method, 'POST');
  assert.equal(capturedInit.headers['xi-api-key'], 'real-key-1');
  const body = JSON.parse(capturedInit.body);
  assert.equal(body.text, 'soft UI click');
  assert.equal(body.loop, undefined, 'Phase 3E is one-shot only — loop must never be requested');
});

test('E2. maxDurationSeconds maps to duration_seconds (clamped to the documented 0.5-30s range), preferred over minDurationSeconds', async () => {
  let capturedBody = null;
  const fetchImpl = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return new Response(buildFixtureMp3Buffer(), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsSfxProvider.search(sfxRequest({ minDurationSeconds: 1, maxDurationSeconds: 2 }), { fetchImpl }));
  assert.equal(capturedBody.duration_seconds, 2);

  await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsSfxProvider.search(sfxRequest({ maxDurationSeconds: 100 }), { fetchImpl }));
  assert.equal(capturedBody.duration_seconds, 30, 'clamped to the documented maximum');

  await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsSfxProvider.search(sfxRequest({ maxDurationSeconds: 0.1 }), { fetchImpl }));
  assert.equal(capturedBody.duration_seconds, 0.5, 'clamped to the documented minimum');

  await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsSfxProvider.search(sfxRequest(), { fetchImpl }));
  assert.equal(capturedBody.duration_seconds, undefined, 'omitted entirely when no duration is requested');
});

// ===========================================================================
// F. malformed response
// ===========================================================================

test('F. a response whose body cannot be read is a structured FAILED/INVALID_RESPONSE result, never a thrown error', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => {
      throw new Error('stream error');
    },
  });
  const result = await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsSfxProvider.search(sfxRequest(), { fetchImpl }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_RESPONSE');
});

test('F2. an empty response body is a structured FAILED/EMPTY_RESPONSE result', async () => {
  const fetchImpl = async () => new Response(Buffer.alloc(0), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  const result = await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsSfxProvider.search(sfxRequest(), { fetchImpl }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'EMPTY_RESPONSE');
});

// ===========================================================================
// G. provider HTTP failure — the real, documented 422 shape
// ===========================================================================

test('G. a real HTTP 422 validation error is a structured FAILED/PROVIDER_HTTP_ERROR result carrying the real error detail, never a crash', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ detail: 'duration_seconds must be between 0.5 and 30' }), { status: 422, headers: { 'content-type': 'application/json' } });
  const result = await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsSfxProvider.search(sfxRequest(), { fetchImpl }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'PROVIDER_HTTP_ERROR');
  assert.match(result.diagnostics[0].message, /422/);
  assert.match(result.diagnostics[0].message, /duration_seconds must be between/);
});

// ===========================================================================
// H. network error
// ===========================================================================

test('H. a network-level fetch failure is a structured UNAVAILABLE/NETWORK_ERROR result, never a thrown error', async () => {
  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.elevenlabs.io');
  };
  const result = await withEnv('EVOLINK_ELEVENLABS_API_KEY', 'k', () => elevenlabsSfxProvider.search(sfxRequest(), { fetchImpl }));
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.diagnostics[0].code, 'NETWORK_ERROR');
});

// Tests for services/music/fixture-music-provider.js — PHASE 3B.
// Mirrors test/stock-media-providers.test.js's own discipline: never
// calls the real network, proves the fixture's bytes are genuinely valid
// audio (not an opaque placeholder), and proves the provider is
// deterministic across repeated calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixtureMusicProvider = require('../services/music/fixture-music-provider');
const { createMusicAcquisitionRequest } = require('../schemas/music-acquisition-schema');
const { sniffAudioFormat } = require('../services/asset-storage');

function request(overrides = {}) {
  return createMusicAcquisitionRequest({ provider: 'fixture', searchQuery: 'ambient piano', ...overrides });
}

// --- deterministic success -------------------------------------------------------------------

test('A. search() returns a single COMPLETED candidate with deterministic metadata', async () => {
  const result = await fixtureMusicProvider.search(request());
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].providerAssetId, 'fixture-music-1');
  assert.equal(result.candidates[0].format, 'wav');
  assert.equal(result.candidates[0].durationSeconds, fixtureMusicProvider.FIXTURE_DURATION_SECONDS);
  assert.equal(result.candidates[0].downloadUrl, fixtureMusicProvider.FIXTURE_URL);
});

test('A2. search() is deterministic — two calls produce identical candidates', async () => {
  const first = await fixtureMusicProvider.search(request());
  const second = await fixtureMusicProvider.search(request());
  assert.deepEqual(first, second);
});

test('A3. search() without a searchQuery fails structurally, never throws', async () => {
  const result = await fixtureMusicProvider.search(createMusicAcquisitionRequest({ provider: 'fixture' }));
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_REQUEST');
});

// --- valid audio -------------------------------------------------------------------

test('B. buildFixtureWavBuffer() produces bytes asset-storage.js\'s own sniffAudioFormat recognizes as real WAV audio', () => {
  const buffer = fixtureMusicProvider.buildFixtureWavBuffer();
  const format = sniffAudioFormat(buffer);
  assert.ok(format, 'the fixture bytes must be recognized as real audio, never an opaque placeholder');
  assert.equal(format.ext, '.wav');
  assert.equal(format.contentType, 'audio/wav');
});

test('B2. the fixture WAV is genuinely decodable by a real audio decoder (ffprobe) with the documented duration', () => {
  const buffer = fixtureMusicProvider.buildFixtureWavBuffer();
  const tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-fixture-music-')), 'sample.wav');
  fs.writeFileSync(tmpPath, buffer);
  try {
    const raw = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', tmpPath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
    const probed = JSON.parse(raw);
    assert.equal(Number(probed.format.duration), fixtureMusicProvider.FIXTURE_DURATION_SECONDS);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
});

// --- deterministic duration -------------------------------------------------------------------

test('C. buildFixtureWavBuffer() produces byte-identical output across repeated calls', () => {
  const first = fixtureMusicProvider.buildFixtureWavBuffer();
  const second = fixtureMusicProvider.buildFixtureWavBuffer();
  assert.ok(first.equals(second), 'repeated fixture generation must be byte-identical — no randomness, no wall-clock dependence');
});

// --- fakeFetchImpl -------------------------------------------------------------------

test('D. fakeFetchImpl resolves the fixture URL to a real, readable Response with the fixture bytes', async () => {
  const response = await fixtureMusicProvider.fakeFetchImpl(fixtureMusicProvider.FIXTURE_URL);
  assert.equal(response.status, 200);
  const arrayBuffer = await response.arrayBuffer();
  assert.ok(Buffer.from(arrayBuffer).equals(fixtureMusicProvider.buildFixtureWavBuffer()));
});

test('D2. fakeFetchImpl throws for any URL other than its own fixture URL, never silently returns something else', async () => {
  await assert.rejects(() => fixtureMusicProvider.fakeFetchImpl('https://example.com/not-the-fixture.wav'));
});

// --- no network/credential dependency -------------------------------------------------------------------

test('E. credential() always returns a non-null placeholder — never gated by a real env var', () => {
  assert.ok(fixtureMusicProvider.credential());
});

test('F. no network/provider/generation call anywhere in this fixture — static scan', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'services', 'music', 'fixture-music-provider.js'), 'utf8');
  for (const pattern of [/axios/, /http\.request/, /https\.request/, /child_process/, /\beval\(/, /new Function\(/]) {
    assert.doesNotMatch(text, pattern);
  }
});

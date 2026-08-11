// Tests for providers/fake-image/fake-image-provider.js — the Stage 13B
// Part 3 fake provider. Confirms it accepts a request, returns a fake
// task id, deterministically simulates processing-then-completion,
// returns the bundled fixture, and that its fetchImpl never touches the
// real network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createImageGeneration,
  getGenerationStatus,
  fakeFetchImpl,
  resetFakeImageProvider,
  FAKE_RESERVED_COST,
  FIXTURE_URL,
  PROVIDER_NAME,
} = require('../providers/fake-image/fake-image-provider');

test.beforeEach(() => resetFakeImageProvider());

// --- 2. fake provider --------------------------------------------------------------

test('2. createImageGeneration accepts a request and returns a fake task id with SUBMITTED status', async () => {
  const status = await createImageGeneration({ prompt: 'x' });
  assert.ok(status.generationId);
  assert.equal(status.provider, PROVIDER_NAME);
  assert.equal(status.status, 'SUBMITTED');
  assert.equal(status.reservedCost, FAKE_RESERVED_COST);
  assert.deepEqual(status.results, []);
});

test('createImageGeneration never invents pricing beyond its own fixed, documented test number', () => {
  assert.equal(typeof FAKE_RESERVED_COST, 'number');
});

test('simulates processing: the first status check reports PROCESSING, later checks report COMPLETED', async () => {
  const created = await createImageGeneration({ prompt: 'x' });
  const first = await getGenerationStatus(created.generationId);
  assert.equal(first.status, 'PROCESSING');

  const second = await getGenerationStatus(created.generationId);
  assert.equal(second.status, 'COMPLETED');
  assert.deepEqual(second.results, [FIXTURE_URL]);

  const third = await getGenerationStatus(created.generationId);
  assert.equal(third.status, 'COMPLETED', 'stays deterministically completed on further checks');
});

test('getGenerationStatus throws a clear error for an unknown task id', async () => {
  await assert.rejects(() => getGenerationStatus('nonexistent-task'), /Unknown fake image generation task/);
});

test('resetFakeImageProvider clears in-memory state between tests', async () => {
  const created = await createImageGeneration({ prompt: 'x' });
  resetFakeImageProvider();
  await assert.rejects(() => getGenerationStatus(created.generationId));
});

// --- fetchImpl: never touches the network -------------------------------------------

test('fakeFetchImpl reads the bundled fixture from disk and never calls the real network', async () => {
  const response = await fakeFetchImpl(FIXTURE_URL);
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  const buffer = Buffer.from(await response.arrayBuffer());
  const fixtureOnDisk = fs.readFileSync(path.join(__dirname, '..', 'providers', 'fake-image', 'fixtures', 'sample-keyframe.png'));
  assert.deepEqual(buffer, fixtureOnDisk);
});

test('fakeFetchImpl rejects any URL other than its own fixture URL', async () => {
  await assert.rejects(() => fakeFetchImpl('https://example.com/not-the-fixture.png'));
});

// --- never touches the network at the source level ----------------------------------

test('fake-image-provider.js never calls fetch/http/https for its own generation logic', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'providers', 'fake-image', 'fake-image-provider.js'), 'utf8');
  // fetchImpl deliberately constructs a Response object directly (no network
  // call) — assert no `fetch(` call appears anywhere, including there.
  assert.doesNotMatch(text, /\bfetch\(/);
  assert.doesNotMatch(text, /require\(\s*['"`]https?['"`]\s*\)/);
  assert.doesNotMatch(text, /require\(\s*['"`]axios['"`]\s*\)/);
});

// Tests for providers/evolink/evolink-provider.js — the full create ->
// status -> result flow, through mocked HTTP only. This is the layer the
// rest of the application (eventually) talks to; it should only ever see
// our generic shapes, never raw EvoLink fields.

const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../providers/evolink/evolink-provider');

const ORIGINAL_KEY = process.env.EVOLINK_API_KEY;

test.beforeEach(() => {
  process.env.EVOLINK_API_KEY = 'test-key-provider';
});

test.after(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.EVOLINK_API_KEY;
  } else {
    process.env.EVOLINK_API_KEY = ORIGINAL_KEY;
  }
});

function fakeResponse(status, bodyObj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(bodyObj),
  };
}

test('4. createGeneration submits a mapped request and returns our generic status shape', async () => {
  let capturedBody;
  const fetchImpl = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return fakeResponse(200, {
      id: 'task-unified-999',
      object: 'video.generation.task',
      model: 'seedance-2.5-text-to-video',
      status: 'pending',
      progress: 0,
    });
  };

  const result = await provider.createGeneration(
    {
      model: 'seedance-2.5-text-to-video',
      prompt: 'A lighthouse at dusk',
      parameters: { duration: 8, aspectRatio: '16:9' },
    },
    { fetchImpl }
  );

  // The request that actually went out used EvoLink's real field names...
  assert.equal(capturedBody.model, 'seedance-2.5-text-to-video');
  assert.equal(capturedBody.aspect_ratio, '16:9');

  // ...but what we get back is our OWN generic shape, not EvoLink's raw one.
  assert.equal(result.generationId, 'task-unified-999');
  assert.equal(result.provider, 'evolink');
  assert.equal(result.status, 'SUBMITTED');
  assert.deepEqual(result.results, []);
  assert.ok(!('object' in result), 'raw EvoLink fields like "object" must not leak into our generic shape');
});

test('5. getGenerationStatus returns our generic shape for an in-progress task', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://api.evolink.ai/v1/tasks/task-unified-999');
    return fakeResponse(200, { id: 'task-unified-999', status: 'processing', progress: 55 });
  };

  const result = await provider.getGenerationStatus('task-unified-999', { fetchImpl });
  assert.equal(result.status, 'PROCESSING');
  assert.equal(result.progress, 55);
});

test('6. getGenerationResult returns populated results once completed', async () => {
  const fetchImpl = async () =>
    fakeResponse(200, {
      id: 'task-unified-999',
      status: 'completed',
      progress: 100,
      results: ['https://example.com/generated-video.mp4'],
    });

  const result = await provider.getGenerationResult('task-unified-999', { fetchImpl });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.results, ['https://example.com/generated-video.mp4']);
});

test('7. a failed generation is reported through our generic error shape', async () => {
  const fetchImpl = async () =>
    fakeResponse(200, {
      id: 'task-unified-999',
      status: 'failed',
      error: { code: 'content_policy_violation', message: 'Blocked by safety filters' },
    });

  const result = await provider.getGenerationStatus('task-unified-999', { fetchImpl });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error.code, 'content_policy_violation');
});

test('7. an EvoLink-level auth error propagates as an EvolinkApiError, not a silent failure', async () => {
  const fetchImpl = async () =>
    fakeResponse(401, { error: { code: 'unauthorized', message: 'Invalid or expired token' } });

  await assert.rejects(() => provider.getGenerationStatus('task-unified-999', { fetchImpl }), (err) => {
    assert.equal(err.name, 'EvolinkApiError');
    assert.equal(err.code, 'unauthorized');
    return true;
  });
});

test('10. createGeneration refuses an unverified model before any HTTP call is made', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return fakeResponse(200, {});
  };

  await assert.rejects(
    () => provider.createGeneration({ model: 'kling-o3-text-to-video', prompt: 'x', parameters: {} }, { fetchImpl }),
    /not a verified EvoLink model/
  );
  assert.equal(called, false, 'no HTTP request should be made for an unverified model');
});

test('checkAccountCredits calls the safe /v1/credits endpoint and returns the raw balance info', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://api.evolink.ai/v1/credits');
    return fakeResponse(200, { success: true, data: { token: { remaining_credits: 100 }, user: {} } });
  };

  const result = await provider.checkAccountCredits({ fetchImpl });
  assert.equal(result.success, true);
});

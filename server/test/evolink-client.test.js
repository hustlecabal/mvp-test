// Tests for providers/evolink/evolink-client.js — HTTP communication,
// auth, and error handling. Every test here uses a mocked fetchImpl; NONE
// of these tests make a real network call, and no real API key exists to
// make one with anyway.

const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('../providers/evolink/evolink-client');

const ORIGINAL_KEY = process.env.EVOLINK_API_KEY;

test.beforeEach(() => {
  delete process.env.EVOLINK_API_KEY;
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

// --- missing API key -----------------------------------------------------

test('8. hasApiKey() is false when EVOLINK_API_KEY is unset', () => {
  assert.equal(client.hasApiKey(), false);
});

test('8. getTask throws a clear, beginner-friendly error when no API key is set', async () => {
  await assert.rejects(() => client.getTask('task-unified-123'), /EVOLINK_API_KEY is not set/);
});

test('9. an empty-string API key counts as missing, not a valid (empty) configuration', async () => {
  process.env.EVOLINK_API_KEY = '';
  await assert.rejects(() => client.getTask('task-unified-123'), /EVOLINK_API_KEY is not set/);
});

test('never silently falls back to a fake key — the request is never sent without one', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return fakeResponse(200, {});
  };

  await assert.rejects(() => client.getTask('task-unified-123', { fetchImpl }));
  assert.equal(called, false, 'fetch must never be called when no API key is configured');
});

// --- successful requests, mocked ------------------------------------------

test('4. createVideoGenerationTask sends the Bearer header and returns the parsed task', async () => {
  process.env.EVOLINK_API_KEY = 'test-key-abc';
  let capturedHeaders;

  const fetchImpl = async (url, options) => {
    capturedHeaders = options.headers;
    assert.equal(url, 'https://api.evolink.ai/v1/videos/generations');
    return fakeResponse(200, { id: 'task-unified-1', status: 'pending', model: 'seedance-2.5-text-to-video' });
  };

  const result = await client.createVideoGenerationTask(
    { model: 'seedance-2.5-text-to-video', prompt: 'x' },
    { fetchImpl }
  );

  assert.equal(capturedHeaders.Authorization, 'Bearer test-key-abc');
  assert.equal(result.id, 'task-unified-1');
  assert.equal(result.status, 'pending');
});

test('5. getTask returns the parsed status response', async () => {
  process.env.EVOLINK_API_KEY = 'test-key-abc';
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://api.evolink.ai/v1/tasks/task-unified-1');
    return fakeResponse(200, { id: 'task-unified-1', status: 'processing', progress: 40 });
  };

  const result = await client.getTask('task-unified-1', { fetchImpl });
  assert.equal(result.status, 'processing');
  assert.equal(result.progress, 40);
});

test('Stage 16: createImageGenerationTask sends the Bearer header to the images endpoint and returns the parsed task', async () => {
  process.env.EVOLINK_API_KEY = 'test-key-abc';
  let capturedHeaders;

  const fetchImpl = async (url, options) => {
    capturedHeaders = options.headers;
    assert.equal(url, 'https://api.evolink.ai/v1/images/generations');
    return fakeResponse(200, { id: 'task-unified-img-1', status: 'pending', model: 'gemini-3-pro-image-preview' });
  };

  const result = await client.createImageGenerationTask({ model: 'gemini-3-pro-image-preview', prompt: 'x' }, { fetchImpl });

  assert.equal(capturedHeaders.Authorization, 'Bearer test-key-abc');
  assert.equal(result.id, 'task-unified-img-1');
});

test('Stage 16: createImageGenerationTask throws the same clear missing-key error as the video endpoint', async () => {
  delete process.env.EVOLINK_API_KEY;
  await assert.rejects(() => client.createImageGenerationTask({ model: 'x', prompt: 'x' }), /EVOLINK_API_KEY is not set/);
});

test('getCredits calls the safe, non-generation account endpoint', async () => {
  process.env.EVOLINK_API_KEY = 'test-key-abc';
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://api.evolink.ai/v1/credits');
    return fakeResponse(200, { success: true, data: { token: {}, user: {} } });
  };

  const result = await client.getCredits({ fetchImpl });
  assert.equal(result.success, true);
});

// --- error mapping ---------------------------------------------------------

test('7. maps an EvoLink HTTP error response into an EvolinkApiError', async () => {
  process.env.EVOLINK_API_KEY = 'test-key-abc';
  const fetchImpl = async () =>
    fakeResponse(401, { error: { code: 'unauthorized', message: 'Invalid or expired token', type: 'authentication_error' } });

  await assert.rejects(
    () => client.getTask('task-unified-1', { fetchImpl }),
    (err) => {
      assert.ok(err instanceof client.EvolinkApiError);
      assert.equal(err.httpStatus, 401);
      assert.equal(err.code, 'unauthorized');
      assert.equal(err.type, 'authentication_error');
      assert.equal(err.message, 'Invalid or expired token');
      return true;
    }
  );
});

test('7. maps a quota-exceeded error response', async () => {
  process.env.EVOLINK_API_KEY = 'test-key-abc';
  const fetchImpl = async () =>
    fakeResponse(402, { error: { code: 'insufficient_quota', message: 'Insufficient quota. Please top up your account.' } });

  await assert.rejects(() => client.createVideoGenerationTask({ model: 'x', prompt: 'x' }, { fetchImpl }), (err) => {
    assert.equal(err.code, 'insufficient_quota');
    return true;
  });
});

test('handles a non-JSON error body without crashing', async () => {
  process.env.EVOLINK_API_KEY = 'test-key-abc';
  const fetchImpl = async () => ({ ok: false, status: 502, text: async () => '<html>Bad Gateway</html>' });

  await assert.rejects(() => client.getTask('task-unified-1', { fetchImpl }), /not valid JSON/);
});

// --- API key never leaks ----------------------------------------------------

test('11. a thrown error never includes the real API key anywhere in its message or properties', async () => {
  const secretKey = 'sk-super-secret-value-should-never-leak-12345';
  process.env.EVOLINK_API_KEY = secretKey;

  const fetchImpl = async () => fakeResponse(500, { error: { code: 'internal_error', message: 'Server error' } });

  try {
    await client.getTask('task-unified-1', { fetchImpl });
    assert.fail('expected getTask to throw');
  } catch (err) {
    const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
    assert.ok(!serialized.includes(secretKey), 'error object must not contain the API key');
    assert.ok(!String(err.stack).includes(secretKey), 'stack trace must not contain the API key');
  }
});

test('11. the missing-key error message never contains a key value (there is none to leak)', async () => {
  delete process.env.EVOLINK_API_KEY;
  try {
    await client.getTask('task-unified-1');
    assert.fail('expected getTask to throw');
  } catch (err) {
    assert.doesNotMatch(err.message, /Bearer/);
  }
});

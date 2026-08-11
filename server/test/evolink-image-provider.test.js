// Tests for providers/evolink/evolink-image-provider.js — Stage 16, Part 4.
// Implements image-provider-interface.js for real EvoLink. Every test here
// uses a mocked fetchImpl passed all the way through evolink-client.js;
// NONE of these tests make a real network call, and the API key used is
// always a test value, never the real EVOLINK_API_KEY. Also proves the key
// is never logged/exposed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertImplementsImageProviderInterface } = require('../providers/image-provider-interface');
const evolinkImageProvider = require('../providers/evolink/evolink-image-provider');

const ORIGINAL_KEY = process.env.EVOLINK_API_KEY;

test.after(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.EVOLINK_API_KEY;
  } else {
    process.env.EVOLINK_API_KEY = ORIGINAL_KEY;
  }
});

function fakeResponse(status, bodyObj) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(bodyObj) };
}

// evolink-client.js reads the global `fetch` when no fetchImpl is passed —
// this file's provider never exposes a fetchImpl override parameter (it
// isn't part of the image-provider-interface contract), so these tests
// monkey-patch the global fetch for the duration of each test instead, then
// restore it. This proves createImageGeneration/getGenerationStatus never
// make a real network call.
function withMockedFetch(fetchImpl, fn) {
  const original = global.fetch;
  global.fetch = fetchImpl;
  return fn().finally(() => {
    global.fetch = original;
  });
}

test('evolink-image-provider.js implements the required image-provider interface', () => {
  assert.doesNotThrow(() => assertImplementsImageProviderInterface(evolinkImageProvider));
});

test('createImageGeneration submits the mapped request and returns our generic status shape', async () => {
  process.env.EVOLINK_API_KEY = 'test-key-abc';
  await withMockedFetch(
    async (url, options) => {
      assert.equal(url, 'https://api.evolink.ai/v1/images/generations');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'gemini-3-pro-image-preview');
      assert.equal(body.prompt, 'A lighthouse keeper at dusk');
      return fakeResponse(200, {
        id: 'task-unified-img-1',
        object: 'image.generation.task',
        model: 'gemini-3-pro-image-preview',
        status: 'pending',
        progress: 0,
        usage: { credits_reserved: 2.5 },
      });
    },
    async () => {
      const result = await evolinkImageProvider.createImageGeneration({
        prompt: 'A lighthouse keeper at dusk',
        referenceDetails: [],
        parameters: { model: 'gemini-3-pro-image-preview' },
      });
      assert.equal(result.generationId, 'task-unified-img-1');
      assert.equal(result.provider, 'evolink-image');
      assert.equal(result.status, 'SUBMITTED');
      assert.equal(result.reservedCost, 2.5);
    }
  );
});

test('createImageGeneration attaches mapper warnings onto the returned status when references could not be fully mapped', async () => {
  process.env.EVOLINK_API_KEY = 'test-key-abc';
  await withMockedFetch(
    async () => fakeResponse(200, { id: 'task-unified-img-2', status: 'pending', model: 'gemini-3-pro-image-preview' }),
    async () => {
      const result = await evolinkImageProvider.createImageGeneration({
        prompt: 'x',
        referenceDetails: [{ assetId: 'asset-1', roleType: 'CHARACTER', role: 'character:Mira' }],
        parameters: { model: 'gemini-3-pro-image-preview', referenceImageUrls: [] },
      });
      assert.ok(Array.isArray(result.warnings));
      assert.ok(result.warnings.some((w) => w.includes('were not included')));
    }
  );
});

test('createImageGeneration never submits a request for an unverified model', async () => {
  await assert.rejects(
    () =>
      evolinkImageProvider.createImageGeneration({
        prompt: 'x',
        referenceDetails: [],
        parameters: { model: 'not-a-real-model' },
      }),
    /not a verified EvoLink IMAGE model/
  );
});

test('getGenerationStatus polls the same unified task endpoint the video provider uses', async () => {
  process.env.EVOLINK_API_KEY = 'test-key-abc';
  await withMockedFetch(
    async (url) => {
      assert.equal(url, 'https://api.evolink.ai/v1/tasks/task-unified-img-1');
      return fakeResponse(200, { id: 'task-unified-img-1', status: 'completed', progress: 100, results: ['https://x/y.png'] });
    },
    async () => {
      const result = await evolinkImageProvider.getGenerationStatus('task-unified-img-1');
      assert.equal(result.status, 'COMPLETED');
      assert.deepEqual(result.results, ['https://x/y.png']);
    }
  );
});

test('getGenerationStatus maps a provider-reported failure without throwing', async () => {
  process.env.EVOLINK_API_KEY = 'test-key-abc';
  await withMockedFetch(
    async () =>
      fakeResponse(200, {
        id: 'task-unified-img-1',
        status: 'failed',
        error: { code: 'content_policy_violation', message: 'blocked' },
      }),
    async () => {
      const result = await evolinkImageProvider.getGenerationStatus('task-unified-img-1');
      assert.equal(result.status, 'FAILED');
      assert.equal(result.error.code, 'content_policy_violation');
    }
  );
});

test('createImageGeneration propagates a malformed (non-JSON) EvoLink response as a clear error, never a silent success', async () => {
  process.env.EVOLINK_API_KEY = 'test-key-abc';
  await withMockedFetch(
    async () => ({ ok: false, status: 502, text: async () => '<html>Bad Gateway</html>' }),
    async () => {
      await assert.rejects(
        () =>
          evolinkImageProvider.createImageGeneration({
            prompt: 'x',
            referenceDetails: [],
            parameters: { model: 'gemini-3-pro-image-preview' },
          }),
        /not valid JSON/
      );
    }
  );
});

test('createImageGeneration throws a clear error, and never calls fetch, when EVOLINK_API_KEY is unset', async () => {
  delete process.env.EVOLINK_API_KEY;
  let called = false;
  await withMockedFetch(
    async () => {
      called = true;
      return fakeResponse(200, {});
    },
    async () => {
      await assert.rejects(
        () =>
          evolinkImageProvider.createImageGeneration({
            prompt: 'x',
            referenceDetails: [],
            parameters: { model: 'gemini-3-pro-image-preview' },
          }),
        /EVOLINK_API_KEY is not set/
      );
    }
  );
  assert.equal(called, false, 'fetch must never be reached when no API key is configured');
});

test('the real EvoLink API key never appears in a thrown error from this provider', async () => {
  const secretKey = 'sk-real-secret-should-never-leak-98765';
  process.env.EVOLINK_API_KEY = secretKey;
  await withMockedFetch(
    async () => fakeResponse(500, { error: { code: 'internal_error', message: 'Server error' } }),
    async () => {
      try {
        await evolinkImageProvider.createImageGeneration({
          prompt: 'x',
          referenceDetails: [],
          parameters: { model: 'gemini-3-pro-image-preview' },
        });
        assert.fail('expected createImageGeneration to throw');
      } catch (err) {
        const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
        assert.ok(!serialized.includes(secretKey));
        assert.ok(!String(err.stack).includes(secretKey));
      }
    }
  );
});

test('checkAccountCredits calls the safe, non-generation account endpoint', async () => {
  process.env.EVOLINK_API_KEY = 'test-key-abc';
  await withMockedFetch(
    async (url) => {
      assert.equal(url, 'https://api.evolink.ai/v1/credits');
      return fakeResponse(200, { success: true, data: { token: { remaining_credits: 42 }, user: {} } });
    },
    async () => {
      const result = await evolinkImageProvider.checkAccountCredits();
      assert.equal(result.data.token.remaining_credits, 42);
    }
  );
});

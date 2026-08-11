// Tests for providers/evolink/evolink-image-mapper.js — Stage 16, Part 3.
// Pure request/response translation, no network, no real API key needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { toEvolinkImageRequest, fromEvolinkImageTask, findVerifiedImageModel } = require('../providers/evolink/evolink-image-mapper');

function normalizedRequest(overrides = {}) {
  return {
    prompt: 'A lighthouse keeper at dusk',
    referenceDetails: [],
    parameters: { model: 'gemini-3-pro-image-preview' },
    ...overrides,
  };
}

// --- model validation --------------------------------------------------------------

test('toEvolinkImageRequest accepts the verified gemini-3-pro-image-preview model', () => {
  const { body } = toEvolinkImageRequest(normalizedRequest());
  assert.equal(body.model, 'gemini-3-pro-image-preview');
  assert.equal(body.prompt, 'A lighthouse keeper at dusk');
});

test('toEvolinkImageRequest accepts the verified gpt-image-2 model', () => {
  const { body } = toEvolinkImageRequest(normalizedRequest({ parameters: { model: 'gpt-image-2' } }));
  assert.equal(body.model, 'gpt-image-2');
});

test('toEvolinkImageRequest rejects an unverified/unknown model rather than guessing its fields', () => {
  assert.throws(
    () => toEvolinkImageRequest(normalizedRequest({ parameters: { model: 'some-made-up-model' } })),
    /not a verified EvoLink IMAGE model/
  );
});

test('toEvolinkImageRequest rejects a VIDEO model even though it is a verified EvoLink identifier', () => {
  assert.throws(
    () => toEvolinkImageRequest(normalizedRequest({ parameters: { model: 'seedance-2.5-text-to-video' } })),
    /not a verified EvoLink IMAGE model/
  );
});

test('findVerifiedImageModel returns the model metadata for a verified image model', () => {
  const info = findVerifiedImageModel('gemini-3-pro-image-preview');
  assert.equal(info.endpointPath, '/v1/images/generations');
  assert.equal(info.requestSchemaVerified, true);
});

test('toEvolinkImageRequest requires a non-empty prompt', () => {
  assert.throws(() => toEvolinkImageRequest(normalizedRequest({ prompt: null })), /requires a non-empty prompt/);
});

// --- optional field mapping --------------------------------------------------------

test('toEvolinkImageRequest maps size/quality/webSearch/callbackUrl only when explicitly provided', () => {
  const { body } = toEvolinkImageRequest(
    normalizedRequest({
      parameters: {
        model: 'gemini-3-pro-image-preview',
        size: '1:1',
        quality: '1K',
        webSearch: true,
        callbackUrl: 'https://example.com/callback',
      },
    })
  );
  assert.equal(body.size, '1:1');
  assert.equal(body.quality, '1K');
  assert.deepEqual(body.model_params, { web_search: true });
  assert.equal(body.callback_url, 'https://example.com/callback');
});

test('toEvolinkImageRequest omits size/quality/model_params/callback_url entirely when not provided', () => {
  const { body } = toEvolinkImageRequest(normalizedRequest());
  assert.equal('size' in body, false);
  assert.equal('quality' in body, false);
  assert.equal('model_params' in body, false);
  assert.equal('callback_url' in body, false);
});

// --- reference mapping (Part 3's "do not fake a role" requirement) -----------------

test('toEvolinkImageRequest maps resolved reference URLs into image_urls, in referenceDetails order', () => {
  const { body } = toEvolinkImageRequest(
    normalizedRequest({
      referenceDetails: [
        { assetId: 'asset-1', roleType: 'CHARACTER', role: 'character:Mira' },
        { assetId: 'asset-2', roleType: 'ENVIRONMENT', role: 'location:Pier' },
      ],
      parameters: {
        model: 'gemini-3-pro-image-preview',
        referenceImageUrls: [
          { assetId: 'asset-1', url: 'https://cdn.example.com/asset-1.png' },
          { assetId: 'asset-2', url: 'https://cdn.example.com/asset-2.png' },
        ],
      },
    })
  );
  assert.deepEqual(body.image_urls, ['https://cdn.example.com/asset-1.png', 'https://cdn.example.com/asset-2.png']);
});

test('toEvolinkImageRequest never invents a role/type field EvoLink does not support', () => {
  const { body } = toEvolinkImageRequest(
    normalizedRequest({
      referenceDetails: [{ assetId: 'asset-1', roleType: 'CHARACTER', role: 'character:Mira' }],
      parameters: {
        model: 'gemini-3-pro-image-preview',
        referenceImageUrls: [{ assetId: 'asset-1', url: 'https://cdn.example.com/asset-1.png' }],
      },
    })
  );
  for (const url of body.image_urls) {
    assert.equal(typeof url, 'string');
  }
  // image_urls is a flat array of URL strings only -- no {url, role} objects,
  // no invented role parameter anywhere in the body.
  assert.deepEqual(Object.keys(body).sort(), ['image_urls', 'model', 'prompt']);
});

test('toEvolinkImageRequest emits a warning explaining role enforcement is unavailable, preserving the intended roles', () => {
  const { warnings } = toEvolinkImageRequest(
    normalizedRequest({
      referenceDetails: [{ assetId: 'asset-1', roleType: 'CHARACTER', role: 'character:Mira' }],
      parameters: {
        model: 'gemini-3-pro-image-preview',
        referenceImageUrls: [{ assetId: 'asset-1', url: 'https://cdn.example.com/asset-1.png' }],
      },
    })
  );
  assert.ok(warnings.some((w) => w.includes('no documented per-image semantic role')));
  assert.ok(warnings.some((w) => w.includes('asset-1=CHARACTER')));
});

test('toEvolinkImageRequest warns (and omits the URL) when a reference has no resolvable public URL, rather than failing or faking one', () => {
  const { body, warnings } = toEvolinkImageRequest(
    normalizedRequest({
      referenceDetails: [{ assetId: 'asset-1', roleType: 'CHARACTER', role: 'character:Mira' }],
      parameters: { model: 'gemini-3-pro-image-preview', referenceImageUrls: [] },
    })
  );
  assert.equal('image_urls' in body, false);
  assert.ok(warnings.some((w) => w.includes('1 reference asset(s) were not included')));
});

test('toEvolinkImageRequest with zero references produces no image_urls field and no reference warnings', () => {
  const { body, warnings } = toEvolinkImageRequest(normalizedRequest());
  assert.equal('image_urls' in body, false);
  assert.deepEqual(warnings, []);
});

// --- response mapping ---------------------------------------------------------------

test('fromEvolinkImageTask maps pending/processing/completed/failed exactly like the video mapper', () => {
  assert.equal(fromEvolinkImageTask({ id: 't1', status: 'pending' }).status, 'SUBMITTED');
  assert.equal(fromEvolinkImageTask({ id: 't1', status: 'processing' }).status, 'PROCESSING');
  assert.equal(fromEvolinkImageTask({ id: 't1', status: 'completed' }).status, 'COMPLETED');
  assert.equal(fromEvolinkImageTask({ id: 't1', status: 'failed' }).status, 'FAILED');
});

test('fromEvolinkImageTask maps a cancelled task (failed + request_cancelled) to CANCELLED', () => {
  const result = fromEvolinkImageTask({ id: 't1', status: 'failed', error: { code: 'request_cancelled', message: 'cancelled' } });
  assert.equal(result.status, 'CANCELLED');
});

test('fromEvolinkImageTask never invents reservedCost when usage is absent (e.g. on a polling response)', () => {
  const result = fromEvolinkImageTask({ id: 't1', status: 'processing', progress: 40 });
  assert.equal(result.reservedCost, null);
});

test('fromEvolinkImageTask reads reservedCost from usage.credits_reserved when present', () => {
  const result = fromEvolinkImageTask({ id: 't1', status: 'pending', usage: { credits_reserved: 3.2 } });
  assert.equal(result.reservedCost, 3.2);
});

test('fromEvolinkImageTask reports provider as "evolink-image", distinct from the video provider name', () => {
  const result = fromEvolinkImageTask({ id: 't1', status: 'completed', results: ['https://x/y.png'] });
  assert.equal(result.provider, 'evolink-image');
  assert.deepEqual(result.results, ['https://x/y.png']);
});

test('fromEvolinkImageTask defaults results to an empty array, never null/undefined', () => {
  const result = fromEvolinkImageTask({ id: 't1', status: 'pending' });
  assert.deepEqual(result.results, []);
});

// --- this file is the only place image_urls/size/quality/model_params can appear ---

test('evolink-image-mapper.js is a self-contained translator with no HTTP/network calls of its own', () => {
  const fs = require('fs');
  const path = require('path');
  const text = fs.readFileSync(path.join(__dirname, '..', 'providers', 'evolink', 'evolink-image-mapper.js'), 'utf8');
  assert.doesNotMatch(text, /\bfetch\(/);
  assert.doesNotMatch(text, /require\(['"]\.\/evolink-client['"]\)/);
});

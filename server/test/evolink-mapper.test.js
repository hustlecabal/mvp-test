// Tests for providers/evolink/evolink-mapper.js — translating between our
// generic shapes and EvoLink's actual documented field names. No network
// calls here at all; this is pure data transformation.

const test = require('node:test');
const assert = require('node:assert/strict');
const mapper = require('../providers/evolink/evolink-mapper');

// --- request mapping ---------------------------------------------------

test('2. maps a text-to-video request to EvoLink field names', () => {
  const body = mapper.toEvolinkRequest({
    provider: 'evolink',
    model: 'seedance-2.5-text-to-video',
    task: 'text-to-video',
    prompt: 'A lighthouse at dusk',
    references: [],
    parameters: {
      duration: 8,
      quality: '720p',
      aspectRatio: '16:9',
      generateAudio: true,
      contentFilter: true,
      outputFormat: 'mp4',
    },
  });

  assert.deepEqual(body, {
    model: 'seedance-2.5-text-to-video',
    prompt: 'A lighthouse at dusk',
    duration: 8,
    quality: '720p',
    aspect_ratio: '16:9',
    generate_audio: true,
    content_filter: true,
    output_format: 'mp4',
  });
});

test('maps image references to image_urls only for image-to-video', () => {
  const body = mapper.toEvolinkRequest({
    model: 'seedance-2.5-image-to-video',
    prompt: 'The camera slowly zooms in',
    references: [
      { type: 'image', url: 'https://example.com/first.jpg' },
      { type: 'image', url: 'https://example.com/last.jpg' },
    ],
    parameters: { duration: 6 },
  });

  assert.deepEqual(body.image_urls, ['https://example.com/first.jpg', 'https://example.com/last.jpg']);
  assert.equal(body.duration, 6);
});

test('omits optional fields entirely when not provided, rather than sending null/undefined', () => {
  const body = mapper.toEvolinkRequest({
    model: 'seedance-2.5-text-to-video',
    prompt: 'Minimal request',
    parameters: {},
  });

  assert.deepEqual(body, { model: 'seedance-2.5-text-to-video', prompt: 'Minimal request' });
});

test('10. rejects a model with no verified request schema', () => {
  assert.throws(
    () =>
      mapper.toEvolinkRequest({
        model: 'seedance-2.5-reference-to-video', // identifier confirmed to exist, schema not verified
        prompt: 'x',
        parameters: {},
      }),
    /not a verified EvoLink model/
  );
});

test('rejects a completely unknown model name', () => {
  assert.throws(
    () =>
      mapper.toEvolinkRequest({
        model: 'totally-made-up-model',
        prompt: 'x',
        parameters: {},
      }),
    /not a verified EvoLink model/
  );
});

// --- response mapping ---------------------------------------------------

test('3. maps a pending EvoLink task to our SUBMITTED status', () => {
  const status = mapper.fromEvolinkTask({
    id: 'task-unified-123',
    model: 'seedance-2.5-text-to-video',
    status: 'pending',
    progress: 0,
  });

  assert.equal(status.generationId, 'task-unified-123');
  assert.equal(status.provider, 'evolink');
  assert.equal(status.status, 'SUBMITTED');
  assert.equal(status.progress, 0);
  assert.equal(status.reservedCost, null);
  assert.deepEqual(status.results, []);
  assert.equal(status.error, null);
});

test('maps usage.credits_reserved into reservedCost when the provider includes it', () => {
  const status = mapper.fromEvolinkTask({
    id: 'task-unified-123',
    status: 'pending',
    usage: { billing_rule: 'per_second', credits_reserved: 50, user_group: 'default' },
  });
  assert.equal(status.reservedCost, 50);
});

test('reservedCost stays null when usage is absent (not present on status/polling responses)', () => {
  const status = mapper.fromEvolinkTask({ id: 'task-unified-123', status: 'processing', progress: 40 });
  assert.equal(status.reservedCost, null);
});

test('maps processing and completed statuses', () => {
  assert.equal(mapper.fromEvolinkTask({ id: 'x', status: 'processing', progress: 40 }).status, 'PROCESSING');

  const completed = mapper.fromEvolinkTask({
    id: 'x',
    status: 'completed',
    progress: 100,
    results: ['https://example.com/video.mp4'],
  });
  assert.equal(completed.status, 'COMPLETED');
  assert.deepEqual(completed.results, ['https://example.com/video.mp4']);
});

test('maps a generic failure to FAILED with the error preserved', () => {
  const status = mapper.fromEvolinkTask({
    id: 'x',
    status: 'failed',
    error: { code: 'content_policy_violation', message: 'Blocked by safety filters' },
  });

  assert.equal(status.status, 'FAILED');
  assert.equal(status.error.code, 'content_policy_violation');
  assert.equal(status.error.message, 'Blocked by safety filters');
});

test('maps request_cancelled specifically to CANCELLED, not FAILED', () => {
  const status = mapper.fromEvolinkTask({
    id: 'x',
    status: 'failed',
    error: { code: 'request_cancelled', message: 'Request was cancelled' },
  });

  assert.equal(status.status, 'CANCELLED');
});

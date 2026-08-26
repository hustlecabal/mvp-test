// Tests for services/media-acquisition/pexels-image-provider.js,
// pexels-video-provider.js, pixabay-image-provider.js,
// pixabay-video-provider.js — Media Acquisition, provider layer.
//
// NEVER calls the real network: every test supplies its own fetchImpl
// (deterministic, in-memory), matching this codebase's own existing
// convention for testing a real-provider adapter without live access
// (see test/reference-video-ingestion*.test.js's own fetchImpl fixtures).
// Credential env vars are saved/restored around every test that touches
// them so this file never leaks state into test/media-acquisition-
// live.test.js or any other file run in the same process.

const test = require('node:test');
const assert = require('node:assert/strict');

const pexelsImage = require('../services/media-acquisition/pexels-image-provider');
const pexelsVideo = require('../services/media-acquisition/pexels-video-provider');
const pixabayImage = require('../services/media-acquisition/pixabay-image-provider');
const pixabayVideo = require('../services/media-acquisition/pixabay-video-provider');
const { createMediaAcquisitionRequest } = require('../schemas/media-acquisition-schema');

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

// --- C. missing credential -------------------------------------------------------------------

test('C. pexels-image-provider reports MISSING_CREDENTIAL (UNAVAILABLE) when PEXELS_API_KEY is not set, without calling fetch', async () => {
  await withEnv('PEXELS_API_KEY', undefined, async () => {
    let called = false;
    const result = await pexelsImage.search(createMediaAcquisitionRequest({ mediaType: 'image', searchQuery: 'city' }), {
      fetchImpl: async () => {
        called = true;
        throw new Error('must never be called');
      },
    });
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.diagnostics[0].code, 'MISSING_CREDENTIAL');
    assert.equal(called, false);
  });
});

test('C2. pixabay-video-provider reports MISSING_CREDENTIAL when PIXABAY_API_KEY is not set', async () => {
  await withEnv('PIXABAY_API_KEY', undefined, async () => {
    const result = await pixabayVideo.search(createMediaAcquisitionRequest({ mediaType: 'video', searchQuery: 'ocean' }));
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.diagnostics[0].code, 'MISSING_CREDENTIAL');
  });
});

// --- A. mocked image search -------------------------------------------------------------------

test('A. pexels-image-provider maps a real Pexels photo response into provider-neutral candidates, applies minWidth/minHeight client-side', async () => {
  await withEnv('PEXELS_API_KEY', 'test-key', async () => {
    const fakeBody = {
      photos: [
        { id: 111, url: 'https://pexels.com/photo/111', width: 4000, height: 3000, photographer: 'Ada', src: { original: 'https://images.pexels.com/111/original.jpg' } },
        { id: 222, url: 'https://pexels.com/photo/222', width: 200, height: 150, photographer: 'Bea', src: { original: 'https://images.pexels.com/222/original.jpg' } },
      ],
    };
    let capturedUrl = null;
    let capturedHeaders = null;
    const result = await pexelsImage.search(createMediaAcquisitionRequest({ mediaType: 'image', searchQuery: 'mountain', orientation: 'landscape', minWidth: 1000, minHeight: 1000 }), {
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedHeaders = init.headers;
        return { ok: true, json: async () => fakeBody };
      },
    });
    assert.match(capturedUrl, /query=mountain/);
    assert.match(capturedUrl, /orientation=landscape/);
    assert.equal(capturedHeaders.Authorization, 'test-key');
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.candidates.length, 1, 'the 200x150 photo must be filtered out by minWidth/minHeight');
    assert.equal(result.candidates[0].providerAssetId, '111');
    assert.equal(result.candidates[0].downloadUrl, 'https://images.pexels.com/111/original.jpg');
    assert.equal(result.candidates[0].attribution, 'Photo by Ada on Pexels');
  });
});

// --- B. mocked video search -------------------------------------------------------------------

test('B. pexels-video-provider picks the largest mp4 file meeting minWidth/minHeight and maps duration', async () => {
  await withEnv('PEXELS_API_KEY', 'test-key', async () => {
    const fakeBody = {
      videos: [
        {
          id: 999,
          url: 'https://pexels.com/video/999',
          duration: 12,
          user: { name: 'Cy' },
          video_files: [
            { file_type: 'video/mp4', width: 640, height: 360, link: 'https://videos.pexels.com/999/small.mp4' },
            { file_type: 'video/mp4', width: 1920, height: 1080, link: 'https://videos.pexels.com/999/large.mp4' },
            { file_type: 'video/webm', width: 3840, height: 2160, link: 'https://videos.pexels.com/999/huge.webm' },
          ],
        },
      ],
    };
    const result = await pexelsVideo.search(createMediaAcquisitionRequest({ mediaType: 'video', searchQuery: 'ocean', minWidth: 1000, minHeight: 700 }), {
      fetchImpl: async () => ({ ok: true, json: async () => fakeBody }),
    });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].downloadUrl, 'https://videos.pexels.com/999/large.mp4', 'must pick the largest MP4 file, never the higher-res webm (unsupported format)');
    assert.equal(result.candidates[0].durationSeconds, 12);
  });
});

test('B2. pixabay-image-provider passes min_width/min_height/orientation server-side and maps hits', async () => {
  await withEnv('PIXABAY_API_KEY', 'test-key', async () => {
    let capturedUrl = null;
    const fakeBody = { hits: [{ id: 55, pageURL: 'https://pixabay.com/photos/55', largeImageURL: 'https://cdn.pixabay.com/55/large.jpg', imageWidth: 1920, imageHeight: 1080, user: 'Dee' }] };
    const result = await pixabayImage.search(createMediaAcquisitionRequest({ mediaType: 'image', searchQuery: 'forest', orientation: 'portrait', minWidth: 800, minHeight: 800 }), {
      fetchImpl: async (url) => {
        capturedUrl = url;
        return { ok: true, json: async () => fakeBody };
      },
    });
    assert.match(capturedUrl, /orientation=vertical/);
    assert.match(capturedUrl, /min_width=800/);
    assert.equal(result.candidates[0].providerAssetId, '55');
  });
});

// --- D. provider API failure -------------------------------------------------------------------

test('D. pexels-image-provider returns a structured FAILED result on a non-2xx HTTP response, never throws', async () => {
  await withEnv('PEXELS_API_KEY', 'test-key', async () => {
    const result = await pexelsImage.search(createMediaAcquisitionRequest({ mediaType: 'image', searchQuery: 'x' }), {
      fetchImpl: async () => ({ ok: false, status: 429 }),
    });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'HTTP_ERROR');
  });
});

test('D2. pixabay-video-provider returns a structured FAILED result on a network error, never throws', async () => {
  await withEnv('PIXABAY_API_KEY', 'test-key', async () => {
    const result = await pixabayVideo.search(createMediaAcquisitionRequest({ mediaType: 'video', searchQuery: 'x' }), {
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.diagnostics[0].code, 'NETWORK_ERROR');
  });
});

test('D3. pexels-image-provider rejects mediaType "video" as UNSUPPORTED — never silently serves the wrong endpoint', async () => {
  await withEnv('PEXELS_API_KEY', 'test-key', async () => {
    const result = await pexelsImage.search(createMediaAcquisitionRequest({ mediaType: 'video', searchQuery: 'x' }));
    assert.equal(result.status, 'UNSUPPORTED');
  });
});

// fake-stock-media-provider.js
//
// Implements ../stock-media-provider-interface.js entirely in memory.
// Exists ONLY to prove the complete Media Acquisition -> validation ->
// Asset storage -> provenance -> Material Execution lifecycle end-to-end
// in automated tests and a mock production run, without ever touching the
// network, spending a real credit, or requiring PEXELS_API_KEY/
// PIXABAY_API_KEY. Mirrors providers/fake-image/fake-image-provider.js and
// providers/fake-video/fake-video-provider.js's exact discipline:
//
// - search() is synchronous/in-memory — never calls fetch/http/any network
//   API, and always returns the SAME candidate for a given mediaType, so
//   test assertions are deterministic.
// - the returned candidate's downloadUrl always resolves (via
//   fakeFetchImpl below) to the SAME two already-bundled fixture files
//   this codebase already ships and already trusts for exactly this
//   purpose — providers/fake-image/fixtures/sample-keyframe.png and
//   providers/fake-video/fixtures/sample-video.mp4. This file does NOT
//   duplicate those bytes into a third copy; it reads them directly by
//   relative path.
// - NEVER registered under 'pexels'/'pixabay' in
//   schemas/media-acquisition-schema.js's PROVIDERS list — see that file's
//   own comment. This provider's own name, 'fake-stock-media', is never
//   selected by production code, only by tests.

const fs = require('fs');
const path = require('path');
const { createMediaSearchResult } = require('./stock-media-provider-interface');
const { createMediaCandidate } = require('../../schemas/media-acquisition-schema');

const PROVIDER_NAME = 'fake-stock-media';

const IMAGE_FIXTURE_PATH = path.join(__dirname, '..', '..', 'providers', 'fake-image', 'fixtures', 'sample-keyframe.png');
const VIDEO_FIXTURE_PATH = path.join(__dirname, '..', '..', 'providers', 'fake-video', 'fixtures', 'sample-video.mp4');

// Syntactically valid https URLs, never actually requested over the
// network — fakeFetchImpl below intercepts them, exactly like
// fake-image-provider.js's/fake-video-provider.js's own FIXTURE_URL.
const IMAGE_FIXTURE_URL = 'https://fake-stock-media-provider.local/fixtures/sample-keyframe.png';
const VIDEO_FIXTURE_URL = 'https://fake-stock-media-provider.local/fixtures/sample-video.mp4';

// Fixed, deterministic per-mediaType fixture metadata — the real reported
// dimensions/duration of the bundled files, not invented placeholders.
const FIXTURE_IMAGE_META = { width: 1280, height: 720 };
const FIXTURE_VIDEO_META = { width: 1280, height: 720, durationSeconds: 4 };

async function search(request) {
  if (!request || typeof request.searchQuery !== 'string' || request.searchQuery.trim().length === 0) {
    return createMediaSearchResult({ status: 'FAILED', diagnostics: [{ code: 'INVALID_REQUEST', message: 'searchQuery is required' }] });
  }
  if (request.mediaType === 'image') {
    return createMediaSearchResult({
      status: 'COMPLETED',
      candidates: [
        createMediaCandidate({
          providerAssetId: 'fake-image-1',
          sourceUrl: IMAGE_FIXTURE_URL,
          downloadUrl: IMAGE_FIXTURE_URL,
          width: FIXTURE_IMAGE_META.width,
          height: FIXTURE_IMAGE_META.height,
          format: 'png',
          attribution: 'Fake Stock Media Provider (test fixture)',
          licenseSummary: 'Test fixture — not a real license',
        }),
      ],
    });
  }
  if (request.mediaType === 'video') {
    return createMediaSearchResult({
      status: 'COMPLETED',
      candidates: [
        createMediaCandidate({
          providerAssetId: 'fake-video-1',
          sourceUrl: VIDEO_FIXTURE_URL,
          downloadUrl: VIDEO_FIXTURE_URL,
          width: FIXTURE_VIDEO_META.width,
          height: FIXTURE_VIDEO_META.height,
          durationSeconds: FIXTURE_VIDEO_META.durationSeconds,
          format: 'mp4',
          attribution: 'Fake Stock Media Provider (test fixture)',
          licenseSummary: 'Test fixture — not a real license',
        }),
      ],
    });
  }
  return createMediaSearchResult({ status: 'UNSUPPORTED', diagnostics: [{ code: 'UNSUPPORTED_MEDIA_TYPE', message: `fake-stock-media-provider does not support mediaType "${request.mediaType}"` }] });
}

// Given to services/asset-storage.js's downloadAsset() IN PLACE OF the
// real `fetch` global — reads the matching bundled fixture straight off
// disk and hands back a real Response object, so download/validation runs
// exactly as it does for a real provider, but nothing ever leaves this
// machine.
async function fakeFetchImpl(url) {
  if (url === IMAGE_FIXTURE_URL) {
    const buffer = fs.readFileSync(IMAGE_FIXTURE_PATH);
    return new Response(buffer, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(buffer.length) } });
  }
  if (url === VIDEO_FIXTURE_URL) {
    const buffer = fs.readFileSync(VIDEO_FIXTURE_PATH);
    return new Response(buffer, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(buffer.length) } });
  }
  throw new Error(`FakeStockMediaProvider's fetchImpl only recognizes its own fixture URLs, got: "${url}"`);
}

// This fake provider needs no credential — credential() always returns a
// non-null placeholder so media-acquisition-service.js's MISSING_CREDENTIAL
// gate never blocks it (it is never reachable via a real credential env
// var, by design — see the file header).
function credential() {
  return 'fake-stock-media-no-credential-required';
}

module.exports = {
  PROVIDER_NAME,
  search,
  credential,
  fakeFetchImpl,
  IMAGE_FIXTURE_URL,
  VIDEO_FIXTURE_URL,
};

// pixabay-image-provider.js
//
// A real StockMediaProvider backed by the Pixabay Image API
// (https://pixabay.com/api/docs/ — GET https://pixabay.com/api/). Requires
// PIXABAY_API_KEY.
//
// CREDENTIAL DISCIPLINE: same as pexels-image-provider.js — with no key
// configured, search() returns a structured UNAVAILABLE result rather than
// throwing. Pixabay authenticates via a `key` QUERY PARAMETER (not a
// header, unlike Pexels) — this is Pixabay's own documented convention,
// not a deviation from this codebase's own discipline; the key still
// never appears in a diagnostic message or log.
//
// FIELD MAPPING (documented, not hidden — verified against Pixabay's
// public API docs; live-verify before first production use): Pixabay's
// image search supports server-side `min_width`/`min_height` and
// `orientation` (all|horizontal|vertical) parameters directly — passed
// through rather than filtered client-side, unlike Pexels (whose photo
// search lacks these params).

const { createMediaSearchResult, createSearchDiagnostic } = require('./stock-media-provider-interface');
const { createMediaCandidate } = require('../../schemas/media-acquisition-schema');

const PROVIDER_NAME = 'pixabay';
const SEARCH_URL = 'https://pixabay.com/api/';

// Pixabay's own orientation vocabulary differs from the provider-neutral
// request.orientation ('landscape'/'portrait'/'square') — mapped here,
// never leaked into the request schema. 'square' has no Pixabay
// equivalent, so it is simply omitted (never guessed into the wrong one).
const ORIENTATION_MAP = { landscape: 'horizontal', portrait: 'vertical' };

function credential() {
  return process.env.PIXABAY_API_KEY || null;
}

function buildUrl(request, key) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('key', key);
  url.searchParams.set('q', request.searchQuery);
  url.searchParams.set('image_type', 'photo');
  url.searchParams.set('per_page', String(Math.min(Math.max(request.maxCandidates || 5, 3), 200))); // Pixabay requires per_page >= 3
  if (ORIENTATION_MAP[request.orientation]) url.searchParams.set('orientation', ORIENTATION_MAP[request.orientation]);
  if (typeof request.minWidth === 'number') url.searchParams.set('min_width', String(request.minWidth));
  if (typeof request.minHeight === 'number') url.searchParams.set('min_height', String(request.minHeight));
  return url.toString();
}

function mapHit(hit) {
  return createMediaCandidate({
    providerAssetId: String(hit.id),
    sourceUrl: hit.pageURL || null,
    downloadUrl: hit.largeImageURL || hit.webformatURL || null,
    width: typeof hit.imageWidth === 'number' ? hit.imageWidth : null,
    height: typeof hit.imageHeight === 'number' ? hit.imageHeight : null,
    durationSeconds: null,
    format: 'jpeg',
    attribution: hit.user ? `Image by ${hit.user} on Pixabay` : null,
    licenseSummary: 'Pixabay Content License — free for commercial and noncommercial use (https://pixabay.com/service/license/)',
  });
}

async function search(request, { fetchImpl = fetch } = {}) {
  if (!request || typeof request.searchQuery !== 'string' || request.searchQuery.trim().length === 0) {
    return createMediaSearchResult({ status: 'FAILED', diagnostics: [createSearchDiagnostic({ code: 'INVALID_REQUEST', message: 'searchQuery is required' })] });
  }
  if (request.mediaType !== 'image') {
    return createMediaSearchResult({ status: 'UNSUPPORTED', diagnostics: [createSearchDiagnostic({ code: 'UNSUPPORTED_MEDIA_TYPE', message: `pixabay-image-provider only supports mediaType "image", got "${request.mediaType}"` })] });
  }
  const key = credential();
  if (!key) {
    return createMediaSearchResult({ status: 'UNAVAILABLE', diagnostics: [createSearchDiagnostic({ code: 'MISSING_CREDENTIAL', message: 'PIXABAY_API_KEY is not configured in this environment' })] });
  }

  let response;
  try {
    response = await fetchImpl(buildUrl(request, key));
  } catch (error) {
    return createMediaSearchResult({ status: 'FAILED', diagnostics: [createSearchDiagnostic({ code: 'NETWORK_ERROR', message: `network error calling Pixabay: ${error && error.message ? error.message : String(error)}` })] });
  }
  if (!response.ok) {
    return createMediaSearchResult({ status: 'FAILED', diagnostics: [createSearchDiagnostic({ code: 'HTTP_ERROR', message: `Pixabay returned HTTP ${response.status}` })] });
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return createMediaSearchResult({ status: 'FAILED', diagnostics: [createSearchDiagnostic({ code: 'UNPARSEABLE_RESPONSE', message: 'Pixabay returned unparseable JSON' })] });
  }
  const hits = Array.isArray(body.hits) ? body.hits : [];
  const candidates = hits.map(mapHit).filter((c) => typeof c.downloadUrl === 'string');
  return createMediaSearchResult({ status: 'COMPLETED', candidates });
}

module.exports = { PROVIDER_NAME, search, credential };

// pexels-image-provider.js
//
// A real StockMediaProvider (stock-media-provider-interface.js) backed by
// the Pexels Photo Search API (https://www.pexels.com/api/documentation/ —
// GET https://api.pexels.com/v1/search). Requires PEXELS_API_KEY.
//
// CREDENTIAL DISCIPLINE (mirrors services/reference-video/apify-
// acquisition-provider.js's own documented rule): with no key configured,
// search() returns a structured UNAVAILABLE result rather than throwing or
// silently no-op'ing — a genuine missing-capability is reported, never
// hidden. No credential is ever logged or embedded in a diagnostic
// message.
//
// FIELD MAPPING (documented, not hidden — verified against Pexels' public
// API docs; live-verify against a real account before first production
// use, exactly like every other provider integration in this codebase):
//   Pexels `orientation` request param accepts landscape|portrait|square
//   directly — request.orientation is passed straight through when it
//   matches one of those three values, otherwise omitted (never guessed
//   into a value Pexels wouldn't recognize).
//   Pexels' photo search has no server-side min_width/min_height filter,
//   so minWidth/minHeight are applied as a CLIENT-SIDE filter over
//   `src.original`'s own reported width/height after the response comes
//   back — never invented, always the exact dimensions Pexels itself
//   reports for that photo.

const { createMediaSearchResult, createSearchDiagnostic } = require('./stock-media-provider-interface');
const { createMediaCandidate } = require('../../schemas/media-acquisition-schema');

const PROVIDER_NAME = 'pexels';
const SEARCH_URL = 'https://api.pexels.com/v1/search';
const ORIENTATIONS = ['landscape', 'portrait', 'square'];

function credential() {
  return process.env.PEXELS_API_KEY || null;
}

function buildUrl(request) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('query', request.searchQuery);
  url.searchParams.set('per_page', String(Math.min(Math.max(request.maxCandidates || 5, 1), 80)));
  if (ORIENTATIONS.includes(request.orientation)) {
    url.searchParams.set('orientation', request.orientation);
  }
  return url.toString();
}

function mapPhoto(photo) {
  const src = photo.src || {};
  return createMediaCandidate({
    providerAssetId: String(photo.id),
    sourceUrl: photo.url || null,
    downloadUrl: src.original || src.large2x || src.large || null,
    width: typeof photo.width === 'number' ? photo.width : null,
    height: typeof photo.height === 'number' ? photo.height : null,
    durationSeconds: null,
    format: 'jpeg', // Pexels' photo API always serves JPEG regardless of the src variant requested
    attribution: photo.photographer ? `Photo by ${photo.photographer} on Pexels` : null,
    licenseSummary: 'Pexels License — free to use, no attribution required (https://www.pexels.com/license/)',
  });
}

async function search(request, { fetchImpl = fetch } = {}) {
  if (!request || typeof request.searchQuery !== 'string' || request.searchQuery.trim().length === 0) {
    return createMediaSearchResult({ status: 'FAILED', diagnostics: [createSearchDiagnostic({ code: 'INVALID_REQUEST', message: 'searchQuery is required' })] });
  }
  if (request.mediaType !== 'image') {
    return createMediaSearchResult({ status: 'UNSUPPORTED', diagnostics: [createSearchDiagnostic({ code: 'UNSUPPORTED_MEDIA_TYPE', message: `pexels-image-provider only supports mediaType "image", got "${request.mediaType}"` })] });
  }
  const key = credential();
  if (!key) {
    return createMediaSearchResult({ status: 'UNAVAILABLE', diagnostics: [createSearchDiagnostic({ code: 'MISSING_CREDENTIAL', message: 'PEXELS_API_KEY is not configured in this environment' })] });
  }

  let response;
  try {
    response = await fetchImpl(buildUrl(request), { headers: { Authorization: key } });
  } catch (error) {
    return createMediaSearchResult({ status: 'FAILED', diagnostics: [createSearchDiagnostic({ code: 'NETWORK_ERROR', message: `network error calling Pexels: ${error && error.message ? error.message : String(error)}` })] });
  }
  if (!response.ok) {
    return createMediaSearchResult({ status: 'FAILED', diagnostics: [createSearchDiagnostic({ code: 'HTTP_ERROR', message: `Pexels returned HTTP ${response.status}` })] });
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return createMediaSearchResult({ status: 'FAILED', diagnostics: [createSearchDiagnostic({ code: 'UNPARSEABLE_RESPONSE', message: 'Pexels returned unparseable JSON' })] });
  }
  const photos = Array.isArray(body.photos) ? body.photos : [];
  let candidates = photos.map(mapPhoto).filter((c) => typeof c.downloadUrl === 'string');
  if (typeof request.minWidth === 'number') candidates = candidates.filter((c) => typeof c.width === 'number' && c.width >= request.minWidth);
  if (typeof request.minHeight === 'number') candidates = candidates.filter((c) => typeof c.height === 'number' && c.height >= request.minHeight);

  if (candidates.length === 0) {
    return createMediaSearchResult({ status: 'COMPLETED', candidates: [] });
  }
  return createMediaSearchResult({ status: 'COMPLETED', candidates });
}

module.exports = { PROVIDER_NAME, search, credential };

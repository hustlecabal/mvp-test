// pixabay-video-provider.js
//
// A real StockMediaProvider backed by the Pixabay Video API
// (https://pixabay.com/api/docs/#api_search_videos — GET
// https://pixabay.com/api/videos/). Requires PIXABAY_API_KEY — same
// credential as pixabay-image-provider.js, read independently.
//
// FIELD MAPPING (documented, not hidden — verified against Pixabay's
// public API docs; live-verify before first production use): each hit's
// `videos` object has up to four quality tiers (large/medium/small/tiny).
// This adapter picks the LARGEST tier whose width/height meet
// request.minWidth/minHeight (when given) — never assumes 'large' is
// always present, since Pixabay omits a tier when no encode exists at
// that size. `duration` is filtered client-side (Pixabay's video search
// has no duration query parameter).

const { createMediaSearchResult, createSearchDiagnostic } = require('./stock-media-provider-interface');
const { createMediaCandidate } = require('../../schemas/media-acquisition-schema');

const PROVIDER_NAME = 'pixabay';
const SEARCH_URL = 'https://pixabay.com/api/videos/';
const QUALITY_TIERS = ['large', 'medium', 'small', 'tiny'];

function credential() {
  return process.env.PIXABAY_API_KEY || null;
}

function buildUrl(request, key) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('key', key);
  url.searchParams.set('q', request.searchQuery);
  url.searchParams.set('per_page', String(Math.min(Math.max(request.maxCandidates || 5, 3), 200)));
  if (typeof request.minWidth === 'number') url.searchParams.set('min_width', String(request.minWidth));
  if (typeof request.minHeight === 'number') url.searchParams.set('min_height', String(request.minHeight));
  return url.toString();
}

// Picks the largest available quality tier meeting minWidth/minHeight
// (when given) — never the first tier in object key order, which is not
// guaranteed by Pixabay to be size-sorted.
function pickBestTier(videos, request) {
  const meetsFloor = (tier) =>
    (typeof request.minWidth !== 'number' || (typeof tier.width === 'number' && tier.width >= request.minWidth)) &&
    (typeof request.minHeight !== 'number' || (typeof tier.height === 'number' && tier.height >= request.minHeight));
  for (const tierName of QUALITY_TIERS) {
    const tier = videos && videos[tierName];
    if (tier && typeof tier.url === 'string' && meetsFloor(tier)) return tier;
  }
  return null;
}

function mapHit(hit, request) {
  const tier = pickBestTier(hit.videos, request);
  if (!tier) return null;
  return createMediaCandidate({
    providerAssetId: String(hit.id),
    sourceUrl: hit.pageURL || null,
    downloadUrl: tier.url,
    width: typeof tier.width === 'number' ? tier.width : null,
    height: typeof tier.height === 'number' ? tier.height : null,
    durationSeconds: typeof hit.duration === 'number' ? hit.duration : null,
    format: 'mp4',
    attribution: hit.user ? `Video by ${hit.user} on Pixabay` : null,
    licenseSummary: 'Pixabay Content License — free for commercial and noncommercial use (https://pixabay.com/service/license/)',
  });
}

async function search(request, { fetchImpl = fetch } = {}) {
  if (!request || typeof request.searchQuery !== 'string' || request.searchQuery.trim().length === 0) {
    return createMediaSearchResult({ status: 'FAILED', diagnostics: [createSearchDiagnostic({ code: 'INVALID_REQUEST', message: 'searchQuery is required' })] });
  }
  if (request.mediaType !== 'video') {
    return createMediaSearchResult({ status: 'UNSUPPORTED', diagnostics: [createSearchDiagnostic({ code: 'UNSUPPORTED_MEDIA_TYPE', message: `pixabay-video-provider only supports mediaType "video", got "${request.mediaType}"` })] });
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
  let candidates = hits.map((h) => mapHit(h, request)).filter((c) => c !== null);
  if (typeof request.minDurationSeconds === 'number') candidates = candidates.filter((c) => typeof c.durationSeconds === 'number' && c.durationSeconds >= request.minDurationSeconds);
  if (typeof request.maxDurationSeconds === 'number') candidates = candidates.filter((c) => typeof c.durationSeconds === 'number' && c.durationSeconds <= request.maxDurationSeconds);

  return createMediaSearchResult({ status: 'COMPLETED', candidates });
}

module.exports = { PROVIDER_NAME, search, credential };

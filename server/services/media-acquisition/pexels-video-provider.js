// pexels-video-provider.js
//
// A real StockMediaProvider backed by the Pexels Video Search API
// (https://www.pexels.com/api/documentation/ — GET
// https://api.pexels.com/videos/search). Requires PEXELS_API_KEY — same
// credential as pexels-image-provider.js (one Pexels account key covers
// both endpoints), read independently here so either provider can be
// enabled/disabled without touching the other.
//
// FIELD MAPPING (documented, not hidden — verified against Pexels' public
// API docs; live-verify before first production use):
//   Each Pexels video has multiple `video_files` (different quality/
//   resolution encodes). This adapter picks the HIGHEST-resolution
//   `video_files` entry whose width/height meet request.minWidth/
//   minHeight (when given) — never the first one in provider order, which
//   Pexels does not document as being resolution-sorted.
//   `duration` is the video's own reported total length in seconds —
//   requests.minDurationSeconds/maxDurationSeconds are applied as a
//   CLIENT-SIDE filter (Pexels' videos/search endpoint has no duration
//   query parameter).

const { createMediaSearchResult, createSearchDiagnostic } = require('./stock-media-provider-interface');
const { createMediaCandidate } = require('../../schemas/media-acquisition-schema');

const PROVIDER_NAME = 'pexels';
const SEARCH_URL = 'https://api.pexels.com/videos/search';
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

// Picks the largest video_files entry meeting minWidth/minHeight (when
// given), preferring mp4 files (the only format services/asset-storage.js
// currently recognizes among Pexels' encodes). Returns null if no file
// satisfies both the format and the size floor.
function pickBestFile(videoFiles, request) {
  const mp4Files = (videoFiles || []).filter((f) => f.file_type === 'video/mp4' && typeof f.link === 'string');
  const meetsFloor = (f) =>
    (typeof request.minWidth !== 'number' || (typeof f.width === 'number' && f.width >= request.minWidth)) &&
    (typeof request.minHeight !== 'number' || (typeof f.height === 'number' && f.height >= request.minHeight));
  const eligible = mp4Files.filter(meetsFloor);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, f) => ((f.width || 0) * (f.height || 0) > (best.width || 0) * (best.height || 0) ? f : best));
}

function mapVideo(video, request) {
  const file = pickBestFile(video.video_files, request);
  if (!file) return null;
  return createMediaCandidate({
    providerAssetId: String(video.id),
    sourceUrl: video.url || null,
    downloadUrl: file.link,
    width: typeof file.width === 'number' ? file.width : video.width || null,
    height: typeof file.height === 'number' ? file.height : video.height || null,
    durationSeconds: typeof video.duration === 'number' ? video.duration : null,
    format: 'mp4',
    attribution: video.user && video.user.name ? `Video by ${video.user.name} on Pexels` : null,
    licenseSummary: 'Pexels License — free to use, no attribution required (https://www.pexels.com/license/)',
  });
}

async function search(request, { fetchImpl = fetch } = {}) {
  if (!request || typeof request.searchQuery !== 'string' || request.searchQuery.trim().length === 0) {
    return createMediaSearchResult({ status: 'FAILED', diagnostics: [createSearchDiagnostic({ code: 'INVALID_REQUEST', message: 'searchQuery is required' })] });
  }
  if (request.mediaType !== 'video') {
    return createMediaSearchResult({ status: 'UNSUPPORTED', diagnostics: [createSearchDiagnostic({ code: 'UNSUPPORTED_MEDIA_TYPE', message: `pexels-video-provider only supports mediaType "video", got "${request.mediaType}"` })] });
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
  const videos = Array.isArray(body.videos) ? body.videos : [];
  let candidates = videos.map((v) => mapVideo(v, request)).filter((c) => c !== null);
  if (typeof request.minDurationSeconds === 'number') candidates = candidates.filter((c) => typeof c.durationSeconds === 'number' && c.durationSeconds >= request.minDurationSeconds);
  if (typeof request.maxDurationSeconds === 'number') candidates = candidates.filter((c) => typeof c.durationSeconds === 'number' && c.durationSeconds <= request.maxDurationSeconds);

  return createMediaSearchResult({ status: 'COMPLETED', candidates });
}

module.exports = { PROVIDER_NAME, search, credential };

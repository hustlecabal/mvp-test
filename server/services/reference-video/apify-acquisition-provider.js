// apify-acquisition-provider.js
//
// INT-1A — the ONE real ReferenceVideoAcquisitionProvider implementation
// (schemas/reference-video-schema.js / acquisition-provider-interface.js),
// backed by two real, independently-priced Apify actors (INT-1's own live
// Part 2 audit, verified again for this stage — never assumed from an
// earlier report):
//
//   starvibe/youtube-video-transcript  — metadata + timestamped transcript
//                                         in one call ($0.005/result)
//   epctex/youtube-video-downloader    — the video file itself, billed
//                                         per second of OUTPUT quality
//                                         ($0.00015/s at 360p, the
//                                         cheapest tier this adapter uses)
//
// SSRF DISCIPLINE (Part 17) — this is the one file in the whole codebase
// that ever turns a human-supplied URL into a fetch, so it is deliberately
// stricter than services/asset-storage.js's own documented, narrower
// assumption ("only ever called with EvoLink's own documented result
// URLs... if this function is ever exposed to attacker-controlled URLs in
// the future, that hardening would need to be added then" — asset-
// storage.js's own header). That "future" is this file:
//   1. The human-supplied URL is NEVER fetched by this server at all. It
//      is validated against a closed YouTube hostname allowlist
//      (resolveSource, below) and then only ever passed as a JSON
//      parameter to Apify's own actor input — Apify's own sandboxed
//      infrastructure performs the actual YouTube fetch, never this
//      process.
//   2. This server only ever fetches two kinds of URL: (a) the fixed,
//      hardcoded https://api.apify.com/v2/... endpoint, never
//      user-influenced, and (b) the `resultUrl` Apify's OWN API returns
//      for a downloaded video — validated against an Apify-hosted-domain
//      allowlist below before ever being handed to
//      services/asset-storage.js's downloadAsset(), which then applies
//      its own maxBytes cap.
//   3. No credential is ever logged, embedded in a diagnostic message, or
//      written into schemas/reference-video-schema.js's persisted record
//      (acquisition.provider is the plain string "apify", nothing more).
//
// COST GATE: every real call is billed per Apify's own pricing above and
// requires APIFY_API_TOKEN to be set — with no token configured, every
// method below returns a structured FAILED/UNSUPPORTED result rather than
// throwing or silently no-op'ing (Part 14's own discipline: a genuine
// missing-capability is reported, never hidden).

const {
  ACQUISITION_RESULT_STATUSES,
  createAcquisitionDiagnostic,
  createSourceResolution,
  createMetadataAcquisitionResult,
  createVideoAcquisitionResult,
  createTranscriptAcquisitionResult,
} = require('./acquisition-provider-interface');

const APIFY_API_BASE = 'https://api.apify.com/v2';
const METADATA_TRANSCRIPT_ACTOR = 'starvibe~youtube-video-transcript';
const VIDEO_DOWNLOADER_ACTOR = 'epctex~youtube-video-downloader';
const DOWNLOAD_QUALITY = '360'; // cheapest tier — Part 19's real proof deliberately minimizes spend

// Closed allowlist of YouTube hostnames — never a substring/regex match
// against the whole URL, always the parsed URL object's own hostname.
const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be']);
// Apify's own result-hosting domain — the only domain this adapter will
// ever download FROM besides api.apify.com itself.
const APIFY_RESULT_HOSTS = /(^|\.)apify\.com$/i;

function extractVideoId(parsed) {
  if (parsed.hostname === 'youtu.be') {
    const id = parsed.pathname.replace(/^\//, '').split('/')[0];
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (parsed.pathname === '/watch') {
    const id = parsed.searchParams.get('v');
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  const shortsMatch = parsed.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
  if (shortsMatch) return shortsMatch[1];
  return null;
}

// Part 3 — pure, local, no network call: a YouTube URL either parses to a
// known host + a well-formed 11-character video id, or it does not. Never
// fetched, never guessed.
function resolveSource({ url } = {}) {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return createSourceResolution({ status: 'FAILED', diagnostics: [createAcquisitionDiagnostic({ code: 'INVALID_REFERENCE_URL', message: 'url is required' })] });
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return createSourceResolution({ status: 'FAILED', diagnostics: [createAcquisitionDiagnostic({ code: 'INVALID_REFERENCE_URL', message: `"${url}" is not a well-formed URL` })] });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return createSourceResolution({ status: 'FAILED', diagnostics: [createAcquisitionDiagnostic({ code: 'INVALID_REFERENCE_URL', message: 'only http/https URLs are accepted' })] });
  }
  if (!YOUTUBE_HOSTS.has(parsed.hostname)) {
    return createSourceResolution({ status: 'UNSUPPORTED', diagnostics: [createAcquisitionDiagnostic({ code: 'UNSUPPORTED_PLATFORM', message: `host "${parsed.hostname}" is not a supported platform` })] });
  }
  const externalId = extractVideoId(parsed);
  if (!externalId) {
    return createSourceResolution({ status: 'FAILED', diagnostics: [createAcquisitionDiagnostic({ code: 'INVALID_REFERENCE_URL', message: 'could not extract a video id from this YouTube URL' })] });
  }
  return createSourceResolution({ status: 'COMPLETED', platform: 'YOUTUBE', externalId, normalizedUrl: `https://www.youtube.com/watch?v=${externalId}` });
}

function apifyToken() {
  return process.env.APIFY_API_TOKEN || null;
}

async function runActorSync(actorSlug, input, fetchImpl) {
  const token = apifyToken();
  if (!token) {
    return { error: 'no APIFY_API_TOKEN configured in this environment' };
  }
  const url = `${APIFY_API_BASE}/acts/${actorSlug}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  } catch (error) {
    return { error: `network error calling Apify: ${error && error.message ? error.message : String(error)}` };
  }
  if (!response.ok) {
    return { error: `Apify returned HTTP ${response.status}` };
  }
  let items;
  try {
    items = await response.json();
  } catch {
    return { error: 'Apify returned unparseable JSON' };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { error: 'Apify returned no dataset items' };
  }
  return { item: items[0] };
}

// Part 11 — mapped verbatim from starvibe/youtube-video-transcript's own
// output fields (live-verified schema — see this stage's final report),
// never invented.
function mapMetadata(item, retrievedAt) {
  return {
    title: typeof item.title === 'string' ? item.title : null,
    description: typeof item.description === 'string' ? item.description : null,
    publishedAt: typeof item.published_at === 'string' ? item.published_at : null,
    retrievedAt,
    viewCount: typeof item.view_count === 'number' ? item.view_count : null,
    likeCount: typeof item.like_count === 'number' ? item.like_count : null,
    commentCount: typeof item.comment_count === 'number' ? item.comment_count : null,
    category: null, // not returned by this actor — never fabricated
    tags: [],
    thumbnailUrl: typeof item.thumbnail === 'string' ? item.thumbnail : null,
  };
}

// Part 9 — the actor's `transcript` field is an array of CUE-level
// segments ({start, end, duration, text}), never word-level — mapped onto
// `segments`, leaving `words` empty (Part 9's own explicit distinction).
function mapTranscript(item) {
  const cues = Array.isArray(item.transcript) ? item.transcript : null;
  if (!cues || cues.length === 0) return null;
  return {
    text: typeof item.transcript_text === 'string' ? item.transcript_text : cues.map((c) => c.text).join(' '),
    language: typeof item.selected_language === 'string' ? item.selected_language : typeof item.language === 'string' ? item.language : null,
    segments: cues.map((c) => ({ text: c.text || '', startTime: typeof c.start === 'number' ? c.start : null, endTime: typeof c.end === 'number' ? c.end : null })),
  };
}

function createApifyAcquisitionProvider({ fetchImpl = fetch } = {}) {
  // Per-externalId cache so a run that calls both acquireMetadata() and
  // acquireTranscript() for the same video only ever pays Apify once —
  // the bundled actor's own real behavior (see file header).
  const combinedCache = new Map();

  async function fetchCombined(source) {
    if (!source || !source.externalId) return { error: 'source.externalId is required' };
    if (combinedCache.has(source.externalId)) return combinedCache.get(source.externalId);
    const result = await runActorSync(METADATA_TRANSCRIPT_ACTOR, { youtube_url: source.normalizedUrl || `https://www.youtube.com/watch?v=${source.externalId}`, include_transcript_text: true }, fetchImpl);
    combinedCache.set(source.externalId, result);
    return result;
  }

  async function acquireMetadata({ source } = {}) {
    const { item, error } = await fetchCombined(source);
    if (error) {
      return createMetadataAcquisitionResult({ status: 'FAILED', diagnostics: [createAcquisitionDiagnostic({ code: 'METADATA_UNAVAILABLE', message: error })] });
    }
    if (item.status === 'error' || item.error_category) {
      return createMetadataAcquisitionResult({ status: 'UNAVAILABLE', diagnostics: [createAcquisitionDiagnostic({ code: 'METADATA_UNAVAILABLE', message: item.message || item.error_category || 'provider reported no metadata' })] });
    }
    return createMetadataAcquisitionResult({ status: 'COMPLETED', metadata: mapMetadata(item, new Date().toISOString()) });
  }

  async function acquireTranscript({ source } = {}) {
    const { item, error } = await fetchCombined(source);
    if (error) {
      return createTranscriptAcquisitionResult({ status: 'FAILED', diagnostics: [createAcquisitionDiagnostic({ code: 'TRANSCRIPT_UNAVAILABLE', message: error })] });
    }
    const transcript = mapTranscript(item);
    if (!transcript) {
      return createTranscriptAcquisitionResult({ status: 'UNAVAILABLE', diagnostics: [createAcquisitionDiagnostic({ code: 'TRANSCRIPT_UNAVAILABLE', message: item.message || 'no captions/transcript available for this video from this provider' })] });
    }
    return createTranscriptAcquisitionResult({ status: 'COMPLETED', transcript });
  }

  async function acquireVideo({ source } = {}) {
    if (!source || !source.externalId) {
      return createVideoAcquisitionResult({ status: 'FAILED', diagnostics: [createAcquisitionDiagnostic({ code: 'VIDEO_ACQUISITION_FAILED', message: 'source.externalId is required' })] });
    }
    const { item, error } = await runActorSync(
      VIDEO_DOWNLOADER_ACTOR,
      { startUrls: [source.normalizedUrl || `https://www.youtube.com/watch?v=${source.externalId}`], quality: DOWNLOAD_QUALITY, storageType: 'apify' },
      fetchImpl
    );
    if (error) {
      return createVideoAcquisitionResult({ status: 'FAILED', diagnostics: [createAcquisitionDiagnostic({ code: 'VIDEO_ACQUISITION_FAILED', message: error })] });
    }
    if (item.status && item.status !== 'success' && item.status !== 'ok' && item.error) {
      return createVideoAcquisitionResult({ status: 'FAILED', diagnostics: [createAcquisitionDiagnostic({ code: 'VIDEO_ACQUISITION_FAILED', message: item.error })] });
    }
    const resultUrl = item.output && typeof item.output.url === 'string' ? item.output.url : null;
    if (!resultUrl) {
      return createVideoAcquisitionResult({ status: 'FAILED', diagnostics: [createAcquisitionDiagnostic({ code: 'VIDEO_ACQUISITION_FAILED', message: 'provider returned no result URL' })] });
    }
    let parsedResultUrl;
    try {
      parsedResultUrl = new URL(resultUrl);
    } catch {
      return createVideoAcquisitionResult({ status: 'FAILED', diagnostics: [createAcquisitionDiagnostic({ code: 'VIDEO_FILE_INVALID', message: 'provider result URL is not well-formed' })] });
    }
    if ((parsedResultUrl.protocol !== 'https:' && parsedResultUrl.protocol !== 'http:') || !APIFY_RESULT_HOSTS.test(parsedResultUrl.hostname)) {
      // Defense in depth (Part 17): never trust a result URL, even from a
      // parsed JSON response, that doesn't point back at Apify's own
      // hosting domain — a compromised/malicious actor response is exactly
      // the case this refuses to silently follow.
      return createVideoAcquisitionResult({ status: 'FAILED', diagnostics: [createAcquisitionDiagnostic({ code: 'VIDEO_FILE_INVALID', message: `result URL host "${parsedResultUrl.hostname}" is not a recognized Apify hosting domain` })] });
    }
    return createVideoAcquisitionResult({ status: 'COMPLETED', resultUrl });
  }

  return { resolveSource, acquireMetadata, acquireVideo, acquireTranscript };
}

module.exports = { createApifyAcquisitionProvider, YOUTUBE_HOSTS, APIFY_RESULT_HOSTS, resolveSource };

// elevenlabs-music-provider.js
//
// PHASE 3D — EvoLink's first REAL, WORKING Music provider. Selected via a
// dedicated provider audit (AI33 has no confirmed Music endpoint — see
// ai33-music-provider.js's own header; Mubert's real API requires a
// negotiated Enterprise contract for commercial use, not self-serve;
// Stability/Beatoven/Loudly were real but not selected this phase).
//
// ---------------------------------------------------------------------------
// VERIFIED CONTRACT (fetched directly from elevenlabs.io/docs/api-reference/
// music/compose on 2026-09-06 — not from memory):
//
//   POST https://api.elevenlabs.io/v1/music
//   Headers:  xi-api-key: <key>
//             Content-Type: application/json
//   Body (JSON): { prompt: string (<=4100 chars), music_length_ms?: int
//                  (3000-600000), force_instrumental?: bool, model_id?,
//                  seed?, composition_plan? (mutually exclusive w/ prompt) }
//   Response: HTTP 200 — the generated audio file's RAW BYTES, directly in
//             the response body (Content-Type reflects the real codec,
//             e.g. audio/mpeg for mp3). A `song-id` response header
//             carries ElevenLabs' own identifier for the track.
//   Errors:   422 Unprocessable Entity (validation failure), JSON body.
//
// This is a SYNCHRONOUS, single-call contract — no task/job id, no
// polling. Unlike every provider this codebase has integrated before it
// (Pexels/Pixabay: search then fetch a URL; AI33 TTS: submit then poll
// then fetch a URL), there is no second URL to fetch — the finished audio
// IS the response to this one call. See music-provider-interface.js's own
// header for why that is a legitimate reading of "search()": for a
// GENERATIVE provider with no separate corpus to search, one call that
// performs generation and returns the result is the entire operation —
// there is no meaningful separate "search" step to defer.
//
// CREDENTIAL: EVOLINK_ELEVENLABS_API_KEY — a brand-new credential, never
// the AI33 one. AI33's own TTS proxy happens to also use a header named
// `xi-api-key` and can route through an "elevenlabs" voice engine
// internally, but that is a routing detail of a DIFFERENT service (AI33's
// gateway) and shares no code, credential, or base URL with this file.
//
// DURATION IS REQUESTED, NEVER GUARANTEED (Phase 3D's own explicit
// instruction): `music_length_ms` tells the model a TARGET length; nothing
// in ElevenLabs' documented contract promises the returned audio is
// exactly that long. This file does not pretend otherwise — the returned
// MusicCandidate's `durationSeconds` is left null (unconfirmed), never set
// to the requested value as if it were a measured fact. Trimming a
// returned clip to the timeline's actual assigned span, if it runs long,
// is the mixer's job (services/audio-mixer-service.js's own atrim stage),
// not this provider's.
//
// BINARY RESPONSE, NO URL SHIM (Phase 3D's own explicit instruction): this
// file never invents a localhost URL or temp HTTP server to force the
// response into the old "candidate.downloadUrl" shape. It sets
// `audioBuffer` on the candidate instead — see schemas/music-acquisition-
// schema.js's own header for the small, provider-neutral acquisition-layer
// change this required, and services/asset-storage.js's pre-existing
// storeUploadedAudio() (Stage 26.9B, built for human-uploaded audio long
// before this provider existed) for how those bytes actually get stored.
//
// force_instrumental: true, UNCONDITIONALLY (Phase 3D Part B's own
// instruction: "EvoLink background music should default to
// force_instrumental: true"). No new field is added to
// createMusicAcquisitionRequest() to make this overridable — EvoLink has
// exactly one use for Music today (an instrumental background bed), and
// schemas/music-acquisition-schema.js's own request shape already forbids
// inventing fields nothing yet needs.
// ---------------------------------------------------------------------------

const { createMusicSearchResult, createMusicSearchDiagnostic } = require('./music-provider-interface');

const DEFAULT_BASE_URL = process.env.EVOLINK_ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';

// Verified against the live API reference — the documented, enforced range
// for music_length_ms. Clamping to this range client-side turns an
// out-of-range request into the closest valid one rather than letting the
// API reject it with a 422 for a mistake this file can trivially avoid.
const MIN_MUSIC_LENGTH_MS = 3000;
const MAX_MUSIC_LENGTH_MS = 600000;

function credential() {
  return process.env.EVOLINK_ELEVENLABS_API_KEY || null;
}

// PART B — duration mapping. Reuses the EXISTING, general
// minDurationSeconds/maxDurationSeconds request fields (no new field
// invented). maxDurationSeconds is preferred (the caller's outer bound is
// the more meaningful target for a generative request than a lower
// bound); falls back to minDurationSeconds; null (omit music_length_ms
// entirely, matching the API's own documented default: "the model will
// choose a length based on the prompt") when neither is supplied.
function resolveMusicLengthMs(request) {
  const seconds = typeof request.maxDurationSeconds === 'number' ? request.maxDurationSeconds : typeof request.minDurationSeconds === 'number' ? request.minDurationSeconds : null;
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = Math.round(seconds * 1000);
  return Math.min(MAX_MUSIC_LENGTH_MS, Math.max(MIN_MUSIC_LENGTH_MS, ms));
}

// Real Content-Type -> this codebase's own short format vocabulary
// (matches asset-storage.js's own sniffAudioFormat() exts) — read from the
// actual response header, never assumed/hardcoded, consistent with this
// schema's "from the provider's own metadata, never guessed" rule.
function formatFromContentType(contentType) {
  if (typeof contentType !== 'string') return null;
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3';
  if (contentType.includes('wav')) return 'wav';
  return null;
}

async function readErrorDetail(response) {
  try {
    const parsed = await response.clone().json();
    if (parsed && parsed.detail) {
      return typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail);
    }
    return JSON.stringify(parsed);
  } catch {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }
}

async function search(request, { fetchImpl = fetch } = {}) {
  if (!request || typeof request.searchQuery !== 'string' || request.searchQuery.trim().length === 0) {
    return createMusicSearchResult({ status: 'FAILED', diagnostics: [createMusicSearchDiagnostic({ code: 'INVALID_REQUEST', message: 'searchQuery is required' })] });
  }

  const apiKey = credential();
  if (!apiKey) {
    return createMusicSearchResult({ status: 'UNAVAILABLE', diagnostics: [createMusicSearchDiagnostic({ code: 'MISSING_CREDENTIAL', message: 'EVOLINK_ELEVENLABS_API_KEY is not configured in this environment' })] });
  }

  const musicLengthMs = resolveMusicLengthMs(request);
  const body = { prompt: request.searchQuery, force_instrumental: true };
  if (musicLengthMs !== null) body.music_length_ms = musicLengthMs;

  let response;
  try {
    response = await fetchImpl(`${DEFAULT_BASE_URL}/v1/music`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return createMusicSearchResult({
      status: 'UNAVAILABLE',
      diagnostics: [createMusicSearchDiagnostic({ code: 'NETWORK_ERROR', message: `network error calling ElevenLabs Music: ${error && error.message ? error.message : String(error)}` })],
    });
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    return createMusicSearchResult({
      status: 'FAILED',
      diagnostics: [createMusicSearchDiagnostic({ code: 'PROVIDER_HTTP_ERROR', message: `ElevenLabs Music returned HTTP ${response.status}${detail ? `: ${detail}` : ''}` })],
    });
  }

  let audioBuffer;
  try {
    const arrayBuffer = await response.arrayBuffer();
    audioBuffer = Buffer.from(arrayBuffer);
  } catch (error) {
    return createMusicSearchResult({
      status: 'FAILED',
      diagnostics: [createMusicSearchDiagnostic({ code: 'INVALID_RESPONSE', message: `could not read ElevenLabs Music response body: ${error && error.message ? error.message : String(error)}` })],
    });
  }
  if (audioBuffer.length === 0) {
    return createMusicSearchResult({ status: 'FAILED', diagnostics: [createMusicSearchDiagnostic({ code: 'EMPTY_RESPONSE', message: 'ElevenLabs Music returned an empty response body' })] });
  }

  const songId = response.headers && typeof response.headers.get === 'function' ? response.headers.get('song-id') : null;
  const contentType = response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-type') : null;

  // Real bytes, no real audio-format validation here — that is
  // acquisition's job (services/music-acquisition-service.js reuses the
  // EXISTING asset-storage.js sniffer for every provider, URL- or
  // buffer-backed alike; see that file's own header). This provider never
  // duplicates that check.
  return createMusicSearchResult({
    status: 'COMPLETED',
    candidates: [
      {
        providerAssetId: songId || null,
        sourceUrl: null, // ElevenLabs Music has no separate hosted page for a generated track
        downloadUrl: null, // mode #2 — see schemas/music-acquisition-schema.js's own audioBuffer comment
        audioBuffer,
        durationSeconds: null, // requested, not confirmed — see file header
        format: formatFromContentType(contentType),
        attribution: null, // not returned by this endpoint — never invented
        licenseSummary: null, // not returned by this endpoint — never invented
      },
    ],
  });
}

module.exports = { PROVIDER_NAME: 'elevenlabs', search, credential, DEFAULT_BASE_URL };

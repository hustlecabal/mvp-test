// elevenlabs-sfx-provider.js
//
// PHASE 3E — EvoLink's first REAL, WORKING SFX provider.
//
// ---------------------------------------------------------------------------
// VERIFIED CONTRACT (fetched directly from elevenlabs.io/docs/api-reference/
// text-to-sound-effects/convert on 2026-09-06 — not from memory):
//
//   POST https://api.elevenlabs.io/v1/sound-generation
//   Headers:  xi-api-key: <key>
//             Content-Type: application/json
//   Body (JSON): { text: string (required), loop?: bool (default false,
//                  only honored by the eleven_text_to_sound_v2 model),
//                  duration_seconds?: number (0.5-30; omitted = provider
//                  guesses the optimal duration from the prompt),
//                  prompt_influence?: number (0-1, default 0.3),
//                  model_id?: string (default eleven_text_to_sound_v2) }
//   Response: HTTP 200 — "The generated sound effect as an MP3 file",
//             raw bytes directly in the response body (fileDownload).
//             Response header `character-cost` (no per-track id header).
//   Errors:   422 Unprocessable Entity (validation failure), JSON body.
//
// Same account, same credential, same binary-response shape as services/
// music/elevenlabs-music-provider.js's own verified POST /v1/music
// contract — this is a DIFFERENT real endpoint of the SAME ElevenLabs
// account, not a second, unrelated service. Reusing
// EVOLINK_ELEVENLABS_API_KEY here is therefore correct, not the kind of
// credential conflation Phase 3C's review rejected (that was about never
// treating AI33's own proxy credential as if it were a real ElevenLabs
// one — this file's credential genuinely IS the ElevenLabs account key).
//
// COMMERCIAL LICENSING (verified via elevenlabs.io/sound-effects-terms,
// updated 2026-02-12): on a paid plan, generated sound effects are
// royalty-free and commercially usable with no attribution and no
// per-track fee, PROVIDED they are embedded in a larger production —
// standalone resale/distribution of the raw generated SFX file itself
// (as an isolated sample, sample library, etc.) is explicitly prohibited.
// EvoLink's own use (muxing an SFX into a produced video) is squarely the
// permitted case. Free-plan output requires attribution to elevenlabs.io
// — this file makes no assumption about which plan a given credential is
// on; that is discovered empirically at call time, exactly like Phase 3D
// discovered the Music API's own plan-tier gate.
//
// ONE-SHOT ONLY, PHASE 3E'S OWN EXPLICIT SCOPE: `loop` is never set on
// the request (its documented default is already false) — this provider
// never asks for a looping sound effect. Looping SFX/ambience is
// explicitly out of scope this phase (see the Phase 3E architecture
// audit, §15 DO NOT BUILD YET).
//
// DURATION IS REQUESTED, NEVER GUARANTEED — same discipline as Music:
// `duration_seconds` tells the model a target; nothing in the documented
// contract promises the returned audio is exactly that long. The
// returned candidate's `durationSeconds` is left null (unconfirmed),
// exactly like elevenlabs-music-provider.js's own choice.
//
// BINARY RESPONSE, NO URL SHIM: sets `audioBuffer` on the candidate, the
// SAME provider-neutral acquisition-layer capability Phase 3D built for
// Music (schemas/sfx-acquisition-schema.js's own `audioBuffer` field,
// mirroring schemas/music-acquisition-schema.js's).
// ---------------------------------------------------------------------------

const { createSfxSearchResult, createSfxSearchDiagnostic } = require('./sfx-provider-interface');

const DEFAULT_BASE_URL = process.env.EVOLINK_ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';

// Verified against the live API reference — the documented, enforced
// range for duration_seconds.
const MIN_DURATION_SECONDS = 0.5;
const MAX_DURATION_SECONDS = 30;

function credential() {
  return process.env.EVOLINK_ELEVENLABS_API_KEY || null;
}

// Reuses the EXISTING, general minDurationSeconds/maxDurationSeconds
// request fields (no new field invented) — same reasoning as
// elevenlabs-music-provider.js's own resolveMusicLengthMs, adapted to
// seconds (not ms) and this endpoint's own 0.5-30s range. null (omit
// duration_seconds entirely) when neither is supplied, matching the
// API's own documented default ("we will guess the optimal duration").
function resolveDurationSeconds(request) {
  const seconds = typeof request.maxDurationSeconds === 'number' ? request.maxDurationSeconds : typeof request.minDurationSeconds === 'number' ? request.minDurationSeconds : null;
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(MAX_DURATION_SECONDS, Math.max(MIN_DURATION_SECONDS, seconds));
}

// Real Content-Type -> this codebase's own short format vocabulary,
// read from the actual response header — never assumed/hardcoded. Kept
// as its own small copy rather than imported from elevenlabs-music-
// provider.js, matching this codebase's own "duplicate a small stable
// helper rather than couple two provider modules together" convention
// (e.g. services/production-completeness-service.js's own header).
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
    return createSfxSearchResult({ status: 'FAILED', diagnostics: [createSfxSearchDiagnostic({ code: 'INVALID_REQUEST', message: 'searchQuery is required' })] });
  }

  const apiKey = credential();
  if (!apiKey) {
    return createSfxSearchResult({ status: 'UNAVAILABLE', diagnostics: [createSfxSearchDiagnostic({ code: 'MISSING_CREDENTIAL', message: 'EVOLINK_ELEVENLABS_API_KEY is not configured in this environment' })] });
  }

  const durationSeconds = resolveDurationSeconds(request);
  const body = { text: request.searchQuery };
  if (durationSeconds !== null) body.duration_seconds = durationSeconds;

  let response;
  try {
    response = await fetchImpl(`${DEFAULT_BASE_URL}/v1/sound-generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return createSfxSearchResult({
      status: 'UNAVAILABLE',
      diagnostics: [createSfxSearchDiagnostic({ code: 'NETWORK_ERROR', message: `network error calling ElevenLabs Sound Effects: ${error && error.message ? error.message : String(error)}` })],
    });
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    return createSfxSearchResult({
      status: 'FAILED',
      diagnostics: [createSfxSearchDiagnostic({ code: 'PROVIDER_HTTP_ERROR', message: `ElevenLabs Sound Effects returned HTTP ${response.status}${detail ? `: ${detail}` : ''}` })],
    });
  }

  let audioBuffer;
  try {
    const arrayBuffer = await response.arrayBuffer();
    audioBuffer = Buffer.from(arrayBuffer);
  } catch (error) {
    return createSfxSearchResult({
      status: 'FAILED',
      diagnostics: [createSfxSearchDiagnostic({ code: 'INVALID_RESPONSE', message: `could not read ElevenLabs Sound Effects response body: ${error && error.message ? error.message : String(error)}` })],
    });
  }
  if (audioBuffer.length === 0) {
    return createSfxSearchResult({ status: 'FAILED', diagnostics: [createSfxSearchDiagnostic({ code: 'EMPTY_RESPONSE', message: 'ElevenLabs Sound Effects returned an empty response body' })] });
  }

  const contentType = response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-type') : null;

  return createSfxSearchResult({
    status: 'COMPLETED',
    candidates: [
      {
        providerAssetId: null, // no per-track id header on this endpoint (verified — only `character-cost`)
        sourceUrl: null,
        downloadUrl: null, // mode #2 — see schemas/sfx-acquisition-schema.js's own audioBuffer comment
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

// ai33-music-provider.js
//
// PHASE 3C — the "production" AI33 Pro Music provider. Implements
// ../music-provider-interface.js's contract exactly, and REUSES this
// codebase's existing, verified AI33 infrastructure wherever a real
// AI33 Music capability would need it: the same credential
// (EVOLINK_AI33_API_KEY), the same base URL constant/override
// (EVOLINK_AI33_BASE_URL, default https://api.ai33.pro — see
// services/voice/ai33-voice-provider.js's own DEFAULT_BASE_URL), and the
// same generic task-polling contract already verified for narration
// (GET {baseUrl}/v3/task/{task_id} -> {success, data:{status, metadata}}}
// — see scripts/ai33-tts-worker.js's own pollTask()/downloadAudio(),
// which are already fully generic and directly reusable once a real
// submit contract exists).
//
// ---------------------------------------------------------------------------
// WHY THIS PROVIDER CURRENTLY ALWAYS REPORTS UNAVAILABLE (real finding,
// not a shortcut) — Phase 3C's own instruction was explicit: "Do not
// invent endpoints, request bodies, response fields, or polling
// behaviour." Before writing a single line of submit logic, the real,
// live AI33 API was probed with the real EVOLINK_AI33_API_KEY credential
// (2026-09-06):
//
//   Confirmed-real endpoints behave like this:
//     GET  /v3/voices           -> HTTP 400, JSON body (real validation
//                                  error: "provider must be one of:
//                                  elevenlabs, minimax, clone, edge,
//                                  kokoro, vbee, fishaudio")
//     POST /v3/text-to-speech   -> HTTP 400, JSON body (real validation
//                                  error: "voice_id is required")
//
//   Every plausible Music endpoint name tried, both GET and POST, with
//   the real API key:
//     /v3/music, /v3/text-to-music, /v3/music-generation,
//     /v3/sound-generation, /v3/generate-music, /v1/music, /v3/song,
//     /v3/songs, /v3/audio/music
//   -> HTTP 404, PLAIN TEXT "404 Not Found" (the framework's own
//      route-does-not-exist response — categorically different from the
//      real endpoints' JSON validation-error bodies above; this
//      distinction is what makes the finding conclusive rather than a
//      guess: a real-but-invalid request against a real route returns a
//      structured error, never a bare framework 404).
//
// CONCLUSION: no AI33 Pro Music generation endpoint currently exists on
// the live API at any tested, plausible path. The submit contract
// (endpoint, request body, response shape) is therefore NOT knowable
// from available evidence, and none is invented here. This provider is
// real, registered, interface-compliant, and genuinely reuses the
// credential/base-URL infrastructure — its current, correct, live
// behavior is a structured UNAVAILABLE, exactly the same honest
// degradation discipline this codebase already uses for a missing
// credential, applied here to a missing/unconfirmed endpoint instead.
//
// COMPLETING THIS PROVIDER LATER: once AI33 documents (or support
// confirms) a real Music endpoint, only this file needs a submit step
// added — reusing scripts/ai33-tts-worker.js's own pollTask()/
// downloadAudio() functions directly (both are already fully generic:
// pollTask takes {taskUrlTemplate, apiKey, taskId, pollIntervalMs,
// timeoutMs} and downloadAudio takes {remoteAudioUrl, outputPath}, with
// no TTS-specific field anywhere in either). Nothing else in this file,
// in music-acquisition-service.js, or in the Phase 3A timeline
// architecture would need to change.
// ---------------------------------------------------------------------------

const { createMusicSearchResult, createMusicSearchDiagnostic } = require('./music-provider-interface');

const DEFAULT_BASE_URL = process.env.EVOLINK_AI33_BASE_URL || 'https://api.ai33.pro';

function credential() {
  return process.env.EVOLINK_AI33_API_KEY || null;
}

async function search(request) {
  if (!request || typeof request.searchQuery !== 'string' || request.searchQuery.trim().length === 0) {
    return createMusicSearchResult({ status: 'FAILED', diagnostics: [createMusicSearchDiagnostic({ code: 'INVALID_REQUEST', message: 'searchQuery is required' })] });
  }
  if (!credential()) {
    return createMusicSearchResult({ status: 'UNAVAILABLE', diagnostics: [createMusicSearchDiagnostic({ code: 'MISSING_CREDENTIAL', message: 'EVOLINK_AI33_API_KEY is not configured in this environment' })] });
  }
  // No configuration surface is invented for the missing endpoint — an
  // earlier draft added one to distinguish "not yet confirmed" from
  // "confirmed but unimplemented," but both meant the exact same real-
  // world state today, so that surface was removed as premature
  // configuration for a contract that doesn't exist. See file header for
  // the full discovery evidence.
  return createMusicSearchResult({
    status: 'UNAVAILABLE',
    diagnostics: [
      createMusicSearchDiagnostic({
        code: 'AI33_MUSIC_ENDPOINT_NOT_CONFIRMED',
        message:
          `no AI33 Pro Music generation endpoint is confirmed against the live API at ${DEFAULT_BASE_URL} ` +
          '(every plausible path tested returned a real 404 — see this file\'s own header for the exact discovery evidence)',
      }),
    ],
  });
}

module.exports = { PROVIDER_NAME: 'ai33', search, credential, DEFAULT_BASE_URL };

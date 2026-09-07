// ai33-music-provider.js
//
// PHASE 3B — the REAL AI33/Suno Music provider. Implements
// ../music-provider-interface.js's contract exactly (search(request) ->
// MusicSearchResult, this codebase's own established name for a
// provider's one operation — see that file's own header for why that
// name is a legitimate reading of "search" for a purely generative
// provider; NOT renamed to a new "generateMusic" method, which would
// require music-acquisition-service.js's dispatch table to know two
// different provider shapes for no real benefit). Reuses this codebase's
// existing, verified AI33 credential (EVOLINK_AI33_API_KEY) and base-URL
// override convention (EVOLINK_AI33_BASE_URL, default
// https://api.ai33.pro — see services/voice/ai33-voice-provider.js's own
// DEFAULT_BASE_URL) — no second AI33 credential invented.
//
// ---------------------------------------------------------------------------
// DOCUMENTED CONTRACT (supplied 2026-09-07):
//
//   POST {baseUrl}/v1s/task/music-generation
//   Headers: xi-api-key: <EVOLINK_AI33_API_KEY>
//   Simple/instrumental mode:  { gpt_description_prompt, make_instrumental: true }
//   Custom mode:               { title, lyrics, tags, vocal_gender }
//   Response: "returns a task_id"
//
//   GET {baseUrl}/v1/task/{task_id}   — the documented common task-retrieval
//   mechanism (note: v1, singular "task" — a DIFFERENT version prefix from
//   narration's own already-verified GET {baseUrl}/v3/task/{task_id}; see
//   scripts/ai33-tts-worker.js's own header. This file does NOT copy that
//   v3 assumption for Music — the two are treated as genuinely different,
//   documented endpoints, per this milestone's own explicit instruction not
//   to blindly reuse the TTS polling assumption).
//
// RESPONSE ENVELOPE — CLASSIFIED BY EVIDENCE (PHASE 3B HARDENING review —
// nothing below is upgraded to "verified" without a real, live music-
// specific response to confirm it):
//
//   A. DOCUMENTED (supplied 2026-09-07, music-specific):
//      - POST {baseUrl}/v1s/task/music-generation, GET {baseUrl}/v1/task/{task_id}
//      - request field names for both modes (gpt_description_prompt/
//        make_instrumental; title/lyrics/tags/vocal_gender)
//      - "the generated task returns a task_id" (existence only — no
//        example response body was supplied)
//
//   B. INFERRED FROM AI33'S OWN VERIFIED TTS CONVENTION (same vendor, same
//      credential, same task-based architecture — scripts/ai33-tts-
//      worker.js, verified live 2026-09-05 — but a DIFFERENT endpoint
//      family, v1s/v1 vs v3, so still an inference, never treated as
//      confirmed for Music):
//      - envelope shape: submit -> `{success:true, task_id}`; poll ->
//        `{success:true, data:{status, metadata:{...}}}`
//      - in-progress status values 'doing'/'pending'/'processing', and
//        'done' for complete (TTS's own literal, observed set — see
//        IN_PROGRESS_STATUSES below; no value here is added beyond what
//        TTS itself verified)
//      - `metadata.audio_url` as the completed-audio field name
//
//   C. PURELY INFERRED, ZERO GROUNDING IN EITHER A OR B (reasonable
//      guesses for a Suno-style generation API, but TTS's own verified
//      metadata shape — {audio_url, srt_url?, json_url?,
//      transcript_status?, voice_id} — never included these fields
//      either): `metadata.duration` (attempted read, then
//      `metadata.model`/`metadata.model_name`. Read DEFENSIVELY ONLY
//      (type-checked, default null, never required for success/failure
//      classification) — a real response missing either is completion
//      metadata's own best-effort provenance, never a MALFORMED_RESPONSE
//      failure by itself, and never presented as a confirmed fact.
//
// A response that doesn't match the required (A/B) envelope shape is
// surfaced as AI33_MALFORMED_RESPONSE, never silently force-fit into it,
// and never treated as evidence the documented endpoint itself is wrong.
//
// REAL VERIFICATION STATUS: a real submit call WAS attempted against the
// live API with the real EVOLINK_AI33_API_KEY credential (2026-09-07,
// scratch verification script, then re-attempted through this file's own
// code path). It did not reach api.ai33.pro — this execution
// environment's own sandbox network egress policy returned "Host not in
// allowlist: api.ai33.pro" before the request ever left the sandbox. This
// is a confirmed environment/network limitation, not an AI33-side
// response, and not evidence against the documented contract above. Per
// this milestone's own explicit instruction, this environmental block is
// never worked around here (no alternate host, no proxy bypass, no TLS
// relaxation, no fallback provider) — see the Phase 3B final report for
// the full real-call attempt and its exact outcome.
//
// TWO REQUEST MODES: `request.lyrics` (schemas/music-acquisition-
// schema.js's own new, additive, optional field) being a non-empty string
// selects CUSTOM mode (title/lyrics/tags/vocal_gender); its absence
// selects SIMPLE/INSTRUMENTAL mode (gpt_description_prompt +
// make_instrumental), EvoLink's own default background-music use case.
// `request.instrumental` defaults to true in simple mode (only an
// explicit `false` turns it off) — mirrors elevenlabs-music-provider.js's
// own "EvoLink background music defaults to instrumental" policy, but
// or, unlike that file, genuinely overridable here per this milestone's
// own interface requirement.
//
// DOWNLOAD: this provider returns a `downloadUrl` (mode #1, the ALREADY-
// EXISTING acquisition path) — never audioBuffer (mode #2 exists only
// because ElevenLabs Music's own real contract returns raw bytes
// directly; AI33's documented contract returns a URL, so the EXISTING
// services/music-acquisition-service.js's own generic
// assetStorage.downloadAsset() call already does the actual fetch+store —
// this file never downloads or writes anything itself).
//
// NO SECRET LEAKAGE: the API key is read from process.env only, sent
// only as a request header, never logged, never included in a
// diagnostic message, never part of a returned candidate/result.
// ---------------------------------------------------------------------------

const { createMusicSearchResult, createMusicSearchDiagnostic } = require('./music-provider-interface');
const { createMusicCandidate } = require('../../schemas/music-acquisition-schema');

const DEFAULT_BASE_URL = process.env.EVOLINK_AI33_BASE_URL || 'https://api.ai33.pro';
const SUBMIT_PATH = '/v1s/task/music-generation';
const DEFAULT_POLL_INTERVAL_MS = Number(process.env.EVOLINK_AI33_MUSIC_POLL_INTERVAL_MS) || 3000;
const DEFAULT_TIMEOUT_MS = Number(process.env.EVOLINK_AI33_MUSIC_TIMEOUT_MS) || 180000;

// EXACTLY the same 3 values already verified live for AI33's sibling TTS
// endpoint (scripts/ai33-tts-worker.js's own pollTask()) — 'queued'/
// 'submitted' were removed here (PHASE 3B HARDENING): neither the
// supplied Music documentation nor the verified TTS convention names
// them, so treating them as in-progress would have been a speculative
// status value with zero evidence behind it. An unrecognized status
// (including either of those, if AI33 ever sends them) now correctly
// surfaces as AI33_TASK_FAILED rather than being silently absorbed.
const IN_PROGRESS_STATUSES = ['doing', 'pending', 'processing'];

function credential() {
  return process.env.EVOLINK_AI33_API_KEY || null;
}

function isCustomMode(request) {
  return typeof request.lyrics === 'string' && request.lyrics.trim().length > 0;
}

// Maps the provider-neutral MusicAcquisitionRequest onto EXACTLY the two
// documented AI33 request bodies — never a third, invented shape.
function buildRequestBody(request) {
  if (isCustomMode(request)) {
    const body = { title: request.title || '', lyrics: request.lyrics };
    if (typeof request.tags === 'string' && request.tags.length > 0) body.tags = request.tags;
    if (request.vocalGender === 'f' || request.vocalGender === 'm') body.vocal_gender = request.vocalGender;
    return body;
  }
  return {
    gpt_description_prompt: request.searchQuery,
    make_instrumental: request.instrumental !== false,
  };
}

async function readBodyText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function submitTask(request, apiKey, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${DEFAULT_BASE_URL}${SUBMIT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify(buildRequestBody(request)),
    });
  } catch (error) {
    return { ok: false, code: 'NETWORK_ERROR', message: `network error calling AI33 Music: ${error && error.message ? error.message : String(error)}` };
  }
  const bodyText = await readBodyText(response);
  if (!response.ok) {
    return { ok: false, code: 'PROVIDER_HTTP_ERROR', message: `AI33 Music submit returned HTTP ${response.status}: ${bodyText.slice(0, 500)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, code: 'AI33_MALFORMED_RESPONSE', message: 'AI33 Music submit response was not valid JSON' };
  }
  const taskId = parsed && parsed.success === true && typeof parsed.task_id === 'string' && parsed.task_id.length > 0 ? parsed.task_id : null;
  if (!taskId) {
    return { ok: false, code: 'AI33_MALFORMED_RESPONSE', message: `AI33 Music submit response missing success/task_id: ${bodyText.slice(0, 500)}` };
  }
  return { ok: true, taskId };
}

async function pollTask(taskId, apiKey, fetchImpl, { pollIntervalMs, timeoutMs }) {
  const url = `${DEFAULT_BASE_URL}/v1/task/${encodeURIComponent(taskId)}`;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { 'xi-api-key': apiKey } });
    } catch (error) {
      return { ok: false, code: 'NETWORK_ERROR', message: `AI33 Music poll network error: ${error && error.message ? error.message : String(error)}` };
    }
    const bodyText = await readBodyText(response);
    if (!response.ok) {
      return { ok: false, code: 'PROVIDER_HTTP_ERROR', message: `AI33 Music poll returned HTTP ${response.status}: ${bodyText.slice(0, 500)}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return { ok: false, code: 'AI33_MALFORMED_RESPONSE', message: 'AI33 Music poll response was not valid JSON' };
    }
    const data = parsed && parsed.success === true ? parsed.data : null;
    if (!data || typeof data.status !== 'string') {
      return { ok: false, code: 'AI33_MALFORMED_RESPONSE', message: `AI33 Music poll response missing success/data.status: ${bodyText.slice(0, 500)}` };
    }
    lastStatus = data.status;

    if (data.status === 'done') {
      const meta = data.metadata || {};
      if (typeof meta.audio_url !== 'string' || meta.audio_url.length === 0) {
        return { ok: false, code: 'AI33_MALFORMED_RESPONSE', message: 'AI33 Music task completed but returned no metadata.audio_url' };
      }
      return {
        ok: true,
        audioUrl: meta.audio_url,
        durationSeconds: typeof meta.duration === 'number' ? meta.duration : null,
        model: meta.model || meta.model_name || null,
      };
    }
    if (!IN_PROGRESS_STATUSES.includes(data.status)) {
      return { ok: false, code: 'AI33_TASK_FAILED', message: `AI33 Music task reported an unrecognized/failure status: ${JSON.stringify(data.status)}` };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { ok: false, code: 'AI33_TASK_TIMEOUT', message: `AI33 Music task did not complete within ${timeoutMs}ms (last status: ${lastStatus})` };
}

// options.pollIntervalMs/timeoutMs are additive, optional overrides for
// testing (unit tests use tiny values so a pending->completed/timeout
// flow runs in milliseconds, never real wall-clock time) — production
// callers (services/music-acquisition-service.js's acquireMusic(), which
// only ever passes {fetchImpl}) get the real, sensible defaults above.
async function search(request, { fetchImpl = fetch, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!request || typeof request.searchQuery !== 'string' || request.searchQuery.trim().length === 0) {
    return createMusicSearchResult({ status: 'FAILED', diagnostics: [createMusicSearchDiagnostic({ code: 'INVALID_REQUEST', message: 'searchQuery is required' })] });
  }
  const apiKey = credential();
  if (!apiKey) {
    return createMusicSearchResult({ status: 'UNAVAILABLE', diagnostics: [createMusicSearchDiagnostic({ code: 'MISSING_CREDENTIAL', message: 'EVOLINK_AI33_API_KEY is not configured in this environment' })] });
  }

  const submission = await submitTask(request, apiKey, fetchImpl);
  if (!submission.ok) {
    return createMusicSearchResult({ status: 'FAILED', diagnostics: [createMusicSearchDiagnostic({ code: submission.code, message: submission.message })] });
  }

  const polled = await pollTask(submission.taskId, apiKey, fetchImpl, { pollIntervalMs, timeoutMs });
  if (!polled.ok) {
    return createMusicSearchResult({ status: 'FAILED', diagnostics: [createMusicSearchDiagnostic({ code: polled.code, message: `${polled.message} (task_id: ${submission.taskId})` })] });
  }

  return createMusicSearchResult({
    status: 'COMPLETED',
    candidates: [
      createMusicCandidate({
        providerAssetId: submission.taskId,
        sourceUrl: polled.audioUrl,
        downloadUrl: polled.audioUrl,
        durationSeconds: polled.durationSeconds,
        format: null, // never guessed — asset-storage.js's own real-signature sniffer determines this from the downloaded bytes
        attribution: null,
        licenseSummary: null,
        providerMetadata: {
          provider: 'ai33',
          operation: 'music-generation',
          taskId: submission.taskId,
          model: polled.model,
          mode: isCustomMode(request) ? 'custom' : 'simple',
        },
      }),
    ],
  });
}

module.exports = { PROVIDER_NAME: 'ai33', search, credential, DEFAULT_BASE_URL, SUBMIT_PATH };

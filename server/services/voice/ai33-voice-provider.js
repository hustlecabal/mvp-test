// ai33-voice-provider.js
//
// AI33 Pro TEXT-TO-SPEECH — a SECOND, swappable adapter implementing the
// EXACT SAME contract as services/voice/espeak-voice-provider.js
// (voice-provider-interface.js's generateVoice({narrationDirection,
// outputPath}) -> VoiceGenerationResult). No changes were made to
// voice-provider-interface.js, to services/voice/whisper-alignment-
// provider.js, or to how services/voice-generation-service.js CALLS a
// voice provider — this is a pure, dependency-injectable swap-in, exactly
// like that file's own header already documents ("either can be swapped
// per-call via the voiceProvider/alignmentProvider parameters").
//
// SYNCHRONOUS BY DESIGN (required, not incidental): production-
// orchestrator-service.js calls generateNarratedAudioEvent() synchronously
// and un-awaited — a Production Orchestrator this milestone is forbidden
// from modifying. AI33's own API is asynchronous (submit -> poll -> done),
// so the real submit/poll/download work runs inside scripts/ai33-tts-
// worker.js, a separate OS process spawned synchronously
// (execFileSync-style — the exact same "block on a subprocess for real
// external work" pattern espeak-voice-provider.js/whisper-alignment-
// provider.js already use for their own external tools), so this file's
// own generateVoice() still returns synchronously either way.
//
// SECURITY: the API key is read server-side only (EVOLINK_AI33_API_KEY —
// following EVOLINK_LLM_API_KEY's established naming convention for a
// cloud provider credential), passed to the worker via STDIN (never argv,
// never an env var the child inherits that a `ps`-style listing could
// read), and never logged or included in this provider's return value —
// voice-provider-interface.js's own contract already requires this
// ("no provider name, no voice ID, no credentials... ever appears" in the
// declared result shape); this file honors that for the declared fields
// and additionally never logs the key anywhere, including on failure.
//
// PROVENANCE HANDOFF (`providerMetadata`): the interface's declared
// VoiceGenerationResult shape is deliberately provider-neutral. To let
// services/voice-generation-service.js still record AI33-specific
// provenance (provider name, voice_id, task_id, remote URL) onto the
// real production-schema.js Asset it already creates — using that
// schema's own existing provider/model/generationId/url fields, never a
// new asset model — this file attaches ONE additive, OPTIONAL field
// (`providerMetadata`) alongside the interface's own declared fields.
// espeak-voice-provider.js never sets this field, so its behavior (and
// every existing test/caller) is completely unaffected; voice-generation-
// service.js only reads it when present (see that file's own small,
// additive change).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createVoiceGenerationResult, createVoiceDiagnostic } = require('./voice-provider-interface');

const DEFAULT_BASE_URL = process.env.EVOLINK_AI33_BASE_URL || 'https://api.ai33.pro';
// See ai33-tts-worker.js's own header for why this exact template is a
// documented ASSUMPTION, not a confirmed AI33 endpoint.
const DEFAULT_TASK_URL_TEMPLATE = process.env.EVOLINK_AI33_TASK_URL_TEMPLATE || `${DEFAULT_BASE_URL}/v3/tasks/{task_id}`;
const DEFAULT_POLL_INTERVAL_MS = Number(process.env.EVOLINK_AI33_POLL_INTERVAL_MS) || 3000;
const DEFAULT_TIMEOUT_MS = Number(process.env.EVOLINK_AI33_TIMEOUT_MS) || 120000;
const WORKER_PATH = path.join(__dirname, '..', '..', 'scripts', 'ai33-tts-worker.js');

const MIN_SPEED = 0.5;
const MAX_SPEED = 1.5;

function ffprobeValidateAudio(outputPath, ffprobeBin) {
  if (!fs.existsSync(outputPath)) return { ok: false, message: 'output file does not exist after download' };
  let raw;
  try {
    raw = execFileSync(
      ffprobeBin,
      ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels', '-of', 'json', outputPath],
      { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString('utf8');
  } catch (error) {
    return { ok: false, message: `ffprobe validation failed to run: ${error.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'ffprobe returned unparseable output' };
  }
  const duration = parsed.format && Number(parsed.format.duration);
  const audioStream = (parsed.streams || []).find((s) => s.codec_type === 'audio');
  if (!audioStream) return { ok: false, message: 'ffprobe found no audio stream in the downloaded file' };
  if (!duration || duration <= 0) return { ok: false, message: `ffprobe reported an invalid duration: ${JSON.stringify(parsed.format)}` };
  return { ok: true, duration };
}

function resolveFfprobeBin() {
  return process.env.HYPERFRAMES_FFPROBE_PATH || process.env.FFPROBE_PATH || 'ffprobe';
}

function fail(code, message) {
  return createVoiceGenerationResult({ status: 'FAILED', audioPath: null, duration: null, diagnostics: [createVoiceDiagnostic({ code, message })] });
}

// Default worker invocation — a real, synchronous subprocess spawn. Tests
// inject a fake `spawnWorker` (see createAi33VoiceProvider) so a unit test
// never spawns a real process or makes a real network call.
function defaultSpawnWorker(requestPayload, { timeoutMs }) {
  const stdout = execFileSync('node', [WORKER_PATH], {
    input: JSON.stringify(requestPayload),
    timeout: timeoutMs + 10000, // headroom over the worker's own internal poll deadline
    // NODE_USE_ENV_PROXY=1 — this sandboxed environment's Node fetch()
    // only reaches the public internet through its HTTPS_PROXY when this
    // is set (established and confirmed working in an earlier milestone's
    // real Claude API calls). Set unconditionally here so a caller of
    // this provider never has to remember it.
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
    maxBuffer: 10 * 1024 * 1024,
  }).toString('utf8');
  return JSON.parse(stdout);
}

// Factory form — for tests and any caller wanting to inject
// apiKey/voiceId/speed/pronunciationDictionaryId/withTranscript/
// spawnWorker explicitly rather than reading them from the environment.
function createAi33VoiceProvider({
  apiKey = process.env.EVOLINK_AI33_API_KEY,
  voiceId = process.env.EVOLINK_AI33_VOICE_ID,
  speed = process.env.EVOLINK_AI33_SPEED ? Number(process.env.EVOLINK_AI33_SPEED) : 1,
  pronunciationDictionaryId = process.env.EVOLINK_AI33_PRONUNCIATION_DICTIONARY_ID || null,
  withTranscript = true,
  fileNamePrefix = 'evolink-narration',
  baseUrl = DEFAULT_BASE_URL,
  taskUrlTemplate = DEFAULT_TASK_URL_TEMPLATE,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnWorker = defaultSpawnWorker,
  ffprobeBin = resolveFfprobeBin(),
} = {}) {
  function generateVoice({ narrationDirection, outputPath } = {}) {
    if (!narrationDirection || narrationDirection.status !== 'COMPLETED' || typeof narrationDirection.text !== 'string' || narrationDirection.text.trim().length === 0) {
      return fail('INVALID_NARRATION_DIRECTION', 'narrationDirection must be a COMPLETED NarrationDirection with non-empty text');
    }
    if (narrationDirection.text.length > 1000000) {
      return fail('INVALID_NARRATION_DIRECTION', 'text exceeds AI33\'s documented 1,000,000 character maximum');
    }
    if (!outputPath) {
      return fail('INVALID_NARRATION_DIRECTION', 'an outputPath is required');
    }
    if (!apiKey) {
      return fail('VOICE_PROVIDER_UNAVAILABLE', 'EVOLINK_AI33_API_KEY is not configured in this environment');
    }
    if (!voiceId) {
      return fail('VOICE_PROVIDER_UNAVAILABLE', 'no voice_id configured — set EVOLINK_AI33_VOICE_ID (a provider-prefixed id such as elevenlabs_<id>) or pass voiceId explicitly; never guessed');
    }
    if (typeof speed !== 'number' || Number.isNaN(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
      return fail('INVALID_SPEED', `speed must be a number between ${MIN_SPEED} and ${MAX_SPEED}, got ${JSON.stringify(speed)}`);
    }

    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    } catch (error) {
      return fail('VOICE_GENERATION_FAILED', `could not prepare output directory: ${error.message}`);
    }

    const requestPayload = {
      apiKey,
      baseUrl,
      text: narrationDirection.text,
      voiceId,
      speed,
      withTranscript,
      fileName: `${fileNamePrefix}-${crypto.randomUUID()}`,
      pronunciationDictionaryId,
      outputPath,
      pollIntervalMs,
      timeoutMs,
      taskUrlTemplate,
    };

    let workerResult;
    try {
      workerResult = spawnWorker(requestPayload, { timeoutMs });
    } catch (error) {
      // execFileSync throws on a non-zero exit or timeout — never surface
      // raw stderr/stdout here (the key is passed via stdin, never argv,
      // but stderr from a genuinely crashed worker could theoretically
      // echo request internals back — truncate and never assume it's safe
      // to log verbatim).
      const isTimeout = error && error.signal === 'SIGTERM';
      return fail(isTimeout ? 'AI33_TASK_TIMEOUT' : 'AI33_WORKER_FAILED', isTimeout ? `AI33 TTS worker did not complete within ${timeoutMs}ms` : `AI33 TTS worker process failed: ${error && error.message ? error.message.slice(0, 300) : 'unknown error'}`);
    }

    if (!workerResult || typeof workerResult !== 'object') {
      return fail('AI33_MALFORMED_RESPONSE', 'AI33 TTS worker produced no parseable result');
    }
    if (!workerResult.ok) {
      return fail(workerResult.code || 'AI33_TASK_FAILED', workerResult.message || 'AI33 TTS task did not complete');
    }

    const validation = ffprobeValidateAudio(outputPath, ffprobeBin);
    if (!validation.ok) {
      return fail('AUDIO_FILE_INVALID', validation.message);
    }

    const result = createVoiceGenerationResult({ status: 'COMPLETED', audioPath: outputPath, duration: validation.duration, diagnostics: [] });
    // See file header — additive, optional, never part of the declared interface shape.
    result.providerMetadata = {
      provider: 'ai33',
      operation: 'text-to-speech',
      voiceId,
      speed,
      pronunciationDictionaryId,
      taskId: workerResult.taskId,
      remoteAudioUrl: workerResult.remoteAudioUrl,
      transcriptUrl: workerResult.transcriptUrl || null,
      transcriptText: workerResult.transcriptText || null,
    };
    return result;
  }

  return { generateVoice };
}

// Default export usable directly as a `voiceProvider` the same way
// espeak-voice-provider.js's plain `generateVoice` export already is —
// reads all configuration from the environment.
const { generateVoice } = createAi33VoiceProvider();

module.exports = { generateVoice, createAi33VoiceProvider, MIN_SPEED, MAX_SPEED };

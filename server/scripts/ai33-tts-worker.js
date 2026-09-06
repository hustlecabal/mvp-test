#!/usr/bin/env node
// ai33-tts-worker.js
//
// The REAL, async AI33 Pro TTS submit -> poll -> download logic, run as a
// separate OS process so services/voice/ai33-voice-provider.js's
// generateVoice() can stay perfectly SYNCHRONOUS from its caller's point of
// view — exactly the same "spawn a subprocess synchronously, block until
// it exits, read a structured result" pattern services/voice/espeak-voice-
// provider.js (execFileSync('espeak-ng', ...)) and services/voice/whisper-
// alignment-provider.js (execFileSync(pythonBin, ...)) already use for
// their own real external work. This is required because voice-generation-
// service.js's generateNarratedAudioEvent() is called synchronously,
// un-awaited, from production-orchestrator-service.js's resumeProduction()
// — a Production Orchestrator this milestone is explicitly forbidden from
// modifying — so an async provider cannot change that call chain's shape.
//
// SECURITY: the request (including the API key) is read from STDIN, never
// argv — argv is visible in a process list (`ps`); stdin is not. The key
// is never logged, never printed, and never included in the JSON this
// script writes to stdout.
//
// INPUT (one JSON object on stdin):
//   { apiKey, baseUrl, text, voiceId, speed, withTranscript, fileName,
//     pronunciationDictionaryId, outputPath, pollIntervalMs, timeoutMs,
//     taskUrlTemplate }
//
// OUTPUT (one JSON object on stdout, always — never a thrown/uncaught
// error for an ordinary API/network failure; those become {ok:false}):
//   { ok:true, taskId, remoteAudioUrl, srtUrl, wordTimestamps, voiceId }
//   { ok:false, code, message }
//
// POLLING ENDPOINT — VERIFIED against the real, live API (2026-09-05,
// using a real API key and a real completed task), not guessed. The
// milestone brief named POST /v3/text-to-speech and GET /v3/voices but
// left the polling endpoint/response shape undocumented ("through webhook
// or the existing/common task polling mechanism"); an initial documented
// assumption (GET /v3/tasks/{task_id}, a flat {status, audio_url, ...}
// body) was tried first and returned a real HTTP 404 from the live API,
// so the correct shape was found empirically against the real service
// rather than left as an unverified guess:
//   GET {baseUrl}/v3/task/{task_id}   (singular "task")
//   -> { success: true, data: { status: 'doing'|'done', progress,
//        metadata: { audio_url, srt_url?, json_url? (word-level
//        timestamps, only when with_transcript was requested), voice_id,
//        ... } } }
// No failure/error status has been observed live — any status other than
// doing/pending/processing/done is treated as a failure rather than
// assumed to have a specific spelling (see pollTask()'s own comment).

const fs = require('fs');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeResult(result) {
  process.stdout.write(JSON.stringify(result));
}

async function submitTask({ baseUrl, apiKey, text, voiceId, speed, withTranscript, fileName, pronunciationDictionaryId }) {
  const form = new FormData();
  form.append('text', text);
  form.append('voice_id', voiceId);
  form.append('speed', String(speed));
  if (withTranscript) form.append('with_transcript', 'true');
  if (fileName) form.append('file_name', fileName);
  if (pronunciationDictionaryId) form.append('pronunciation_dictionary_id', pronunciationDictionaryId);

  const response = await fetch(`${baseUrl}/v3/text-to-speech`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });

  const bodyText = await response.text();
  if (!response.ok) {
    return { ok: false, code: 'AI33_HTTP_ERROR', message: `AI33 returned HTTP ${response.status}: ${bodyText.slice(0, 500)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, code: 'AI33_MALFORMED_RESPONSE', message: 'AI33 submit response was not valid JSON' };
  }
  if (!parsed || parsed.success !== true || typeof parsed.task_id !== 'string' || parsed.task_id.length === 0) {
    return { ok: false, code: 'AI33_MALFORMED_RESPONSE', message: `AI33 submit response missing success/task_id: ${bodyText.slice(0, 500)}` };
  }
  return { ok: true, taskId: parsed.task_id };
}

// VERIFIED against the real, live API (2026-09-05, using a real API key) —
// this is no longer a documented assumption:
//   GET {baseUrl}/v3/task/{task_id}   (singular "task")
//   -> { success: true, data: { id, created_at, status, credit_cost,
//        progress, type, metadata: { audio_url, srt_url?, json_url?,
//        transcript_status?, voice_id, ... } } }
// status observed: "doing" (in progress) -> "done" (complete). No
// "failed"/error status has been observed live; a status this file does
// not recognize is treated as a malformed response (surfaced, never
// silently retried as if it were still pending) rather than assuming an
// unconfirmed error-state spelling.
async function pollTask({ taskUrlTemplate, apiKey, taskId, pollIntervalMs, timeoutMs }) {
  const url = taskUrlTemplate.replace('{task_id}', encodeURIComponent(taskId));
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    let response;
    try {
      response = await fetch(url, { method: 'GET', headers: { 'xi-api-key': apiKey } });
    } catch (error) {
      return { ok: false, code: 'AI33_NETWORK_ERROR', message: `polling request failed: ${error.message}` };
    }
    const bodyText = await response.text();
    if (!response.ok) {
      return { ok: false, code: 'AI33_HTTP_ERROR', message: `AI33 task poll returned HTTP ${response.status}: ${bodyText.slice(0, 500)}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return { ok: false, code: 'AI33_MALFORMED_RESPONSE', message: 'AI33 task poll response was not valid JSON' };
    }
    const data = parsed && parsed.success === true ? parsed.data : null;
    if (!data || typeof data.status !== 'string') {
      return { ok: false, code: 'AI33_MALFORMED_RESPONSE', message: `AI33 task poll response missing success/data.status: ${bodyText.slice(0, 500)}` };
    }
    lastStatus = data.status;
    if (data.status === 'done') {
      const meta = data.metadata || {};
      if (typeof meta.audio_url !== 'string' || meta.audio_url.length === 0) {
        return { ok: false, code: 'AI33_MALFORMED_RESPONSE', message: 'AI33 task completed but returned no metadata.audio_url' };
      }
      return { ok: true, remoteAudioUrl: meta.audio_url, srtUrl: meta.srt_url || null, wordTimestampsUrl: meta.json_url || null };
    }
    if (data.status !== 'doing' && data.status !== 'pending' && data.status !== 'processing') {
      return { ok: false, code: 'AI33_TASK_FAILED', message: `AI33 task reported an unrecognized/failure status: ${JSON.stringify(data.status)}` };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { ok: false, code: 'AI33_TASK_TIMEOUT', message: `AI33 task did not complete within ${timeoutMs}ms (last status: ${lastStatus})` };
}

// AI33's own json_url, when with_transcript was requested, is a REAL,
// provider-native word-level alignment (ElevenLabs forced-alignment
// output) — {text, start, end, type: 'word'|'spacing', ...}[] inside one
// object per detected language segment. This is genuinely usable
// alignment data, not merely descriptive metadata — fetched and
// normalized into the same {word, start, end} shape services/voice-
// generation-service.js already turns an AlignmentResult into (see
// schemas/audio-schema.js's createWordTimestamp()), but returned
// separately as `wordTimestamps` rather than replacing the existing
// Whisper alignment pass — that remains a deliberate, separate decision
// for voice-generation-service.js to make, not this worker.
async function fetchWordTimestamps(wordTimestampsUrl) {
  if (!wordTimestampsUrl) return null;
  try {
    const response = await fetch(wordTimestampsUrl);
    if (!response.ok) return null;
    const segments = await response.json();
    if (!Array.isArray(segments)) return null;
    const words = [];
    for (const segment of segments) {
      for (const entry of segment.words || []) {
        if (entry.type === 'word' && typeof entry.text === 'string' && entry.text.trim().length > 0) {
          words.push({ word: entry.text.trim(), start: entry.start, end: entry.end });
        }
      }
    }
    return words.length > 0 ? words : null;
  } catch {
    return null; // best-effort only — never fails the overall task for this
  }
}

async function downloadAudio(remoteAudioUrl, outputPath) {
  let response;
  try {
    response = await fetch(remoteAudioUrl);
  } catch (error) {
    return { ok: false, code: 'AI33_NETWORK_ERROR', message: `audio download failed: ${error.message}` };
  }
  if (!response.ok) {
    return { ok: false, code: 'AI33_HTTP_ERROR', message: `audio download returned HTTP ${response.status}` };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    return { ok: false, code: 'AI33_MALFORMED_RESPONSE', message: 'downloaded audio file is empty' };
  }
  fs.writeFileSync(outputPath, buffer);
  return { ok: true };
}

async function main() {
  const raw = await readStdin();
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    writeResult({ ok: false, code: 'INVALID_WORKER_INPUT', message: 'worker stdin was not valid JSON' });
    process.exitCode = 0;
    return;
  }

  const { apiKey, baseUrl, text, voiceId, speed, withTranscript, fileName, pronunciationDictionaryId, outputPath, pollIntervalMs, timeoutMs, taskUrlTemplate } = request;

  const submission = await submitTask({ baseUrl, apiKey, text, voiceId, speed, withTranscript, fileName, pronunciationDictionaryId });
  if (!submission.ok) {
    writeResult(submission);
    return;
  }

  const polled = await pollTask({ taskUrlTemplate, apiKey, taskId: submission.taskId, pollIntervalMs, timeoutMs });
  if (!polled.ok) {
    writeResult({ ...polled, taskId: submission.taskId });
    return;
  }

  const downloaded = await downloadAudio(polled.remoteAudioUrl, outputPath);
  if (!downloaded.ok) {
    writeResult({ ...downloaded, taskId: submission.taskId });
    return;
  }

  const wordTimestamps = await fetchWordTimestamps(polled.wordTimestampsUrl);

  writeResult({
    ok: true,
    taskId: submission.taskId,
    remoteAudioUrl: polled.remoteAudioUrl,
    srtUrl: polled.srtUrl,
    wordTimestamps, // real, provider-native word-level alignment — see fetchWordTimestamps()'s own header; null when with_transcript wasn't requested or fetching it failed
    voiceId,
  });
}

if (require.main === module) {
  main().catch((error) => {
    writeResult({ ok: false, code: 'AI33_WORKER_THREW', message: error && error.message ? error.message : String(error) });
  });
}

// Exported for direct, network-mocked unit testing of the pure submit/
// poll/download logic (test/ai33-voice-provider.test.js) — never imported
// by services/voice/ai33-voice-provider.js itself, which only ever spawns
// this file as a subprocess (see that file's own header for why).
module.exports = { submitTask, pollTask, downloadAudio, fetchWordTimestamps };

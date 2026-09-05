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
//   { ok:true, taskId, remoteAudioUrl, transcriptUrl, transcriptText, voiceId }
//   { ok:false, code, message }
//
// DOCUMENTED ASSUMPTION (per this milestone's own "do not invent
// undocumented API behaviour" instruction, made explicit rather than
// silently guessed): the milestone brief specifies POST /v3/text-to-speech
// and GET /v3/voices, and states completion is available "through webhook
// or the existing/common task polling mechanism" without naming the exact
// polling URL or its response shape. This worker polls
// `{baseUrl}/v3/tasks/{task_id}` (overridable via taskUrlTemplate/the
// EVOLINK_AI33_TASK_URL_TEMPLATE env var) and expects a JSON body shaped
// { status: 'pending'|'processing'|'done'|'failed', audio_url,
// transcript_url, transcript_text, error }. If the real AI33 API differs,
// only this one assumption needs correcting — everything else in this
// file (submission, bounded polling, download, provenance) is unaffected.

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
    lastStatus = parsed.status;
    if (parsed.status === 'done') {
      if (typeof parsed.audio_url !== 'string' || parsed.audio_url.length === 0) {
        return { ok: false, code: 'AI33_MALFORMED_RESPONSE', message: 'AI33 task completed but returned no audio_url' };
      }
      return { ok: true, remoteAudioUrl: parsed.audio_url, transcriptUrl: parsed.transcript_url || null, transcriptText: parsed.transcript_text || null };
    }
    if (parsed.status === 'failed') {
      return { ok: false, code: 'AI33_TASK_FAILED', message: parsed.error || 'AI33 task reported status: failed' };
    }
    if (parsed.status !== 'pending' && parsed.status !== 'processing') {
      return { ok: false, code: 'AI33_MALFORMED_RESPONSE', message: `AI33 task poll returned an unrecognized status: ${JSON.stringify(parsed.status)}` };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { ok: false, code: 'AI33_TASK_TIMEOUT', message: `AI33 task did not complete within ${timeoutMs}ms (last status: ${lastStatus})` };
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

  writeResult({
    ok: true,
    taskId: submission.taskId,
    remoteAudioUrl: polled.remoteAudioUrl,
    transcriptUrl: polled.transcriptUrl,
    transcriptText: polled.transcriptText,
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
module.exports = { submitTask, pollTask, downloadAudio };

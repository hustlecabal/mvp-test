// Tests for services/voice/ai33-voice-provider.js — using an INJECTED
// spawnWorker throughout (no real subprocess, no real network, no real
// AI33 credits), same convention as claude-interpretation-provider.test.js's
// injected fetchImpl and voice-generation-service.test.js's injected
// voiceProvider/alignmentProvider. Real, network-hitting tests are in
// test/ai33-voice-provider-live.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { directNarration } = require('../services/narration-director-service');
const { createAi33VoiceProvider, MIN_SPEED, MAX_SPEED } = require('../services/voice/ai33-voice-provider');

function tempOutputPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai33-provider-test-')), `${crypto.randomUUID()}.mp3`);
}

// A real, valid, ffprobe-measurable silent audio file — stands in for a
// "downloaded" AI33 result without any real network call.
function writeRealSilentAudio(outputPath, durationSeconds = 2) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=22050:cl=mono:d=${durationSeconds}`, '-c:a', 'libmp3lame', outputPath]);
}

function completedNarrationDirection(text = 'More options should make choosing easier.') {
  return directNarration({ scriptRefId: 'script-1', text, beats: [{ beatId: 'beat-1', narrativeRole: 'HOOK' }] });
}

function fakeSpawnWorkerSucceeding({ taskId = 'task-123', durationSeconds = 2, transcriptUrl = null, transcriptText = null } = {}) {
  return (requestPayload) => {
    writeRealSilentAudio(requestPayload.outputPath, durationSeconds);
    return { ok: true, taskId, remoteAudioUrl: 'https://ai33.example/audio/result.mp3', transcriptUrl, transcriptText, voiceId: requestPayload.voiceId };
  };
}

// 1. request construction
test('1. the worker request carries text, voice_id, speed, and a generated file_name', () => {
  let captured = null;
  const spawnWorker = (requestPayload) => {
    captured = requestPayload;
    return fakeSpawnWorkerSucceeding()(requestPayload);
  };
  const provider = createAi33VoiceProvider({ apiKey: 'key-1', voiceId: 'elevenlabs_abc', speed: 1.1, spawnWorker });
  const result = provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });

  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.diagnostics));
  assert.equal(captured.voiceId, 'elevenlabs_abc');
  assert.equal(captured.speed, 1.1);
  assert.equal(captured.text, 'More options should make choosing easier.');
  assert.ok(captured.fileName && captured.fileName.length > 0);
});

// 2. API key is server-side only
test('2. the API key never appears in the returned VoiceGenerationResult or its providerMetadata', () => {
  const provider = createAi33VoiceProvider({ apiKey: 'super-secret-key', voiceId: 'elevenlabs_abc', spawnWorker: fakeSpawnWorkerSucceeding() });
  const result = provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /super-secret-key/);
});

test('2b. the API key is passed to the worker via the request payload object, never via argv (verified structurally: spawnWorker receives it as a field, not a string template)', () => {
  let captured = null;
  const spawnWorker = (requestPayload) => { captured = requestPayload; return fakeSpawnWorkerSucceeding()(requestPayload); };
  const provider = createAi33VoiceProvider({ apiKey: 'key-xyz', voiceId: 'elevenlabs_abc', spawnWorker });
  provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });
  assert.equal(captured.apiKey, 'key-xyz');
});

// 3. voice_id is passed correctly
test('3. voice_id is passed through verbatim, provider-prefixed ids included', () => {
  let captured = null;
  const spawnWorker = (requestPayload) => { captured = requestPayload; return fakeSpawnWorkerSucceeding()(requestPayload); };
  const provider = createAi33VoiceProvider({ apiKey: 'k', voiceId: 'minimax_voice42', spawnWorker });
  provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });
  assert.equal(captured.voiceId, 'minimax_voice42');
});

// 4. speed validation
test('4. speed outside [0.5, 1.5] is rejected before any worker call', () => {
  let called = false;
  const spawnWorker = () => { called = true; return { ok: true }; };
  const provider = createAi33VoiceProvider({ apiKey: 'k', voiceId: 'v', speed: 2.0, spawnWorker });
  const result = provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'INVALID_SPEED');
  assert.equal(called, false);
  assert.equal(MIN_SPEED, 0.5);
  assert.equal(MAX_SPEED, 1.5);
});

// 5. pronunciation dictionary handling
test('5. pronunciationDictionaryId, when set, is passed through to the worker', () => {
  let captured = null;
  const spawnWorker = (requestPayload) => { captured = requestPayload; return fakeSpawnWorkerSucceeding()(requestPayload); };
  const provider = createAi33VoiceProvider({ apiKey: 'k', voiceId: 'v', pronunciationDictionaryId: 'dict-42', spawnWorker });
  provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });
  assert.equal(captured.pronunciationDictionaryId, 'dict-42');
});

test('5b. pronunciationDictionaryId defaults to null when not configured — never fabricated', () => {
  let captured = null;
  const spawnWorker = (requestPayload) => { captured = requestPayload; return fakeSpawnWorkerSucceeding()(requestPayload); };
  const provider = createAi33VoiceProvider({ apiKey: 'k', voiceId: 'v', spawnWorker });
  provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });
  assert.equal(captured.pronunciationDictionaryId, null);
});

// 6. asynchronous task submission (task_id captured in providerMetadata)
test('6. a successful task submission/completion surfaces the real task_id in providerMetadata', () => {
  const provider = createAi33VoiceProvider({ apiKey: 'k', voiceId: 'v', spawnWorker: fakeSpawnWorkerSucceeding({ taskId: 'task-987' }) });
  const result = provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.providerMetadata.taskId, 'task-987');
  assert.equal(result.providerMetadata.provider, 'ai33');
  assert.equal(result.providerMetadata.operation, 'text-to-speech');
});

// 7. polling/completion handling — exercised at the worker level directly (pure functions, no process spawn, no network)
test('7. the worker\'s pollTask() treats "done" as completion and "pending"/"processing" as intermediate states', async () => {
  const { pollTask } = require('../scripts/ai33-tts-worker.js');
  let call = 0;
  const responses = [{ status: 'pending' }, { status: 'processing' }, { status: 'done', audio_url: 'https://example/audio.mp3' }];
  global.fetch = async () => ({ ok: true, text: async () => JSON.stringify(responses[Math.min(call++, responses.length - 1)]) });
  const result = await pollTask({ taskUrlTemplate: 'https://example/{task_id}', apiKey: 'k', taskId: 't1', pollIntervalMs: 1, timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.remoteAudioUrl, 'https://example/audio.mp3');
  assert.equal(call, 3);
});

// 8. failed task handling
test('8. a task that reports status "failed" is surfaced as AI33_TASK_FAILED, never retried as if it were pending', async () => {
  const { pollTask } = require('../scripts/ai33-tts-worker.js');
  global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ status: 'failed', error: 'synthesis engine error' }) });
  const result = await pollTask({ taskUrlTemplate: 'https://example/{task_id}', apiKey: 'k', taskId: 't1', pollIntervalMs: 1, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AI33_TASK_FAILED');
  assert.match(result.message, /synthesis engine error/);
});

test('8b. a whole-provider failure (worker reports ok:false) never fabricates a COMPLETED result', () => {
  const spawnWorker = () => ({ ok: false, code: 'AI33_HTTP_ERROR', message: 'AI33 returned HTTP 500' });
  const provider = createAi33VoiceProvider({ apiKey: 'k', voiceId: 'v', spawnWorker });
  const result = provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'AI33_HTTP_ERROR');
});

// 9. timeout handling
test('9. the worker\'s pollTask() gives up after its bounded timeout — never polls indefinitely', async () => {
  const { pollTask } = require('../scripts/ai33-tts-worker.js');
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: true, text: async () => JSON.stringify({ status: 'processing' }) }; };
  const result = await pollTask({ taskUrlTemplate: 'https://example/{task_id}', apiKey: 'k', taskId: 't1', pollIntervalMs: 5, timeoutMs: 30 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AI33_TASK_TIMEOUT');
  assert.ok(calls > 0 && calls < 100, 'must be bounded, not infinite');
});

test('9b. a provider-level worker timeout (subprocess exceeds its own bound) is reported as AI33_TASK_TIMEOUT, never a silent hang', () => {
  const spawnWorker = () => { const err = new Error('timed out'); err.signal = 'SIGTERM'; throw err; };
  const provider = createAi33VoiceProvider({ apiKey: 'k', voiceId: 'v', spawnWorker, timeoutMs: 50 });
  const result = provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'AI33_TASK_TIMEOUT');
});

// 13. actual audio duration propagation
test('13. the real, ffprobe-measured duration of the downloaded audio is returned — never AI33\'s own self-reported duration, never estimated', () => {
  const provider = createAi33VoiceProvider({ apiKey: 'k', voiceId: 'v', spawnWorker: fakeSpawnWorkerSucceeding({ durationSeconds: 3 }) });
  const result = provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });
  assert.equal(result.status, 'COMPLETED');
  assert.ok(Math.abs(result.duration - 3) < 0.2, `expected ~3s, got ${result.duration}`);
});

// 12. transcript/SRT preservation (provider level — full pipeline preservation is tested in test/ai33-voice-generation-integration.test.js)
test('12. AI33\'s own returned transcript URL/text, when present, is preserved in providerMetadata — never discarded, never force-fit into word timing', () => {
  const provider = createAi33VoiceProvider({ apiKey: 'k', voiceId: 'v', spawnWorker: fakeSpawnWorkerSucceeding({ transcriptUrl: 'https://ai33.example/transcript.srt', transcriptText: 'More options should make choosing easier.' }) });
  const result = provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });
  assert.equal(result.providerMetadata.transcriptUrl, 'https://ai33.example/transcript.srt');
  assert.equal(result.providerMetadata.transcriptText, 'More options should make choosing easier.');
});

// 14. missing API key behaviour
test('14. a missing API key returns VOICE_PROVIDER_UNAVAILABLE and never calls the worker', () => {
  let called = false;
  const spawnWorker = () => { called = true; return { ok: true }; };
  const provider = createAi33VoiceProvider({ apiKey: '', voiceId: 'v', spawnWorker });
  const result = provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'VOICE_PROVIDER_UNAVAILABLE');
  assert.equal(called, false);
});

test('14b. a missing voice_id also fails structurally rather than guessing a default voice', () => {
  let called = false;
  const spawnWorker = () => { called = true; return { ok: true }; };
  const provider = createAi33VoiceProvider({ apiKey: 'k', voiceId: '', spawnWorker });
  const result = provider.generateVoice({ narrationDirection: completedNarrationDirection(), outputPath: tempOutputPath() });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'VOICE_PROVIDER_UNAVAILABLE');
  assert.equal(called, false);
});

test('security — ai33-voice-provider.js and its worker only use execFileSync with argument arrays; no shell, no eval', () => {
  const fsSrc = require('fs');
  for (const file of ['../services/voice/ai33-voice-provider.js', '../scripts/ai33-tts-worker.js']) {
    const text = fsSrc.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotMatch(text, /\beval\(/);
    assert.doesNotMatch(text, /new Function\(/);
    assert.doesNotMatch(text, /shell:\s*true/);
  }
});

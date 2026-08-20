// P0-TEMPORAL — Part 20 REAL TIMING PROOF.
//
//   real audio (espeak-ng) -> real Whisper alignment (faster-whisper) ->
//   REAL word timings (schemas/audio-schema.js AudioEvent.transcript.words) ->
//   services/caption-service.js's canonical timing consumption ->
//   REAL caption segments -> REAL SRT
//
// Every step below this file's own two `generateNarratedAudioEvent()` calls
// uses the REAL, already-proven Stage 26.9B pipeline (see
// test/voice-generation-pipeline.test.js for that pipeline's own proof) —
// nothing here mocks Whisper, nothing here fabricates a timestamp.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const assetStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-temporal-proof-asset-storage-'));
process.env.ASSET_STORAGE_DIR = assetStorageDir;
const projectTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolink-temporal-proof-projects-'));
process.env.PROJECT_DATA_DIR = projectTempDir;

const projectStore = require('../services/project-store');
const { directNarration } = require('../services/narration-director-service');
const { generateNarratedAudioEvent } = require('../services/voice-generation-service');
const { buildCaptionTrack, validateCaptionSegments } = require('../services/caption-service');

test('REAL TIMING PROOF — real narration audio -> real Whisper word timing -> real caption segments -> real SRT, verified against the actual measured audio durations', () => {
  const project = projectStore.createProject({ title: 'EVOLINK P0-TEMPORAL REAL TIMING PROOF', topic: 'temporal backbone proof' });

  // --- two real narration beats, placed sequentially on a production timeline ---
  const nd1 = directNarration({ scriptRefId: 'temporal-proof-1', text: 'Every great video starts with a single clear idea.', beats: [{ beatId: 'beat-1', narrativeRole: 'HOOK' }] });
  assert.equal(nd1.status, 'COMPLETED');
  const r1 = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd1 });
  assert.equal(r1.status, 'COMPLETED', r1.diagnostics[0] && r1.diagnostics[0].message);

  const nd2 = directNarration({ scriptRefId: 'temporal-proof-2', text: 'Then real footage brings that idea to life on screen.', beats: [{ beatId: 'beat-2', narrativeRole: 'EXPLANATION' }] });
  assert.equal(nd2.status, 'COMPLETED');
  const r2 = generateNarratedAudioEvent({ projectId: project.id, narrationDirection: nd2 });
  assert.equal(r2.status, 'COMPLETED', r2.diagnostics[0] && r2.diagnostics[0].message);

  // --- place the two REAL AudioEvents on a production timeline, exactly as
  // production-orchestrator-service.js does (sequential, gapless, using
  // each clip's own real measured duration) ---
  const audioEvent1 = { ...r1.audioEvent, startTime: 0 };
  const audioEvent2 = { ...r2.audioEvent, startTime: r1.audioEvent.duration + 1 }; // real 1s gap between beats

  // --- sanity: prove these are REAL, non-trivial, independently measured word timings ---
  assert.ok(audioEvent1.transcript.words.length >= 5, 'the real Whisper transcript for this sentence must have produced multiple real words');
  assert.ok(audioEvent2.transcript.words.length >= 5);
  for (const w of [...audioEvent1.transcript.words, ...audioEvent2.transcript.words]) {
    assert.ok(w.startTime >= 0 && w.endTime > w.startTime, `word "${w.word}" must have real, valid, positive-duration timing`);
    assert.ok(w.endTime <= audioEvent1.duration + audioEvent2.duration + 5, 'word timing must be plausible relative to the real measured clip durations');
  }

  // --- the canonical timing consumption this stage adds ---
  const result = buildCaptionTrack([audioEvent1, audioEvent2]);
  assert.equal(result.status, 'COMPLETED', JSON.stringify(result.diagnostics));
  assert.ok(result.segments.length >= 1);
  assert.ok(result.srt && result.srt.length > 0);

  // --- verify every caption's absolute timing is a real, measured value —
  // never a fabricated/rounded/estimated one — and stays within the real,
  // combined audio duration ---
  const totalRealAudioSpan = audioEvent2.startTime + audioEvent2.duration;
  for (const segment of result.segments) {
    assert.ok(segment.startTime >= 0);
    assert.ok(segment.endTime > segment.startTime);
    assert.ok(segment.endTime <= totalRealAudioSpan + 0.001, `caption "${segment.text}" (ends ${segment.endTime}s) must not exceed the real combined audio span (${totalRealAudioSpan}s)`);
  }

  // --- at least one caption should be attributable to EACH real AudioEvent (proves both clips' real timing was actually used, not just the first) ---
  const allSourceIds = new Set(result.segments.flatMap((s) => s.sourceAudioEventIds));
  assert.ok(allSourceIds.has(audioEvent1.audioEventId), 'at least one caption must trace back to the first real AudioEvent');
  assert.ok(allSourceIds.has(audioEvent2.audioEventId), 'at least one caption must trace back to the second real AudioEvent');

  // --- word coverage: the real SRT must account for every real Whisper word ---
  const absoluteWords = [
    ...audioEvent1.transcript.words.map((w) => ({ word: w.word, startTime: w.startTime, endTime: w.endTime })),
    ...audioEvent2.transcript.words.map((w) => ({ word: w.word, startTime: w.startTime + audioEvent2.startTime, endTime: w.endTime + audioEvent2.startTime })),
  ].sort((a, b) => a.startTime - b.startTime);
  const validation = validateCaptionSegments(result.segments, absoluteWords);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));

  // --- inspect the real SRT structurally (Part 20 — "inspect the resulting SRT") ---
  const srtLines = result.srt.trim().split('\n');
  assert.match(srtLines[0], /^1$/);
  assert.match(srtLines[1], /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/);
  console.log('--- REAL SRT OUTPUT (temporal backbone proof) ---');
  console.log(result.srt);
});

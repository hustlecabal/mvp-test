// Tests for schemas/reference-video-schema.js — INT-1A, Part 2/22.
// Pure factory tests: defaults, partial-data safety, no invented data.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REFERENCE_VIDEO_STATUSES,
  PLATFORMS,
  TRANSCRIPT_SOURCES,
  ACQUISITION_DIAGNOSTIC_CODES,
  ACQUISITION_STAGES,
  ACQUISITION_STAGE_STATUSES,
  createReferenceVideoSource,
  createVideoTechnicalMetadata,
  createAudioTechnicalMetadata,
  createReferenceVideoMetadata,
  createTranscriptWord,
  createTranscriptSegment,
  createReferenceTranscript,
  createAcquisitionStageResult,
  createAcquisitionRecord,
  createReferenceVideoDiagnostic,
  createReferenceVideo,
} = require('../schemas/reference-video-schema');

test('1. createReferenceVideo defaults every field to null/[]/empty — nothing invented', () => {
  const rv = createReferenceVideo();
  assert.equal(typeof rv.id, 'string');
  assert.equal(rv.projectId, null);
  assert.equal(rv.videoAssetId, null);
  assert.equal(rv.audioAssetId, null);
  assert.equal(rv.transcript, null);
  assert.equal(rv.status, null);
  assert.deepEqual(rv.diagnostics, []);
  assert.equal(typeof rv.createdAt, 'string');
});

test('2. createReferenceVideoSource distinguishes SOURCE fields only — never media/metadata', () => {
  const source = createReferenceVideoSource({ originalUrl: 'https://youtu.be/abc', platform: 'YOUTUBE', externalId: 'abc' });
  assert.equal(source.originalUrl, 'https://youtu.be/abc');
  assert.equal(source.platform, 'YOUTUBE');
  assert.equal(source.channelId, null);
  assert.ok(!('duration' in source));
  assert.ok(!('title' in source));
});

test('3. video/audio technical metadata factories default to null, never a guessed value', () => {
  const v = createVideoTechnicalMetadata();
  const a = createAudioTechnicalMetadata();
  for (const key of Object.keys(v)) assert.equal(v[key], null);
  for (const key of Object.keys(a)) assert.equal(a[key], null);
});

test('4. createReferenceVideoMetadata separates publishedAt from retrievedAt', () => {
  const m = createReferenceVideoMetadata({ publishedAt: '2020-01-01T00:00:00Z', retrievedAt: '2026-08-16T00:00:00Z', viewCount: 100 });
  assert.notEqual(m.publishedAt, m.retrievedAt);
  assert.equal(m.viewCount, 100);
  assert.deepEqual(m.tags, []);
});

test('5. createReferenceTranscript separates words[] (word-level) from segments[] (cue-level) and requires no source by default', () => {
  const t = createReferenceTranscript({ source: 'LOCAL_WHISPER', words: [{ word: 'hi', startTime: 0, endTime: 0.3 }] });
  assert.equal(t.words.length, 1);
  assert.equal(t.words[0].word, 'hi');
  assert.deepEqual(t.segments, []);
  assert.equal(t.source, 'LOCAL_WHISPER');
});

test('6. createTranscriptWord / createTranscriptSegment default timing to null', () => {
  assert.deepEqual(createTranscriptWord(), { word: '', startTime: null, endTime: null });
  assert.deepEqual(createTranscriptSegment(), { text: '', startTime: null, endTime: null });
});

test('7. createAcquisitionRecord defaults to an empty stages[] and stamps requestedAt automatically', () => {
  const record = createAcquisitionRecord();
  assert.deepEqual(record.stages, []);
  assert.equal(typeof record.requestedAt, 'string');
  assert.equal(record.completedAt, null);
});

test('8. createAcquisitionStageResult only accepts a stage/status pair, never a provider-internal object', () => {
  const s = createAcquisitionStageResult({ stage: 'ACQUIRE_VIDEO', status: 'SUCCEEDED' });
  assert.deepEqual(Object.keys(s).sort(), ['completedAt', 'message', 'stage', 'status']);
});

test('9. createReferenceVideoDiagnostic mirrors the {code,message} shape every other diagnostic in this codebase uses, plus an optional stage', () => {
  const d = createReferenceVideoDiagnostic({ code: 'TRANSCRIPT_UNAVAILABLE', message: 'x', stage: 'ACQUIRE_TRANSCRIPT' });
  assert.deepEqual(Object.keys(d).sort(), ['code', 'message', 'stage']);
});

test('10. every documented enum is a non-empty array of unique string values', () => {
  for (const list of [REFERENCE_VIDEO_STATUSES, PLATFORMS, TRANSCRIPT_SOURCES, ACQUISITION_DIAGNOSTIC_CODES, ACQUISITION_STAGES, ACQUISITION_STAGE_STATUSES]) {
    assert.ok(Array.isArray(list) && list.length > 0);
    assert.equal(new Set(list).size, list.length);
    for (const v of list) assert.equal(typeof v, 'string');
  }
});

test('11. createReferenceVideo never mixes analytical conclusions into the record — no hook/pattern/score field exists anywhere in its shape', () => {
  const rv = createReferenceVideo({ metadata: {}, transcript: { source: 'PLATFORM_CAPTION' } });
  const json = JSON.stringify(rv).toLowerCase();
  for (const forbidden of ['hook', 'pattern', 'score', 'interpretation', 'recommendation', 'confidence']) {
    assert.doesNotMatch(json, new RegExp(forbidden), `ReferenceVideo must never carry a "${forbidden}" field — that belongs to a later intelligence stage`);
  }
});

test('12. partial overrides never wipe out sibling defaults (withDefaults discipline)', () => {
  const rv = createReferenceVideo({ status: 'PARTIAL' });
  assert.equal(rv.status, 'PARTIAL');
  assert.deepEqual(rv.source, createReferenceVideoSource());
  assert.deepEqual(rv.videoTechnical, createVideoTechnicalMetadata());
});

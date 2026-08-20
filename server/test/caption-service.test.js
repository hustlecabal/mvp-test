// Tests for schemas/caption-schema.js + services/caption-service.js —
// the TEMPORAL BACKBONE's one new layer. See caption-service.js's own
// header for the architecture: AudioEvent.transcript.words[] (already real,
// Whisper-measured — services/voice-generation-service.js) remains the
// canonical timing source; this file only adds a deterministic
// word -> caption-segment -> SRT transformation downstream of it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCaptionSegment, createCaptionTrackResult, CAPTION_TRACK_STATUSES, DEFAULT_CAPTION_SEGMENTATION_OPTIONS } = require('../schemas/caption-schema');
const { validateWordTiming, segmentWordsIntoCaptions, generateSRT, validateCaptionSegments, buildCaptionTrack, srtTimestamp } = require('../services/caption-service');

function narrationEvent(overrides = {}) {
  return {
    audioEventId: 'ae-1',
    type: 'NARRATION',
    status: 'READY',
    startTime: 0,
    duration: 10,
    sourceAssetId: 'asset-1',
    transcript: { text: '', words: [] },
    ...overrides,
  };
}

// --- 1. Schema tests ---------------------------------------------------

test('1a. createCaptionSegment() default shape', () => {
  const s = createCaptionSegment();
  assert.equal(s.index, null);
  assert.equal(s.text, '');
  assert.equal(s.startTime, null);
  assert.equal(s.endTime, null);
  assert.equal(s.wordCount, 0);
  assert.deepEqual(s.sourceAudioEventIds, []);
});

test('1b. createCaptionTrackResult() default shape and CAPTION_TRACK_STATUSES', () => {
  const r = createCaptionTrackResult();
  assert.equal(r.status, null);
  assert.deepEqual(r.segments, []);
  assert.equal(r.srt, null);
  assert.deepEqual(r.diagnostics, []);
  assert.ok(typeof r.createdAt === 'string');
  assert.deepEqual(CAPTION_TRACK_STATUSES, ['COMPLETED', 'PARTIAL', 'FAILED', 'EMPTY']);
});

test('1c. DEFAULT_CAPTION_SEGMENTATION_OPTIONS is a plain, documented, overridable object — never a hidden magic number', () => {
  assert.equal(typeof DEFAULT_CAPTION_SEGMENTATION_OPTIONS.maxCharsPerCaption, 'number');
  assert.equal(typeof DEFAULT_CAPTION_SEGMENTATION_OPTIONS.maxWordsPerCaption, 'number');
  assert.equal(typeof DEFAULT_CAPTION_SEGMENTATION_OPTIONS.silenceGapSeconds, 'number');
});

// --- 2. Timing invariant tests (Part 4) ---------------------------------

test('2a. valid, ordered, non-overlapping words pass validation untouched', () => {
  const words = [
    { word: 'a', startTime: 0, endTime: 0.5 },
    { word: 'b', startTime: 0.5, endTime: 1.0 },
  ];
  const { valid, validWords, diagnostics } = validateWordTiming(words);
  assert.equal(valid, true);
  assert.equal(diagnostics.length, 0);
  assert.deepEqual(validWords, words);
});

test('2b. negative startTime is rejected, never clamped to 0', () => {
  const { valid, validWords, diagnostics } = validateWordTiming([{ word: 'a', startTime: -1, endTime: 0.5 }]);
  assert.equal(valid, false);
  assert.equal(validWords.length, 0);
  assert.equal(diagnostics[0].code, 'NEGATIVE_START_TIME');
});

test('2c. endTime <= startTime is rejected (timestamp inversion)', () => {
  const { valid, diagnostics } = validateWordTiming([{ word: 'a', startTime: 1, endTime: 1 }]);
  assert.equal(valid, false);
  assert.equal(diagnostics[0].code, 'TIMESTAMP_INVERSION');
});

test('2d. non-finite/missing timestamps are rejected, never defaulted to a plausible-looking number', () => {
  const { diagnostics } = validateWordTiming([{ word: 'a', startTime: null, endTime: 1 }]);
  assert.equal(diagnostics[0].code, 'INVALID_WORD_TIMESTAMP');
  const { diagnostics: d2 } = validateWordTiming([{ word: 'a', startTime: 0, endTime: Infinity }]);
  assert.equal(d2[0].code, 'INVALID_WORD_TIMESTAMP');
});

test('2e. words that start before the previous word ended are rejected (sequence must be non-decreasing)', () => {
  const { diagnostics } = validateWordTiming([
    { word: 'a', startTime: 0, endTime: 1 },
    { word: 'b', startTime: 0.5, endTime: 1.5 },
  ]);
  assert.equal(diagnostics[0].code, 'WORD_ORDER_REVERSED');
});

test('2f. a word ending beyond the audio\'s own measured duration is flagged, never silently trusted', () => {
  const { diagnostics } = validateWordTiming([{ word: 'a', startTime: 0, endTime: 5 }], { clipDuration: 2 });
  assert.equal(diagnostics[0].code, 'WORD_EXCEEDS_AUDIO_DURATION');
});

test('2g. a word with empty/non-string text is rejected', () => {
  const { diagnostics } = validateWordTiming([{ word: '', startTime: 0, endTime: 1 }]);
  assert.equal(diagnostics[0].code, 'INVALID_WORD_TEXT');
});

test('2h. one bad word does not discard the other, valid words', () => {
  const { validWords, diagnostics } = validateWordTiming([
    { word: 'good', startTime: 0, endTime: 0.5 },
    { word: 'bad', startTime: -1, endTime: 0.9 },
    { word: 'fine', startTime: 1, endTime: 1.5 },
  ]);
  assert.equal(validWords.length, 2);
  assert.equal(diagnostics.length, 1);
});

// --- 3. "Whisper parsing" compatibility — the exact shape voice-generation-service.js produces ---

test('3. buildCaptionTrack consumes the EXACT AudioEvent/Transcript shape services/voice-generation-service.js produces', () => {
  // Mirrors createAudioEvent({ transcript: createTranscript({ words: [...] }) }) verbatim.
  const event = narrationEvent({
    transcript: {
      text: 'hi there',
      words: [
        { word: 'hi', startTime: 0, endTime: 0.4 },
        { word: 'there', startTime: 0.4, endTime: 0.9 },
      ],
    },
  });
  const result = buildCaptionTrack([event]);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, 'hi there');
});

// --- 4. Caption segmentation tests (Part 6) ------------------------------

function words(pairs) {
  // pairs: [[word, start, end], ...]
  return pairs.map(([word, startTime, endTime]) => ({ word, startTime, endTime }));
}

test('4a. splits on a strong sentence terminator', () => {
  const w = words([
    ['One.', 0, 0.5],
    ['Two.', 0.5, 1.0],
  ]);
  const segments = segmentWordsIntoCaptions(w);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, 'One.');
  assert.equal(segments[1].text, 'Two.');
});

test('4b. splits on a natural silence gap even with no punctuation', () => {
  const w = words([
    ['first', 0, 0.5],
    ['second', 2.0, 2.5], // 1.5s gap >= default 0.5s threshold
  ]);
  const segments = segmentWordsIntoCaptions(w);
  assert.equal(segments.length, 2);
});

test('4c. does not split mid-sentence for a short, normal inter-word gap', () => {
  const w = words([
    ['a', 0, 0.3],
    ['b', 0.32, 0.6],
    ['c.', 0.62, 0.9],
  ]);
  const segments = segmentWordsIntoCaptions(w);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, 'a b c.');
});

test('4d. respects maxWordsPerCaption even with no punctuation or silence', () => {
  const w = words(Array.from({ length: 20 }, (_, i) => [`w${i}`, i * 0.2, i * 0.2 + 0.15]));
  const segments = segmentWordsIntoCaptions(w, { maxWordsPerCaption: 5, maxCharsPerCaption: 999 });
  assert.ok(segments.every((s) => s.wordCount <= 5));
  assert.equal(segments.reduce((sum, s) => sum + s.wordCount, 0), 20);
});

test('4e. respects maxCharsPerCaption', () => {
  const w = words([
    ['abcdefghij', 0, 0.5], // 10 chars
    ['klmnopqrst', 0.5, 1.0], // + 1 space + 10 = 21
    ['uvwxyzabcd', 1.0, 1.5], // + 1 space + 10 = 32 > 25 -> must split before this word
  ]);
  const segments = segmentWordsIntoCaptions(w, { maxCharsPerCaption: 25, maxWordsPerCaption: 999 });
  assert.ok(segments.every((s) => s.text.length <= 25));
});

test('4f. never produces an empty segment', () => {
  const segments = segmentWordsIntoCaptions([]);
  assert.deepEqual(segments, []);
});

test('4g. sequential 1-based index numbering, no gaps or duplicates', () => {
  const w = words([
    ['One.', 0, 0.5],
    ['Two.', 0.5, 1.0],
    ['Three.', 1.0, 1.5],
  ]);
  const segments = segmentWordsIntoCaptions(w);
  assert.deepEqual(segments.map((s) => s.index), [1, 2, 3]);
});

// --- 5. SRT serialization tests (Part 7) --------------------------------

test('5a. srtTimestamp formats hours/minutes/seconds/milliseconds correctly', () => {
  assert.equal(srtTimestamp(0), '00:00:00,000');
  assert.equal(srtTimestamp(2.1), '00:00:02,100');
  assert.equal(srtTimestamp(65.005), '00:01:05,005');
  assert.equal(srtTimestamp(3661.999), '01:01:01,999');
});

test('5b. generateSRT produces a valid, deterministically ordered SRT block', () => {
  const segments = [createCaptionSegment({ index: 1, text: 'The first caption segment.', startTime: 0, endTime: 2.1 }), createCaptionSegment({ index: 2, text: 'The second caption segment.', startTime: 2.1, endTime: 4.7 })];
  const srt = generateSRT(segments);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:02,100\nThe first caption segment.\n\n2\n00:00:02,100 --> 00:00:04,700\nThe second caption segment.\n');
});

test('5c. generateSRT skips empty-text captions rather than emitting a blank entry', () => {
  const segments = [createCaptionSegment({ index: 1, text: '', startTime: 0, endTime: 1 }), createCaptionSegment({ index: 2, text: 'real', startTime: 1, endTime: 2 })];
  const srt = generateSRT(segments);
  assert.equal(srt.includes('\n\n\n'), false);
  assert.ok(srt.startsWith('1\n')); // renumbered — never a gap
  assert.ok(srt.includes('real'));
});

test('5d. generateSRT skips negative/inverted timing rather than emitting an invalid entry', () => {
  const segments = [createCaptionSegment({ index: 1, text: 'bad', startTime: -1, endTime: 1 }), createCaptionSegment({ index: 2, text: 'also bad', startTime: 2, endTime: 1 })];
  const srt = generateSRT(segments);
  assert.equal(srt, '');
});

test('5e. generateSRT of zero segments returns an empty string', () => {
  assert.equal(generateSRT([]), '');
});

// --- 6. Provenance tests (Part 15) ---------------------------------------

test('6a. every CaptionSegment records the AudioEvent id(s) its words came from', () => {
  const events = [
    narrationEvent({ audioEventId: 'ae-a', startTime: 0, duration: 2, transcript: { words: words([['first.', 0, 1]]) } }),
    narrationEvent({ audioEventId: 'ae-b', startTime: 5, duration: 2, transcript: { words: words([['second.', 0, 1]]) } }),
  ];
  const result = buildCaptionTrack(events);
  assert.equal(result.segments.length, 2);
  assert.deepEqual(result.segments[0].sourceAudioEventIds, ['ae-a']);
  assert.deepEqual(result.segments[1].sourceAudioEventIds, ['ae-b']);
});

test('6b. a caption spanning words from two AudioEvents records both source ids (no silence/punctuation break between them)', () => {
  const events = [
    narrationEvent({ audioEventId: 'ae-a', startTime: 0, duration: 2, transcript: { words: words([['no', 0, 0.3], ['pause', 0.3, 0.6]]) } }),
    narrationEvent({ audioEventId: 'ae-b', startTime: 0.65, duration: 2, transcript: { words: words([['here', 0, 0.3]]) } }),
  ];
  const result = buildCaptionTrack(events);
  assert.equal(result.segments.length, 1);
  assert.deepEqual(result.segments[0].sourceAudioEventIds.sort(), ['ae-a', 'ae-b']);
});

// --- 7. Determinism tests (Part 16) ---------------------------------------

test('7. identical input produces byte-identical SRT and structurally identical segments across repeated calls', () => {
  const events = [narrationEvent({ transcript: { words: words([['Every', 0, 0.3], ['great', 0.3, 0.6], ['video.', 0.6, 1.0]]) } })];
  const r1 = buildCaptionTrack(events);
  const r2 = buildCaptionTrack(events);
  assert.equal(r1.srt, r2.srt);
  assert.deepEqual(r1.segments, r2.segments);
});

// --- 8. Idempotency tests (Part 17) ----------------------------------------

test('8. buildCaptionTrack never mutates its input audioEvents', () => {
  const events = [narrationEvent({ transcript: { words: words([['hello.', 0, 0.5]]) } })];
  const before = JSON.parse(JSON.stringify(events));
  buildCaptionTrack(events);
  buildCaptionTrack(events);
  assert.deepEqual(events, before);
});

// --- 9. Failure-path tests (Part 18) ----------------------------------------

test('9a. no audioEvents at all -> EMPTY, not FAILED', () => {
  const result = buildCaptionTrack([]);
  assert.equal(result.status, 'EMPTY');
  assert.deepEqual(result.segments, []);
  assert.equal(result.srt, null);
});

test('9b. only non-NARRATION AudioEvents -> EMPTY', () => {
  const result = buildCaptionTrack([{ audioEventId: 'm', type: 'MUSIC', startTime: 0, duration: 5 }]);
  assert.equal(result.status, 'EMPTY');
});

test('9c. a NARRATION AudioEvent with an empty transcript.words array is excluded, not fabricated', () => {
  const result = buildCaptionTrack([narrationEvent({ transcript: { text: 'x', words: [] } })]);
  assert.equal(result.status, 'EMPTY');
});

test('9d. a NARRATION AudioEvent with no valid startTime cannot be placed on the timeline and is excluded with a diagnostic', () => {
  const result = buildCaptionTrack([narrationEvent({ startTime: null, transcript: { words: words([['hi', 0, 0.5]]) } })]);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.diagnostics[0].code, 'MISSING_TIMELINE_OFFSET');
});

test('9e. malformed word timing inside an otherwise-good AudioEvent is excluded, never silently repaired', () => {
  const result = buildCaptionTrack([narrationEvent({ transcript: { words: [{ word: 'bad', startTime: -5, endTime: 1 }] } })]);
  assert.equal(result.status, 'FAILED');
  assert.ok(result.diagnostics.some((d) => d.code === 'NEGATIVE_START_TIME'));
});

test('9f. one bad AudioEvent does not block captions from a good one', () => {
  const events = [narrationEvent({ audioEventId: 'bad', startTime: null, transcript: { words: words([['x', 0, 0.5]]) } }), narrationEvent({ audioEventId: 'good', startTime: 0, transcript: { words: words([['hello.', 0, 0.5]]) } })];
  const result = buildCaptionTrack(events);
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, 'hello.');
});

test('9g. overlapping words (impossible timestamps) across two AudioEvents are still honestly ordered/validated after the absolute-time shift', () => {
  // ae-b's words, shifted by its own startTime, land BEFORE ae-a's words end — a genuine overlap in the merged absolute stream.
  const events = [
    narrationEvent({ audioEventId: 'ae-a', startTime: 0, transcript: { words: words([['long', 0, 3]]) } }),
    narrationEvent({ audioEventId: 'ae-b', startTime: 1, transcript: { words: words([['overlap', 0, 0.5]]) } }), // absolute 1.0-1.5, inside ae-a's 0-3 window
  ];
  const result = buildCaptionTrack(events);
  // Both words are individually valid; the merge is sorted by absolute startTime — this is a real,
  // honestly-reported overlap between two narration tracks, not a crash or a silently-dropped word.
  assert.equal(result.segments.reduce((n, s) => n + s.wordCount, 0), 2);
});

// --- Validation function tests (Part 8) -------------------------------------

test('validateCaptionSegments: valid, ordered segments matching their source words pass', () => {
  const w = words([['One.', 0, 0.5], ['Two.', 0.5, 1.0]]);
  const segments = segmentWordsIntoCaptions(w);
  const { valid, diagnostics } = validateCaptionSegments(segments, w);
  assert.equal(valid, true);
  assert.equal(diagnostics.length, 0);
});

test('validateCaptionSegments: detects word coverage mismatch (a dropped word)', () => {
  const w = words([['One.', 0, 0.5], ['Two.', 0.5, 1.0]]);
  const segments = [createCaptionSegment({ index: 1, text: 'One.', startTime: 0, endTime: 0.5, wordCount: 1 })]; // "Two." silently missing
  const { valid, diagnostics } = validateCaptionSegments(segments, w);
  assert.equal(valid, false);
  assert.ok(diagnostics.some((d) => d.code === 'WORD_COVERAGE_MISMATCH' || d.code === 'WORD_COUNT_MISMATCH'));
});

test('validateCaptionSegments: detects overlapping segment timing', () => {
  const segments = [createCaptionSegment({ index: 1, text: 'a', startTime: 0, endTime: 2, wordCount: 1 }), createCaptionSegment({ index: 2, text: 'b', startTime: 1, endTime: 3, wordCount: 1 })];
  const { valid, diagnostics } = validateCaptionSegments(segments, [{ word: 'a' }, { word: 'b' }]);
  assert.equal(valid, false);
  assert.ok(diagnostics.some((d) => d.code === 'CAPTION_OVERLAP'));
});

// --- 10. Visual-consumer compatibility (Parts 9-13) -------------------------
//
// These prove that the SAME canonical word/caption timing this file
// produces can be mapped onto the EXISTING options shapes
// whiteboard-executor.js / kinetic-typography-executor.js / motion-graphic-
// executor.js already accept (drawStartOffset/drawDuration,
// startOffset/endOffset) — WITHOUT modifying any of those executors. A
// future caller is free to wire this in; this stage only proves the shapes
// are compatible, per this stage's own Part 9 instruction not to rewrite
// every visual treatment.

test('10a. word timing can be mapped to whiteboard-executor.js\'s element {drawStartOffset, drawDuration} shape', () => {
  const whiteboardExecutor = require('../services/material-executors/whiteboard-executor');
  const w = words([['draw', 0, 0.5], ['this.', 0.5, 1.2]]);
  const beatStart = w[0].startTime;
  const elements = w.map((word, i) => ({
    elementId: `wb-word-${i}`,
    kind: 'TEXT',
    content: word.word,
    drawStartOffset: word.startTime - beatStart,
    drawDuration: word.endTime - word.startTime,
  }));
  const result = whiteboardExecutor.execute({ beat: { id: 'b1', duration: 1.2 }, selectedMaterial: { candidate: 'm1' }, options: { duration: 1.2, elements } });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.renderSpec.drawingOrder.length, 2);
});

test('10b. phrase/word timing can drive kinetic-typography-executor.js purely via its existing text/duration/sequencing options — no transcription logic added to the executor', () => {
  const kineticExecutor = require('../services/material-executors/kinetic-typography-executor');
  const w = words([['This', 0, 0.3], ['is', 0.3, 0.5], ['kinetic.', 0.5, 1.0]]);
  const text = w.map((word) => word.word).join(' ');
  const duration = w[w.length - 1].endTime - w[0].startTime;
  const result = kineticExecutor.execute({ beat: { id: 'b1', duration }, selectedMaterial: { candidate: 'm1' }, options: { text, duration, sequencing: 'WORD_BY_WORD' } });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.renderSpec.units.length, w.length);
});

test('10c. beat/phrase timing can be mapped to motion-graphic-executor.js\'s element {sequence:{startOffset,endOffset}} shape', () => {
  const motionExecutor = require('../services/material-executors/motion-graphic-executor');
  const segments = segmentWordsIntoCaptions(words([['One.', 0, 0.5], ['Two.', 0.5, 1.0]]));
  const beatStart = segments[0].startTime;
  const totalDuration = segments[segments.length - 1].endTime - beatStart;
  const elements = segments.map((s, i) => ({ elementId: `mg-caption-${i}`, kind: 'TEXT', sequence: { startOffset: s.startTime - beatStart, endOffset: s.endTime - beatStart }, props: { text: s.text } }));
  const result = motionExecutor.execute({ beat: { id: 'b1', duration: totalDuration }, selectedMaterial: { candidate: 'm1' }, options: { duration: totalDuration, elements } });
  assert.equal(result.status, 'COMPLETED');
});

test('10d. caption segment timing never exceeds the beat/production duration it is meant to fit within (sanity bound for any visual consumer)', () => {
  const events = [narrationEvent({ startTime: 0, duration: 3, transcript: { words: words([['fits.', 0, 2.5]]) } })];
  const result = buildCaptionTrack(events);
  assert.ok(result.segments[0].endTime <= 3);
});

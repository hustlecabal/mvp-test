// Tests for services/reference-video/measurement-math.js — pure arithmetic,
// no FFmpeg, no I/O. Every test asserts an EXACT expected number computed
// by hand against a known input, never merely "a field exists" (Part 21's
// explicit requirement).

const test = require('node:test');
const assert = require('node:assert/strict');
const math = require('../services/reference-video/measurement-math');

test('1. computeDistribution on an empty array returns an all-null shape with count 0', () => {
  assert.deepEqual(math.computeDistribution([]), { count: 0, mean: null, median: null, min: null, max: null, p25: null, p75: null, p90: null });
});

test('2. computeDistribution on [1,2,3,4,5,6,7,8,9,10] matches hand-computed statistics', () => {
  const d = math.computeDistribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(d.count, 10);
  assert.equal(d.mean, 5.5);
  assert.equal(d.median, 5.5);
  assert.equal(d.min, 1);
  assert.equal(d.max, 10);
  assert.equal(d.p25, 3); // nearest-rank: ceil(0.25*10)=3 -> values[2]=3
  assert.equal(d.p75, 8); // ceil(0.75*10)=8 -> values[7]=8
  assert.equal(d.p90, 9); // ceil(0.90*10)=9 -> values[8]=9
});

test('3. computeDistribution ignores non-finite/non-number entries', () => {
  const d = math.computeDistribution([1, NaN, 2, Infinity, 3, 'x', null]);
  assert.equal(d.count, 3);
  assert.equal(d.mean, 2);
});

test('4. buildShotsFromCutTimes with zero cuts returns exactly one shot spanning the whole video', () => {
  const shots = math.buildShotsFromCutTimes([], 10);
  assert.deepEqual(shots, [{ index: 0, startTime: 0, endTime: 10, duration: 10 }]);
});

test('5. buildShotsFromCutTimes with two cuts returns three contiguous shots covering the entire duration exactly', () => {
  const shots = math.buildShotsFromCutTimes([3, 7], 10);
  assert.deepEqual(shots, [
    { index: 0, startTime: 0, endTime: 3, duration: 3 },
    { index: 1, startTime: 3, endTime: 7, duration: 4 },
    { index: 2, startTime: 7, endTime: 10, duration: 3 },
  ]);
});

test('6. buildShotsFromCutTimes deduplicates and drops cuts outside (0, duration)', () => {
  const shots = math.buildShotsFromCutTimes([5, 5, 0, 10, -1, 20], 10);
  assert.deepEqual(shots, [
    { index: 0, startTime: 0, endTime: 5, duration: 5 },
    { index: 1, startTime: 5, endTime: 10, duration: 5 },
  ]);
});

test('7. buildShotsFromCutTimes returns [] for an invalid duration', () => {
  assert.deepEqual(math.buildShotsFromCutTimes([1, 2], null), []);
  assert.deepEqual(math.buildShotsFromCutTimes([1, 2], 0), []);
});

test('8. computeShotRhythm on 6 one-shot-per-10s shots over 60s computes shotsPerMinute=6 exactly', () => {
  const shots = [0, 10, 20, 30, 40, 50].map((t, i) => ({ index: i, startTime: t, endTime: t + 10, duration: 10 }));
  const rhythm = math.computeShotRhythm(shots, 60);
  assert.equal(rhythm.shotCount, 6);
  assert.equal(rhythm.shotsPerMinute, 6);
  assert.equal(rhythm.first30sShotCount, 3); // shots starting at 0,10,20
  assert.equal(rhythm.first60sShotCount, 6);
  assert.equal(rhythm.quarterShotCounts.length, 4);
  assert.deepEqual(rhythm.quarterShotCounts.map((q) => q.shotCount), [2, 1, 2, 1]); // quarters are [0,15) [15,30) [30,45) [45,60); shots start at 0,10,20,30,40,50
});

test('9. computeWordTimingMeasurements computes exact per-word duration and inter-word gap; last word has null gap', () => {
  const words = [
    { word: 'a', startTime: 0, endTime: 0.3 },
    { word: 'b', startTime: 0.5, endTime: 0.8 },
  ];
  const result = math.computeWordTimingMeasurements(words);
  assert.deepEqual(result, [
    { index: 0, word: 'a', startTime: 0, endTime: 0.3, duration: 0.3, gapBeforeNextWord: 0.2 },
    { index: 1, word: 'b', startTime: 0.5, endTime: 0.8, duration: 0.3, gapBeforeNextWord: null },
  ]);
});

test('10. computePauses only counts gaps at or above the threshold, and reports the exact gap as the pause duration', () => {
  const wordTimings = [
    { index: 0, gapBeforeNextWord: 0.49, endTime: 1 },
    { index: 1, gapBeforeNextWord: 0.5, endTime: 2 },
    { index: 2, gapBeforeNextWord: 1.2, endTime: 3 },
  ];
  const { pauses } = math.computePauses(wordTimings, 0.5);
  assert.deepEqual(pauses, [
    { afterWordIndex: 1, startTime: 2, duration: 0.5 },
    { afterWordIndex: 2, startTime: 3, duration: 1.2 },
  ]);
});

test('11. countSentencesFromText counts terminal punctuation-delimited segments, ignoring empty ones', () => {
  assert.equal(math.countSentencesFromText('One. Two! Three?'), 3);
  assert.equal(math.countSentencesFromText('No terminal punctuation at all'), 1);
  assert.equal(math.countSentencesFromText(''), 0);
  assert.equal(math.countSentencesFromText('Trailing punctuation.'), 1);
});

test('12. computeSentencesFromWords groups words by terminal punctuation on the word token itself', () => {
  const words = [
    { word: 'Hello', startTime: 0, endTime: 0.3 },
    { word: 'world.', startTime: 0.3, endTime: 0.6 },
    { word: 'Bye', startTime: 1, endTime: 1.2 },
  ];
  const sentences = math.computeSentencesFromWords(words);
  assert.equal(sentences.length, 2);
  assert.equal(sentences[0].text, 'Hello world.');
  assert.equal(sentences[0].startTime, 0);
  assert.equal(sentences[0].endTime, 0.6);
  assert.equal(sentences[0].wordCount, 2);
  // trailing words with no terminal punctuation still become one final sentence
  assert.equal(sentences[1].text, 'Bye');
  assert.equal(sentences[1].wordCount, 1);
});

test('13. computeOpeningWordCounts uses word-level timing when available', () => {
  const words = [
    { word: 'a', startTime: 1 },
    { word: 'b', startTime: 6 },
    { word: 'c', startTime: 12 },
  ];
  assert.deepEqual(math.computeOpeningWordCounts(words, []), { first5s: 1, first10s: 2, first15s: 3 });
});

test('14. computeOpeningWordCounts falls back to counting words-per-cue when only cue-level segments exist', () => {
  const segments = [
    { text: 'two words', startTime: 1 },
    { text: 'three more words', startTime: 8 },
  ];
  assert.deepEqual(math.computeOpeningWordCounts([], segments), { first5s: 2, first10s: 5, first15s: 5 });
});

test('15. computeOpeningWordCounts returns nulls when there is no transcript data at all', () => {
  assert.deepEqual(math.computeOpeningWordCounts([], []), { first5s: null, first10s: null, first15s: null });
});

test('16. computeOpeningCutCounts counts detected shots by their startTime against fixed windows', () => {
  const shots = [0, 3, 8, 20, 40].map((t, i) => ({ index: i, startTime: t }));
  assert.deepEqual(math.computeOpeningCutCounts(shots), { first5s: 2, first10s: 3, first15s: 3, first30s: 4 });
});

test('17. findFirstQuestionMark reports a time only when a word token itself carries the "?"', () => {
  const words = [{ word: 'Really?', startTime: 3.5, endTime: 4 }];
  const found = math.findFirstQuestionMark('Wait, Really? Yes.', words);
  assert.equal(found.time, 3.5);
  assert.equal(found.text, 'Wait, Really?');
});

test('18. findFirstQuestionMark reports the text but leaves time null when no word carries the punctuation', () => {
  const found = math.findFirstQuestionMark('Is this real?', [{ word: 'real', startTime: 1, endTime: 1.2 }]);
  assert.equal(found.time, null);
  assert.equal(found.text, 'Is this real?');
});

test('19. findFirstQuestionMark returns nulls when there is no "?" in the text at all', () => {
  assert.deepEqual(math.findFirstQuestionMark('No question here.', []), { time: null, text: null });
});

test('20. computeTemporalWindows produces real shot/word counts per window and clips windows to the video\'s own duration', () => {
  const shots = [0, 4, 9].map((t, i) => ({ index: i, startTime: t }));
  const words = [{ startTime: 1 }, { startTime: 6 }];
  const windows = math.computeTemporalWindows(10, shots, words, []);
  const byLabel = Object.fromEntries(windows.map((w) => [w.label, w]));
  assert.equal(byLabel.ENTIRE_VIDEO.shotCount, 3);
  assert.equal(byLabel.FIRST_5S.shotCount, 2); // shots at 0 and 4
  assert.equal(byLabel.FIRST_5S.wordCount, 1); // word at 1
  assert.equal(byLabel.FIRST_5S.endTime, 5);
  // a 10s video has no meaningful FIRST_60S window beyond its own duration —
  // still present, but clipped to endTime 10, never extended past real evidence
  assert.equal(byLabel.FIRST_60S.endTime, 10);
});

test('21. computeTemporalWindows returns [] when duration is unknown, never inventing a window', () => {
  assert.deepEqual(math.computeTemporalWindows(null, [], [], []), []);
});

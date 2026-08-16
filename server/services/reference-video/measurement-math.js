// measurement-math.js
//
// INT-1B — PURE arithmetic over already-parsed data (see measurement-
// parsers.js for turning raw FFmpeg text into the arrays these functions
// consume). No I/O, no FFmpeg invocation, no schema-object construction —
// every function returns plain numbers/arrays/objects that services/
// reference-video-measurement-service.js wraps into schemas/reference-
// video-measurement-schema.js records. Kept separate specifically so Part
// 21's "deterministic fixture tests" can assert exact expected numbers
// against fixed inputs, independent of whether FFmpeg is even installed.

// Part 15/17 — the one shared distribution shape used everywhere a set of
// numbers needs its shape preserved, not just its average. Uses the
// nearest-rank percentile method (simple, deterministic, no interpolation
// ambiguity to document).
function computeDistribution(numbers) {
  const values = (Array.isArray(numbers) ? numbers : []).filter((n) => typeof n === 'number' && Number.isFinite(n)).slice().sort((a, b) => a - b);
  const count = values.length;
  if (count === 0) {
    return { count: 0, mean: null, median: null, min: null, max: null, p25: null, p75: null, p90: null };
  }
  const sum = values.reduce((a, b) => a + b, 0);
  const percentile = (p) => values[Math.min(count - 1, Math.max(0, Math.ceil((p / 100) * count) - 1))];
  const mid = Math.floor(count / 2);
  const median = count % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
  return {
    count,
    mean: sum / count,
    median,
    min: values[0],
    max: values[count - 1],
    p25: percentile(25),
    p75: percentile(75),
    p90: percentile(90),
  };
}

// Part 4 — turns a sorted list of detected cut timestamps into contiguous
// shot spans covering the whole video: [0, cut1), [cut1, cut2), ...,
// [cutN, videoDuration]. A video with zero detected cuts is one shot
// spanning the entire duration — never zero shots (every video has at
// least one shot by definition).
function buildShotsFromCutTimes(cutTimes, videoDuration) {
  if (typeof videoDuration !== 'number' || !Number.isFinite(videoDuration) || videoDuration <= 0) return [];
  const boundaries = [0, ...[...new Set(cutTimes)].filter((t) => t > 0 && t < videoDuration).sort((a, b) => a - b), videoDuration];
  const shots = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const startTime = boundaries[i];
    const endTime = boundaries[i + 1];
    shots.push({ index: i, startTime, endTime, duration: Number((endTime - startTime).toFixed(6)) });
  }
  return shots;
}

// Part 5 — shot rhythm, numbers only.
function computeShotRhythm(shots, videoDuration) {
  const durations = shots.map((s) => s.duration);
  const durationDistribution = computeDistribution(durations);
  const shotCount = shots.length;
  const shotsPerMinute = videoDuration > 0 ? (shotCount / videoDuration) * 60 : null;
  const countBefore = (t) => shots.filter((s) => s.startTime < t).length;
  const first30sShotCount = videoDuration !== null ? countBefore(30) : null;
  const first60sShotCount = videoDuration !== null ? countBefore(60) : null;

  // "pacing changes over time" (Part 5) — shot count per quarter of the
  // video's own duration. For a video shorter than 4 distinguishable
  // quarters this still produces 4 windows; short windows simply end up
  // with low/zero counts, which is itself real information, not an error.
  const quarterShotCounts = [];
  if (typeof videoDuration === 'number' && videoDuration > 0) {
    const q = videoDuration / 4;
    for (let i = 0; i < 4; i += 1) {
      const start = q * i;
      const end = i === 3 ? videoDuration : q * (i + 1);
      quarterShotCounts.push({ quarter: i + 1, startTime: start, endTime: end, shotCount: shots.filter((s) => s.startTime >= start && s.startTime < end).length });
    }
  }

  return { shotCount, durationDistribution, shotsPerMinute, first30sShotCount, first60sShotCount, quarterShotCounts };
}

// Part 9 — per-word duration + inter-word gap. Never mutates the input
// words array (schemas/reference-video-schema.js's own Transcript.words is
// passed straight through by reference by callers — this function only
// reads it).
function computeWordTimingMeasurements(words) {
  const list = Array.isArray(words) ? words : [];
  return list.map((w, i) => {
    const duration = typeof w.startTime === 'number' && typeof w.endTime === 'number' ? Number((w.endTime - w.startTime).toFixed(6)) : null;
    const next = list[i + 1];
    const gapBeforeNextWord = next && typeof w.endTime === 'number' && typeof next.startTime === 'number' ? Number((next.startTime - w.endTime).toFixed(6)) : null;
    return { index: i, word: w.word, startTime: w.startTime, endTime: w.endTime, duration, gapBeforeNextWord };
  });
}

const DEFAULT_PAUSE_THRESHOLD_SECONDS = 0.5;

// Part 8 — a "pause" is any inter-word gap exceeding the threshold.
// Documented, tunable constant, never a hidden magic number.
function computePauses(wordTimings, pauseThresholdSeconds = DEFAULT_PAUSE_THRESHOLD_SECONDS) {
  const pauses = wordTimings.filter((w) => typeof w.gapBeforeNextWord === 'number' && w.gapBeforeNextWord >= pauseThresholdSeconds).map((w) => ({ afterWordIndex: w.index, startTime: w.endTime, duration: w.gapBeforeNextWord }));
  return { pauses, durations: pauses.map((p) => p.duration) };
}

// Part 8 — a text-only sentence count (regex split on terminal
// punctuation). Works even when no word-level timing exists at all
// (cue-level-only transcripts) — this is the ONE transcript measurement
// this layer can still produce without word timestamps.
function countSentencesFromText(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0).length;
}

// Part 9 — sentence TIMING, only possible when word-level timestamps
// exist. A sentence ends at the first word whose own token text ends with
// terminal punctuation (the convention faster-whisper's tokenizer already
// follows — see services/voice/whisper-alignment-provider.js). Any
// trailing words with no terminal punctuation at all become one final
// "sentence" (an honest reflection of the source, never a fabricated
// boundary).
function computeSentencesFromWords(words) {
  const list = Array.isArray(words) ? words : [];
  const sentences = [];
  let buffer = [];
  for (const w of list) {
    buffer.push(w);
    if (/[.!?]\s*$/.test(String(w.word || '').trim())) {
      sentences.push(buffer);
      buffer = [];
    }
  }
  if (buffer.length > 0) sentences.push(buffer);
  return sentences.map((sentenceWords, index) => {
    const first = sentenceWords[0];
    const last = sentenceWords[sentenceWords.length - 1];
    const startTime = typeof first.startTime === 'number' ? first.startTime : null;
    const endTime = typeof last.endTime === 'number' ? last.endTime : null;
    return {
      index,
      text: sentenceWords.map((w) => w.word).join(' ').trim(),
      startTime,
      endTime,
      duration: typeof startTime === 'number' && typeof endTime === 'number' ? Number((endTime - startTime).toFixed(6)) : null,
      wordCount: sentenceWords.length,
    };
  });
}

// Part 10 — literal, mechanical opening-window counts. `getWordStart`
// abstracts over word-level (words[]) vs cue-level (segments[]) timing so
// the same counting logic works with whichever the transcript actually has.
function countItemsBefore(items, getStartTime, thresholdSeconds) {
  return items.filter((item) => {
    const t = getStartTime(item);
    return typeof t === 'number' && t < thresholdSeconds;
  }).length;
}

function computeOpeningWordCounts(words, segments) {
  if (Array.isArray(words) && words.length > 0) {
    return {
      first5s: countItemsBefore(words, (w) => w.startTime, 5),
      first10s: countItemsBefore(words, (w) => w.startTime, 10),
      first15s: countItemsBefore(words, (w) => w.startTime, 15),
    };
  }
  if (Array.isArray(segments) && segments.length > 0) {
    // cue-level fallback — counts WORDS WITHIN cues that start before the
    // threshold (a coarser approximation, since only the cue's own start
    // time is known, not each word's) — never silently upgraded to look
    // as precise as the word-level path.
    const wordsInCuesBefore = (t) => segments.filter((s) => typeof s.startTime === 'number' && s.startTime < t).reduce((sum, s) => sum + String(s.text || '').split(/\s+/).filter(Boolean).length, 0);
    return { first5s: wordsInCuesBefore(5), first10s: wordsInCuesBefore(10), first15s: wordsInCuesBefore(15) };
  }
  return { first5s: null, first10s: null, first15s: null };
}

function computeOpeningCutCounts(shots) {
  const list = Array.isArray(shots) ? shots : [];
  return {
    first5s: countItemsBefore(list, (s) => s.startTime, 5),
    first10s: countItemsBefore(list, (s) => s.startTime, 10),
    first15s: countItemsBefore(list, (s) => s.startTime, 15),
    first30s: countItemsBefore(list, (s) => s.startTime, 30),
  };
}

// Part 10 — a literal "?" character, nothing more. Only ever reports a
// TIME when a single word token itself carries the "?" (the one case this
// layer can map a character position back to a timestamp without
// guessing); otherwise reports the text but leaves time null.
function findFirstQuestionMark(text, words) {
  const raw = String(text || '');
  const idx = raw.indexOf('?');
  if (idx === -1) return { time: null, text: null };
  const start = Math.max(0, idx - 40);
  const snippet = raw.slice(start, idx + 1).trim();
  const wordList = Array.isArray(words) ? words : [];
  const carrier = wordList.find((w) => String(w.word || '').includes('?'));
  return { time: carrier && typeof carrier.startTime === 'number' ? carrier.startTime : null, text: snippet };
}

// Part 14 — the standard set of temporal windows this stage always
// produces, each carrying real counts derived from already-computed
// shots/words — never re-measured independently per window.
function computeTemporalWindows(videoDuration, shots, words, segments) {
  const duration = typeof videoDuration === 'number' && Number.isFinite(videoDuration) ? videoDuration : null;
  const shotList = Array.isArray(shots) ? shots : [];
  const wordStartsFn = Array.isArray(words) && words.length > 0 ? (t0, t1) => words.filter((w) => typeof w.startTime === 'number' && w.startTime >= t0 && w.startTime < t1).length : null;

  const windows = [];
  const pushWindow = (label, startTime, endTime) => {
    if (duration === null) return;
    const clampedEnd = Math.min(endTime, duration);
    if (startTime >= clampedEnd) return;
    windows.push({
      label,
      startTime,
      endTime: clampedEnd,
      shotCount: shotList.filter((s) => s.startTime >= startTime && s.startTime < clampedEnd).length,
      wordCount: wordStartsFn ? wordStartsFn(startTime, clampedEnd) : null,
    });
  };

  if (duration !== null) {
    windows.push({ label: 'ENTIRE_VIDEO', startTime: 0, endTime: duration, shotCount: shotList.length, wordCount: wordStartsFn ? wordStartsFn(0, duration) : null });
    pushWindow('FIRST_5S', 0, 5);
    pushWindow('FIRST_10S', 0, 10);
    pushWindow('FIRST_30S', 0, 30);
    pushWindow('FIRST_60S', 0, 60);
    const q = duration / 4;
    for (let i = 0; i < 4; i += 1) pushWindow(`QUARTER_${i + 1}`, q * i, i === 3 ? duration : q * (i + 1));
  }
  return windows;
}

module.exports = {
  DEFAULT_PAUSE_THRESHOLD_SECONDS,
  computeDistribution,
  buildShotsFromCutTimes,
  computeShotRhythm,
  computeWordTimingMeasurements,
  computePauses,
  countSentencesFromText,
  computeSentencesFromWords,
  computeOpeningWordCounts,
  computeOpeningCutCounts,
  findFirstQuestionMark,
  computeTemporalWindows,
};

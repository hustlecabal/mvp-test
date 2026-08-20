// caption-service.js
//
// P0-TEMPORAL — the TEMPORAL BACKBONE's one new service. Turns the
// EXISTING, real, Whisper-measured word timing already carried on
// NARRATION AudioEvents (schemas/audio-schema.js's
// AudioEvent.transcript.words[], populated by services/voice-generation-
// service.js's real espeak-ng + faster-whisper pipeline — see that file
// and services/voice/whisper-alignment-provider.js) into:
//
//   1. validated word timing (Part 4 invariants — never silently repaired)
//   2. deterministic caption/phrase segments (Part 6)
//   3. a deterministic SRT export (Part 7)
//
// NOT A SECOND TRANSCRIPTION SYSTEM, NOT A SECOND TIMING AUTHORITY (Hard
// Rules 3/4/5): this file never calls Whisper, never invents a timestamp,
// and never reads anything Whisper did not already measure. It is a pure,
// deterministic TRANSFORMATION layer sitting entirely downstream of
// services/voice-generation-service.js's own output.
//
// ABSOLUTE VS CLIP-RELATIVE TIMING (the one real subtlety here): Whisper
// aligns against ONE narration clip's own audio file, so
// AudioEvent.transcript.words[].startTime/endTime are relative to that
// CLIP's own start (0-based). services/video-assembly-service.js places
// that same clip in the final assembled video at AudioEvent.startTime
// (see its own buildNarrationSegment) — that is the exact offset that
// determines where a viewer actually hears each word. This file applies
// that SAME offset to every word before segmenting, so a CaptionSegment's
// startTime/endTime always describes the same absolute instant in the
// final assembled timeline that the real muxed audio does — never a
// second, independently-computed notion of "when."
//
// SIDECAR, NEVER BURNED-IN (Part 21 of this stage's spec, explicit): this
// file only ever produces data/an SRT string. It never touches FFmpeg,
// never re-renders the final MP4, and is never called by video-assembly-
// service.js. services/production-orchestrator-service.js calls it AFTER
// assembly succeeds, as a non-fatal, additive step.

const { createCaptionSegment, createCaptionDiagnostic, createCaptionTrackResult, DEFAULT_CAPTION_SEGMENTATION_OPTIONS } = require('../schemas/caption-schema');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifyTimingValue(value) {
  if (value === null || value === undefined) return 'ABSENT';
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return 'INVALID';
  return 'VALID';
}

// ---------------------------------------------------------------------------
// Part 4 — timing invariants. Validates ONE AudioEvent's own
// transcript.words[] against its own real, measured clip duration. Never
// clamps or repairs — a word that fails any invariant is reported and
// EXCLUDED from the words this file trusts (Hard Rule 17/18: fail honestly,
// never fabricate/substitute).
// ---------------------------------------------------------------------------
function validateWordTiming(words, { clipDuration } = {}) {
  const diagnostics = [];
  const validWords = [];
  const list = Array.isArray(words) ? words : [];

  let previousEnd = null;
  for (let i = 0; i < list.length; i += 1) {
    const w = list[i];
    if (!isPlainObject(w) || typeof w.word !== 'string' || w.word.length === 0) {
      diagnostics.push({ code: 'INVALID_WORD_TEXT', index: i, message: `word at index ${i} has no non-empty text` });
      continue;
    }
    const startClass = classifyTimingValue(w.startTime);
    const endClass = classifyTimingValue(w.endTime);
    if (startClass !== 'VALID' || endClass !== 'VALID') {
      diagnostics.push({ code: 'INVALID_WORD_TIMESTAMP', index: i, message: `word "${w.word}" at index ${i} has a non-finite/missing timestamp (start=${JSON.stringify(w.startTime)}, end=${JSON.stringify(w.endTime)})` });
      continue;
    }
    if (w.startTime < 0) {
      diagnostics.push({ code: 'NEGATIVE_START_TIME', index: i, message: `word "${w.word}" at index ${i} has a negative startTime (${w.startTime})` });
      continue;
    }
    if (w.endTime <= w.startTime) {
      diagnostics.push({ code: 'TIMESTAMP_INVERSION', index: i, message: `word "${w.word}" at index ${i} has endTime (${w.endTime}) <= startTime (${w.startTime})` });
      continue;
    }
    if (previousEnd !== null && w.startTime < previousEnd) {
      diagnostics.push({ code: 'WORD_ORDER_REVERSED', index: i, message: `word "${w.word}" at index ${i} starts (${w.startTime}) before the previous word ended (${previousEnd}) — transcript sequence must be non-decreasing` });
      continue;
    }
    if (typeof clipDuration === 'number' && Number.isFinite(clipDuration) && clipDuration > 0 && w.endTime > clipDuration) {
      diagnostics.push({ code: 'WORD_EXCEEDS_AUDIO_DURATION', index: i, message: `word "${w.word}" at index ${i} ends at ${w.endTime}s, beyond the audio's own measured duration (${clipDuration}s)` });
      continue;
    }
    validWords.push(w);
    previousEnd = w.endTime;
  }

  return { valid: diagnostics.length === 0, validWords, diagnostics };
}

// ---------------------------------------------------------------------------
// Part 6 — deterministic word -> caption segmentation. Pure function: the
// same `words` (already absolute-time, already validated) + the same
// `options` always produces the same segments (Part 16 — determinism).
//
// Breaks the current segment (and starts a new one) when ANY of:
//   - adding the next word would exceed maxCharsPerCaption
//   - adding the next word would exceed maxWordsPerCaption
//   - the current word's own text ends with a strong sentence terminator
//     (. ? !) and the segment already has at least one word
//   - the gap before the NEXT word (its startTime minus this word's own
//     endTime — both REAL measured values, never estimated) is at least
//     silenceGapSeconds — a natural pause, inferred honestly from the
//     measured timing itself, never a fabricated "silence event"
// ---------------------------------------------------------------------------
const SENTENCE_TERMINATOR_RE = /[.?!]["')\]]?$/;

function segmentWordsIntoCaptions(words, options = {}) {
  const { maxCharsPerCaption, maxWordsPerCaption, silenceGapSeconds } = { ...DEFAULT_CAPTION_SEGMENTATION_OPTIONS, ...options };

  const segments = [];
  let current = null; // { words: [{word,startTime,endTime,audioEventId}], text }

  function flush() {
    if (!current || current.words.length === 0) return;
    const first = current.words[0];
    const last = current.words[current.words.length - 1];
    segments.push(
      createCaptionSegment({
        index: segments.length + 1,
        text: current.words.map((w) => w.word).join(' '),
        startTime: first.startTime,
        endTime: last.endTime,
        wordCount: current.words.length,
        sourceAudioEventIds: [...new Set(current.words.map((w) => w.audioEventId).filter(Boolean))],
      })
    );
    current = null;
  }

  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (!current) current = { words: [] };

    const candidateText = current.words.length === 0 ? w.word : `${current.words.map((cw) => cw.word).join(' ')} ${w.word}`;
    const wouldExceedChars = candidateText.length > maxCharsPerCaption;
    const wouldExceedWords = current.words.length + 1 > maxWordsPerCaption;

    if (current.words.length > 0 && (wouldExceedChars || wouldExceedWords)) {
      flush();
      current = { words: [] };
    }

    current.words.push(w);

    const endsSentence = SENTENCE_TERMINATOR_RE.test(w.word);
    const next = words[i + 1];
    const gapBeforeNext = next ? next.startTime - w.endTime : null;
    const naturalPause = typeof gapBeforeNext === 'number' && gapBeforeNext >= silenceGapSeconds;

    if (endsSentence || naturalPause) {
      flush();
    }
  }
  flush();

  return segments;
}

// ---------------------------------------------------------------------------
// Part 7 — deterministic SRT serialization. An EXPORT format only — never
// read back as the canonical representation anywhere in this codebase.
// ---------------------------------------------------------------------------
function srtTimestamp(totalSeconds) {
  const ms = Math.round(totalSeconds * 1000);
  const hh = Math.floor(ms / 3600000);
  const mm = Math.floor((ms % 3600000) / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  const pad = (n, len) => String(n).padStart(len, '0');
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)},${pad(mmm, 3)}`;
}

function generateSRT(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const lines = [];
  let index = 0;
  for (const segment of list) {
    if (!segment || typeof segment.text !== 'string' || segment.text.trim().length === 0) continue; // Part 7 — no empty captions
    if (classifyTimingValue(segment.startTime) !== 'VALID' || classifyTimingValue(segment.endTime) !== 'VALID' || segment.startTime < 0 || segment.endTime <= segment.startTime) continue; // never serialize invalid/negative/inverted timing
    index += 1;
    lines.push(String(index));
    lines.push(`${srtTimestamp(segment.startTime)} --> ${srtTimestamp(segment.endTime)}`);
    lines.push(segment.text);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + (lines.length > 0 ? '\n' : '');
}

// ---------------------------------------------------------------------------
// Part 8 — caption validation against the source words they were built
// from. Never mutates either input.
// ---------------------------------------------------------------------------
function validateCaptionSegments(segments, sourceWords) {
  const diagnostics = [];
  const list = Array.isArray(segments) ? segments : [];
  const words = Array.isArray(sourceWords) ? sourceWords : [];

  // sequence + ordering
  let previousEnd = null;
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    if (s.index !== i + 1) diagnostics.push({ code: 'CAPTION_SEQUENCE_GAP', message: `segment at position ${i} has index ${s.index}, expected ${i + 1}` });
    if (classifyTimingValue(s.startTime) !== 'VALID' || classifyTimingValue(s.endTime) !== 'VALID' || s.startTime < 0 || s.endTime <= s.startTime) {
      diagnostics.push({ code: 'CAPTION_INVALID_TIMING', message: `segment ${s.index} has invalid timing (start=${s.startTime}, end=${s.endTime})` });
    }
    if (previousEnd !== null && s.startTime < previousEnd) {
      diagnostics.push({ code: 'CAPTION_OVERLAP', message: `segment ${s.index} starts (${s.startTime}) before the previous segment ended (${previousEnd})` });
    }
    previousEnd = s.endTime;
  }

  // word coverage — reconstruct text from segments and compare against source words
  const reconstructed = list.map((s) => s.text).join(' ').split(/\s+/).filter(Boolean);
  const expected = words.map((w) => w.word);
  if (reconstructed.length !== expected.length) {
    diagnostics.push({ code: 'WORD_COVERAGE_MISMATCH', message: `caption segments contain ${reconstructed.length} word(s), source transcript had ${expected.length}` });
  } else {
    for (let i = 0; i < expected.length; i += 1) {
      if (reconstructed[i] !== expected[i]) {
        diagnostics.push({ code: 'WORD_COVERAGE_MISMATCH', message: `word ${i} differs: caption has "${reconstructed[i]}", source had "${expected[i]}"` });
        break;
      }
    }
  }

  const totalSegmentWordCount = list.reduce((sum, s) => sum + s.wordCount, 0);
  if (totalSegmentWordCount !== expected.length) {
    diagnostics.push({ code: 'WORD_COUNT_MISMATCH', message: `segments report ${totalSegmentWordCount} total word(s), source transcript had ${expected.length}` });
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

// ---------------------------------------------------------------------------
// Top-level entry point — Part 9/21. Consumes the SAME `audioEvents` array
// services/production-orchestrator-service.js already builds and passes to
// video-assembly-service.js's assembleTimeline() — never a second
// collection, never re-derived.
// ---------------------------------------------------------------------------
function buildCaptionTrack(audioEvents, options = {}) {
  const events = (Array.isArray(audioEvents) ? audioEvents : []).filter((ae) => isPlainObject(ae) && ae.type === 'NARRATION' && ae.transcript && Array.isArray(ae.transcript.words) && ae.transcript.words.length > 0);

  if (events.length === 0) {
    return createCaptionTrackResult({ status: 'EMPTY', segments: [], srt: null, diagnostics: [] });
  }

  const diagnostics = [];
  const absoluteWords = [];

  for (const ae of events) {
    const startOffsetClass = classifyTimingValue(ae.startTime);
    if (startOffsetClass !== 'VALID' || ae.startTime < 0) {
      diagnostics.push(createCaptionDiagnostic({ code: 'MISSING_TIMELINE_OFFSET', audioEventId: ae.audioEventId, message: `AudioEvent "${ae.audioEventId}" has no valid startTime — its words cannot be placed on the production timeline, excluded` }));
      continue;
    }
    const { validWords, diagnostics: wordDiagnostics } = validateWordTiming(ae.transcript.words, { clipDuration: ae.duration });
    for (const d of wordDiagnostics) {
      diagnostics.push(createCaptionDiagnostic({ code: d.code, audioEventId: ae.audioEventId, message: d.message }));
    }
    for (const w of validWords) {
      absoluteWords.push({ word: w.word, startTime: w.startTime + ae.startTime, endTime: w.endTime + ae.startTime, audioEventId: ae.audioEventId });
    }
  }

  absoluteWords.sort((a, b) => a.startTime - b.startTime);

  if (absoluteWords.length === 0) {
    return createCaptionTrackResult({ status: diagnostics.length > 0 ? 'FAILED' : 'EMPTY', segments: [], srt: null, diagnostics });
  }

  const segments = segmentWordsIntoCaptions(absoluteWords, options);
  const validation = validateCaptionSegments(segments, absoluteWords);
  for (const d of validation.diagnostics) {
    diagnostics.push(createCaptionDiagnostic({ code: d.code, audioEventId: null, message: d.message }));
  }

  const srt = generateSRT(segments);
  const status = validation.valid ? (events.length > 0 && diagnostics.length === 0 ? 'COMPLETED' : 'PARTIAL') : 'PARTIAL';

  return createCaptionTrackResult({ status, segments, srt, diagnostics });
}

module.exports = {
  validateWordTiming,
  segmentWordsIntoCaptions,
  generateSRT,
  validateCaptionSegments,
  buildCaptionTrack,
  srtTimestamp,
};

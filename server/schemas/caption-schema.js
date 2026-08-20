// caption-schema.js
//
// P0-TEMPORAL — the SMALLEST possible addition on top of the canonical
// timing representation this codebase already has: schemas/audio-schema.js's
// AudioEvent.transcript.words[] (word/startTime/endTime), populated with
// REAL, Whisper-measured timestamps by services/voice/whisper-alignment-
// provider.js via services/voice-generation-service.js. That file's own
// header already states the intended architecture verbatim: "SRT/VTT is
// deliberately not a field here... subtitles are a DERIVED interchange
// format, generated on demand from `words` by a future stage, never the
// master representation stored on this record." This file is that future
// stage's own shape — nothing here duplicates a word's own timing/text; a
// CaptionSegment only ever REFERENCES the AudioEvent(s) whose words it
// groups (sourceAudioEventIds), never copies their content.
//
// No new "canonical timing" schema was introduced (Part 3 of this stage's
// spec): AudioEvent + Transcript.words already satisfy every field that
// spec asked for (source narration/audio ID -> AudioEvent.sourceAssetId /
// audioEventId; timing provenance -> AudioEvent.scriptRefId/beatId; word
// start/end/text -> Transcript.words[]; sequence/order -> array order).
// CaptionSegment is a genuinely NEW concept (phrase/caption-level grouping)
// that did not exist anywhere in the repository before this stage — hence
// the one new file.

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

// One caption/phrase-level segment — coarser than a WordTimestamp,
// finer than a whole AudioEvent. `startTime`/`endTime` are ABSOLUTE
// production-timeline seconds (already shifted by whichever AudioEvent(s)
// this segment's words came from — see services/caption-service.js's own
// header for why that shift is necessary), matching the same timeline
// AssemblyResult's real muxed audio lives on, so a caption and the word a
// viewer actually hears are guaranteed to describe the same instant.
function createCaptionSegment(overrides = {}) {
  const { sourceAudioEventIds, ...rest } = overrides;
  const base = {
    index: null, // 1-based sequence number within this CaptionTrack — SRT's own numbering
    text: '',
    startTime: null, // absolute production-timeline seconds
    endTime: null, // absolute production-timeline seconds
    wordCount: 0, // for validation only (Part 8) — never a copy of the words themselves
    sourceAudioEventIds: Array.isArray(sourceAudioEventIds) ? [...sourceAudioEventIds] : [], // provenance — which AudioEvent(s) contributed words to this segment
  };
  return withDefaults(base, rest);
}

const CAPTION_TRACK_STATUSES = ['COMPLETED', 'PARTIAL', 'FAILED', 'EMPTY'];
// EMPTY: no NARRATION AudioEvents with transcript words were supplied — a
// production with no narration at all (e.g. music-only) is not a failure.

function createCaptionDiagnostic(overrides = {}) {
  const base = { code: null, audioEventId: null, message: '' };
  return withDefaults(base, overrides);
}

// The top-level result services/caption-service.js's buildCaptionTrack()
// returns, and what production-orchestrator-service.js persists onto
// ProductionJob.captionResult (Part 21 — a sidecar output, never gating
// COMPLETE).
function createCaptionTrackResult(overrides = {}) {
  const { segments, diagnostics, ...rest } = overrides;
  const base = {
    status: null, // one of CAPTION_TRACK_STATUSES
    segments: Array.isArray(segments) ? segments.map((s) => createCaptionSegment(s)) : [],
    srt: null, // the deterministic SRT string, set only when status is COMPLETED or PARTIAL and segments.length > 0
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createCaptionDiagnostic(d)) : [],
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

// Segmentation configuration (Part 6 — "do not optimise for a single magic
// number"): documented, overridable defaults, never hardcoded as if they
// were the one correct answer. Values below follow common subtitle
// readability conventions (e.g. Netflix's own public timed-text style
// guide targets ~42 characters/line) — a reasonable starting point, not a
// locked constant.
const DEFAULT_CAPTION_SEGMENTATION_OPTIONS = {
  maxCharsPerCaption: 84, // ~2 lines at ~42 chars/line
  maxWordsPerCaption: 14,
  silenceGapSeconds: 0.5, // a gap this large between two words' measured timestamps is treated as a natural phrase break
};

module.exports = {
  CAPTION_TRACK_STATUSES,
  DEFAULT_CAPTION_SEGMENTATION_OPTIONS,
  createCaptionSegment,
  createCaptionDiagnostic,
  createCaptionTrackResult,
};

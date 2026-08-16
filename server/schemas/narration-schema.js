// narration-schema.js
//
// Stage 26.9 — the NARRATION DIRECTION layer. Answers "how should this
// narration be PERFORMED", never "which TTS provider generates it." Same
// rules as every other schema file in this codebase: plain object
// factories only, no file I/O, no provider knowledge, every field defaults
// to null/[]/'' so partial data is always valid, nothing here invents
// information.
//
// This is a COMPUTED SNAPSHOT — the same discipline schemas/material-
// execution-schema.js's ExecutionResult, schemas/render-result-schema.js's
// RenderResult, and schemas/timeline-compilation-schema.js's
// TimelineCompilationResult already established: no versionFields()/
// history, regenerated fresh every call by services/narration-director-
// service.js. A human "override" (Part 12) is expressed as an INPUT to
// that service (a beatOverride argument), never a post-hoc mutation of a
// persisted NarrationDirection — no store/persistence layer is introduced
// this stage (none was requested; see that service's own header).
//
// ---------------------------------------------------------------------------
// PROVIDER NEUTRALITY — the one rule this whole stage exists to enforce
// ---------------------------------------------------------------------------
// Nothing in this file names a TTS provider, a provider voice ID, an API
// key, a model ID, or SSML/vendor-specific markup. VoiceProfile itself is
// NOT redefined here — Part 3's explicit instruction is to REUSE
// schemas/audio-schema.js's existing createVoiceProfile(), which already
// has exactly the free-text creative-intent field set this stage needs
// (genderPresentation/ageImpression/accent/language/speakingStyle/
// emotionalTone/energy/pace/pitch/deliveryNotes) and already documents the
// same "creative intent only, never a provider ID" boundary. Per this
// codebase's established self-contained-schema-file convention (see
// visual-beat-schema.js's/timeline-compilation-schema.js's own header
// comments: "duplicated here rather than imported... every schema file
// stays self-contained with no cross-schema-file requires"), this file
// does NOT require('./audio-schema') — `voiceProfile` below is a plain
// field that stores whatever object the CALLER already built (services,
// unlike schema files, may cross-require freely — see services/narration-
// director-service.js, which is the one place createVoiceProfile() is
// actually invoked).
//
// ---------------------------------------------------------------------------
// WHY scriptRefId IS A PLAIN STRING, NOT A join TO A Script SCHEMA
// ---------------------------------------------------------------------------
// The Stage 26.9 Part 1 audit confirmed no Script schema/store exists
// anywhere in this repository. schemas/visual-beat-schema.js's own
// narrationSegment.scriptRefId and schemas/audio-schema.js's
// AudioEvent.scriptRefId both already use scriptRefId as an unenforced
// plain string reference ("a plain id reference now" — visual-beat-
// schema.js's own comment) — this file uses the exact same convention,
// not a new one.

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

const NARRATION_DIRECTION_STATUSES = ['COMPLETED', 'FAILED'];

// ---------------------------------------------------------------------------
// Part 4 — Delivery model. Deliberately small and controlled (the task's
// own explicit instruction: "do not create hundreds of arbitrary
// options"). Two closed enums (pace/emotionalTone) plus five 0-10 integer
// axes — enough to express the task's own worked example ("calm -> curious
// -> tense -> surprised -> resolved") as a SEQUENCE of these snapshots
// (see createEmotionalArcStage below), without inventing a combinatorial
// vocabulary. Range/type ENFORCEMENT (0-10, one of the enums) is a
// services/narration-director-service.js concern — this factory only
// describes shape, same restraint every other schema file in this
// codebase already applies (see e.g. schemas/audio-schema.js's `volume`
// field comment: "0-1, unenforced — schema files describe shape, never
// policy").
// ---------------------------------------------------------------------------
const PACE_LEVELS = ['SLOW', 'MODERATE', 'MODERATELY_FAST', 'FAST'];
const EMOTIONAL_TONES = ['CALM', 'CURIOUS', 'CONFIDENT', 'TENSE', 'SURPRISED', 'RESOLVED', 'URGENT', 'WARM', 'PLAYFUL', 'SERIOUS'];
const DELIVERY_AXES = ['energy', 'intensity', 'confidence', 'warmth', 'urgency', 'conversationality']; // each 0-10

function createDeliveryDirection(overrides = {}) {
  const base = {
    pace: null, // one of PACE_LEVELS
    emotionalTone: null, // one of EMOTIONAL_TONES
    energy: null, // 0-10
    intensity: null, // 0-10
    confidence: null, // 0-10
    warmth: null, // 0-10
    urgency: null, // 0-10
    conversationality: null, // 0-10
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 5 — Emphasis. Anchored by DETERMINISTIC character offsets into the
// parent NarrationDirection's own `text` (never fuzzy string matching at
// read time — services/narration-director-service.js resolves `text`/
// `charStart`/`charEnd` once, deterministically, at construction time; a
// future TTS adapter reads charStart/charEnd directly, it never re-searches
// for the word).
// ---------------------------------------------------------------------------
const EMPHASIS_LEVELS = ['LIGHT', 'MODERATE', 'STRONG', 'CONTRAST'];

function createEmphasis(overrides = {}) {
  const base = {
    text: null, // the exact substring being emphasized, verbatim
    charStart: null, // offset into the parent NarrationDirection.text
    charEnd: null,
    level: null, // one of EMPHASIS_LEVELS
    reason: null, // free text, e.g. "key figure", "contrast", "IMPORTANT_NUMBER"
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 6 — Pauses. Same determinism discipline as Emphasis: anchored by a
// resolved character offset, never a re-searched string at read time.
// ---------------------------------------------------------------------------
const PAUSE_REASONS = ['SENTENCE_BREAK', 'PARAGRAPH_BREAK', 'BEFORE_REVEAL', 'AFTER_REVEAL', 'DRAMATIC', 'BREATH'];

function createPause(overrides = {}) {
  const base = {
    afterCharOffset: null, // the pause occurs immediately after this offset into `text`
    afterText: null, // human-readable echo of the text ending at afterCharOffset, for inspectability only — never re-matched
    durationMs: null, // must be a non-negative integer; enforced by narration-director-service.js, never by this factory
    reason: null, // one of PAUSE_REASONS
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 7 — Pronunciation. Provider-neutral: a free-text phonetic guide
// (e.g. "en-VID-ee-uh"), never SSML `<phoneme>` markup or an IPA
// requirement — a future provider-specific TTS adapter is responsible for
// translating this into whatever markup its own provider accepts.
// ---------------------------------------------------------------------------
function createPronunciationNote(overrides = {}) {
  const base = {
    text: null, // exact word/phrase as it appears in `text`
    pronunciation: null, // free-text phonetic guide, provider-neutral
    notes: null,
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 8 — Emotional arc. A SEQUENCE of createDeliveryDirection() snapshots,
// each tied to a beatId where possible (the task's own explicit
// requirement) — this is how "calm -> curious -> tense -> surprised ->
// resolved" is expressed: one stage per point in that sequence, never a
// single flat field.
// ---------------------------------------------------------------------------
function createEmotionalArcStage(overrides = {}) {
  const { delivery, ...rest } = overrides;
  const base = {
    beatId: null, // the VisualBeat this stage corresponds to, where possible
    label: null, // free text, e.g. "HOOK"/"EXPLANATION"/"REVEAL"/"CONCLUSION" —
                   // deliberately NOT constrained to NARRATIVE_ROLES below:
                   // this is a human-readable stage name, while
                   // NARRATIVE_ROLES is the closed vocabulary the director
                   // RULES key off of (see narration-director-service.js)
    delivery: delivery !== undefined ? (delivery === null ? null : createDeliveryDirection(delivery)) : createDeliveryDirection(),
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// Part 9 — Timing. TARGET vs ACTUAL, never conflated — the exact same
// discipline schemas/audio-schema.js's own file header already documents
// for AudioEvent.duration vs a beat's planned duration ("never assumed
// equal, never silently reconciled"). `actual` stays null until real,
// measured audio exists — services/narration-director-service.js never
// sets it to anything else this stage (there is no audio to measure yet).
// ---------------------------------------------------------------------------
function createNarrationTargetTiming(overrides = {}) {
  const base = {
    startTime: null, // seconds — target only, mirrors VisualBeat.startTime's own "null until placed" convention
    duration: null, // seconds — TARGET duration only; never a stand-in for measured audio duration
    wordsPerMinute: null, // target pace used to derive `duration` when the caller supplies wordsPerMinute instead of an explicit duration
    pauseBudgetMs: null, // sum of this NarrationDirection's own pauses[].durationMs — computed, informational only
  };
  return withDefaults(base, overrides);
}

function createNarrationTiming(overrides = {}) {
  const { target, ...rest } = overrides;
  const base = {
    target: target !== undefined ? (target === null ? null : createNarrationTargetTiming(target)) : createNarrationTargetTiming(),
    actual: null, // MUST remain null until real, measured audio timing exists — never populated this stage
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// Part 2 — NarrationDirection, the top-level output of
// services/narration-director-service.js's directNarration(). Mirrors
// schemas/material-execution-schema.js's ExecutionResult convention
// exactly: status+diagnostics carried on the SAME object as the payload,
// not a separate wrapper — the closest existing precedent (a deterministic
// service turning already-decided input into a structured, inspectable
// spec, never a provider call).
// ---------------------------------------------------------------------------
function createNarrationDirection(overrides = {}) {
  const { voiceProfile, delivery, timing, emphasis, pauses, pronunciation, emotionalArc, diagnostics, ...rest } = overrides;
  const base = {
    narrationId: crypto.randomUUID(),
    scriptRefId: null, // plain string reference — see file header
    beatIds: [], // VisualBeat.id values this narration direction covers, in order

    text: '', // the narration text this direction was computed from, verbatim

    voiceProfile: voiceProfile !== undefined ? voiceProfile : null, // schemas/audio-schema.js's createVoiceProfile() shape, built by the caller/service — never re-shaped here (see file header)
    delivery: delivery !== undefined ? (delivery === null ? null : createDeliveryDirection(delivery)) : null,
    timing: timing !== undefined ? (timing === null ? null : createNarrationTiming(timing)) : createNarrationTiming(),

    emphasis: Array.isArray(emphasis) ? emphasis.map((e) => createEmphasis(e)) : [],
    pauses: Array.isArray(pauses) ? pauses.map((p) => createPause(p)) : [],
    pronunciation: Array.isArray(pronunciation) ? pronunciation.map((p) => createPronunciationNote(p)) : [],
    emotionalArc: Array.isArray(emotionalArc) ? emotionalArc.map((s) => createEmotionalArcStage(s)) : [],

    notes: null, // free-text human creative notes — never parsed/acted on programmatically

    status: null, // one of NARRATION_DIRECTION_STATUSES
    diagnostics: Array.isArray(diagnostics) ? diagnostics : [], // { code, message } entries — same shape as every other *Result schema's diagnostics

    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

function createNarrationDiagnostic(overrides = {}) {
  const base = {
    code: null,
    message: '',
  };
  return withDefaults(base, overrides);
}

module.exports = {
  NARRATION_DIRECTION_STATUSES,
  PACE_LEVELS,
  EMOTIONAL_TONES,
  DELIVERY_AXES,
  EMPHASIS_LEVELS,
  PAUSE_REASONS,
  createDeliveryDirection,
  createEmphasis,
  createPause,
  createPronunciationNote,
  createEmotionalArcStage,
  createNarrationTargetTiming,
  createNarrationTiming,
  createNarrationDiagnostic,
  createNarrationDirection,
};

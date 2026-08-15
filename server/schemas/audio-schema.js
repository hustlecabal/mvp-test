// audio-schema.js
//
// Stage 26.7 — the AUDIO layer. Same rules as every other schema file in
// this codebase: plain object factories only, no file I/O, no provider
// knowledge, every field defaults to null/[]/'' so partial data is always
// valid, nothing here invents information.
//
// THIS STAGE DOES NOT GENERATE AUDIO. No TTS, no Whisper, no FFmpeg, no
// provider adapter exists anywhere in this file or is called by it. It
// only defines WHAT audio is required/present — never WHO produces it.
//
// ---------------------------------------------------------------------------
// WHY THESE THREE FACTORIES, AND NOT SIX
// ---------------------------------------------------------------------------
// The Stage 26.7 audit considered AudioAsset, AudioTrack, AudioEvent,
// VoiceProfile, Transcript, and WordTimestamp. Only three are implemented:
//
//   AudioEvent    — the load-bearing concept. schemas/visual-beat-
//                    schema.js's VisualBeat.audioEvents[] (Stage 26.1) has
//                    been waiting for this exact shape since it was
//                    written ("audioEventId values, once that schema
//                    exists"), and schemas/production-schema.js's
//                    TimelineIR.audio[] has been declared-but-unshaped
//                    since Stage 9 — exactly the situation Stage 26.6
//                    Part 2 already resolved for TimelineIR.transitions[]
//                    (see schemas/timeline-compilation-schema.js's own
//                    header). This file gives audio[] its first-ever entry
//                    shape the same way.
//   Transcript    — required so word-level timestamps (Part 4) can be
//                    introduced LATER without ever changing AudioEvent or
//                    TimelineIR: `words` starts empty and is populated by a
//                    future speech-to-text stage; nothing that reads an
//                    AudioEvent today needs to know or care whether it is
//                    empty or populated.
//   VoiceProfile  — required by Stage 26.7 Part 3's explicit instruction
//                    to keep creative intent (a warm, confident narrator)
//                    structurally separate from provider execution (a
//                    provider's own voice ID) — the same discipline
//                    schemas/video-prompt-schema.js and schemas/visual-
//                    beat-schema.js already enforce for visual generation.
//
// NOT implemented, and why:
//   AudioAsset    — would duplicate schemas/production-schema.js's
//                    existing Asset model. A narration/music/SFX clip is
//                    an Asset with type: 'audio' (added additively to
//                    ASSET_TYPES this stage) — same storage.status
//                    lifecycle, same approvalStatus/version/lineage,
//                    exactly how Stage 26.5B made B-roll reference an
//                    existing Asset rather than inventing a second one.
//                    AudioEvent.sourceAssetId points at one.
//   AudioTrack    — Stage 26.6's own Shot.layer field already established
//                    the precedent that "which channel/layer something
//                    belongs to" is a FIELD on the event, not a separate
//                    container object. AudioEvent.type (NARRATION/MUSIC/
//                    SFX/AMBIENCE) already answers "which track" — a
//                    distinct AudioTrack record would be a redundant
//                    grouping over data AudioEvent.type already expresses.
//   WordTimestamp — not a standalone schema file; it is one entry in
//                    Transcript.words[], exactly how schemas/visual-beat-
//                    schema.js's own createIdentityRequirements/
//                    createNarrationSegment are small nested factories in
//                    the same file as their parent, never separate files.
//
// ---------------------------------------------------------------------------
// TIMING: PLANNED vs ACTUAL — never silently conflated (Part 5)
// ---------------------------------------------------------------------------
// A VisualBeat's own `duration` (schemas/visual-beat-schema.js) — and, when
// present, its `narrationSegment.startOffset`/`endOffset` — is the PLANNED/
// authored timing, unchanged by this file. An AudioEvent's own `duration`
// is the ACTUAL/measured duration of the real audio it represents, exactly
// the same distinction schemas/material-execution-schema.js's
// ExecutionResult.duration already draws against a beat's own planned
// duration for VISUAL material (Stage 26.5A) — never assumed equal, never
// silently reconciled here. A future Timeline Compiler extension (not this
// stage — see this stage's final report) is where the two would actually be
// COMPARED and a structured AUDIO_DURATION_MISMATCH diagnostic raised when
// they diverge; this file only makes sure the two numbers are never the
// same field, so they can never be silently conflated in the first place.
//
// ---------------------------------------------------------------------------
// TIMING PRECEDENCE (documented here, NOT implemented — Part 13)
// ---------------------------------------------------------------------------
// A future audio-aware Timeline Compiler extension should resolve timing in
// this order, reconciling Stage 26.6's existing 3-tier hierarchy with this
// stage's audio-first-timing goal (docs/architecture/stage-26.2-visual-
// production-master-spec.md, Section 15, already established: "narration
// segment is the timing contract"):
//   1. Actual measured AudioEvent timing (once real audio/word timestamps exist)
//   2. beat.narrationSegment-derived timing (when narrationSegment is set)
//   3. beat.startTime/duration directly (when narrationSegment is null —
//      Section 15's own documented Case C, e.g. a pure B-roll/music beat)
//   4. Deterministic sequential inference (Stage 26.6's existing fallback,
//      services/timeline-compiler-service.js's compareBeats/cursor logic,
//      unchanged)
// Tiers 3/4 are exactly services/timeline-compiler-service.js's existing
// tiers 2/3 today — this is a REFINEMENT (inserting audio-actual-timing
// above, and splitting "beat timing" into narration-derived vs directly-
// authored) of what already exists, never a rewrite. Not implemented in
// services/timeline-compiler-service.js this stage — see file scope note
// in this stage's final report.

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

// Deliberately NOT including 'SILENCE' (an earlier draft of this design,
// docs/architecture/stage-26.2-visual-production-master-spec.md Section
// 19, proposed one). Stage 26.6 Part 2 already established the governing
// precedent for gaps: an absence of a compiled entry in a time range is
// itself a valid, reported-but-never-repaired state (TIMELINE_GAP) — audio
// silence needs no dedicated event type for the same reason a visual gap
// doesn't invent a "BLANK" shot type. An intentional pause is simply the
// absence of an AudioEvent in that window.
const AUDIO_EVENT_TYPES = ['NARRATION', 'MUSIC', 'SFX', 'AMBIENCE'];

// A record's own lifecycle — separate from the Asset it may eventually
// reference (whose OWN storage.status already tracks NOT_ARCHIVED/STORED/
// FAILED). PLANNED: authored/intended, no sourceAssetId yet — no audio has
// been produced. READY: sourceAssetId is set and duration is the real,
// measured value. Deliberately no FAILED/GENERATING state yet — nothing in
// the current architecture can fail or generate audio; adding those states
// now would describe a process that does not exist.
const AUDIO_EVENT_STATUSES = ['PLANNED', 'READY'];

// ---------------------------------------------------------------------------
// VoiceProfile — CREATIVE INTENT ONLY (Part 3). Every field here describes
// how a narrator should SOUND to a human, in plain descriptive language —
// never a provider's own voice ID, model name, or API parameter. Free-text
// fields throughout, matching this codebase's existing convention for
// subjective creative descriptors with no single correct closed vocabulary
// (schemas/production-schema.js's own creativeMode field: "no fixed list
// enforced yet" — the same reasoning applies here). Provider EXECUTION
// parameters (which of ElevenLabs/Azure/Google's voices this maps to)
// belong to a future, separate provider-adapter layer this file never
// references and never imports.
function createVoiceProfile(overrides = {}) {
  const base = {
    genderPresentation: '', // e.g. "male", "female", "neutral" — free text
    ageImpression: '', // e.g. "young adult", "mature"
    accent: '', // e.g. "British", "American general"
    language: '', // e.g. "en-GB" — free text, never enforced against a locale list here
    speakingStyle: '', // e.g. "conversational", "authoritative"
    emotionalTone: '', // e.g. "warm", "urgent", "playful"
    energy: '', // e.g. "low", "medium", "high" — free text, not an enum
    pace: '', // e.g. "slow", "medium", "fast"
    pitch: '', // e.g. "low", "medium", "high"
    deliveryNotes: '', // free-form additional creative direction
  };
  return withDefaults(base, overrides);
}

// One word (or short unit) with its own measured timing — the smallest
// granularity Part 4's timing model names. Never required to exist;
// Transcript.words defaults to an empty array (see createTranscript).
function createWordTimestamp(overrides = {}) {
  const base = {
    word: '',
    startTime: null,
    endTime: null,
  };
  return withDefaults(base, overrides);
}

// Text is available immediately (from a script); word-level timing is an
// OPTIONAL refinement that can be added later (a future speech-to-text
// stage) WITHOUT this shape, AudioEvent, or TimelineIR changing at all —
// exactly Part 4's explicit requirement. SRT/VTT is deliberately not a
// field here: per Part 8, subtitles are a DERIVED interchange format,
// generated on demand from `words` by a future stage, never the master
// representation stored on this record.
function createTranscript(overrides = {}) {
  const { words, ...rest } = overrides;
  const base = {
    text: '',
    words: Array.isArray(words) ? words.map((w) => createWordTimestamp(w)) : [], // createWordTimestamp() entries, empty until populated
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// AudioEvent — the shape schemas/visual-beat-schema.js's
// VisualBeat.audioEvents[] (an array of audioEventId strings, Stage 26.1)
// and schemas/production-schema.js's TimelineIR.audio[] (declared, empty,
// Stage 9) have both been waiting for. Provider-neutral by construction:
// sourceAssetId is a plain Asset reference (type: 'audio'), never a
// provider name or generation job. No cost field — see this stage's final
// report's Cost Architecture section for why none is added yet.
// ---------------------------------------------------------------------------
function createAudioEvent(overrides = {}) {
  const { transcript, voiceProfile, ...rest } = overrides;
  const base = {
    audioEventId: crypto.randomUUID(),
    type: null, // one of AUDIO_EVENT_TYPES
    status: 'PLANNED', // one of AUDIO_EVENT_STATUSES

    // --- timing — see file header's PLANNED vs ACTUAL note ---
    startTime: null,
    duration: null, // the ACTUAL/measured duration once known; never the beat's planned duration

    // --- source — an existing Asset (type: 'audio'), never a new asset model ---
    sourceAssetId: null,

    // --- narration-specific (meaningful only when type === 'NARRATION') ---
    scriptRefId: null, // which script line/segment this reads — same join
                         // key schemas/visual-beat-schema.js's own
                         // narrationSegment.scriptRefId already uses, so a
                         // future stage can correlate an AudioEvent's real
                         // word timestamps back to the VisualBeat(s) that
                         // share the same narration segment (Part 7)
    transcript: transcript !== undefined ? (transcript === null ? null : createTranscript(transcript)) : null,
    voiceProfile: voiceProfile !== undefined ? (voiceProfile === null ? null : createVoiceProfile(voiceProfile)) : null,

    // --- mixing-relevant structural fields (Part 9) — no mixing/ducking
    // LOGIC is implemented anywhere in this codebase; these are the future
    // contract only ---
    volume: 1, // 0-1, unenforced — schema files describe shape, never policy
    fadeIn: 0, // seconds
    fadeOut: 0, // seconds
    duckingTarget: null, // another AudioEvent's audioEventId this event
                           // should duck under at render time — only
                           // meaningful for MUSIC/AMBIENCE ducking under a
                           // NARRATION event; never resolved/applied here

    // --- provenance (mirrors how Asset already carries both sceneId and
    // shotId even though a shot implies its scene) ---
    beatId: null, // the VisualBeat this event belongs to, if any — an
                   // AMBIENCE/MUSIC bed spanning a whole scene may leave
                   // this null
    sceneId: null,

    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  AUDIO_EVENT_TYPES,
  AUDIO_EVENT_STATUSES,
  createVoiceProfile,
  createWordTimestamp,
  createTranscript,
  createAudioEvent,
};

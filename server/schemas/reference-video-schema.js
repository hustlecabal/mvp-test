// reference-video-schema.js
//
// INT-1A — the ReferenceVideo record shape: RAW EVIDENCE only (see the
// INT-1 specification's five-layer model — Raw Evidence -> Measurements ->
// Observations -> Interpretation -> Recommendation). This file describes
// what a reference video literally IS, once ingested: where it came from,
// what media/transcript/metadata was actually retrieved, and how that
// retrieval went. It contains no measurement, no observation, no
// interpretation, and no recommendation — those are later stages' schemas,
// not this one's. Same rules as every other schema file in this codebase:
// plain object factories only, no file I/O, no provider knowledge, every
// field defaults to null/[]/'' so partial data is always valid, nothing
// here invents information.
//
// RELATIONSHIP TO THE EXISTING ASSET MODEL (Part 4's explicit instruction
// — "do not create VideoAsset/ReferenceVideoAsset unless genuinely
// required"): the audit found no reason to. A downloaded reference video's
// bytes are an ordinary schemas/production-schema.js Asset (type: 'video'),
// stored through the EXISTING services/asset-storage.js — same as every
// other video in this codebase. Its extracted audio is likewise an
// ordinary Asset (type: 'audio'), same as narration audio (Stage 26.9B).
// This schema never duplicates those bytes or their storage.status
// lifecycle — it only holds `videoAssetId`/`audioAssetId` references,
// exactly the same "reference an existing Asset by id, never re-shape it"
// discipline schemas/broll-schema.js's own BRollSegment already
// established for exactly the same kind of externally-sourced media.
//
// PROVIDER NEUTRALITY (Part 3/18's explicit instruction): nothing in this
// file names Apify, or any other acquisition provider. `source.platform`
// describes the REFERENCE VIDEO's own origin (e.g. "YOUTUBE" — a fact
// about the video, not about how EVOLINK fetched it); which acquisition
// provider retrieved it lives only on `acquisition.provider`, a plain
// free-text field never read by anything in this file. No API key, no
// provider credential, no provider-internal response object is ever
// stored here — see services/reference-video-acquisition-provider-
// interface.js for the boundary this schema sits behind.

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

// A record's own ingestion outcome — separate from the underlying Assets'
// own storage.status lifecycle (NOT_ARCHIVED/STORED/FAILED, defined on the
// Asset itself). PARTIAL is a legitimate, expected outcome (Part 14): a
// missing transcript or missing engagement metadata does not, by itself,
// mean ingestion failed — only a missing/unusable VIDEO does.
const REFERENCE_VIDEO_STATUSES = ['COMPLETE', 'PARTIAL', 'FAILED'];

// Only the platforms an eventual acquisition provider could genuinely
// support are listed — never speculative. YOUTUBE is the only one any
// located Apify actor (INT-1's Part 2 audit) actually retrieves.
const PLATFORMS = ['YOUTUBE'];

// Part 10 — transcript provenance vocabulary. Exactly the three sources
// Part 8's own source hierarchy investigation named, no more:
//   PLATFORM_CAPTION      — the platform's own human/creator-authored captions
//   ACQUISITION_PROVIDER  — the provider's own transcript extraction
//                            (auto-generated captions it retrieved, or its
//                            own ASR — indistinguishable from here, hence
//                            one provenance value, never invented detail)
//   LOCAL_WHISPER         — services/voice/whisper-alignment-provider.js,
//                            run locally against the acquired audio, only
//                            as an explicit fallback (Part 8 — never
//                            silently overwrites a retrieved transcript)
const TRANSCRIPT_SOURCES = ['PLATFORM_CAPTION', 'ACQUISITION_PROVIDER', 'LOCAL_WHISPER'];

// Part 14 — the closed set of structured ingestion failures.
const ACQUISITION_DIAGNOSTIC_CODES = [
  'INVALID_REFERENCE_URL',
  'UNSUPPORTED_PLATFORM',
  'VIDEO_ACQUISITION_FAILED',
  'VIDEO_FILE_INVALID',
  'VIDEO_METADATA_UNAVAILABLE',
  'AUDIO_EXTRACTION_FAILED',
  'TRANSCRIPT_UNAVAILABLE',
  'TRANSCRIPT_INVALID',
  'TRANSCRIPT_ALIGNMENT_FAILED',
  'METADATA_UNAVAILABLE',
];

// Part 13 — one stage of the acquisition record's own audit trail.
const ACQUISITION_STAGES = ['RESOLVE_SOURCE', 'ACQUIRE_METADATA', 'ACQUIRE_VIDEO', 'ACQUIRE_AUDIO', 'ACQUIRE_TRANSCRIPT'];
const ACQUISITION_STAGE_STATUSES = ['SUCCEEDED', 'FAILED', 'SKIPPED'];

// ---------------------------------------------------------------------------
// Part 3 — SOURCE. Where the reference came from — never mixed with what
// was retrieved (that's `metadata`/media below) or how retrieval went
// (that's `acquisition` below).
// ---------------------------------------------------------------------------
function createReferenceVideoSource(overrides = {}) {
  const base = {
    originalUrl: null, // exactly as the human supplied it
    normalizedUrl: null, // canonical form used for the Part 15 idempotency key
    platform: null, // one of PLATFORMS
    externalId: null, // the platform's own video id (e.g. YouTube's 11-char id)
    channelId: null,
    channelName: null,
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 6/7 — technical media facts, MEASURED (ffprobe) only. Every field
// stays null, never guessed, when ffprobe could not determine it — exactly
// schemas/broll-schema.js's own createBrollMedia precedent ("Unknown
// metadata is represented as null, never guessed or defaulted").
// ---------------------------------------------------------------------------
function createVideoTechnicalMetadata(overrides = {}) {
  const base = {
    duration: null,
    width: null,
    height: null,
    fps: null,
    videoCodec: null,
    pixelFormat: null,
    bitrate: null,
    containerFormat: null,
    fileSizeBytes: null,
  };
  return withDefaults(base, overrides);
}

function createAudioTechnicalMetadata(overrides = {}) {
  const base = {
    duration: null,
    audioCodec: null,
    sampleRate: null,
    channels: null,
    bitrate: null,
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 11 — platform metadata, RETRIEVED (never computed) from the
// acquisition provider. publishedAt (the platform's own claim) and
// retrievedAt (when THIS system fetched it) are never conflated — engagement
// numbers are a snapshot at retrievedAt, not an immutable fact about the
// video (Part 11's explicit instruction).
// ---------------------------------------------------------------------------
function createReferenceVideoMetadata(overrides = {}) {
  const base = {
    title: null,
    description: null,
    publishedAt: null, // the platform's own claimed publish timestamp
    retrievedAt: null, // when THIS system retrieved these numbers — set by the acquisition service, never by this factory
    viewCount: null,
    likeCount: null,
    commentCount: null,
    category: null,
    tags: [],
    thumbnailUrl: null,
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 9 — provider-neutral transcript representation. Deliberately reuses
// schemas/audio-schema.js's own field names (words: [{word,startTime,
// endTime}]) rather than inventing a second, incompatible shape for the
// exact same concept — Part 9's explicit instruction. `segments` is
// additive: platform/provider captions are usually cue-level (a few
// seconds each, no word-level split), which words[] cannot represent
// without inventing timing precision the source never provided.
// ---------------------------------------------------------------------------
function createTranscriptWord(overrides = {}) {
  const base = {
    word: '',
    startTime: null,
    endTime: null,
  };
  return withDefaults(base, overrides);
}

function createTranscriptSegment(overrides = {}) {
  const base = {
    text: '',
    startTime: null,
    endTime: null,
  };
  return withDefaults(base, overrides);
}

function createReferenceTranscript(overrides = {}) {
  const { words, segments, ...rest } = overrides;
  const base = {
    text: '',
    language: null,
    source: null, // one of TRANSCRIPT_SOURCES — Part 10, never omitted once a transcript exists
    words: Array.isArray(words) ? words.map((w) => createTranscriptWord(w)) : [], // populated only when the source gives word-level timing (LOCAL_WHISPER)
    segments: Array.isArray(segments) ? segments.map((s) => createTranscriptSegment(s)) : [], // populated when the source gives cue-level timing (PLATFORM_CAPTION/ACQUISITION_PROVIDER)
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// Part 13 — the acquisition audit trail: what was requested, what
// succeeded/failed, when, from which provider. Never a provider-specific
// internal object, never a credential — see file header.
// ---------------------------------------------------------------------------
function createAcquisitionStageResult(overrides = {}) {
  const base = {
    stage: null, // one of ACQUISITION_STAGES
    status: null, // one of ACQUISITION_STAGE_STATUSES
    message: null,
    completedAt: null,
  };
  return withDefaults(base, overrides);
}

function createAcquisitionRecord(overrides = {}) {
  const { stages, ...rest } = overrides;
  const base = {
    provider: null, // free text, e.g. "apify" — never a credential, never a full provider response
    requestedAt: new Date().toISOString(),
    completedAt: null,
    stages: Array.isArray(stages) ? stages.map((s) => createAcquisitionStageResult(s)) : [],
  };
  return withDefaults(base, rest);
}

function createReferenceVideoDiagnostic(overrides = {}) {
  const base = {
    code: null, // one of ACQUISITION_DIAGNOSTIC_CODES
    message: '',
    stage: null, // one of ACQUISITION_STAGES, when the diagnostic is stage-specific
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 2 — the ReferenceVideo record itself.
// ---------------------------------------------------------------------------
function createReferenceVideo(overrides = {}) {
  const { source, metadata, videoTechnical, audioTechnical, transcript, acquisition, diagnostics, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,

    source: createReferenceVideoSource(source),
    metadata: metadata !== undefined ? (metadata === null ? null : createReferenceVideoMetadata(metadata)) : createReferenceVideoMetadata(),

    videoAssetId: null, // an existing Asset (type: 'video'), never a new binary/model
    audioAssetId: null, // an existing Asset (type: 'audio'), extracted or retrieved separately — Part 5

    videoTechnical: videoTechnical !== undefined ? (videoTechnical === null ? null : createVideoTechnicalMetadata(videoTechnical)) : createVideoTechnicalMetadata(),
    audioTechnical: audioTechnical !== undefined ? (audioTechnical === null ? null : createAudioTechnicalMetadata(audioTechnical)) : createAudioTechnicalMetadata(),

    transcript: transcript !== undefined ? (transcript === null ? null : createReferenceTranscript(transcript)) : null,

    acquisition: createAcquisitionRecord(acquisition),

    status: null, // one of REFERENCE_VIDEO_STATUSES
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createReferenceVideoDiagnostic(d)) : [],

    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
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
};

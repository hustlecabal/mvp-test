// music-acquisition-schema.js
//
// PHASE 3B — the MusicAcquisitionRequest/Result record shapes. Same rules
// as every other schema file in this codebase: plain object factories
// only, no file I/O, no provider knowledge, no runtime enum validation
// (policy belongs to services/music-acquisition-service.js, not this
// file — this file only describes shape), every field defaults to
// null/[]/'' so partial data is always valid.
//
// PATTERN, NOT REUSE: this file deliberately mirrors schemas/media-
// acquisition-schema.js's own MediaAcquisitionRequest/MediaCandidate/
// MediaAcquisitionResult shapes field-for-field wherever a field applies
// to audio (provider/searchQuery/projectId/beatId/sceneId/duration/
// format/attribution/licenseSummary/status vocabulary) and drops what
// doesn't (width/height/orientation — visual-only concepts). It is a
// SEPARATE file, never an extension of media-acquisition-schema.js,
// because Phase 3B's own scope boundary forbids any change to the
// existing, audited visual stock-media architecture — copying the
// PATTERN here keeps that architecture completely untouched while giving
// Music the exact same provider-neutral discipline.
//
// RELATIONSHIP TO THE EXISTING ASSET MODEL: an acquired music file's
// bytes are an ordinary schemas/production-schema.js Asset (type:
// 'audio' — the same type services/voice-generation-service.js's real
// NARRATION audio already uses), stored through the EXISTING
// services/asset-storage.js — never a second asset-storage abstraction.
// This schema's MusicAcquisitionResult references that Asset by
// `assetId` only.
//
// RAW AUDIO ONLY: nothing in this shape describes gain, fades, ducking,
// or any other mix/processing concern — those belong entirely to a
// future assembly/mixing layer (Phase 3D), never to acquisition.

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

// Every provider this codebase's Music provider interface currently has
// an implementation for. Extending this list, and adding one new provider
// module under services/music/, is the ONLY change needed to add a real
// provider — services/music-acquisition-service.js's own dispatch table
// is the single place that reads this list (see that file's header).
// PHASE 3C — 'ai33' is a real, credentialed adapter (services/music/ai33-
// music-provider.js); its real, live behavior today is UNAVAILABLE — no
// AI33 Pro Music generation endpoint is confirmed to exist yet (see that
// file's own header for the exact discovery evidence). Never fabricated
// to look more complete than it is.
// PHASE 3D — 'elevenlabs' is EvoLink's first REAL, WORKING Music provider
// (services/music/elevenlabs-music-provider.js), chosen after a dedicated
// provider audit ruled out AI33 (no confirmed endpoint), Mubert (real API,
// but commercial use requires a negotiated Enterprise contract, not
// self-serve), and Stability/Beatoven/Loudly (real but not selected this
// phase — see the Phase 3D provider audit for the full comparison).
const MUSIC_PROVIDERS = ['fixture', 'ai33', 'elevenlabs'];

// Mirrors schemas/media-acquisition-schema.js's own ACQUISITION_STATUSES
// vocabulary exactly — the same five terminal outcomes apply unchanged to
// an externally-sourced music search+download, never a second status
// vocabulary invented for audio.
const MUSIC_ACQUISITION_STATUSES = ['ACQUIRED', 'REJECTED_INVALID', 'PROVIDER_FAILED', 'NO_CANDIDATES', 'MISSING_CREDENTIAL', 'UNSUPPORTED_PROVIDER'];

function createMusicAcquisitionDiagnostic(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

// MusicAcquisitionRequest — provider-neutral input. No orientation/width/
// height (visual-only); minDurationSeconds/maxDurationSeconds carry over
// from the video request shape since duration is exactly as meaningful
// for a music bed as for a video clip.
//
// PHASE 3B (AI33) — instrumental/title/lyrics/tags/vocalGender are
// ADDITIVE, OPTIONAL fields for a real GENERATIVE provider's own two
// documented modes (see services/music/ai33-music-provider.js's own
// header): simple/instrumental mode uses only `searchQuery` (mapped to
// the provider's own description-prompt field) + `instrumental`; custom
// mode additionally uses `title`/`lyrics`/`tags`/`vocalGender`. A
// provider that has no use for a field (elevenlabs-music-provider.js,
// fixture) simply ignores it — no interface method changed, no second
// request shape invented. `instrumental` defaults to null (provider's
// own default applies) rather than true, so this schema itself never
// hard-codes EvoLink's own "background music is instrumental" policy —
// that policy lives in the caller (services/music-acquisition-service.js
// callers / production usage), exactly like every other policy decision
// in this file already stays out of the schema layer.
function createMusicAcquisitionRequest(overrides = {}) {
  const base = {
    provider: null, // one of MUSIC_PROVIDERS — required, never inferred/chosen here
    searchQuery: null,
    minDurationSeconds: null,
    maxDurationSeconds: null,
    maxCandidates: 5,
    projectId: null,
    beatId: null, // null is legitimate and common — a music bed is often scene/video-spanning, not beat-scoped (see schemas/audio-schema.js's own Phase 3A span-representation comment)
    sceneId: null,
    provenanceRequirement: null,
    instrumental: null, // boolean | null — null means "provider default"
    title: null, // custom-mode only
    lyrics: null, // custom-mode only — presence signals custom mode to a provider that supports both
    tags: null, // custom-mode only — free-text style/genre tags
    vocalGender: null, // custom-mode only — 'f' | 'm' | null
  };
  return withDefaults(base, overrides);
}

// One provider search candidate, BEFORE download/validation — the shape
// every services/music/*-provider.js's search() method returns.
// Provider-neutral: no provider-internal field name survives past the
// provider adapter itself.
//
// PHASE 3D — `audioBuffer` (candidate acquisition mode #2). Every provider
// through Phase 3C fit one shape: search() returns a URL, and
// services/music-acquisition-service.js fetches it separately (exactly
// media-acquisition-service.js's own corpus-search-then-download pattern).
// A GENERATIVE provider whose real contract is a single call that returns
// the finished audio bytes directly (services/music/elevenlabs-music-
// provider.js's real POST /v1/music — see that file's own header) has no
// second URL to fetch — inventing one (a localhost shim, a data: URL) would
// be exactly the fake-configuration-surface mistake Phase 3C's own review
// already rejected once for a different reason. `audioBuffer` is the
// minimal, provider-neutral alternative: a candidate carries EITHER
// `downloadUrl` (fetch it) OR `audioBuffer` (a Buffer of already-obtained
// bytes — store it directly), never both. services/asset-storage.js
// already has the generic, provider-agnostic capability this needs
// (storeUploadedAudio() — added for human-uploaded audio, Stage 26.9B,
// long before any generative Music provider existed) — this field is the
// only change required to route a candidate's bytes there instead of
// through downloadAsset().
function createMusicCandidate(overrides = {}) {
  const base = {
    providerAssetId: null,
    sourceUrl: null, // the provider's own hosted page/asset URL (attribution target)
    downloadUrl: null, // mode #1 — a URL this server will fetch itself
    audioBuffer: null, // mode #2 — a Buffer of already-obtained bytes, mutually exclusive with downloadUrl
    durationSeconds: null, // from the provider's own metadata, never guessed
    format: null, // e.g. 'wav', 'mp3' — from the provider's own metadata, never guessed
    attribution: null, // free text credit line, when the provider supplies one
    licenseSummary: null, // free text, when the provider supplies one — never invented
    // PHASE 3B (AI33) — additive, optional, provider-internal generation
    // provenance (model/version, task id, request mode, etc). Mirrors
    // services/voice/ai33-voice-provider.js's own `providerMetadata`
    // convention exactly: never part of any interface contract, ignored
    // by every provider that has no use for it (elevenlabs, fixture),
    // carried through by services/music-acquisition-service.js onto the
    // final MusicAcquisitionResult only when a provider sets it.
    providerMetadata: null,
  };
  return withDefaults(base, overrides);
}

// MusicAcquisitionResult — the durable, provenance-complete record.
// `diagnostics` is populated on every non-ACQUIRED status.
function createMusicAcquisitionResult(overrides = {}) {
  const { diagnostics, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    status: null, // one of MUSIC_ACQUISITION_STATUSES
    projectId: null,
    beatId: null,
    sceneId: null,
    assetId: null, // the registered Asset (schemas/production-schema.js) — null unless status === 'ACQUIRED'
    provider: null,
    providerAssetId: null,
    sourceUrl: null,
    downloadUrl: null,
    durationSeconds: null,
    format: null,
    attribution: null,
    licenseSummary: null,
    searchQuery: null,
    checksum: null, // 'sha256:<hex>' — null unless status === 'ACQUIRED'
    acquiredAt: new Date().toISOString(),
    providerMetadata: null, // additive, optional — see createMusicCandidate()'s own comment
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createMusicAcquisitionDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

module.exports = {
  MUSIC_PROVIDERS,
  MUSIC_ACQUISITION_STATUSES,
  createMusicAcquisitionDiagnostic,
  createMusicAcquisitionRequest,
  createMusicCandidate,
  createMusicAcquisitionResult,
};

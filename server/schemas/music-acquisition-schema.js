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
const MUSIC_PROVIDERS = ['fixture', 'ai33'];

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
  };
  return withDefaults(base, overrides);
}

// One provider search candidate, BEFORE download/validation — the shape
// every services/music/*-provider.js's search() method returns.
// Provider-neutral: no provider-internal field name survives past the
// provider adapter itself.
function createMusicCandidate(overrides = {}) {
  const base = {
    providerAssetId: null,
    sourceUrl: null, // the provider's own hosted page/asset URL (attribution target)
    downloadUrl: null, // the actual bytes URL this server will fetch
    durationSeconds: null, // from the provider's own metadata, never guessed
    format: null, // e.g. 'wav', 'mp3' — from the provider's own metadata, never guessed
    attribution: null, // free text credit line, when the provider supplies one
    licenseSummary: null, // free text, when the provider supplies one — never invented
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

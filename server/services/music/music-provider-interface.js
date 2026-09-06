// music-provider-interface.js
//
// PHASE 3B — the contract every MUSIC provider adapter (a real library/
// generation API, or the deterministic test fixture) must implement.
// Mirrors services/media-acquisition/stock-media-provider-interface.js's
// exact convention (a REQUIRED_METHODS list + an assert helper + a
// provider-neutral result shape) — the same pattern this codebase already
// uses to keep a provider swap from ever requiring a change to the
// caller. Deliberately a SEPARATE file/interface from stock-media's own —
// Phase 3B's scope boundary forbids touching the existing, audited visual
// stock-media architecture; this file copies its PATTERN, never its code.
//
// A provider exposes exactly one operation:
//
//   search(request) -> MusicSearchResult
//
// `request` is a schemas/music-acquisition-schema.js
// createMusicAcquisitionRequest() object. `search` must be read-only from
// this codebase's point of view — it performs the provider's own remote
// search (or, for the fixture, in-memory) call, but it never downloads
// audio bytes and never writes anything to disk; downloading is
// services/music-acquisition-service.js's own job, via the EXISTING
// services/asset-storage.js — exactly the same acquisition/download split
// stock-media-provider-interface.js already established.
//
// RAW AUDIO ONLY (Phase 3B's own non-negotiable boundary): a provider
// returns WHERE to obtain source audio and its own reported metadata —
// never a gain/fade/ducking/loudness decision. Those belong entirely to a
// future mixing layer (Phase 3D), never to this interface or its
// implementers.
//
// NO PROVIDER CREDENTIAL, NO PROVIDER-INTERNAL RESPONSE OBJECT ever
// appears in a MusicSearchResult — only schemas/music-acquisition-
// schema.js's createMusicCandidate() shape.

const { createMusicCandidate } = require('../../schemas/music-acquisition-schema');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

const REQUIRED_METHODS = ['search'];

// Mirrors stock-media-provider-interface.js's SEARCH_RESULT_STATUSES
// exactly (same four values, same meaning) — never a second status
// vocabulary invented for this interface.
const MUSIC_SEARCH_STATUSES = ['COMPLETED', 'UNAVAILABLE', 'UNSUPPORTED', 'FAILED'];

function createMusicSearchDiagnostic(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

// MusicSearchResult — `candidates` is ALWAYS already provider-neutral
// (createMusicCandidate() shape) by the time it leaves a provider
// adapter; this interface file, not each adapter individually, owns
// normalizing that. `candidates` is never re-ordered here — a provider
// returns its own relevance order, and services/music-acquisition-
// service.js always takes candidates[0], deterministically, never a
// random/weighted pick — the same discipline media-acquisition-
// service.js already established for stock media.
function createMusicSearchResult(overrides = {}) {
  const { diagnostics, candidates, ...rest } = overrides;
  const base = {
    status: null, // one of MUSIC_SEARCH_STATUSES
    candidates: Array.isArray(candidates) ? candidates.map((c) => createMusicCandidate(c)) : [],
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createMusicSearchDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

function assertImplementsMusicProviderInterface(provider) {
  for (const method of REQUIRED_METHODS) {
    if (!provider || typeof provider[method] !== 'function') {
      throw new Error(`Music provider is missing required method: ${method}()`);
    }
  }
}

module.exports = {
  REQUIRED_METHODS,
  MUSIC_SEARCH_STATUSES,
  createMusicSearchDiagnostic,
  createMusicSearchResult,
  assertImplementsMusicProviderInterface,
};

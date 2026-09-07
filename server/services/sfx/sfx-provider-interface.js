// sfx-provider-interface.js
//
// PHASE 3E — the contract every SFX provider adapter (a real generation
// API, a stock library, or the deterministic test fixture) must
// implement. Mirrors services/music/music-provider-interface.js's exact
// convention — the Phase 3E audit's own conclusion (§6) was that SFX
// acquisition needs no new interface shape, only a new file for the new
// domain. This file never imports music-provider-interface.js and never
// touches it.
//
// A provider exposes exactly one operation:
//
//   search(request) -> SfxSearchResult
//
// `request` is a schemas/sfx-acquisition-schema.js
// createSfxAcquisitionRequest() object. `search` is read-only from this
// codebase's point of view for a URL-backed provider; for a GENERATIVE
// provider (services/sfx/elevenlabs-sfx-provider.js) it performs the
// actual generation call and returns the resulting bytes as
// `audioBuffer` — see schemas/sfx-acquisition-schema.js's own header for
// why that is a legitimate reading of "search()" for a provider with no
// separate corpus to search.

const { createSfxCandidate } = require('../../schemas/sfx-acquisition-schema');

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

// Mirrors stock-media-provider-interface.js's / music-provider-
// interface.js's SEARCH_RESULT_STATUSES exactly.
const SFX_SEARCH_STATUSES = ['COMPLETED', 'UNAVAILABLE', 'UNSUPPORTED', 'FAILED'];

function createSfxSearchDiagnostic(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

function createSfxSearchResult(overrides = {}) {
  const { diagnostics, candidates, ...rest } = overrides;
  const base = {
    status: null, // one of SFX_SEARCH_STATUSES
    candidates: Array.isArray(candidates) ? candidates.map((c) => createSfxCandidate(c)) : [],
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createSfxSearchDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

function assertImplementsSfxProviderInterface(provider) {
  for (const method of REQUIRED_METHODS) {
    if (!provider || typeof provider[method] !== 'function') {
      throw new Error(`SFX provider is missing required method: ${method}()`);
    }
  }
}

module.exports = {
  REQUIRED_METHODS,
  SFX_SEARCH_STATUSES,
  createSfxSearchDiagnostic,
  createSfxSearchResult,
  assertImplementsSfxProviderInterface,
};

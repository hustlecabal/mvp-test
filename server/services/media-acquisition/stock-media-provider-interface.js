// stock-media-provider-interface.js
//
// The contract every STOCK MEDIA provider adapter (Pexels, Pixabay, the
// fake test provider, and any future one) must implement. Mirrors
// services/reference-video/acquisition-provider-interface.js's exact
// convention (a REQUIRED_METHODS list + an assert helper + a
// provider-neutral result shape) — the same pattern this codebase already
// uses so a provider swap never requires a change to the caller
// (services/media-acquisition-service.js never reads a provider-shaped
// response directly, only this interface's own result shape).
//
// A provider exposes exactly one operation:
//
//   search(request) -> MediaSearchResult
//
// `request` is a schemas/media-acquisition-schema.js createMediaAcquisitionRequest()
// object. `search` must be read-only from this codebase's point of view —
// it performs the provider's own remote search call, but it never
// downloads media bytes and never writes anything to disk; downloading is
// services/media-acquisition-service.js's own job, via the EXISTING
// services/asset-storage.js, exactly like every other acquisition path in
// this codebase (reference-video-ingestion-service.js's own
// acquireVideo()/downloadAsset() split is the direct precedent).
//
// NO PROVIDER CREDENTIAL, NO PROVIDER-INTERNAL RESPONSE OBJECT ever
// appears in a MediaSearchResult — only schemas/media-acquisition-
// schema.js's createMediaCandidate() shape.

const { createMediaCandidate } = require('../../schemas/media-acquisition-schema');

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

// Mirrors acquisition-provider-interface.js's ACQUISITION_RESULT_STATUSES
// exactly (same four values, same meaning) — never a second status
// vocabulary invented for this interface.
const SEARCH_RESULT_STATUSES = ['COMPLETED', 'UNAVAILABLE', 'UNSUPPORTED', 'FAILED'];

function createSearchDiagnostic(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

// MediaSearchResult — `candidates` is ALWAYS already provider-neutral
// (createMediaCandidate() shape) by the time it leaves a provider adapter;
// this interface file, not each adapter individually, owns normalizing
// that. `candidates` is never re-ordered here — a provider returns its own
// relevance order, and services/media-acquisition-service.js always takes
// candidates[0], deterministically, never a random/weighted pick.
function createMediaSearchResult(overrides = {}) {
  const { diagnostics, candidates, ...rest } = overrides;
  const base = {
    status: null, // one of SEARCH_RESULT_STATUSES
    candidates: Array.isArray(candidates) ? candidates.map((c) => createMediaCandidate(c)) : [],
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createSearchDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

function assertImplementsStockMediaProviderInterface(provider) {
  for (const method of REQUIRED_METHODS) {
    if (!provider || typeof provider[method] !== 'function') {
      throw new Error(`Stock media provider is missing required method: ${method}()`);
    }
  }
}

module.exports = {
  REQUIRED_METHODS,
  SEARCH_RESULT_STATUSES,
  createSearchDiagnostic,
  createMediaSearchResult,
  assertImplementsStockMediaProviderInterface,
};

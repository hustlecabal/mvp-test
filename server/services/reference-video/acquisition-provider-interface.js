// acquisition-provider-interface.js
//
// INT-1A, Part 18 — the contract every REFERENCE VIDEO ACQUISITION
// provider adapter must implement. Mirrors services/voice/voice-provider-
// interface.js's exact convention (a REQUIRED_METHODS list + an assert
// helper + provider-neutral result shapes) — the same pattern this
// codebase already uses to keep a provider swap from ever requiring a
// change to the caller (services/reference-video-ingestion-service.js).
//
// APIFY IS AN ACQUISITION PROVIDER. IT IS NOT THE INTELLIGENCE LAYER. This
// file is the boundary that makes that true in code, not just in
// documentation: services/reference-video-ingestion-service.js never
// imports Apify-specific types or reads an Apify-shaped response directly
// — it only ever calls these four methods and reads their provider-neutral
// results.
//
// A provider exposes up to four independent operations. Part 18's own
// instruction — "do not unnecessarily implement every operation if the
// actual provider does not support it" — means a provider MAY return a
// structured UNSUPPORTED result from any of these rather than throwing;
// resolveSource is the one operation every provider must implement
// (there is no useful acquisition without first knowing whether a source
// is even resolvable), so it alone is in REQUIRED_METHODS. The other three
// are asserted separately by assertImplementsAcquisitionProviderInterface's
// `optional` check — present as functions (even if they always return
// UNSUPPORTED), never silently absent, so a caller's typeof-check never
// has to special-case a missing method.
//
//   resolveSource({ url })       -> SourceResolution
//   acquireMetadata({ source })  -> MetadataAcquisitionResult
//   acquireVideo({ source, outputDir }) -> VideoAcquisitionResult
//   acquireTranscript({ source }) -> TranscriptAcquisitionResult
//
// Every result is provider-neutral by construction: no provider name, no
// API key, no provider-internal response object ever appears in one (see
// schemas/reference-video-schema.js's own header for the same rule on the
// persisted record these results feed).

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

const REQUIRED_METHODS = ['resolveSource'];
const OPTIONAL_METHODS = ['acquireMetadata', 'acquireVideo', 'acquireTranscript'];

const ACQUISITION_RESULT_STATUSES = ['COMPLETED', 'UNAVAILABLE', 'UNSUPPORTED', 'FAILED'];

function createAcquisitionDiagnostic(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

// SourceResolution — Part 3's SOURCE fields only, never media/metadata.
function createSourceResolution(overrides = {}) {
  const { diagnostics, ...rest } = overrides;
  const base = {
    status: null, // one of ACQUISITION_RESULT_STATUSES
    platform: null,
    externalId: null,
    normalizedUrl: null,
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createAcquisitionDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

// MetadataAcquisitionResult — Part 11's fields, RETRIEVED only, plus an
// optional transcript when the provider bundles the two in one call (Part
// 18's own "do not unnecessarily implement" — a provider that bundles
// metadata+transcript may populate `transcript` here and let
// acquireTranscript() return UNAVAILABLE/COMPLETED-from-cache; the
// ingestion service never assumes which shape a given provider uses).
function createMetadataAcquisitionResult(overrides = {}) {
  const { diagnostics, ...rest } = overrides;
  const base = {
    status: null,
    metadata: null, // schemas/reference-video-schema.js's createReferenceVideoMetadata() shape, or null
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createAcquisitionDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

// VideoAcquisitionResult — a resolvable reference, never bytes inline.
// `resultUrl` is the PROVIDER's own hosted URL for the downloaded video
// (e.g. Apify's key-value store, never YouTube's CDN directly — see
// apify-acquisition-provider.js's header for why that matters for SSRF).
// Pulling it into permanent Asset storage is the ingestion service's job,
// via the EXISTING services/asset-storage.js's downloadAsset() — exactly
// the same split of responsibility services/asset-archive-service.js
// already uses for a generation job's own result URL (Stage 9A): a
// provider/job hands back a reference, orchestration downloads it.
function createVideoAcquisitionResult(overrides = {}) {
  const { diagnostics, ...rest } = overrides;
  const base = {
    status: null,
    resultUrl: null,
    // P0 Golden Run Blocker Repair, Blocker A — optional plain object of
    // extra request headers the caller must send when downloading
    // `resultUrl` (e.g. an Apify-hosted result requires the account's own
    // token). null for a provider whose result URL needs no auth (e.g. a
    // public CDN URL) — never required, never provider-specific by name
    // here (this file stays provider-neutral; only the concrete provider
    // adapter that issues resultUrl knows what it needs).
    resultAuthHeaders: null,
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createAcquisitionDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

// TranscriptAcquisitionResult — Part 9's provider-neutral transcript
// shape, RETRIEVED (never Whisper-generated — that fallback lives in
// services/reference-video-ingestion-service.js itself via the EXISTING
// services/voice/whisper-alignment-provider.js, never inside a provider
// adapter, so provenance stays unambiguous per Part 10).
function createTranscriptAcquisitionResult(overrides = {}) {
  const { diagnostics, ...rest } = overrides;
  const base = {
    status: null,
    transcript: null, // schemas/reference-video-schema.js's createReferenceTranscript() shape (source left for the caller to stamp), or null
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createAcquisitionDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

function assertImplementsAcquisitionProviderInterface(provider) {
  for (const method of REQUIRED_METHODS) {
    if (!provider || typeof provider[method] !== 'function') {
      throw new Error(`Acquisition provider is missing required method: ${method}()`);
    }
  }
  for (const method of OPTIONAL_METHODS) {
    if (!provider || typeof provider[method] !== 'function') {
      throw new Error(`Acquisition provider is missing method: ${method}() — implement it (even if it always returns UNSUPPORTED) rather than omitting it`);
    }
  }
}

module.exports = {
  REQUIRED_METHODS,
  OPTIONAL_METHODS,
  ACQUISITION_RESULT_STATUSES,
  createAcquisitionDiagnostic,
  createSourceResolution,
  createMetadataAcquisitionResult,
  createVideoAcquisitionResult,
  createTranscriptAcquisitionResult,
  assertImplementsAcquisitionProviderInterface,
};

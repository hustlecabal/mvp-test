// media-acquisition-schema.js
//
// MEDIA ACQUISITION — the MediaAcquisitionRequest/Result record shapes.
// Same rules as every other schema file in this codebase: plain object
// factories only, no file I/O, no provider knowledge, no runtime enum
// validation (policy belongs to services/media-acquisition-service.js, not
// this file — this file only describes shape), every field defaults to
// null/[]/'' so partial data is always valid.
//
// BOUNDARY (see services/media-acquisition-service.js's own header):
// Material Resolution decides WHAT kind of material a beat needs. Media
// Acquisition decides HOW to obtain externally-sourced material satisfying
// that decision. This schema is Media Acquisition's own request/result
// shape — it is never a MaterialComponent, never a BRollSegment, and this
// file never imports schemas/visual-beat-schema.js or
// schemas/broll-schema.js.
//
// RELATIONSHIP TO THE EXISTING ASSET MODEL (same discipline
// schemas/broll-schema.js and schemas/reference-video-schema.js already
// established for exactly this kind of externally-sourced media): an
// acquired file's bytes are an ordinary schemas/production-schema.js Asset
// (type 'keyframe' for an image, 'video' for a clip), stored through the
// EXISTING services/asset-storage.js — never a second asset-storage
// abstraction. This schema's MediaAcquisitionResult references that Asset
// by `assetId` only; it never duplicates the bytes or the storage.status
// lifecycle.
//
// PROVIDER NEUTRALITY: `provider` is a plain string identifying WHICH
// stock-media provider satisfied a request (e.g. 'pexels', 'pixabay') —
// never a credential, never a provider-internal response object, never
// read by anything outside services/media-acquisition-service.js and
// services/media-acquisition-store.js.

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

// The two media types Media Acquisition can obtain — deliberately just
// these two (Objective #1 in this stage's own instructions: "BOTH stock
// images and stock video"), never a third guessed value.
const MEDIA_TYPES = ['image', 'video'];

// Every provider this codebase's MediaProvider interface currently has an
// implementation for. Extending this list, and adding one new provider
// module under services/media-acquisition/, is the ONLY change needed to
// add a provider — services/media-acquisition-service.js's own dispatch
// table is the single place that reads this list (see that file's header).
const PROVIDERS = ['pexels', 'pixabay', 'fake-stock-media'];

// A request's own terminal outcome.
//   ACQUIRED         — a candidate was found, downloaded, and validated
//   REJECTED_INVALID — a candidate was downloaded but failed asset
//                       validation (never silently accepted)
//   PROVIDER_FAILED  — the provider's search/download call itself failed
//                       (network error, non-2xx, malformed response)
//   NO_CANDIDATES    — the provider search succeeded but returned zero
//                       usable results
//   MISSING_CREDENTIAL — the requested provider has no credential
//                       configured in this environment
//   UNSUPPORTED_PROVIDER — the requested provider name is not one of
//                       PROVIDERS, or does not support the requested
//                       media_type
const ACQUISITION_STATUSES = ['ACQUIRED', 'REJECTED_INVALID', 'PROVIDER_FAILED', 'NO_CANDIDATES', 'MISSING_CREDENTIAL', 'UNSUPPORTED_PROVIDER'];

function createAcquisitionDiagnostic(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// MediaAcquisitionRequest — provider-neutral input. Every field this
// stage's own instructions list as "at minimum" required, plus the
// provider selection itself (Objective/Boundary: Media Acquisition never
// silently picks a provider Material Resolution/the caller didn't name —
// see the "DO NOT IMPLEMENT AUTOMATIC PROVIDER FALLBACK" rule in
// services/media-acquisition-service.js).
// ---------------------------------------------------------------------------
function createMediaAcquisitionRequest(overrides = {}) {
  const base = {
    provider: null, // one of PROVIDERS — required, never inferred/chosen here
    mediaType: null, // one of MEDIA_TYPES
    searchQuery: null,
    orientation: null, // free text ('landscape' | 'portrait' | 'square'), provider-neutral; a provider adapter maps this onto its own vocabulary, or ignores it if unsupported
    minDurationSeconds: null, // video only
    maxDurationSeconds: null, // video only
    minWidth: null,
    minHeight: null,
    maxCandidates: 5,
    projectId: null,
    beatId: null,
    sceneId: null,
    // Free-text provenance requirement the caller expects the acquired
    // asset to satisfy (e.g. 'commercial-use'). Never enforced by this
    // schema — a later stage's validator/licensing gate is where any real
    // enforcement would live; this field only carries the caller's intent
    // through to the persisted provenance record.
    provenanceRequirement: null,
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// A single provider search candidate, BEFORE download/validation — the
// shape every services/media-acquisition/*-provider.js's search() method
// returns, one entry per result. Provider-neutral: no provider-internal
// field name survives past the provider adapter itself.
// ---------------------------------------------------------------------------
function createMediaCandidate(overrides = {}) {
  const base = {
    providerAssetId: null,
    sourceUrl: null, // the provider's own hosted page/asset URL (attribution target)
    downloadUrl: null, // the actual bytes URL this server will fetch
    width: null,
    height: null,
    durationSeconds: null, // video only
    format: null, // e.g. 'jpeg', 'mp4' — from the provider's own metadata, never guessed
    attribution: null, // free text credit line, when the provider supplies one
    licenseSummary: null, // free text, when the provider supplies one — never invented
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// MediaAcquisitionResult — the durable, provenance-complete record this
// stage's own instructions require. `diagnostics` is populated on every
// non-ACQUIRED status, per the "return a structured provider failure,
// preserve the failure reason" rule (never a bare boolean/thrown error).
// ---------------------------------------------------------------------------
function createMediaAcquisitionResult(overrides = {}) {
  const { diagnostics, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    status: null, // one of ACQUISITION_STATUSES
    projectId: null,
    beatId: null,
    sceneId: null,
    assetId: null, // the registered Asset (schemas/production-schema.js) — null unless status === 'ACQUIRED'
    provider: null,
    providerAssetId: null,
    mediaType: null, // one of MEDIA_TYPES
    sourceUrl: null,
    downloadUrl: null,
    width: null,
    height: null,
    durationSeconds: null,
    format: null,
    attribution: null,
    licenseSummary: null,
    searchQuery: null,
    checksum: null, // 'sha256:<hex>' — null unless status === 'ACQUIRED'
    acquiredAt: new Date().toISOString(),
    fromCache: false, // true when this result reused a previously-downloaded asset for the same (provider, providerAssetId) rather than downloading again
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createAcquisitionDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

module.exports = {
  MEDIA_TYPES,
  PROVIDERS,
  ACQUISITION_STATUSES,
  createAcquisitionDiagnostic,
  createMediaAcquisitionRequest,
  createMediaCandidate,
  createMediaAcquisitionResult,
};

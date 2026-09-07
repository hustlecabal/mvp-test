// sfx-acquisition-schema.js
//
// PHASE 3E — the SfxAcquisitionRequest/Result record shapes. Same rules as
// every other schema file in this codebase: plain object factories only,
// no file I/O, no provider knowledge, no runtime enum validation (policy
// belongs to services/sfx-acquisition-service.js, not this file), every
// field defaults to null/[]/'' so partial data is always valid.
//
// PATTERN, NOT REUSE: this file mirrors schemas/music-acquisition-
// schema.js field-for-field — the Phase 3E architecture audit's own
// conclusion (its §6, "Provider strategy") was that SFX/AMBIENCE
// acquisition mechanics are identical to MUSIC's (search a provider, get
// a candidate, obtain bytes via a URL or directly, register an Asset) and
// only the REQUEST'S TYPICAL USE differs, not the shape. Copying the
// pattern here is not touching schemas/music-acquisition-schema.js, and
// this file never imports it.
//
// NO NEW FIELDS (Phase 3E's own explicit instruction): every field below
// is a direct copy of MusicAcquisitionRequest/Candidate/Result. If a real
// SFX requirement is later discovered that these fields cannot express,
// that is a finding for a future stage — this stage's own audit concluded
// none exists yet.

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

// PHASE 3E — 'elevenlabs' is a real, credentialed adapter (services/sfx/
// elevenlabs-sfx-provider.js) using the REAL, verified POST /v1/sound-
// generation endpoint (see that file's own header for the exact contract
// evidence). Reuses the SAME EVOLINK_ELEVENLABS_API_KEY credential as
// services/music/elevenlabs-music-provider.js — not a violation of "never
// reuse a credential" (that rule was about never conflating AI33's proxy
// credential with a genuinely different ElevenLabs one; here Sound
// Effects and Music are two endpoints of the literal same ElevenLabs
// account, so one real credential legitimately serves both).
const SFX_PROVIDERS = ['fixture', 'elevenlabs'];

// Mirrors schemas/music-acquisition-schema.js's own ACQUISITION_STATUSES
// vocabulary exactly.
const SFX_ACQUISITION_STATUSES = ['ACQUIRED', 'REJECTED_INVALID', 'PROVIDER_FAILED', 'NO_CANDIDATES', 'MISSING_CREDENTIAL', 'UNSUPPORTED_PROVIDER'];

function createSfxAcquisitionDiagnostic(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

// SfxAcquisitionRequest — provider-neutral input, identical shape to
// MusicAcquisitionRequest. minDurationSeconds/maxDurationSeconds are as
// meaningful for a one-shot SFX hit as for a music bed (a provider like
// ElevenLabs Sound Effects accepts a target duration in seconds).
function createSfxAcquisitionRequest(overrides = {}) {
  const base = {
    provider: null, // one of SFX_PROVIDERS — required, never inferred/chosen here
    searchQuery: null,
    minDurationSeconds: null,
    maxDurationSeconds: null,
    maxCandidates: 5,
    projectId: null,
    beatId: null, // the usual SFX case — a one-shot tied to a specific beat
    sceneId: null,
    provenanceRequirement: null,
  };
  return withDefaults(base, overrides);
}

// One provider search candidate, BEFORE download/validation.
function createSfxCandidate(overrides = {}) {
  const base = {
    providerAssetId: null,
    sourceUrl: null,
    downloadUrl: null, // mode #1 — a URL this server will fetch
    audioBuffer: null, // mode #2 — a Buffer of already-obtained bytes, mutually exclusive with downloadUrl (see schemas/music-acquisition-schema.js's own header for why this exists)
    durationSeconds: null,
    format: null,
    attribution: null,
    licenseSummary: null,
  };
  return withDefaults(base, overrides);
}

// SfxAcquisitionResult — the durable, provenance-complete record.
function createSfxAcquisitionResult(overrides = {}) {
  const { diagnostics, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    status: null, // one of SFX_ACQUISITION_STATUSES
    projectId: null,
    beatId: null,
    sceneId: null,
    assetId: null,
    provider: null,
    providerAssetId: null,
    sourceUrl: null,
    downloadUrl: null,
    durationSeconds: null,
    format: null,
    attribution: null,
    licenseSummary: null,
    searchQuery: null,
    checksum: null,
    acquiredAt: new Date().toISOString(),
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createSfxAcquisitionDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

module.exports = {
  SFX_PROVIDERS,
  SFX_ACQUISITION_STATUSES,
  createSfxAcquisitionDiagnostic,
  createSfxAcquisitionRequest,
  createSfxCandidate,
  createSfxAcquisitionResult,
};

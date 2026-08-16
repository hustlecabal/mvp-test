// voice-provider-interface.js
//
// Stage 26.9B, Part 3 — the contract every VOICE GENERATION provider
// adapter must implement. Mirrors providers/image-provider-interface.js's
// exact convention (a REQUIRED_METHODS list + an assert helper + a shared
// generic result shape) — the same pattern this codebase already uses to
// keep a provider swap from ever requiring a change to the caller.
//
// A provider must expose exactly one operation:
//
//   generateVoice({ narrationDirection, outputPath }) -> VoiceGenerationResult
//
// `narrationDirection` is the REAL, unmodified schemas/narration-schema.js
// NarrationDirection produced by services/narration-director-service.js —
// a provider adapter TRANSLATES it into provider-specific controls (pace,
// pitch, SSML breaks/emphasis/pronunciation, ...) but never rewrites the
// direction itself (Stage 26.9B Part 4: "the adapter translates the
// direction, it does not rewrite it").
//
// The RESULT is provider-neutral by construction: `status`, `audioPath`,
// `duration`, `diagnostics` only — no provider name, no voice ID, no
// credentials, no raw API response ever appears in it.

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

const REQUIRED_METHODS = ['generateVoice'];

const VOICE_GENERATION_STATUSES = ['COMPLETED', 'FAILED'];

function createVoiceDiagnostic(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

// duration is the REAL, measured duration of the generated audio file
// (Stage 26.9B Part 6: "do not guess duration") — null when status: FAILED.
function createVoiceGenerationResult(overrides = {}) {
  const { diagnostics, ...rest } = overrides;
  const base = {
    status: null, // one of VOICE_GENERATION_STATUSES
    audioPath: null, // absolute path to the generated audio file, null when FAILED
    duration: null, // seconds — real, ffprobe-measured, never estimated
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createVoiceDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

function assertImplementsVoiceProviderInterface(provider) {
  for (const method of REQUIRED_METHODS) {
    if (!provider || typeof provider[method] !== 'function') {
      throw new Error(`Voice provider is missing required method: ${method}()`);
    }
  }
}

module.exports = {
  REQUIRED_METHODS,
  VOICE_GENERATION_STATUSES,
  createVoiceDiagnostic,
  createVoiceGenerationResult,
  assertImplementsVoiceProviderInterface,
};

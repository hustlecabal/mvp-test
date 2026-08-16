// alignment-provider-interface.js
//
// Stage 26.9B, Part 8 — the contract every WORD-LEVEL ALIGNMENT provider
// adapter must implement. Same convention as voice-provider-interface.js/
// providers/image-provider-interface.js (REQUIRED_METHODS + an assert
// helper + a shared generic result shape).
//
// A provider must expose exactly one operation:
//
//   alignAudio({ audioPath }) -> AlignmentResult
//
// Alignment is independent ASR — it never receives the "expected" script
// text; comparing what it actually heard against the original narration
// text is a SEPARATE, later, deterministic step (Stage 26.9B Part 12 —
// services/voice/voice-generation-service.js's own script/audio
// consistency check), never something an alignment provider does itself.
//
// The result's `words[]` entries are the exact shape services/voice/
// voice-generation-service.js turns into schemas/audio-schema.js's own
// createWordTimestamp() entries — {word, start, end} — `confidence` is
// carried separately (Part 9: "if confidence is available, it may be
// stored only if the existing schema supports it without redesign" —
// WordTimestamp does NOT have a confidence field, so it is never forced
// into it; it stays here, on the adapter-level AlignmentResult, available
// for services/voice/voice-generation-service.js's own consistency checks
// without leaking into the core audio schema).

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

const REQUIRED_METHODS = ['alignAudio'];

const ALIGNMENT_STATUSES = ['COMPLETED', 'FAILED'];

function createAlignmentDiagnostic(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

function createAlignedWord(overrides = {}) {
  const base = { word: '', start: null, end: null, confidence: null };
  return withDefaults(base, overrides);
}

function createAlignmentResult(overrides = {}) {
  const { words, diagnostics, ...rest } = overrides;
  const base = {
    status: null, // one of ALIGNMENT_STATUSES
    language: null,
    words: Array.isArray(words) ? words.map((w) => createAlignedWord(w)) : [],
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createAlignmentDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

function assertImplementsAlignmentProviderInterface(provider) {
  for (const method of REQUIRED_METHODS) {
    if (!provider || typeof provider[method] !== 'function') {
      throw new Error(`Alignment provider is missing required method: ${method}()`);
    }
  }
}

module.exports = {
  REQUIRED_METHODS,
  ALIGNMENT_STATUSES,
  createAlignedWord,
  createAlignmentDiagnostic,
  createAlignmentResult,
  assertImplementsAlignmentProviderInterface,
};

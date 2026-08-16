// interpretation-provider-interface.js
//
// INT-1D, Part 16 — the contract every INTERPRETATION (reasoning) provider
// adapter must implement. Mirrors services/reference-video/acquisition-
// provider-interface.js's exact convention (a REQUIRED_METHODS list + an
// assert helper + provider-neutral request/result shapes) — the same
// pattern this codebase already uses to keep a provider swap from ever
// requiring a change to the caller (services/reference-video-
// interpretation-service.js never imports a vendor SDK or reads a
// vendor-shaped response directly).
//
// Part 5's LLM BOUNDARY, enforced by this file's own shape: a provider's
// `interpret(input)` receives ONLY an InterpretationInput built entirely
// from already-persisted EVOLINK evidence (see createInterpretationInput
// below) — there is no field anywhere in this file through which a
// provider could receive network access, a file path, or a tool-call
// capability. A provider that wanted to "call Apify" or "call FFmpeg"
// would have to import those modules itself, which every test in this
// stage's security suite greps for and fails on.

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

const REQUIRED_METHODS = ['interpret'];

const PROVIDER_RESULT_STATUSES = ['COMPLETED', 'UNAVAILABLE', 'INVALID', 'TIMEOUT', 'FAILED'];

// Part 6 — the fixed, always-identical constraint list every provider is
// told to follow (Part 15's own 10-point list, restated here as the one
// canonical source both the real prompt-builder and every test assert
// against, rather than letting the wording drift between files).
const INTERPRETATION_CONSTRAINTS = [
  'Use ONLY the supplied evidence — never invent a measurement, timestamp, or transcript content that was not provided.',
  'Cite the observationId of every Observation your hypothesis relies on.',
  'Distinguish fact/observation (already measured/derived) from your own inference — your role is only the inference.',
  'Explicitly state your uncertainty; do not present a hypothesis as settled fact.',
  'Provide at least one alternative explanation when the evidence plausibly supports more than one.',
  'Identify any supplied evidence that weakens or narrows your primary hypothesis (counter-evidence) — do not reason in a confirmation-only direction.',
  'Never claim creator intent as fact (e.g. "the creator deliberately..."). Frame structural claims as consistent-with, not as intent.',
  'Never produce a quality judgment, score, or rating of any kind.',
  'Never produce a recommendation or suggest any action.',
  'If the supplied evidence is insufficient, contradictory, or does not support any reasonable hypothesis, say so explicitly rather than fabricating one.',
];

function createInterpretationDiagnostic(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 6 — the structured request. A provider NEVER receives the full raw
// ReferenceVideo/Measurements/Observation records — only the fields
// relevant to the question being asked, selected by services/reference-
// video-interpretation-service.js's own input builder. `referenceVideo`
// carries only display metadata (title/description/platform) — never an
// acquisition record, never a credential, never a file path.
// ---------------------------------------------------------------------------
function createInterpretationEvidenceObservation(overrides = {}) {
  const base = {
    observationId: null,
    category: null,
    statement: '',
    confidence: null,
  };
  return withDefaults(base, overrides);
}

function createInterpretationInput(overrides = {}) {
  const { observations, constraints, ...rest } = overrides;
  const base = {
    questionId: null,
    question: '',
    referenceVideo: { title: null, description: null, platform: null }, // display metadata ONLY — untrusted DATA, see Part 25 / the real provider's own prompt-boundary handling
    measurements: {}, // a plain object of the SELECTED relevant measurement values only (see the service's own selection logic)
    observations: Array.isArray(observations) ? observations.map((o) => createInterpretationEvidenceObservation(o)) : [],
    constraints: Array.isArray(constraints) ? [...constraints] : [...INTERPRETATION_CONSTRAINTS],
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// Part 7 — the structured output contract. A provider's raw response
// (however it produced it — tool-use JSON, parsed prose, a fake canned
// object) is normalized into exactly this shape before the service will
// even attempt semantic validation. Anything that cannot be coerced into
// this shape is INTERPRETATION_INVALID — never best-effort repaired.
// ---------------------------------------------------------------------------
function createInterpretationProviderResult(overrides = {}) {
  const { supportingObservationIds, counterObservationIds, alternativeHypotheses, limitations, diagnostics, ...rest } = overrides;
  const base = {
    status: null, // one of PROVIDER_RESULT_STATUSES
    hypothesis: null,
    reasoning: null,
    supportingObservationIds: Array.isArray(supportingObservationIds) ? [...supportingObservationIds] : [],
    counterObservationIds: Array.isArray(counterObservationIds) ? [...counterObservationIds] : [],
    alternativeHypotheses: Array.isArray(alternativeHypotheses) ? alternativeHypotheses.map((a) => ({ hypothesis: a.hypothesis || '', reasoning: a.reasoning || '' })) : [],
    confidence: null, // the PROVIDER's own stated confidence — the service enforces the never-HIGH cap independently, never trusting this alone
    limitations: Array.isArray(limitations) ? [...limitations] : [],
    model: null, // free text, e.g. "claude-opus-5" — never a credential
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createInterpretationDiagnostic(d)) : [],
  };
  return withDefaults(base, rest);
}

function assertImplementsInterpretationProviderInterface(provider) {
  for (const method of REQUIRED_METHODS) {
    if (!provider || typeof provider[method] !== 'function') {
      throw new Error(`Interpretation provider is missing required method: ${method}()`);
    }
  }
}

module.exports = {
  REQUIRED_METHODS,
  PROVIDER_RESULT_STATUSES,
  INTERPRETATION_CONSTRAINTS,
  createInterpretationDiagnostic,
  createInterpretationEvidenceObservation,
  createInterpretationInput,
  createInterpretationProviderResult,
  assertImplementsInterpretationProviderInterface,
};

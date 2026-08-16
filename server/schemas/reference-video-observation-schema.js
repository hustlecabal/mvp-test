// reference-video-observation-schema.js
//
// INT-1C — Layer 3 of the INT-1 specification's five-layer model:
//
//   Raw Evidence -> Measurements (INT-1B) -> OBSERVATIONS (this file) ->
//   Interpretation -> Recommendation
//
// AN OBSERVATION IS NOT AN OPINION. It is a structured, factual statement
// derived from measured evidence by a named, deterministic rule — never a
// judgment about whether anything is good, engaging, effective, or works.
// "Median shot duration is 1.9s, with 78% of detected shots below 3s" is
// an observation. "The video has excellent pacing" is an interpretation,
// and has no representation anywhere in this file — there is no field
// here that could hold it (see createObservationStatement's own
// constraints and this stage's test suite, which asserts this directly).
//
// Every Observation answers four questions on its own record (Part 2):
//   WHAT WAS OBSERVED       -> statement (free text, but rule-generated —
//                               never hand-typed by a human per-record)
//   FROM WHICH MEASUREMENTS -> evidence[] (dot-path pointers INTO a real,
//                               already-persisted ReferenceVideoMeasurements
//                               record, plus the literal value read)
//   USING WHICH RULE        -> methodology.ruleId (see services/reference-
//                               video/observation-rules.js's registry)
//   WITH WHAT CONFIDENCE    -> confidence (never manufactured — always
//                               either copied from the underlying
//                               Measurement's own confidence, or set by an
//                               explicit, documented rule of the observation
//                               rule itself)
//
// NO ORPHAN OBSERVATIONS (Part 3): createObservation refuses to default
// `evidence` to a non-empty placeholder — every real Observation the
// service produces carries at least one real EvidenceLink pointing at a
// real field inside a real, persisted ReferenceVideoMeasurements record.

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

// Part 5 — the closed category vocabulary. Every one of these ten is
// backed by at least one real rule in services/reference-video/
// observation-rules.js — none exists "because it sounds useful."
const OBSERVATION_CATEGORIES = ['TIMING', 'PACING', 'SHOT_RHYTHM', 'NARRATION', 'SPEECH_DENSITY', 'SILENCE', 'OPENING', 'VISUAL_CHANGE', 'TEXT_PRESENCE', 'STRUCTURE'];

// Part 13 — same three-level vocabulary as the measurement layer, but a
// SEPARATE list: an observation's confidence describes the OBSERVATION's
// own reliability (how directly the rule's conclusion follows from its
// inputs), which is related to but not identical with the confidence of
// any single underlying Measurement it cites.
const OBSERVATION_CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'];

const OBSERVATION_SET_STATUSES = ['COMPLETE', 'PARTIAL', 'FAILED'];

// Part 20/21 — the closed set of reasons an observation could not be
// produced. Never a place a real observation's own text lives — these are
// diagnostics about ABSENCE, not statements about evidence.
const OBSERVATION_DIAGNOSTIC_CODES = [
  'INVALID_MEASUREMENTS',
  'INSUFFICIENT_MEASUREMENTS',
  'MEASUREMENT_UNAVAILABLE',
  'CONTRADICTORY_MEASUREMENTS',
  'OCR_UNAVAILABLE',
  'SCENE_OBSERVATION_UNAVAILABLE',
];

// ---------------------------------------------------------------------------
// Part 3 — evidence linkage. A pointer INTO a real ReferenceVideoMeasurements
// record (dot-path, e.g. "shotRhythm.durationDistribution.median") plus the
// literal value the rule actually read there at evaluation time — so a
// later reader never has to re-resolve the path to know what was seen.
// ---------------------------------------------------------------------------
function createEvidenceLink(overrides = {}) {
  const base = {
    measurementsId: null, // the ReferenceVideoMeasurements record this points into
    metricPath: null, // dot-path within that record, e.g. "transcript.wordsPerMinute"
    value: null, // the literal value read at that path when this observation was made
    unit: null,
  };
  return withDefaults(base, overrides);
}

// Part 2/15 — "USING WHICH RULE". Mirrors services/reference-video/
// observation-rules.js's own registry entry for the rule that produced
// this specific Observation — ruleId is always a real, registered rule id
// (enforced by the observation service, never a free-text guess).
function createObservationMethodology(overrides = {}) {
  const base = {
    ruleId: null,
    description: '', // what the rule checks, in one sentence
    limitations: '', // Part 15's own required field — what this rule does NOT establish
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// The Observation record itself.
// ---------------------------------------------------------------------------
function createObservation(overrides = {}) {
  const { evidence, methodology, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    referenceVideoId: null,
    measurementsId: null, // the specific ReferenceVideoMeasurements this was derived from

    category: null, // one of OBSERVATION_CATEGORIES
    statement: '', // factual, neutral, measurable, reproducible — see file header

    evidence: Array.isArray(evidence) ? evidence.map((e) => createEvidenceLink(e)) : [],
    confidence: null, // one of OBSERVATION_CONFIDENCE_LEVELS
    methodology: methodology !== undefined ? (methodology === null ? null : createObservationMethodology(methodology)) : createObservationMethodology(),

    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

function createObservationDiagnostic(overrides = {}) {
  const base = {
    code: null, // one of OBSERVATION_DIAGNOSTIC_CODES
    ruleId: null, // which rule (if any) produced this diagnostic
    message: '',
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// ObservationSet — the top-level record for one observation run against
// one ReferenceVideoMeasurements record, exactly mirroring how
// ReferenceVideoMeasurements is the top-level record for one measurement
// run against one ReferenceVideo (INT-1B's own convention, reused here).
// ---------------------------------------------------------------------------
function createObservationSet(overrides = {}) {
  const { observations, diagnostics, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    referenceVideoId: null,
    measurementsId: null,

    observations: Array.isArray(observations) ? observations.map((o) => createObservation(o)) : [],

    status: null, // one of OBSERVATION_SET_STATUSES
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createObservationDiagnostic(d)) : [],

    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  OBSERVATION_CATEGORIES,
  OBSERVATION_CONFIDENCE_LEVELS,
  OBSERVATION_SET_STATUSES,
  OBSERVATION_DIAGNOSTIC_CODES,
  createEvidenceLink,
  createObservationMethodology,
  createObservation,
  createObservationDiagnostic,
  createObservationSet,
};

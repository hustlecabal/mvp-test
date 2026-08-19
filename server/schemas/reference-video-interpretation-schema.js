// reference-video-interpretation-schema.js
//
// INT-1D — Layer 4 of the INT-1 specification's five-layer model:
//
//   Raw Evidence -> Measurements (INT-1B) -> Observations (INT-1C) ->
//   INTERPRETATION (this file) -> Recommendation
//
// THE CRITICAL EPISTEMIC RULE this file exists to enforce, structurally,
// not just by convention:
//
//   FACT           — a measured number (INT-1B). Lives on Measurements,
//                     never duplicated here.
//   OBSERVATION    — a factual statement directly derived from measurements
//                     (INT-1C). Lives on Observation, referenced here by id.
//   INTERPRETATION — a REASONED, HEDGED EXPLANATION of the observed
//                     structure. Everything in THIS file is at this third
//                     level. Every field name below says so: `hypothesis`
//                     (never `fact`), `reasoning` (never `explanation` —
//                     "explanation" reads as settled; "reasoning" reads as
//                     an argument that could be wrong).
//
// An Interpretation is never allowed to assert intent as fact (Part 11):
// `hypothesis`/`reasoning`/`alternativeHypotheses[].hypothesis` are free
// text, but services/reference-video-interpretation-service.js validates
// every one of them against a banned-phrase list (unqualified "the creator
// deliberately/intentionally/wanted to...") BEFORE persistence — this
// schema file only shapes the record; the service enforces the rule (see
// that file's own header for why validation lives there, not here, mirroring
// every other schema/service split in this codebase).
//
// CONFIDENCE IS STRUCTURALLY CAPPED BELOW OBSERVATION'S OWN SCALE (Part 8):
// schemas/reference-video-observation-schema.js's OBSERVATION_CONFIDENCE_
// LEVELS is HIGH/MEDIUM/LOW. INTERPRETATION_CONFIDENCE_LEVELS below is
// deliberately only MEDIUM/LOW — there is no HIGH an interpretation can
// ever be assigned, by construction, not by a runtime check that could be
// bypassed. Interpretation is inherently more uncertain than the
// observations it reasons over; this is Part 8's own requirement taken to
// its most defensible, hardest-to-violate form.

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

// Part 8 — see file header. Never HIGH.
const INTERPRETATION_CONFIDENCE_LEVELS = ['MEDIUM', 'LOW'];

// Part 4 — the closed set of structural interpretation questions. Never
// "why is this video successful" (too broad, invites a quality judgment).
// Each question names which Observation CATEGORIES (schemas/reference-
// video-observation-schema.js's OBSERVATION_CATEGORIES) are relevant —
// used by the interpretation input builder (services/reference-video-
// interpretation-service.js) to select evidence, never to invent it.
const INTERPRETATION_QUESTIONS = {
  OPENING_STRUCTURAL_PURPOSE: { text: 'What structural purpose might the opening serve?', relevantCategories: ['OPENING', 'STRUCTURE'] },
  PACING_PATTERN_EXPLANATION: { text: 'What might explain the observed pacing pattern?', relevantCategories: ['PACING', 'SHOT_RHYTHM'] },
  NARRATION_VISUAL_RHYTHM_RELATIONSHIP: { text: 'What role might narration timing play in the visual rhythm?', relevantCategories: ['NARRATION', 'SHOT_RHYTHM', 'VISUAL_CHANGE'] },
  VISUAL_NARRATION_RELATIONSHIP: { text: 'What relationship exists between visual changes and narration?', relevantCategories: ['VISUAL_CHANGE', 'NARRATION', 'SPEECH_DENSITY'] },
  INFORMATION_DELAY_LOCATION: { text: 'Where does the video appear to delay information?', relevantCategories: ['OPENING', 'NARRATION', 'STRUCTURE'] },
  PACING_ACCELERATION_DECELERATION: { text: 'Where does the video appear to accelerate or decelerate?', relevantCategories: ['PACING', 'SHOT_RHYTHM', 'VISUAL_CHANGE'] },
  RECURRING_STRUCTURAL_RELATIONSHIPS: { text: 'What recurring structural relationships are visible?', relevantCategories: ['STRUCTURE', 'PACING', 'SHOT_RHYTHM', 'VISUAL_CHANGE'] },
};
const INTERPRETATION_QUESTION_IDS = Object.keys(INTERPRETATION_QUESTIONS);

const INTERPRETATION_STATUSES = ['PENDING_REVIEW', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'FAILED'];

// Part 19 — a human decision on a machine interpretation. EDIT/
// REQUEST_ALTERNATIVE never mutate the original record (see
// createInterpretationReview's own note + the service's reviewInterpretation).
const REVIEW_DECISIONS = ['ACCEPT', 'REJECT', 'EDIT', 'REQUEST_ALTERNATIVE'];

// Part 21 — exactly the eight codes the task specification requires.
const INTERPRETATION_DIAGNOSTIC_CODES = [
  'INTERPRETATION_INPUT_INVALID',
  'INTERPRETATION_EVIDENCE_MISSING',
  'INTERPRETATION_PROVIDER_UNAVAILABLE',
  'INTERPRETATION_COST_BLOCKED',
  'INTERPRETATION_FAILED',
  'INTERPRETATION_INVALID',
  'INTERPRETATION_UNSUPPORTED',
  'INTERPRETATION_TIMEOUT',
];

function createInterpretationDiagnostic(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 3 — evidence chain. A pointer to one real, already-persisted
// Observation (schemas/reference-video-observation-schema.js) — never a
// restatement of its text (that would invite drift between what the
// Observation actually says and what the Interpretation claims it says).
// ---------------------------------------------------------------------------
function createEvidenceReference(overrides = {}) {
  const base = {
    observationId: null,
    category: null, // copied from the Observation at citation time, for readability only — never authoritative (the real Observation record is)
    statement: null, // copied verbatim from the Observation at citation time — an audit convenience, never edited here
  };
  return withDefaults(base, overrides);
}

// Part 9 — a competing explanation for the SAME observed structure. Never
// forced to a single answer when the evidence plausibly supports more than
// one (the core anti-hallucination mechanism Part 9 names explicitly).
function createAlternativeHypothesis(overrides = {}) {
  const base = {
    hypothesis: '',
    reasoning: '',
  };
  return withDefaults(base, overrides);
}

// Part 10 — evidence that WEAKENS or narrows the primary hypothesis. Never
// optional decoration — a hypothesis with real counter-evidence available
// but not disclosed here is exactly the "confirmation-only reasoning"
// Part 10 forbids.
function createCounterEvidence(overrides = {}) {
  const base = {
    observationId: null,
    note: '', // how this observation weakens/narrows the hypothesis
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 20 — the audit trail. What was supplied, which question was asked,
// which provider/model answered, when — WITHOUT ever persisting an API key
// or the model's own hidden chain-of-thought (only the final, concise
// reasoning the provider returned).
// ---------------------------------------------------------------------------
function createInterpretationAuditTrail(overrides = {}) {
  const { suppliedObservationIds, ...rest } = overrides;
  const base = {
    questionId: null, // one of INTERPRETATION_QUESTION_IDS
    suppliedObservationIds: Array.isArray(suppliedObservationIds) ? [...suppliedObservationIds] : [],
    provider: null, // free text, e.g. "claude" — never a credential
    model: null, // free text model identifier
    requestedAt: null,
    respondedAt: null,
    estimatedCostUsd: null, // from the Part 18 cost gate — null when unknown
    // P0-HARDENING-2, Part 12 — additive. actualCostUsd is computed from
    // the provider's OWN reported real token usage (actualInputTokens/
    // actualOutputTokens) via reference-video-interpretation-model-
    // registry.js's estimateCostUsd, fed real numbers instead of
    // estimates. estimatedCostUsd above is NEVER overwritten by these —
    // both are kept, side by side, so a human can see the estimate that
    // gated approval next to what the call actually cost. All three stay
    // null when the provider's response never exposed real usage (e.g. it
    // never reached Anthropic, or reached it but the response carried no
    // usage object) — never a fabricated substitute.
    actualInputTokens: null,
    actualOutputTokens: null,
    actualCostUsd: null,
  };
  return withDefaults(base, rest);
}

// Part 19 — one human decision on a machine (or prior human-edited)
// interpretation. Appended to Interpretation.reviews[], never replacing an
// earlier entry — the same "history, never overwrite" discipline
// services/identity-consistency-review-store.js already established.
function createInterpretationReview(overrides = {}) {
  const base = {
    decision: null, // one of REVIEW_DECISIONS
    reviewedBy: null,
    reviewedAt: new Date().toISOString(),
    note: null,
    // Only set when decision === 'EDIT' — the id of the NEW Interpretation
    // record created to hold the human's edited text (see
    // reference-video-interpretation-service.js's reviewInterpretation).
    // The original machine record's own hypothesis/reasoning fields are
    // NEVER overwritten in place (Part 19's explicit instruction).
    resultingInterpretationId: null,
  };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// The Interpretation record itself.
// ---------------------------------------------------------------------------
function createInterpretation(overrides = {}) {
  const { supportingEvidence, counterEvidence, alternativeHypotheses, limitations, audit, diagnostics, reviews, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    referenceVideoId: null,
    measurementsId: null,
    observationSetId: null,

    question: null, // the literal question TEXT asked (copied from INTERPRETATION_QUESTIONS at creation time, for readability)

    // --- Part 2's WHAT WE INFER, always hedged language, never fact ---
    hypothesis: '', // the primary, reasoned explanation — "may", "could", "is consistent with", never "is"/"was"
    reasoning: '', // concise, auditable argument connecting the cited evidence to the hypothesis — never hidden chain-of-thought

    // --- Part 3 — the evidence chain, INTERPRETATION -> OBSERVATION ---
    supportingEvidence: Array.isArray(supportingEvidence) ? supportingEvidence.map((e) => createEvidenceReference(e)) : [],
    counterEvidence: Array.isArray(counterEvidence) ? counterEvidence.map((e) => createCounterEvidence(e)) : [],

    // --- Part 9 — competing explanations, never forced to one ---
    alternativeHypotheses: Array.isArray(alternativeHypotheses) ? alternativeHypotheses.map((a) => createAlternativeHypothesis(a)) : [],

    confidence: null, // one of INTERPRETATION_CONFIDENCE_LEVELS — never HIGH, see file header
    limitations: Array.isArray(limitations) ? [...limitations] : [], // free-text caveats, e.g. "based on a sampled, not exhaustive, frame-difference signal"

    audit: audit !== undefined ? (audit === null ? null : createInterpretationAuditTrail(audit)) : createInterpretationAuditTrail(),

    // Part 19 — human review state. status is the CURRENT verdict;
    // reviews[] is the full append-only history.
    status: 'PENDING_REVIEW', // one of INTERPRETATION_STATUSES
    reviews: Array.isArray(reviews) ? reviews.map((r) => createInterpretationReview(r)) : [],

    // Part 19 — set only when THIS record itself was created by an EDIT
    // review on an earlier one (see createInterpretationReview's own note).
    // Never set by the machine provider path.
    supersedesInterpretationId: null,

    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createInterpretationDiagnostic(d)) : [],

    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  INTERPRETATION_CONFIDENCE_LEVELS,
  INTERPRETATION_QUESTIONS,
  INTERPRETATION_QUESTION_IDS,
  INTERPRETATION_STATUSES,
  REVIEW_DECISIONS,
  INTERPRETATION_DIAGNOSTIC_CODES,
  createInterpretationDiagnostic,
  createEvidenceReference,
  createAlternativeHypothesis,
  createCounterEvidence,
  createInterpretationAuditTrail,
  createInterpretationReview,
  createInterpretation,
};

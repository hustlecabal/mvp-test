// cross-video-pattern-schema.js
//
// INT-1E — the first CROSS-VIDEO layer, sitting after INT-1D's single-
// video Interpretation in the INT-1 architecture. A Pattern is NEVER
// generalized from one video (this file's own PatternSet.homogeneityReport
// and every Pattern's prevalence field exist specifically so "one video"
// can never silently masquerade as "a pattern" — see services/cross-
// video-pattern-service.js's own enforcement of Part 8's minimum evidence
// threshold before anything is even labeled RECURRING).
//
// CORRELATION, NEVER CAUSATION (Part 13) — enforced by vocabulary, not
// just intention: PATTERN_TYPES has no CAUSATION value, and 'statement'
// is validated by the service (never this file) against a banned-causal-
// language list before persistence, the same "schema shapes, service
// validates" split schemas/reference-video-interpretation-schema.js
// already established for its own intent-claim ban.

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// Part 21 — only categories backed by real evidence this codebase can
// actually produce. Deliberately excludes VIRALITY/ENGAGEMENT/QUALITY/
// SUCCESS (Part 21's own explicit prohibition — no outcome data exists
// anywhere in this system for any of those to describe).
const PATTERN_CATEGORIES = ['OPENING_STRUCTURE', 'SHOT_RHYTHM', 'NARRATION', 'SPEECH_DENSITY', 'SILENCE', 'VISUAL_CHANGE', 'TIMING', 'STRUCTURE', 'CO_OCCURRENCE'];

// Part 10/11/14/15 — four, and only four, kinds of pattern this stage
// produces. RECURRING_OBSERVATION mirrors INT-1C's own rule-id-based
// vocabulary; NUMERIC_DISTRIBUTION aggregates a measured metric;
// CO_OCCURRENCE is a joint-frequency count of two observations (Part 14);
// OUTLIER records an individual video's departure from the set's own
// distribution (Part 15) — never discarded, always reported.
const PATTERN_TYPES = ['RECURRING_OBSERVATION', 'NUMERIC_DISTRIBUTION', 'CO_OCCURRENCE', 'OUTLIER'];

// Part 9 — mirrors schemas/reference-video-interpretation-schema.js's own
// INTERPRETATION_CONFIDENCE_LEVELS exactly: MEDIUM/LOW only. A cross-video
// pattern is never MORE certain than the single-video interpretations it
// could feed, so it inherits the identical "never HIGH" structural cap.
const PATTERN_CONFIDENCE_LEVELS = ['MEDIUM', 'LOW'];

// Part 17 — CANDIDATE is the machine's own first verdict; a human then
// ACCEPTs/REJECTs/FLAGs/REQUESTs_REVIEW (mirroring INT-1D's own review
// vocabulary, adapted to patterns rather than interpretations).
const PATTERN_STATUSES = ['CANDIDATE', 'ACCEPTED', 'REJECTED', 'FLAGGED', 'NEEDS_REVIEW'];
const PATTERN_REVIEW_DECISIONS = ['ACCEPT', 'REJECT', 'FLAG', 'REQUEST_REVIEW'];

const PATTERN_SET_STATUSES = ['COMPLETE', 'PARTIAL', 'FAILED'];

const PATTERN_DIAGNOSTIC_CODES = [
  'INSUFFICIENT_REFERENCE_SET', // fewer than the minimum videos to attempt extraction at all
  'BELOW_MINIMUM_EVIDENCE_THRESHOLD', // a specific candidate pattern didn't clear Part 8's bar (still recorded, never discarded)
  'HETEROGENEOUS_REFERENCE_SET', // Part 4 — the set's own real metadata suggests it may not be safely comparable
  'INCOMPLETE_MEASUREMENTS', // one or more members has no usable Measurements
  'INCOMPLETE_OBSERVATIONS', // one or more members has no usable ObservationSet
  'MISSING_METADATA', // a homogeneity dimension couldn't be evaluated because the field isn't populated for enough members
  // INT-1E-PATCH — a CO_OCCURRENCE support entry's two candidate observations
  // failed the provenance check (didn't exist / didn't belong to the claimed
  // video / didn't match the claimed rule ids). The entry is dropped, never
  // repaired or invented — see services/cross-video-pattern-service.js's
  // own validateCoOccurrenceProvenance().
  'INVALID_CO_OCCURRENCE_PROVENANCE',
];

function createPatternDiagnostic(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// Part 4 — HOMOGENEITY. Built only from metadata this codebase genuinely
// has (platform, channel, duration, aspect ratio — see services/cross-
// video-pattern-service.js's own extraction). Never invents a "topic" or
// "content type" field that doesn't exist anywhere upstream.
// ---------------------------------------------------------------------------
function createHomogeneityReport(overrides = {}) {
  const { warnings, ...rest } = overrides;
  const base = {
    metadataAvailable: [], // which dimensions could actually be evaluated across the set, e.g. ['platform', 'durationSeconds', 'aspectRatio', 'channelId']
    platformConsistent: null, // true/false/null (not evaluable)
    channelConsistent: null,
    durationCoefficientOfVariation: null, // stdDev/mean of member durations — a real, computed dispersion measure
    aspectRatioConsistent: null,
    warnings: Array.isArray(warnings) ? warnings.map((w) => createPatternDiagnostic(w)) : [],
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// Part 19 — evidence chain: Pattern -> Observation/Measurement -> Raw
// Evidence, one entry per contributing video. `value` is populated only
// for NUMERIC_DISTRIBUTION patterns (the exact number this video
// contributed); `observationId` only for RECURRING_OBSERVATION patterns.
//
// INT-1E-PATCH — `observationIds` (plural) is the CO_OCCURRENCE-only
// counterpart to the singular `observationId`: a co-occurrence is by
// definition backed by TWO observations per contributing video (one per
// rule id in the pair), so a single `observationId` cannot represent it
// truthfully. RECURRING_OBSERVATION/NUMERIC_DISTRIBUTION support entries
// are unaffected — they continue to use `observationId`/`value` exactly as
// before and simply carry an empty `observationIds: []` by default, like
// every other field on this record.
// ---------------------------------------------------------------------------
function createPatternSupport(overrides = {}) {
  const { observationIds, ...rest } = overrides;
  const base = {
    referenceVideoId: null,
    measurementsId: null,
    observationId: null,
    observationIds: Array.isArray(observationIds) ? [...observationIds] : [],
    value: null,
  };
  return withDefaults(base, rest);
}

// Part 8/9 — how many of the set support this pattern, and what fraction.
function createPrevalence(overrides = {}) {
  const base = { supportingCount: 0, totalCount: 0, percentage: 0 };
  return withDefaults(base, overrides);
}

// Part 9 — the documented confidence methodology's own inputs, persisted
// alongside the result so "why is this MEDIUM and not LOW" is always
// answerable from the record itself.
function createConfidenceMethodology(overrides = {}) {
  const base = { prevalenceScore: null, sampleSizeScore: null, consistencyScore: null, consistencyApplicable: false, combinedScore: null, formula: '' };
  return withDefaults(base, overrides);
}

// Part 14 — only populated for type: 'CO_OCCURRENCE'.
function createCoOccurrenceDetail(overrides = {}) {
  const base = { ruleIdA: null, ruleIdB: null, categoryA: null, categoryB: null };
  return withDefaults(base, overrides);
}

// Part 15 — only populated for type: 'OUTLIER'.
function createOutlierDetail(overrides = {}) {
  const base = { referenceVideoId: null, metric: null, value: null, medianValue: null, deviation: null };
  return withDefaults(base, overrides);
}

function createPatternReview(overrides = {}) {
  const base = { decision: null, reviewedBy: null, reviewedAt: new Date().toISOString(), note: null };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// The Pattern record itself.
// ---------------------------------------------------------------------------
function createPattern(overrides = {}) {
  const { prevalence, distribution, support, coOccurrence, outlier, confidenceMethodology, limitations, reviews, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    referenceSetId: null,

    type: null, // one of PATTERN_TYPES
    category: null, // one of PATTERN_CATEGORIES
    // Part 13's hard rule, restated as the field's own contract: statement
    // may only ever describe FREQUENCY/CO-OCCURRENCE within this reference
    // set — never a claim that the pattern causes any outcome. Enforced by
    // services/cross-video-pattern-service.js's own banned-language check
    // before this record is ever persisted.
    statement: '',

    metric: null, // for NUMERIC_DISTRIBUTION: the metric name, e.g. "shotsPerMinute"; null otherwise
    ruleId: null, // for RECURRING_OBSERVATION: the INT-1C rule id this pattern aggregates; null otherwise

    prevalence: prevalence !== undefined ? (prevalence === null ? null : createPrevalence(prevalence)) : createPrevalence(),
    distribution: distribution || null, // services/reference-video/pattern-math.js's computeDistributionWithStdDev() shape, for NUMERIC_DISTRIBUTION only

    support: Array.isArray(support) ? support.map((s) => createPatternSupport(s)) : [],
    coOccurrence: coOccurrence !== undefined ? (coOccurrence === null ? null : createCoOccurrenceDetail(coOccurrence)) : null,
    outlier: outlier !== undefined ? (outlier === null ? null : createOutlierDetail(outlier)) : null,

    confidence: null, // one of PATTERN_CONFIDENCE_LEVELS — never HIGH
    confidenceMethodology: confidenceMethodology !== undefined ? (confidenceMethodology === null ? null : createConfidenceMethodology(confidenceMethodology)) : createConfidenceMethodology(),

    meetsMinimumEvidenceThreshold: false, // Part 8 — services/reference-video/pattern-math.js's meetsMinimumEvidenceThreshold()
    limitations: Array.isArray(limitations) ? [...limitations] : [], // Part 20 — never hidden

    status: 'CANDIDATE', // one of PATTERN_STATUSES
    reviews: Array.isArray(reviews) ? reviews.map((r) => createPatternReview(r)) : [],

    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

// ---------------------------------------------------------------------------
// PatternSet — the top-level record for one extraction run against one
// ReferenceSet, mirroring ObservationSet/InterpretationSet's own
// "one record per run" convention.
// ---------------------------------------------------------------------------
function createPatternSet(overrides = {}) {
  const { patterns, homogeneityReport, diagnostics, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    referenceSetId: null,

    patterns: Array.isArray(patterns) ? patterns.map((p) => createPattern(p)) : [],
    homogeneityReport: homogeneityReport !== undefined ? (homogeneityReport === null ? null : createHomogeneityReport(homogeneityReport)) : createHomogeneityReport(),

    status: null, // one of PATTERN_SET_STATUSES
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createPatternDiagnostic(d)) : [],

    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  PATTERN_CATEGORIES,
  PATTERN_TYPES,
  PATTERN_CONFIDENCE_LEVELS,
  PATTERN_STATUSES,
  PATTERN_REVIEW_DECISIONS,
  PATTERN_SET_STATUSES,
  PATTERN_DIAGNOSTIC_CODES,
  createPatternDiagnostic,
  createHomogeneityReport,
  createPatternSupport,
  createPrevalence,
  createConfidenceMethodology,
  createCoOccurrenceDetail,
  createOutlierDetail,
  createPatternReview,
  createPattern,
  createPatternSet,
};

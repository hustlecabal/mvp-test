// intelligence-run-schema.js
//
// P0-INTEL — the IntelligenceRun shape, produced and persisted by
// services/intelligence-orchestrator-service.js. Represents the lifecycle
// of coordinating the SIX ALREADY-BUILT, SEPARATE intelligence stages
// (INT-1A ingestion, INT-1B measurement, INT-1C observation, INT-1D
// interpretation, INT-1E cross-video pattern extraction, INT-1F
// recommendation) into one operator-driven run.
//
// SAME DISCIPLINE AS schemas/production-job-schema.js (its own header is
// the direct precedent this file follows): a REAL, PERSISTED record — not
// a computed snapshot — because it is what makes "one entry point drives
// the whole chain" possible. It stores REFERENCES (ids) to each stage's
// own real, persisted output — never a second copy of a ReferenceVideo,
// Measurements, ObservationSet, Interpretation, PatternSet, or
// RecommendationSet. Every one of those records is read from its own
// existing store when needed; nothing here duplicates them.
//
// NOT A GENERIC WORKFLOW ENGINE: the six stages below are the fixed, real
// dependency order this codebase's own services already establish (see
// this stage's final report, Part 3, for the forensic verification this
// shape is built from) — this schema does not describe an arbitrary
// sequence of steps, and adding a seventh stage type is not a matter of
// configuration.

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

// Mirrors the real call sequence services/intelligence-orchestrator-
// service.js drives — see this file's own header. INTERPRETING is
// deliberately NEVER a blocking prerequisite for PATTERNING: the real
// services/cross-video-pattern-service.js's extractPatterns() reads
// Measurements/ObservationSets directly (verified, not assumed — see the
// final report's Part 3 dependency graph) and does not consume
// Interpretations at all today. COMPLETE therefore means "patterning and
// recommendation succeeded," regardless of whether interpretation for any
// individual video is still AWAITING_APPROVAL.
const INTELLIGENCE_RUN_STATUSES = ['REQUESTED', 'INGESTING', 'MEASURING', 'OBSERVING', 'INTERPRETING', 'PATTERNING', 'RECOMMENDING', 'COMPLETE', 'FAILED'];

// Which stage a FAILED run stopped at — same convention as schemas/
// production-job-schema.js's PRODUCTION_FAILURE_STAGES. INTERPRETATION is
// deliberately absent: an interpretation that is missing, blocked on
// approval, or provider-unavailable is recorded honestly in that video's
// own interpretations[] progress entry, but per this file's own header it
// never fails the whole IntelligenceRun (Hard Rule: existing INT-1D
// approval/review semantics are never bypassed by continuing, but they
// are also never treated as a hard dependency the rest of the pipeline
// does not actually have).
const INTELLIGENCE_FAILURE_STAGES = ['REFERENCE_SET', 'INGESTION', 'MEASUREMENT', 'OBSERVATION', 'PATTERNING', 'RECOMMENDATION'];

function createIntelligenceDiagnostic(overrides = {}) {
  const base = {
    stage: null, // one of INTELLIGENCE_FAILURE_STAGES, or null for a run-level diagnostic
    code: null,
    referenceVideoId: null,
    message: '',
  };
  return withDefaults(base, overrides);
}

// One requested interpretation question's own progress for ONE reference
// video. AWAITING_APPROVAL is a first-class, non-failure state (Part 11 —
// "must not... if approval missing, continue anyway" — the honest
// alternative to continuing is recording exactly this, not fabricating a
// result and not failing the run).
const INTERPRETATION_PROGRESS_STATUSES = ['NOT_REQUESTED', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED'];

function createInterpretationProgress(overrides = {}) {
  const base = {
    questionId: null,
    status: 'NOT_REQUESTED', // one of INTERPRETATION_PROGRESS_STATUSES
    interpretationId: null, // set once interpretReferenceVideo() has actually run (COMPLETED or FAILED)
  };
  return withDefaults(base, overrides);
}

// One reference video's own progress through the pipeline. `url` is
// preserved even if ingestion never produces a real ReferenceVideo record
// at all (Part 10 — "never silently exclude a failed video from the
// denominator") — the IntelligenceRun's own honesty about what was
// requested does not depend on what ReferenceSet.members ended up holding.
function createVideoProgress(overrides = {}) {
  const { interpretations, ...rest } = overrides;
  const base = {
    url: null,
    referenceVideoId: null, // set once ingestReferenceVideo() actually produced a record (any status)
    ingestionStatus: null, // mirrors the real ReferenceVideo.status once known — COMPLETE/PARTIAL/FAILED
    measurementId: null,
    observationSetId: null,
    interpretations: Array.isArray(interpretations) ? interpretations.map((i) => createInterpretationProgress(i)) : [],
  };
  return withDefaults(base, rest);
}

function createIntelligenceRun(overrides = {}) {
  const { videoProgress, diagnostics, requestedReferenceVideoUrls, interpretationQuestions, ...rest } = overrides;
  const base = {
    intelligenceRunId: crypto.randomUUID(),
    projectId: null,
    referenceSetId: null, // the ONE ReferenceSet (schemas/reference-set-schema.js) this run analyses — either caller-supplied or created fresh
    requestedReferenceVideoUrls: Array.isArray(requestedReferenceVideoUrls) ? [...requestedReferenceVideoUrls] : [], // the exact input, before any ingestion attempt
    interpretationQuestions: Array.isArray(interpretationQuestions) ? [...interpretationQuestions] : [], // which INT-1D questionIds this run attempts per video; [] = interpretation not requested at all
    status: 'REQUESTED', // one of INTELLIGENCE_RUN_STATUSES
    failureStage: null, // one of INTELLIGENCE_FAILURE_STAGES, set only when status is FAILED
    videoProgress: Array.isArray(videoProgress) ? videoProgress.map((v) => createVideoProgress(v)) : [],
    patternSetId: null, // schemas/cross-video-pattern-schema.js PatternSet.id — the ONE cross-video pattern extraction this run performs
    recommendationSetId: null, // schemas/recommendation-schema.js RecommendationSet.id — the run's final output
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createIntelligenceDiagnostic(d)) : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  INTELLIGENCE_RUN_STATUSES,
  INTELLIGENCE_FAILURE_STAGES,
  INTERPRETATION_PROGRESS_STATUSES,
  createIntelligenceDiagnostic,
  createInterpretationProgress,
  createVideoProgress,
  createIntelligenceRun,
};

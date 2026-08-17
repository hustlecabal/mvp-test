// creative-blueprint-schema.js
//
// INT-2 — the first layer ABOVE evidence-backed recommendations that
// commits to an actual creative contract for ONE proposed video:
//
//   RecommendationSet (INT-1F) -> CreativeBlueprint
//
// PART 2's OWN DECISION, restated here because it governs every field
// below: schemas/creative-schema.js's `CreativeBrief` is NOT reused as
// this model. CreativeBrief predates the INT-1 evidence pipeline entirely
// — it is a continuously-user-editable artifact (every update via
// services/creative-store.js's applyVersionedUpdate() just bumps
// `version` and snapshots `history[]`; there is no APPROVE/REJECT gate,
// no recommendation-provenance concept, no immutable-once-approved
// semantics) and it has none of the fields this stage's own task
// (recommendation adoption/rejection, hook/narrative/pacing/narration
// STRATEGY, human strategy gate, provenance chain) requires. Reusing it
// would mean silently overloading one record with two incompatible
// mutation models (freely-re-editable vs. immutable-once-approved).
// CreativeBlueprint is therefore a DEDICATED, NEW model — but it never
// duplicates CreativeBrief's own authoritative content as a stored copy:
// it references an existing CreativeBrief by id (`creativeBriefId`,
// nullable — a project may not have one yet) purely for context, and
// `validateCreativeBlueprintDraft()` in services/creative-blueprint-
// service.js checks for (never invents) a soft mismatch between the two
// where both exist, rather than either re-deriving CreativeBrief's values
// or ignoring it.
//
// THE EPISTEMIC RULE (mirrors recommendation-schema.js's own): a
// Blueprint decision is not the same thing as the recommendation it came
// from, and neither is the same thing as the human's bare accept/reject.
// `createRecommendationDecision()` below is the one place this codebase
// keeps all three: recommendationId (provenance) -> decision (human
// authority) -> finalCreativeDecision (the Blueprint's own actionable
// text) are three separate fields, never collapsed (Part 4).
//
// IMMUTABLE ONCE APPROVED (Part 19) — mirrors schemas/cross-video-
// pattern-schema.js's PatternSet/schemas/recommendation-schema.js's
// RecommendationSet "one record per attempt, status+reviews[] only"
// convention, extended with an explicit revision chain
// (`supersedesBlueprintId`) matching reference-video-interpretation-
// schema.js's own EDIT-creates-a-new-record precedent.

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// Part 3's own suggested list, plus FAILED — every other INT-1 stage in
// this codebase (PatternSet/RecommendationSet/Interpretation/
// ObservationSet) reserves a FAILED status for a hard construction
// failure (bad project id, bad source-record id) that can never be
// persisted as a reviewable DRAFT; CreativeBlueprint keeps that same
// convention rather than inventing a different failure representation.
const CREATIVE_BLUEPRINT_STATUSES = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'FAILED'];

// Part 7 — the Blueprint's OWN review decisions (approve/reject/request a
// new revision). Deliberately a SEPARATE enum from
// RECOMMENDATION_DECISION_TYPES below — these two "review" concepts are
// not interchangeable: one is a human judging the whole Blueprint, the
// other is a human judging one recommendation's place within it.
const CREATIVE_BLUEPRINT_REVIEW_DECISIONS = ['APPROVE', 'REJECT', 'REQUEST_REVISION'];

// Part 5 — how a human disposes of ONE recommendation as Blueprint
// evidence. EDIT here NEVER touches the source Recommendation record
// (INT-1F's own reviewRecommendation()/EDIT flow is a separate, already-
// existing operation) — it only means "accepted, but the Blueprint's own
// finalCreativeDecision text differs from the recommendation's own
// `action`". DEFER records an intentionally-unresolved decision (Part 3's
// own openQuestions[] concept, applied per-recommendation) — never
// blocking, never silently dropped.
const RECOMMENDATION_DECISION_TYPES = ['ACCEPT', 'REJECT', 'EDIT', 'DEFER'];

const REFERENCE_ENTITY_TYPES = ['CHARACTER', 'LOCATION', 'PROP'];

const CREATIVE_BLUEPRINT_DIAGNOSTIC_CODES = [
  'INVALID_RECOMMENDATION_SET', // no RecommendationSet found, or it belongs to a different project
  'MISSING_CONCEPT',
  'MISSING_CORE_PROMISE',
  'MISSING_TARGET_DURATION',
  'INVALID_TARGET_DURATION', // present but not a positive number
  'INVALID_RECOMMENDATION_PROVENANCE', // a recommendationDecision named a recommendationId that doesn't resolve — dropped, never invented
  'INSUFFICIENT_EVIDENCE_RECOMMENDATION', // ACCEPT/EDIT on a recommendation whose own evidenceSufficiency is INSUFFICIENT_EVIDENCE — same rule INT-1F itself enforces, propagated up
  'INVALID_ENTITY_REFERENCE', // a continuityRequirement named a character/location/prop id absent from the project's own VisualBible — dropped, never invented
  'CONTRADICTORY_STRUCTURE', // Part 18's own worked example: planned sections * minimum section duration exceeds targetDuration
  'CREATIVE_BRIEF_MISMATCH', // informational only, never blocking — Blueprint's own targetAudience/format/targetDuration differs from a linked CreativeBrief's
];

// Part 17/13 — the SUBSET of diagnostic codes that structurally block
// APPROVE (never block DRAFT creation or PENDING_REVIEW submission — an
// intentionally incomplete draft is still a real, inspectable record).
// CREATIVE_BRIEF_MISMATCH and INSUFFICIENT_EVIDENCE_RECOMMENDATION are
// deliberately NOT blocking on their own: a mismatch is informational
// (the Blueprint is explicitly the higher-authority artifact — Part 2's
// header), and an insufficient-evidence recommendation is simply dropped
// from recommendationDecisions before a Blueprint is even built, so it
// can never itself remain as a live blocking condition on the persisted
// draft.
const BLOCKING_DIAGNOSTIC_CODES = ['INVALID_RECOMMENDATION_SET', 'MISSING_CONCEPT', 'MISSING_CORE_PROMISE', 'MISSING_TARGET_DURATION', 'INVALID_TARGET_DURATION', 'CONTRADICTORY_STRUCTURE'];

function createCreativeBlueprintDiagnostic(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

// Part 16 — qualitative-only, mirrors recommendation-schema.js's own
// createProductionConsideration() exactly (never a cost estimate).
function createBlueprintProductionConsideration(overrides = {}) {
  const base = { note: '' };
  return withDefaults(base, overrides);
}

// Part 9 — references an entity by id (schemas/creative-schema.js's own
// VisualBible.characters[]/.locations[]/.props[]), never duplicates the
// Bible's own content.
function createContinuityRequirement(overrides = {}) {
  const base = { entityType: null, entityId: null, requirement: '' };
  return withDefaults(base, overrides);
}

// Part 13 — deliberately thin: a COUNT of planned sections and a MINIMUM
// per-section duration, never a full section-by-section breakdown (that
// belongs to Storyboard, explicitly out of scope here) and never exact
// timestamps. Exists specifically so Part 18's contradiction check
// ("8 sections * 20s minimum > 60s target") is checkable against real
// structured numbers instead of unparseable free text.
function createStructuralDirection(overrides = {}) {
  const base = { plannedSectionCount: null, minimumSectionDurationSeconds: null, rhythmNotes: '' };
  return withDefaults(base, overrides);
}

// Part 10 — voiceProfile, when supplied, is expected to be schemas/
// audio-schema.js's own createVoiceProfile() shape, reused verbatim
// (never redefined here) — this file has no dependency on audio-schema.js
// at the schema-construction level to keep this file dependency-free;
// services/creative-blueprint-service.js is the one place that imports
// and validates against the real factory.
function createNarrationDirection(overrides = {}) {
  const base = { voiceRole: '', deliveryCharacter: '', pacingIntent: '', emotionalProgression: '', narrationVisualRelationship: '', voiceProfile: null };
  return withDefaults(base, overrides);
}

// Part 4 — the ONE place recommendation -> human decision -> final
// creative decision are kept as three distinct fields.
function createRecommendationDecision(overrides = {}) {
  const base = {
    recommendationId: null, // provenance — the ORIGINAL recommendation, never a re-derived id
    decision: null, // one of RECOMMENDATION_DECISION_TYPES
    decidedBy: null,
    decidedAt: new Date().toISOString(),
    note: null,
    finalCreativeDecision: null, // the Blueprint's own actionable text — populated only for ACCEPT/EDIT
  };
  return withDefaults(base, overrides);
}

// Part 4 — a creative decision with NO recommendation origin at all
// (a pure human/creative-director choice).
function createCreativeDecision(overrides = {}) {
  const base = { id: crypto.randomUUID(), statement: '', rationale: '', decidedBy: null, decidedAt: new Date().toISOString() };
  return withDefaults(base, overrides);
}

// Part 7/19 — mirrors createRecommendationReview/createInterpretationReview
// exactly: resultingBlueprintId is populated only for a REQUEST_REVISION
// decision, pointing at the brand-new v(n+1) draft.
function createCreativeBlueprintReview(overrides = {}) {
  const base = { decision: null, reviewedBy: null, reviewedAt: new Date().toISOString(), note: null, resultingBlueprintId: null };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// The CreativeBlueprint record itself.
// ---------------------------------------------------------------------------
function createCreativeBlueprint(overrides = {}) {
  const {
    recommendationDecisions,
    creativeDecisions,
    constraints,
    exclusions,
    openQuestions,
    continuityRequirements,
    productionConsiderations,
    sourceRecommendationIds,
    sourcePatternIds,
    sourceReferenceSetIds,
    reviews,
    structuralDirection,
    narrationDirection,
    diagnostics,
    ...rest
  } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    creativeBriefId: null, // Part 2 — reference only, never a duplicated copy
    referenceSetId: null,
    recommendationSetId: null,

    // IDENTITY
    title: '',
    concept: '',
    corePromise: '',
    format: null,
    targetAudience: null,
    targetDuration: null, // seconds

    // CREATIVE STRATEGY (Part 11 — WHAT/HOW, never a shot list)
    hookStrategy: '',
    narrativeStrategy: '',
    pacingStrategy: '',
    visualStrategy: '',
    narrationStrategy: '',
    tone: '',
    emotionalArc: '',

    // DECISIONS (Part 4/5)
    recommendationDecisions: Array.isArray(recommendationDecisions) ? recommendationDecisions.map((d) => createRecommendationDecision(d)) : [],
    creativeDecisions: Array.isArray(creativeDecisions) ? creativeDecisions.map((d) => createCreativeDecision(d)) : [],
    constraints: Array.isArray(constraints) ? [...constraints] : [],
    exclusions: Array.isArray(exclusions) ? [...exclusions] : [], // Part 3 — what production must NOT do
    openQuestions: Array.isArray(openQuestions) ? [...openQuestions] : [], // Part 3 — what remains intentionally unresolved

    // PRODUCTION INTENT
    visualDirection: '',
    narrationDirection: narrationDirection !== undefined ? (narrationDirection === null ? null : createNarrationDirection(narrationDirection)) : createNarrationDirection(),
    structuralDirection: structuralDirection !== undefined ? (structuralDirection === null ? null : createStructuralDirection(structuralDirection)) : createStructuralDirection(),
    continuityRequirements: Array.isArray(continuityRequirements) ? continuityRequirements.map((c) => createContinuityRequirement(c)) : [],
    productionConsiderations: Array.isArray(productionConsiderations) ? productionConsiderations.map((p) => createBlueprintProductionConsideration(p)) : [],

    // PROVENANCE — machine-DERIVED from recommendationDecisions at build
    // time (services/creative-blueprint-service.js), never independently
    // settable by a caller.
    sourceRecommendationIds: Array.isArray(sourceRecommendationIds) ? [...sourceRecommendationIds] : [],
    sourcePatternIds: Array.isArray(sourcePatternIds) ? [...sourcePatternIds] : [],
    sourceReferenceSetIds: Array.isArray(sourceReferenceSetIds) ? [...sourceReferenceSetIds] : [],

    status: 'DRAFT', // one of CREATIVE_BLUEPRINT_STATUSES
    diagnostics: Array.isArray(diagnostics) ? diagnostics.map((d) => createCreativeBlueprintDiagnostic(d)) : [],
    reviews: Array.isArray(reviews) ? reviews.map((r) => createCreativeBlueprintReview(r)) : [],
    supersedesBlueprintId: null, // Part 19 — set ONLY on the NEW record created by a REQUEST_REVISION

    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  CREATIVE_BLUEPRINT_STATUSES,
  CREATIVE_BLUEPRINT_REVIEW_DECISIONS,
  RECOMMENDATION_DECISION_TYPES,
  REFERENCE_ENTITY_TYPES,
  CREATIVE_BLUEPRINT_DIAGNOSTIC_CODES,
  BLOCKING_DIAGNOSTIC_CODES,
  createCreativeBlueprintDiagnostic,
  createBlueprintProductionConsideration,
  createContinuityRequirement,
  createStructuralDirection,
  createNarrationDirection,
  createRecommendationDecision,
  createCreativeDecision,
  createCreativeBlueprintReview,
  createCreativeBlueprint,
};

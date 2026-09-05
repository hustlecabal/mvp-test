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

  // CREATIVE BRAIN, Part 26 — the anti-slop gate. Every one of these is
  // ALSO in BLOCKING_DIAGNOSTIC_CODES below: this is not a second, parallel
  // quality-gate mechanism — a Creative-Brain-generated Blueprint carrying
  // any of these is blocked from APPROVED by the exact same array/check
  // that already blocks MISSING_CONCEPT. Produced by services/creative-
  // brain/creative-evaluation-service.js's per-dimension PASS/FAIL/WARN
  // checks (never a single fake quality score — see that file's header).
  'GENERIC_ANGLE', // narrative-clarity check: corePromise/concept too close to a bare restatement of the input topic
  'GENERIC_HOOK', // specificity check failed specifically on hookStrategy
  'EXCESSIVE_CLICHE_DENSITY', // banned-language/cliché registry hit above threshold
  'WEAK_SPECIFICITY', // specificity-budget check failed overall (too few concrete anchors)
  'NO_MEANINGFUL_TENSION', // emotional-logic check failed — a flat/single-stage emotionalArc
  'REFERENCE_TEMPLATE_IMITATION', // originality check failed — structural/phrasing overlap with source evidence
  'VISUAL_DIRECTION_TOO_GENERIC', // visual-taste completeness check failed — visualSpecification missing required dimensions
  'CONFLICTING_VISUAL_RULES', // an internal contradiction inside visualSpecification (e.g. negativeConstraints contradicts composition)
  'UNSUPPORTED_CLAIM', // banned-language causal/certainty pattern hit in generated text
  'TONE_MISMATCH', // tone field contradicts emotionalArc's own dominant register
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
const BLOCKING_DIAGNOSTIC_CODES = [
  'INVALID_RECOMMENDATION_SET',
  'MISSING_CONCEPT',
  'MISSING_CORE_PROMISE',
  'MISSING_TARGET_DURATION',
  'INVALID_TARGET_DURATION',
  'CONTRADICTORY_STRUCTURE',
  // CREATIVE BRAIN, Part 26 — the anti-slop gate's own diagnostic codes
  // are blocking by construction: this is THE rejection mechanism (no
  // separate enforcement path is written anywhere else).
  'GENERIC_ANGLE',
  'GENERIC_HOOK',
  'EXCESSIVE_CLICHE_DENSITY',
  'WEAK_SPECIFICITY',
  'NO_MEANINGFUL_TENSION',
  'REFERENCE_TEMPLATE_IMITATION',
  'VISUAL_DIRECTION_TOO_GENERIC',
  'CONFLICTING_VISUAL_RULES',
  'UNSUPPORTED_CLAIM',
  'TONE_MISMATCH',
];

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

// CREATIVE BRAIN, Part 3/15/16 — the structured breakdown Part 15 asks
// for, ALONGSIDE the existing free-text `visualDirection` (never
// replacing it). Explicitly a SPECIFICATION-COMPLETENESS mechanism, not a
// taste engine (per this stage's sign-off): filling every dimension here
// proves the Creative Brain considered each one, not that the result is
// aesthetically good — that judgment happens later, when Visual World +
// Material Resolution actually turn these into imagery.
function createVisualSpecification(overrides = {}) {
  const base = {
    composition: '',
    palette: '',
    lighting: '',
    texture: '',
    depth: '',
    cameraLanguage: '',
    subjectTreatment: '',
    environmentalTreatment: '',
    visualDensity: '',
    motionLanguage: '',
    typography: '',
    negativeConstraints: '',
  };
  return withDefaults(base, overrides);
}

// CREATIVE BRAIN, Part 24 — one generated Creative Angle candidate, kept
// on the Blueprint for transparency (Part 27 — no separate approval
// screen; a human reviewing the Blueprint can see what was tried and
// rejected). `selected` marks the one candidate whose angle became this
// Blueprint's concept/corePromise/hookStrategy; when every candidate
// failed evaluation, the STRONGEST one is still marked selected (Part 24
// correction — never silently discarded, never a false PASS).
function createCreativeAngleCandidate(overrides = {}) {
  const { evaluationResults, ...rest } = overrides;
  const base = {
    candidateId: crypto.randomUUID(),
    concept: '',
    corePromise: '',
    hookStrategy: '',
    rationale: '',
    selected: false,
    evaluationResults: Array.isArray(evaluationResults) ? evaluationResults.map((e) => createCreativeEvaluationResult(e)) : [],
  };
  return withDefaults(base, rest);
}

// CREATIVE BRAIN, Part 25 — ONE dimension's independent PASS/FAIL/WARN
// result. Never collapsed into a combined score (explicit, locked
// decision) — an EvaluationResult array is always read as a set of
// independent checks, never averaged/summed.
const CREATIVE_EVALUATION_RESULTS = ['PASS', 'FAIL', 'WARN'];
function createCreativeEvaluationResult(overrides = {}) {
  const base = { dimension: null, code: null, result: null, detail: '' };
  return withDefaults(base, overrides);
}

// CREATIVE BRAIN, Part 29 — how ONE HumanVoiceProfile pattern actually
// influenced this Blueprint's generated content. Reuses createCreative
// Decision's own free-text `howUsed` convention rather than inventing a
// second provenance shape.
function createHumanVoiceInfluence(overrides = {}) {
  const base = { patternId: null, howUsed: '' };
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
  const base = {
    voiceRole: '',
    deliveryCharacter: '',
    pacingIntent: '',
    emotionalProgression: '',
    narrationVisualRelationship: '',
    voiceProfile: null,
    // CREATIVE BRAIN, Part 18/19 — the actual narration SCRIPT text, when
    // the Blueprint's own strategy layer produced one (no separate script
    // engine exists elsewhere — see services/creative-brain/creative-
    // brain-provider-interface.js's own header). This is intent-adjacent
    // production input, not yet the real, timed NarrationDirection
    // services/narration-director-service.js's directNarration() later
    // produces from it — that remains a separate, unmodified stage.
    narrationText: '',
  };
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
    strategyId,
    ideaId,
    packageId,
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
    visualSpecification,
    candidates,
    evaluationResults,
    humanVoiceInfluences,
    ...rest
  } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    creativeBriefId: null, // Part 2 — reference only, never a duplicated copy
    referenceSetId: null,
    recommendationSetId: null,

    // PHASE 1 EDITORIAL SPINE — reference-only links (never a duplicated
    // copy of their content) to the EditorialStrategy/Idea/Package this
    // Blueprint was generated from, when it was generated via the
    // editorial spine (services/editorial-spine-service.js) rather than
    // the pre-existing human-authored path. All three stay null for a
    // Blueprint NOT built this way — never required, never invented.
    strategyId: strategyId !== undefined ? strategyId : null,
    ideaId: ideaId !== undefined ? ideaId : null,
    packageId: packageId !== undefined ? packageId : null,

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
    visualSpecification: visualSpecification !== undefined ? (visualSpecification === null ? null : createVisualSpecification(visualSpecification)) : createVisualSpecification(),
    narrationDirection: narrationDirection !== undefined ? (narrationDirection === null ? null : createNarrationDirection(narrationDirection)) : createNarrationDirection(),
    structuralDirection: structuralDirection !== undefined ? (structuralDirection === null ? null : createStructuralDirection(structuralDirection)) : createStructuralDirection(),
    continuityRequirements: Array.isArray(continuityRequirements) ? continuityRequirements.map((c) => createContinuityRequirement(c)) : [],
    productionConsiderations: Array.isArray(productionConsiderations) ? productionConsiderations.map((p) => createBlueprintProductionConsideration(p)) : [],

    // CREATIVE BRAIN — candidate generation transparency + evaluation +
    // human-voice provenance. All additive; empty by default for every
    // Blueprint NOT built by the Creative Brain (e.g. build_creative_
    // blueprint_draft's existing human-authored path) — never required.
    humanVoiceProfileId: null,
    humanVoiceInfluences: Array.isArray(humanVoiceInfluences) ? humanVoiceInfluences.map((h) => createHumanVoiceInfluence(h)) : [],
    candidates: Array.isArray(candidates) ? candidates.map((c) => createCreativeAngleCandidate(c)) : [],
    evaluationResults: Array.isArray(evaluationResults) ? evaluationResults.map((e) => createCreativeEvaluationResult(e)) : [],

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
  createVisualSpecification,
  createCreativeAngleCandidate,
  createCreativeEvaluationResult,
  createHumanVoiceInfluence,
  CREATIVE_EVALUATION_RESULTS,
  createCreativeBlueprint,
};

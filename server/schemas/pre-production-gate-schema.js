// pre-production-gate-schema.js
//
// INT-2.5 — the PRE-PRODUCTION QUALITY GATE. Sits immediately after an
// APPROVED CreativeBlueprint (INT-2) and before Storyboard/BeatGraph work.
// Answers "is this creative plan sufficiently complete, coherent,
// evidence-aligned, and technically producible to justify spending
// downstream production effort?" — never "will this video perform well?"
//
// NEW, APPEND-ONLY ARTIFACT (INT-2.5 spec, Part 3): PreProductionGateResult
// is never bolted onto CreativeBlueprint. It REFERENCES a Blueprint
// (blueprintId + blueprintRevision) and is a standalone record, mirroring
// RecommendationReview/CreativeBlueprintReview's own "review is a separate
// record, never a mutation of the reviewed artifact" convention — except
// here the record IS the reviewable unit (same convention CreativeBlueprint
// itself already established over RecommendationSet/PatternSet's "one
// record per attempt" convention), so there is no separate "GateSet"
// wrapper, exactly like CreativeBlueprint has no "BlueprintSet" wrapper.
//
// NO NUMERICAL SCORE (spec Part 1/7, locked). machineAssessment is
// categorical (PROCEED/REVISE/REJECT); blockers/warnings/information are
// typed lists, mirroring CreativeBlueprint.diagnostics[] exactly. There is
// no field anywhere in this file named score/rating/percent/confidence-as-
// a-number — the only place a real percentage already exists in this
// codebase (Pattern/Recommendation prevalence.percentage) is copied
// through, never invented fresh here.
//
// MACHINE FINDINGS ARE IMMUTABLE (spec Part 3/11, locked): machineAssessment,
// blockers, warnings, information, and reasoning are written ONCE, by
// services/pre-production-gate-service.js's evaluator, at record-creation
// time. Human review (humanDecision/humanDecidedBy/humanDecidedAt/
// humanRationale) is captured in the SAME record's own separate field
// group, but the machine fields are never rewritten by that later step —
// mirrors creative-blueprint-store.js's updateCreativeBlueprintReviewState()
// discipline (append review data, never touch machine-derived content),
// enforced here by services/pre-production-gate-store.js only ever writing
// the humanDecision* fields on an existing record, never the machine ones.

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// Spec Part 1 — the only three machine verdicts. PROCEED: no blockers.
// REVISE: fundamentally viable, specific fixable defects. REJECT: not an
// acceptable production candidate as currently conceived (spec Part 2D).
const GATE_ASSESSMENT_VALUES = ['PROCEED', 'REVISE', 'REJECT'];

// Spec Part 11 — the human's OWN decision, deliberately a different enum
// from GATE_ASSESSMENT_VALUES (same "two different decision concepts, two
// different enums" discipline creative-blueprint-schema.js already applies
// to CREATIVE_BLUEPRINT_REVIEW_DECISIONS vs RECOMMENDATION_DECISION_TYPES).
const HUMAN_DECISION_VALUES = ['ACCEPT', 'OVERRIDE', 'REQUEST_REVISION', 'REJECT'];

// Spec Part 6 — every finding this stage's evaluator can produce, grouped
// by which severity tier they belong to (spec Part 6's own policy table).
// A code appearing in exactly one of these three lists is enforced by a
// dedicated schema test (never duplicated across tiers).
const GATE_BLOCKER_CODES = [
  'BLUEPRINT_NOT_APPROVED', // Blueprint.status !== 'APPROVED'
  'MISSING_CONCEPT', // mirrors CreativeBlueprint's own diagnostic verbatim
  'MISSING_CORE_PROMISE',
  'MISSING_TARGET_DURATION',
  'INVALID_TARGET_DURATION',
  'CONTRADICTORY_STRUCTURE', // reuses detectStructuralContradiction() unchanged
  'INVALID_RECOMMENDATION_PROVENANCE', // BLOCKER here even though non-blocking at the Blueprint layer (spec Part 2A, Part 5D) — INT-2.5 is the stricter gate
  // P0 Hardening (finding C) — a human ACCEPT/EDIT of an INSUFFICIENT_EVIDENCE
  // recommendation is dropped by INT-2's own buildCreativeBlueprintDraft(),
  // which records this diagnostic but never blocks approval with it. Copied
  // through here as a BLOCKER using the exact same "gate is the stricter
  // layer" precedent already established for INVALID_RECOMMENDATION_PROVENANCE
  // directly above — a broken evidence link is a broken evidence link.
  'INSUFFICIENT_EVIDENCE_RECOMMENDATION',
  'UNSUPPORTED_CAPABILITY_NO_FALLBACK', // a confirmed UNSUPPORTED production capability with no acceptable fallback expressed anywhere reachable
];

const GATE_WARNING_CODES = [
  'INVALID_ENTITY_REFERENCE', // reused from Blueprint diagnostics — never silently disappears from the gate report
  'RECOMMENDATION_ALIGNMENT_UNVERIFIED', // deterministic keyword/category match found no reflection in any strategy field
  'RECOMMENDATION_CONFLICT', // narrow, documented category-opposition rule
  'PACING_DIRECTION_CONFLICT', // free-text heuristic only — never a hard blocker
  'NARRATION_DIRECTION_INCOMPLETE', // voiceRole/deliveryCharacter set but voiceProfile null, or vice versa
  'INVALID_VOICE_PROFILE', // defensive — Blueprint's own construction path already guarantees a valid shape when non-null
  'PARTIALLY_SUPPORTED_CAPABILITY', // e.g. HYBRID — non-PRIMARY layers real but not composited by video-assembly-service.js
  'UNKNOWN_CAPABILITY', // gate could not classify a stated requirement — never silently PASS
  'HIGH_PRODUCTION_COMPLEXITY', // reuses CreativeBlueprint's own deriveBlueprintProductionConsiderations thresholds
  'DEFERRED_RECOMMENDATION_DECISION', // a recommendationDecision with decision: 'DEFER'
  'OPEN_QUESTION_UNRESOLVED', // Blueprint.openQuestions[] non-empty
  'CREATIVE_BRIEF_MISMATCH', // reused from Blueprint diagnostics, kept non-blocking here too
];

const GATE_INFORMATION_CODES = [
  'RECOMMENDATION_DECISION_COUNTS', // counts of ACCEPT/REJECT/EDIT/DEFER
  'BEATGRAPH_UNAVAILABLE', // no BeatGraph was supplied — cost/per-beat capability sections are UNKNOWN, not absent
  'BEATGRAPH_AVAILABLE',
  'COST_STATUS', // KNOWN | ESTIMATED | UNKNOWN, never a fabricated number
  'GENERATION_CANDIDATE_INFO', // estimatedGenerationCandidates / zeroCostDeterministicCount, only when a BeatGraph was supplied
  'BLUEPRINT_REVISION_INFO', // supersedesBlueprintId chain depth, when present
  'AUDIENCE_CONTEXT_STATUS', // whether targetAudience is specified — no Channel Bible exists to supply it otherwise (Part 1 finding)
];

// Spec Part 7 — KNOWN/ESTIMATED/UNKNOWN only. Never a monetary number
// invented here; never collapsed with "free"/"$0".
const COST_STATUS_VALUES = ['KNOWN', 'ESTIMATED', 'UNKNOWN'];

// Spec Part 8 — mirrors MATERIAL_RESOLUTION_STATUSES' own vocabulary
// discipline (schemas/material-resolution-schema.js): a small, closed,
// honestly-named set. UNKNOWN is a first-class value, never collapsed
// into SUPPORTED or omitted.
const CAPABILITY_STATUS_VALUES = ['SUPPORTED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'UNKNOWN'];

function createGateFinding(overrides = {}) {
  const base = { code: null, message: '', category: null };
  return withDefaults(base, overrides);
}

function createGateInformation(overrides = {}) {
  const base = { code: null, message: '' };
  return withDefaults(base, overrides);
}

// P0 Hardening (finding D) — ONE entry in the gate result's append-only
// human-decision history. A later decision NEVER overwrites or erases an
// earlier one's own rationale — mirrors CreativeBlueprint.reviews[]'s own
// append-only discipline exactly, applied here because the gate previously
// had none: it stored only four overwritable scalars, so a rationale-free
// ACCEPT could silently erase a mandatory OVERRIDE rationale.
function createGateHumanDecision(overrides = {}) {
  const base = { decision: null, decidedBy: null, decidedAt: new Date().toISOString(), rationale: null };
  return withDefaults(base, overrides);
}

// ---------------------------------------------------------------------------
// PreProductionGateResult — the record itself.
// ---------------------------------------------------------------------------
function createPreProductionGateResult(overrides = {}) {
  const { blockers, warnings, information, humanDecisions, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    blueprintId: null, // the specific CreativeBlueprint revision this result was computed against
    blueprintRevision: null, // == blueprintId today (CreativeBlueprint has no separate numeric revision field —
                               // its own identity IS the revision, distinguished via supersedesBlueprintId); kept
                               // as its own named field per the spec's exact required shape, not collapsed into blueprintId
    gateVersion: 1, // Part 18/29 — versions THIS FILE's own rule logic; bump when evaluator rules change

    // P0 Hardening (finding E) — the Blueprint's OWN updatedAt at the exact
    // moment this gate result was computed. A later mutation of the
    // Blueprint (status change, content edit, a new revision superseding
    // it) changes the Blueprint's own updatedAt, so comparing the two
    // values is how services/pre-production-gate-service.js's
    // isGateResultStale() answers "is this PROCEED still about the
    // Blueprint that currently exists, or about one that no longer does?"
    // — never a second state-machine, just a plain timestamp comparison
    // against data the Blueprint already carries.
    blueprintUpdatedAt: null,

    machineAssessment: null, // one of GATE_ASSESSMENT_VALUES — set once, by the evaluator, never after
    blockers: Array.isArray(blockers) ? blockers.map((b) => createGateFinding(b)) : [],
    warnings: Array.isArray(warnings) ? warnings.map((w) => createGateFinding(w)) : [],
    information: Array.isArray(information) ? information.map((i) => createGateInformation(i)) : [],
    reasoning: '', // deterministically assembled from blockers/warnings — never LLM-authored (spec Part 20)

    // P0 Hardening (finding I) — previously computed by the evaluator and
    // discarded before ever reaching this record. One of COST_STATUS_VALUES.
    costStatus: null,

    createdAt: new Date().toISOString(),

    // --- human review (spec Part 11) ---
    // P0 Hardening (finding D) — humanDecisions[] is the real, authoritative,
    // append-only history (never mutated in place, only pushed to). The four
    // scalars below are kept as a read-convenience MIRROR of the array's own
    // last entry (exactly what every existing caller already reads) — but
    // the authoritative record, and the only place an OVERRIDE's rationale
    // is guaranteed recoverable after a later decision, is the array.
    humanDecisions: Array.isArray(humanDecisions) ? humanDecisions.map((d) => createGateHumanDecision(d)) : [],
    humanDecision: null, // mirrors humanDecisions[humanDecisions.length - 1].decision
    humanDecidedBy: null,
    humanDecidedAt: null,
    humanRationale: null, // mirrors humanDecisions[humanDecisions.length - 1].rationale — REQUIRED (non-null, non-empty) when that decision is 'OVERRIDE', enforced by the service
  };
  return withDefaults(base, rest);
}

module.exports = {
  GATE_ASSESSMENT_VALUES,
  HUMAN_DECISION_VALUES,
  GATE_BLOCKER_CODES,
  GATE_WARNING_CODES,
  GATE_INFORMATION_CODES,
  COST_STATUS_VALUES,
  CAPABILITY_STATUS_VALUES,
  createGateFinding,
  createGateInformation,
  createGateHumanDecision,
  createPreProductionGateResult,
};

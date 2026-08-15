// material-resolution-schema.js
//
// Stage 26.3 — the MaterialResolution result shape, produced by
// services/material-resolution-service.js's resolveMaterial(). Same rules
// as every other schema file in this codebase: plain object factories
// only, no file I/O, no provider knowledge, every field defaults to
// null/[]/'' so partial data is always valid, nothing here invents
// information.
//
// This is a COMPUTED SNAPSHOT, not an edited creative artifact — it is
// regenerated fresh every time resolveMaterial() runs, never hand-edited
// by a human the way a VisualBeat or BeatGraph is. It deliberately does
// NOT use the versionFields()/history pattern schemas/visual-beat-schema.js
// and schemas/beat-graph-schema.js use — the same precedent
// schemas/keyframe-execution-result-schema.js and
// schemas/video-generation-result-schema.js (the other two "normalized
// computed result" schemas in this codebase) already set: neither of
// those uses versionFields() either.
//
// NO totalScore. Ranking is a strict, ordered-phase comparison
// (CREATIVE_FIT -> CONTINUITY -> REUSE -> COST -> COMPLEXITY), never a
// weighted sum — see services/material-resolution-service.js's
// compareCandidates() for the comparator this schema's `phaseScores` and
// `decidingPhase` fields exist to make inspectable.

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

const MATERIAL_RESOLUTION_STATUSES = ['RESOLVED', 'UNRESOLVED'];

// Which phase, if any, actually separated the winning candidate from the
// runner-up (or explained why there was no ranking to do at all). Purely
// descriptive/explainability metadata — never itself a ranking input.
const DECIDING_PHASES = ['CREATIVE_FIT', 'CONTINUITY', 'REUSE', 'COST', 'COMPLEXITY', 'CREATED_AT', 'SOLE_SURVIVOR'];

// One Phase-A (hard gate) verdict for one candidate class, evaluated for
// one MATERIAL_ROLES value (schemas/visual-beat-schema.js's
// MATERIAL_ROLES — this stage only ever evaluates role: 'PRIMARY', but
// the field exists so a rejected-for-PRIMARY verdict can still carry
// forward-looking `eligibleRoles` metadata, e.g. B-roll rejected as
// PRIMARY for an identity beat but still eligible as OVERLAY/BACKGROUND/
// INSERT for a future HYBRID beat — see the Stage 26.3 design review, B-
// roll section).
function createHardGateResult(overrides = {}) {
  const base = {
    candidate: null, // a candidate-class id, e.g. "BROLL_LIBRARY+BROLL_CLIP"
    role: 'PRIMARY', // which MATERIAL_ROLES value this verdict is scoped to
    allowed: null,
    rejectedBy: null, // a fixed code, null when allowed: true
    reason: '',
    eligibleRoles: [], // MATERIAL_ROLES values this candidate COULD satisfy,
                         // independent of the allowed/rejectedBy verdict above
  };
  return withDefaults(base, overrides);
}

// One Phase-B..F (ranking) result for one candidate that SURVIVED Phase A
// for role 'PRIMARY'. `phaseScores` exposes every component so the
// decision is fully inspectable, but the components are read by
// compareCandidates() as an ORDERED sequence of tie-breaks, never summed
// into a single number — there is deliberately no `totalScore` field.
function createCandidateResult(overrides = {}) {
  const base = {
    candidate: null,
    role: 'PRIMARY',
    materialSource: null,
    visualTreatment: null,
    selectedAssetId: null, // set only for PROJECT_ASSET_REUSE candidates
    modelRequirements: null, // set only for GENERATED_NEW candidates —
                               // capability requirements only (see
                               // generation-model-registry.js's own
                               // requirement shape), NEVER a provider or
                               // model name
    eligibleRoles: ['PRIMARY'], // default reflects "only evaluated as
                                  // PRIMARY this stage," not a claim this
                                  // class can never serve another role
    phaseScores: {
      creativeFit: null, // Phase B
      continuity: null, // Phase C
      reuse: null, // Phase D
      cost: null, // Phase E — tie-break only
      complexity: null, // Phase F — tie-break only
    },
  };
  return withDefaults(base, overrides);
}

function createMaterialResolution(overrides = {}) {
  const base = {
    id: crypto.randomUUID(),
    beatId: null,
    status: null, // one of MATERIAL_RESOLUTION_STATUSES
    selectedMaterial: null, // the winning CandidateResult (role: PRIMARY),
                              // or null if UNRESOLVED
    decidingPhase: null, // one of DECIDING_PHASES, or null when UNRESOLVED
    candidates: [], // role: PRIMARY Phase-A survivors, each phase-scored,
                      // already sorted (candidates[0] === selectedMaterial)
    hardGateResults: [], // EVERY candidate class evaluated, every role
                           // considered, pass or fail
    ranking: [], // candidate ids in final order, a convenience view over candidates
    unresolvedRequirements: [],
    warnings: [],
    rationale: '',
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, overrides);
}

module.exports = {
  MATERIAL_RESOLUTION_STATUSES,
  DECIDING_PHASES,
  createHardGateResult,
  createCandidateResult,
  createMaterialResolution,
};

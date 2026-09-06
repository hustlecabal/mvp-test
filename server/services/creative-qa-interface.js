// creative-qa-interface.js
//
// Section 18 — CREATIVE QA CONTRACT. Formalises the INTERFACE for the pass
// that catches what structural validation (creative-production-contract-
// validator.js) cannot prove.
//
// Two genuinely different tiers of dimension live under the same
// PASS/FAIL/WARN finding shape:
//
//   SUBJECTIVE dimensions (identity drift, wardrobe drift, camera
//   plausibility, screen direction, lighting/environment continuity, shot
//   purpose, B-roll relevance, audio/visual relationship, generation-
//   boundary/continuation-frame quality) — require real visual/creative
//   judgment. Still UNIMPLEMENTED: no autonomous system exists for these,
//   and none is built here. A future reviewer (human, or a specialist
//   skill invoked deliberately) would produce findings for these.
//
//   DETERMINISTIC dimensions (PRODUCTION RELIABILITY LAYER, added once a
//   real implementation existed to back them — services/creative-qa-
//   service.js) — beat coverage, narration coverage, silent/unexpected
//   timeline gaps, and scene-length plausibility are all directly
//   computable from existing production metadata (services/production-
//   completeness-service.js, and the timeline compiler's own already-
//   computed TIMELINE_GAP diagnostics). These are real, tested, and wired
//   into production-orchestrator-service.js's completion path.
//
// This file itself still only defines the SHAPE — it never runs a check
// or calls a model itself.

const CREATIVE_QA_DIMENSIONS = [
  // Subjective — unimplemented, require real visual/creative judgment.
  'IDENTITY_DRIFT',
  'WARDROBE_DRIFT',
  'CAMERA_MOVEMENT_PLAUSIBILITY',
  'SCREEN_DIRECTION_CONTINUITY',
  'LIGHTING_CONTINUITY',
  'ENVIRONMENT_DRIFT',
  'SHOT_PURPOSE_CLARITY',
  'BROLL_RELEVANCE',
  'AUDIO_VISUAL_RELATIONSHIP',
  'GENERATION_BOUNDARY_QUALITY',
  'CONTINUATION_FRAME_QUALITY',

  // Deterministic — implemented in services/creative-qa-service.js,
  // backed by services/production-completeness-service.js and the
  // timeline compiler's own existing diagnostics.
  'BEAT_COVERAGE', // every beat the BeatGraph/Storyboard intended reached the final assembly
  'NARRATION_COVERAGE', // every beat with an intended narration segment has real, persisted audio
  'TIMELINE_CONTENT_MISMATCH', // an unexpected gap exists in the compiled timeline (TIMELINE_GAP)
  'SCENE_LENGTH_PLAUSIBILITY', // a compiled beat's duration is implausibly short to convey content
];

// One finding against one dimension, for one object. `result` is
// PASS/FAIL/WARN — the same convention this codebase's other evaluators
// (e.g. story-architecture-evaluator.js) already use, never a fabricated
// numeric score, per this codebase's standing anti-fabrication discipline.
function createCreativeQAFinding({ dimension, result, objectType, objectId, note = null }) {
  if (!CREATIVE_QA_DIMENSIONS.includes(dimension)) {
    throw new Error(`unknown Creative QA dimension "${dimension}"`);
  }
  if (!['PASS', 'FAIL', 'WARN'].includes(result)) {
    throw new Error(`Creative QA result must be PASS/FAIL/WARN, got "${result}"`);
  }
  return { dimension, result, objectType, objectId, note };
}

function createCreativeQAReport({ subjectType, subjectId, reviewedBy = null, findings = [] } = {}) {
  return { subjectType, subjectId, reviewedBy, findings, createdAt: new Date().toISOString() };
}

// A reviewer (human or specialist-skill-backed) implements this. Never
// called by creative-production-contract-validator.js or by any schema
// factory — Creative QA is deliberately a separate, optional pass a caller
// invokes explicitly, never a hidden step inside structural validation.
function assertImplementsCreativeQAReviewer(reviewer) {
  if (!reviewer || typeof reviewer.review !== 'function') {
    throw new Error('Creative QA reviewer must implement review(subject) -> CreativeQAReport');
  }
}

module.exports = {
  CREATIVE_QA_DIMENSIONS,
  createCreativeQAFinding,
  createCreativeQAReport,
  assertImplementsCreativeQAReviewer,
};

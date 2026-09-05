// creative-qa-interface.js
//
// Section 18 — CREATIVE QA CONTRACT. Formalises the INTERFACE for the pass
// that catches what structural validation (creative-production-contract-
// validator.js) cannot prove: identity drift, wardrobe drift, implausible
// camera movement, broken screen direction, lighting discontinuity,
// environment drift, poor shot purpose, irrelevant B-roll, weak
// audio/visual relationship, awkward generation boundaries, a bad
// continuation frame.
//
// This file defines the SHAPE only — no autonomous QA system is built here
// (the milestone explicitly says not to, and no such infrastructure exists
// yet in this repository to build on). A future reviewer (human, or a
// specialist skill invoked deliberately) produces a CreativeQAReport; nothing
// here calls a model, a skill, or makes the judgment itself.

const CREATIVE_QA_DIMENSIONS = [
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

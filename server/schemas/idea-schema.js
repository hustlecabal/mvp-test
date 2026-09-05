// idea-schema.js
//
// PHASE 1 EDITORIAL SPINE, Part 2 — the IDEA layer: one step ABOVE
// services/creative-brain-service.js's own angle-candidate generation.
// Creative Brain already proves the GENERATE N -> EVALUATE EACH
// INDEPENDENTLY -> SELECT STRONGEST pattern for "which angle on this
// topic" (schemas/creative-blueprint-schema.js's CreativeAngleCandidate).
// This file is the SAME conceptual pattern, one level up: "which topic
// should this even be about." Deliberately its own schema, not a reuse of
// CreativeAngleCandidate — an Idea has no corePromise/hookStrategy yet (that
// is what Packaging/Angle generation produce downstream); it only has to be
// evaluable against an EditorialStrategy.
//
// PASS/FAIL/WARN, never a combined score (same locked decision creative-
// evaluation-service.js's header documents, reused here for the same
// reason: "far more defensible than a single fabricated number").
//
// NEVER a performance/CTR/retention claim (the phase brief's own explicit
// instruction) — every dimension below scores EDITORIAL POTENTIAL
// (specificity, novelty, curiosity-as-a-textual-property, strategic fit),
// never predicted audience behavior.

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const IDEA_EVALUATION_RESULTS = ['PASS', 'FAIL', 'WARN'];

function createIdeaEvaluationResult(overrides = {}) {
  const base = { dimension: null, code: null, result: null, detail: '' };
  return withDefaults(base, overrides);
}

// One candidate idea — a topic + premise + the editorial angle it takes on
// that topic, evaluated on 8 independent dimensions (Part 2's own list):
// audienceRelevance, novelty, specificity, curiosity, stakes, tension,
// usefulness, distinctiveness — plus strategicFit against the
// EditorialStrategy it was generated for.
function createIdeaCandidate(overrides = {}) {
  const { evaluationResults, ...rest } = overrides;
  const base = {
    ideaId: crypto.randomUUID(),
    topic: '',
    premise: '',
    rationale: '', // why this idea, in this shape, for this strategy
    selected: false,
    evaluationResults: Array.isArray(evaluationResults) ? evaluationResults.map((e) => createIdeaEvaluationResult(e)) : [],
  };
  return withDefaults(base, rest);
}

const IDEA_SET_STATUSES = ['DRAFT', 'EVALUATED', 'SELECTED'];

// IdeaSet — one record per generation attempt against one EditorialStrategy
// (mirrors RecommendationSet/PatternSet's own "one record per run"
// convention). `candidates` keeps every generated idea, evaluated,
// including the ones NOT selected — the same "no separate approval screen,
// a human reviewing this can see what was tried and rejected" transparency
// creative-blueprint-schema.js's own CreativeAngleCandidate documents.
function createIdeaSet(overrides = {}) {
  const { candidates, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    strategyId: null,
    candidates: Array.isArray(candidates) ? candidates.map((c) => createIdeaCandidate(c)) : [],
    selectedIdeaId: null,
    status: 'DRAFT', // one of IDEA_SET_STATUSES
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  IDEA_EVALUATION_RESULTS,
  IDEA_SET_STATUSES,
  createIdeaEvaluationResult,
  createIdeaCandidate,
  createIdeaSet,
};

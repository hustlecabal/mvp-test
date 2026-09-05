// package-schema.js
//
// PHASE 1 EDITORIAL SPINE, Part 3 — the PACKAGING layer: title + thumbnail
// concept + promise, as its OWN editorial decision, generated and scored
// BEFORE the full CreativeBlueprint/script exists. This is exactly the
// "packaging gap" the preceding Editorial Intelligence Gap Audit named:
// CreativeBlueprint.title (schemas/creative-blueprint-schema.js) was a
// single, unscored string aliased from whatever the winning angle's
// `concept` text happened to be — never an independent candidate set, never
// a thumbnail concept at all. PackageCandidate is that missing decision
// point, upstream of CreativeBlueprint (see creative-brain-service.js's
// new `selectedPackage` option, which makes a selected package authoritative
// for the Blueprint's title/corePromise once one exists).
//
// Field shape matches the phase brief's own worked example exactly:
// title/thumbnailConcept/promise/curiosityMechanism/specificity/novelty/
// stakes/packageRationale are the package's own descriptive content;
// PackageEvaluationResult (separate, PASS/FAIL/WARN, never a combined
// score — same locked convention as CreativeAngleCandidate/IdeaCandidate)
// is the independent judgment of that content's quality.

const crypto = require('crypto');

function withDefaults(base, overrides = {}) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

const PACKAGE_EVALUATION_RESULTS = ['PASS', 'FAIL', 'WARN'];

function createPackageEvaluationResult(overrides = {}) {
  const base = { dimension: null, code: null, result: null, detail: '' };
  return withDefaults(base, overrides);
}

function createPackageCandidate(overrides = {}) {
  const { evaluationResults, ...rest } = overrides;
  const base = {
    packageId: crypto.randomUUID(),
    title: '',
    thumbnailConcept: '',
    promise: '',
    curiosityMechanism: '', // WHAT creates the open loop (a question, a contradiction, a reveal withheld)
    specificity: '', // descriptive note: what makes this package concrete rather than generic
    novelty: '', // descriptive note: what makes this package distinct from an obvious take
    stakes: '', // descriptive note: what the viewer stands to gain/lose/understand
    packageRationale: '', // why this package, for this idea
    selected: false,
    evaluationResults: Array.isArray(evaluationResults) ? evaluationResults.map((e) => createPackageEvaluationResult(e)) : [],
  };
  return withDefaults(base, rest);
}

const PACKAGE_SET_STATUSES = ['DRAFT', 'EVALUATED', 'SELECTED'];

// PackageSet — one record per generation attempt against one selected Idea
// (mirrors IdeaSet/RecommendationSet's own "one record per run"
// convention). `candidates` keeps every generated package, evaluated,
// including the ones NOT selected.
function createPackageSet(overrides = {}) {
  const { candidates, ...rest } = overrides;
  const base = {
    id: crypto.randomUUID(),
    projectId: null,
    ideaId: null,
    candidates: Array.isArray(candidates) ? candidates.map((c) => createPackageCandidate(c)) : [],
    selectedPackageId: null,
    status: 'DRAFT', // one of PACKAGE_SET_STATUSES
    createdAt: new Date().toISOString(),
  };
  return withDefaults(base, rest);
}

module.exports = {
  PACKAGE_EVALUATION_RESULTS,
  PACKAGE_SET_STATUSES,
  createPackageEvaluationResult,
  createPackageCandidate,
  createPackageSet,
};

// recommendation-store.js
//
// INT-1F — persistence for RecommendationSet records (schemas/
// recommendation-schema.js). Same one-JSON-file-per-project convention
// every store in this codebase uses — `{ projectId, recommendationSets: [] }`.
// Never mutates a ReferenceVideo, Measurements, Observation, Interpretation,
// or Pattern record (Part 24) — this file only ever writes its own small
// JSON index of DERIVED recommendation data.
//
// Part 22 — append-only derived records, matching cross-video-pattern-
// store.js's own PatternSet convention exactly (never "the" persistence
// philosophy invented fresh here): re-running generation never overwrites
// or deletes a prior RecommendationSet, it only ever appends a new one.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const RECOMMENDATION_DATA_DIR = process.env.RECOMMENDATION_DATA_DIR ? path.resolve(process.env.RECOMMENDATION_DATA_DIR) : path.join(__dirname, '..', 'data', 'recommendations');

fs.mkdirSync(RECOMMENDATION_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(RECOMMENDATION_DATA_DIR, `${projectId}.json`);
}

function loadLibrary(projectId) {
  if (!isValidId(projectId)) return null;
  const filePath = fileFor(projectId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveLibrary(library) {
  fs.writeFileSync(fileFor(library.projectId), JSON.stringify(library, null, 2));
}

function ensureLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let library = loadLibrary(projectId);
  if (!library) {
    library = { projectId, recommendationSets: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, recommendationSets: [] };
}

function getRecommendationSet(projectId, recommendationSetId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.recommendationSets.find((s) => s.id === recommendationSetId) || null;
}

function listRecommendationSets(projectId, { referenceSetId } = {}) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return referenceSetId ? library.recommendationSets.filter((s) => s.referenceSetId === referenceSetId) : library.recommendationSets.slice();
}

function getLatestRecommendationSetForReferenceSet(projectId, referenceSetId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  const matches = library.recommendationSets.filter((s) => s.referenceSetId === referenceSetId);
  if (matches.length === 0) return null;
  return matches.reduce((latest, s) => (new Date(s.createdAt) > new Date(latest.createdAt) ? s : latest));
}

function addRecommendationSet(projectId, recommendationSet) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `No project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(recommendationSet));
  library.recommendationSets.push(stored);
  saveLibrary(library);
  return { ok: true, recommendationSet: stored };
}

// Part 10 — updates ONLY a single recommendation's status/reviews[] within
// an EXISTING RecommendationSet, in place. Never touches statement/
// rationale/action/prevalence/confidence/evidenceSummary — the machine's
// own derived result is permanent, matching cross-video-pattern-store.js's
// updatePatternReviewState() / reference-video-interpretation-store.js's
// updateReviewState() exactly. An EDIT decision does NOT call this with a
// content change — it creates a brand-new Recommendation via
// addRecommendationSetMember/insertRecommendation below and only uses this
// function to mark the ORIGINAL SUPERSEDED.
function updateRecommendationReviewState(projectId, recommendationSetId, recommendationId, { status, review }) {
  const library = ensureLibrary(projectId);
  if (!library) return null;
  const set = library.recommendationSets.find((s) => s.id === recommendationSetId);
  if (!set) return null;
  const recommendation = set.recommendations.find((r) => r.id === recommendationId);
  if (!recommendation) return null;
  if (status) recommendation.status = status;
  if (review) recommendation.reviews.push(JSON.parse(JSON.stringify(review)));
  saveLibrary(library);
  return recommendation;
}

// Part 10 — appends a brand-new, human-edited Recommendation record into
// the SAME RecommendationSet as the original it supersedes (never a new
// RecommendationSet, never overwriting the original's own array slot).
function addRecommendation(projectId, recommendationSetId, recommendation) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `No project found with id "${projectId}"` };
  const set = library.recommendationSets.find((s) => s.id === recommendationSetId);
  if (!set) return { ok: false, reason: `No RecommendationSet found with id "${recommendationSetId}"` };
  const stored = JSON.parse(JSON.stringify(recommendation));
  set.recommendations.push(stored);
  saveLibrary(library);
  return { ok: true, recommendation: stored };
}

module.exports = {
  RECOMMENDATION_DATA_DIR,
  getRecommendationSet,
  listRecommendationSets,
  getLatestRecommendationSetForReferenceSet,
  addRecommendationSet,
  updateRecommendationReviewState,
  addRecommendation,
};

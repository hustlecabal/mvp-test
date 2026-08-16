// cross-video-pattern-store.js
//
// INT-1E — persistence for PatternSet records (schemas/cross-video-
// pattern-schema.js). Same one-JSON-file-per-project convention every
// store in this codebase uses — `{ projectId, patternSets: [] }`. Never
// mutates a ReferenceVideo, Measurements, Observation, or Interpretation
// record (Part 26) — this file only ever writes its own small JSON index
// of DERIVED pattern data.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const CROSS_VIDEO_PATTERN_DATA_DIR = process.env.CROSS_VIDEO_PATTERN_DATA_DIR
  ? path.resolve(process.env.CROSS_VIDEO_PATTERN_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'cross-video-patterns');

fs.mkdirSync(CROSS_VIDEO_PATTERN_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(CROSS_VIDEO_PATTERN_DATA_DIR, `${projectId}.json`);
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
    library = { projectId, patternSets: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, patternSets: [] };
}

function getPatternSet(projectId, patternSetId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.patternSets.find((s) => s.id === patternSetId) || null;
}

function listPatternSets(projectId, { referenceSetId } = {}) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return referenceSetId ? library.patternSets.filter((s) => s.referenceSetId === referenceSetId) : library.patternSets.slice();
}

function getLatestPatternSetForReferenceSet(projectId, referenceSetId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  const matches = library.patternSets.filter((s) => s.referenceSetId === referenceSetId);
  if (matches.length === 0) return null;
  return matches.reduce((latest, s) => (new Date(s.createdAt) > new Date(latest.createdAt) ? s : latest));
}

function addPatternSet(projectId, patternSet) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `No project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(patternSet));
  library.patternSets.push(stored);
  saveLibrary(library);
  return { ok: true, patternSet: stored };
}

// Part 17 — updates ONLY a single pattern's status/reviews[] within an
// EXISTING PatternSet, in place. Never touches statement/prevalence/
// distribution/support/confidence — the machine's own derived result is
// permanent, matching services/reference-video-interpretation-store.js's
// updateReviewState() exactly.
function updatePatternReviewState(projectId, patternSetId, patternId, { status, review }) {
  const library = ensureLibrary(projectId);
  if (!library) return null;
  const set = library.patternSets.find((s) => s.id === patternSetId);
  if (!set) return null;
  const pattern = set.patterns.find((p) => p.id === patternId);
  if (!pattern) return null;
  if (status) pattern.status = status;
  if (review) pattern.reviews.push(JSON.parse(JSON.stringify(review)));
  saveLibrary(library);
  return pattern;
}

module.exports = {
  CROSS_VIDEO_PATTERN_DATA_DIR,
  getPatternSet,
  listPatternSets,
  getLatestPatternSetForReferenceSet,
  addPatternSet,
  updatePatternReviewState,
};

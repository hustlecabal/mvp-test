// reference-video-interpretation-store.js
//
// INT-1D — persistence for Interpretation records (schemas/reference-
// video-interpretation-schema.js). Same one-JSON-file-per-project
// convention every store in this codebase uses (services/reference-video-
// observation-store.js's own `{ projectId, observationSets: [] }`,
// mirrored here as `{ projectId, interpretations: [] }`). Never mutates a
// ReferenceVideo, Measurements, or Observation record — Part 26's "never
// mutate" rule, enforced structurally by this file simply never importing
// or writing to any of those other stores' data directories.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const INTERPRETATION_DATA_DIR = process.env.REFERENCE_VIDEO_INTERPRETATION_DATA_DIR
  ? path.resolve(process.env.REFERENCE_VIDEO_INTERPRETATION_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'reference-video-interpretations');

fs.mkdirSync(INTERPRETATION_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(INTERPRETATION_DATA_DIR, `${projectId}.json`);
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
    library = { projectId, interpretations: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, interpretations: [] };
}

function getInterpretation(projectId, interpretationId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.interpretations.find((i) => i.id === interpretationId) || null;
}

function listInterpretations(projectId, { referenceVideoId } = {}) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return referenceVideoId ? library.interpretations.filter((i) => i.referenceVideoId === referenceVideoId) : library.interpretations.slice();
}

// Never mutates the caller's object — stores a plain-JSON round-tripped copy.
function addInterpretation(projectId, interpretation) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `No project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(interpretation));
  library.interpretations.push(stored);
  saveLibrary(library);
  return { ok: true, interpretation: stored };
}

// Part 19 — updates ONLY the mutable review fields (status, reviews[]) of
// an EXISTING interpretation record in place. Never touches hypothesis/
// reasoning/supportingEvidence/counterEvidence/alternativeHypotheses/
// confidence — those are the machine's original output and are permanent
// (Part 19's "preserve the original machine interpretation" — an EDIT
// review creates a NEW record via addInterpretation instead; see
// services/reference-video-interpretation-service.js's reviewInterpretation).
function updateReviewState(projectId, interpretationId, { status, review }) {
  const library = ensureLibrary(projectId);
  if (!library) return null;
  const record = library.interpretations.find((i) => i.id === interpretationId);
  if (!record) return null;
  if (status) record.status = status;
  if (review) record.reviews.push(JSON.parse(JSON.stringify(review)));
  saveLibrary(library);
  return record;
}

module.exports = {
  INTERPRETATION_DATA_DIR,
  getInterpretation,
  listInterpretations,
  addInterpretation,
  updateReviewState,
};

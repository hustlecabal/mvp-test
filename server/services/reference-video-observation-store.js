// reference-video-observation-store.js
//
// INT-1C — persistence for ObservationSet records (schemas/reference-
// video-observation-schema.js). Same one-JSON-file-per-project convention
// every store in this codebase uses (services/reference-video-measurement-
// store.js's own `{ projectId, measurements: [] }`, mirrored here as
// `{ projectId, observationSets: [] }`). Never mutates a ReferenceVideo,
// an Asset, a transcript, or a ReferenceVideoMeasurements record — this
// file only writes its own small JSON index of DERIVED data (Part 23).
//
// Like the measurement store (and unlike INT-1A's paid-acquisition store),
// deriving observations is free and entirely local — re-deriving from the
// same measurements is always allowed and simply appends.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const OBSERVATION_DATA_DIR = process.env.REFERENCE_VIDEO_OBSERVATION_DATA_DIR
  ? path.resolve(process.env.REFERENCE_VIDEO_OBSERVATION_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'reference-video-observations');

fs.mkdirSync(OBSERVATION_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(OBSERVATION_DATA_DIR, `${projectId}.json`);
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
    library = { projectId, observationSets: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, observationSets: [] };
}

function getObservationSet(projectId, observationSetId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.observationSets.find((o) => o.id === observationSetId) || null;
}

function listObservationSets(projectId) {
  const library = readLibrary(projectId);
  return library ? library.observationSets.slice() : null;
}

function getLatestObservationSetForMeasurements(projectId, measurementsId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  const matches = library.observationSets.filter((o) => o.measurementsId === measurementsId);
  if (matches.length === 0) return null;
  return matches.reduce((latest, o) => (new Date(o.createdAt) > new Date(latest.createdAt) ? o : latest));
}

// Never mutates the caller's object — stores a plain-JSON round-tripped copy.
function addObservationSet(projectId, observationSet) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `No project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(observationSet));
  library.observationSets.push(stored);
  saveLibrary(library);
  return { ok: true, observationSet: stored };
}

module.exports = {
  OBSERVATION_DATA_DIR,
  getObservationSet,
  listObservationSets,
  getLatestObservationSetForMeasurements,
  addObservationSet,
};

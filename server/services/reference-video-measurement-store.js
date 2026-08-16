// reference-video-measurement-store.js
//
// INT-1B — persistence for ReferenceVideoMeasurements records (schemas/
// reference-video-measurement-schema.js). Same one-JSON-file-per-project
// convention every store in this codebase already uses (services/
// reference-video-store.js's own `{ projectId, referenceVideos: [] }`,
// mirrored here as `{ projectId, measurements: [] }`). Never downloads,
// fetches, or invokes FFmpeg — the only thing this file writes is its own
// small JSON index; any extracted frame images live exactly once, in
// services/asset-storage.js.
//
// Unlike INT-1A's reference-video-store (idempotent on (platform,
// externalId) because re-acquisition costs real money), measurement is
// free and entirely local — re-measuring the same ReferenceVideo is always
// allowed and simply appends a new record, so a project's measurement
// history is never silently overwritten.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const MEASUREMENT_DATA_DIR = process.env.REFERENCE_VIDEO_MEASUREMENT_DATA_DIR
  ? path.resolve(process.env.REFERENCE_VIDEO_MEASUREMENT_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'reference-video-measurements');

fs.mkdirSync(MEASUREMENT_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(MEASUREMENT_DATA_DIR, `${projectId}.json`);
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
    library = { projectId, measurements: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, measurements: [] };
}

function getMeasurement(projectId, measurementId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.measurements.find((m) => m.id === measurementId) || null;
}

function listMeasurements(projectId) {
  const library = readLibrary(projectId);
  return library ? library.measurements.slice() : null;
}

// Most recent measurement run for a given ReferenceVideo — never assumed
// to be the only one (re-measuring is always allowed; see file header).
function getLatestMeasurementForReferenceVideo(projectId, referenceVideoId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  const matches = library.measurements.filter((m) => m.referenceVideoId === referenceVideoId);
  if (matches.length === 0) return null;
  return matches.reduce((latest, m) => (new Date(m.createdAt) > new Date(latest.createdAt) ? m : latest));
}

// Never mutates the caller's object — stores a plain-JSON round-tripped
// copy, same discipline every other store in this codebase already uses.
function addMeasurement(projectId, measurements) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `No project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(measurements));
  library.measurements.push(stored);
  saveLibrary(library);
  return { ok: true, measurements: stored };
}

module.exports = {
  MEASUREMENT_DATA_DIR,
  getMeasurement,
  listMeasurements,
  getLatestMeasurementForReferenceVideo,
  addMeasurement,
};

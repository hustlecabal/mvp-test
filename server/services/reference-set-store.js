// reference-set-store.js
//
// INT-1E — persistence for ReferenceSet records (schemas/reference-set-
// schema.js). Same one-JSON-file-per-project convention every store in
// this codebase uses — `{ projectId, referenceSets: [] }`, mirroring
// services/reference-video-store.js's own `{ projectId, referenceVideos:
// [] }` exactly. Never downloads, measures, or observes anything — the
// only thing this file writes is its own small JSON index of which
// EXISTING ReferenceVideo ids belong to which set.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const REFERENCE_SET_DATA_DIR = process.env.REFERENCE_SET_DATA_DIR
  ? path.resolve(process.env.REFERENCE_SET_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'reference-sets');

fs.mkdirSync(REFERENCE_SET_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(REFERENCE_SET_DATA_DIR, `${projectId}.json`);
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
    library = { projectId, referenceSets: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, referenceSets: [] };
}

function getReferenceSet(projectId, referenceSetId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.referenceSets.find((s) => s.id === referenceSetId) || null;
}

function listReferenceSets(projectId) {
  const library = readLibrary(projectId);
  return library ? library.referenceSets.slice() : null;
}

// Never mutates the caller's object — stores a plain-JSON round-tripped copy.
function addReferenceSet(projectId, referenceSet) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `No project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(referenceSet));
  library.referenceSets.push(stored);
  saveLibrary(library);
  return { ok: true, referenceSet: stored };
}

// Replaces an EXISTING ReferenceSet's full record in place (used by
// services/reference-set-service.js after a membership/curation change —
// the same "read the whole record, mutate it in memory, write it back"
// convention services/keyframe-generation-approval-store.js's own
// requestApproval/decideApproval pair already uses for a single keyed
// object; here the record is the whole array entry, replaced wholesale
// rather than field-by-field, since ReferenceSet has no separate
// per-field update needs beyond it own members[] array).
function updateReferenceSet(projectId, referenceSet) {
  const library = ensureLibrary(projectId);
  if (!library) return null;
  const index = library.referenceSets.findIndex((s) => s.id === referenceSet.id);
  if (index === -1) return null;
  const stored = JSON.parse(JSON.stringify(referenceSet));
  library.referenceSets[index] = stored;
  saveLibrary(library);
  return stored;
}

module.exports = {
  REFERENCE_SET_DATA_DIR,
  getReferenceSet,
  listReferenceSets,
  addReferenceSet,
  updateReferenceSet,
};

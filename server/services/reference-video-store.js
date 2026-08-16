// reference-video-store.js
//
// INT-1A — persistence for ReferenceVideo records (schemas/reference-
// video-schema.js). One JSON file per project id, `{ projectId,
// referenceVideos: [] }` — the exact same convention every store in this
// codebase already uses (services/broll-library-service.js's own
// `{ projectId, segments: [] }`, services/keyframe-store.js, services/
// keyframe-handoff-service.js). This file never downloads, fetches, or
// calls a provider — the only thing it ever writes to disk is its own
// small JSON index; the referenced Assets' own bytes live exactly once,
// in services/asset-storage.js, exactly like BRollSegment already
// established for the same kind of externally-sourced media.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const REFERENCE_VIDEO_DATA_DIR = process.env.REFERENCE_VIDEO_DATA_DIR
  ? path.resolve(process.env.REFERENCE_VIDEO_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'reference-videos');

fs.mkdirSync(REFERENCE_VIDEO_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(REFERENCE_VIDEO_DATA_DIR, `${projectId}.json`);
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

// Same "create an empty record the first time it's touched, but only if
// the project itself exists" rule as broll-library-service.js's own
// ensureLibrary — used only by the write path below.
function ensureLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let library = loadLibrary(projectId);
  if (!library) {
    library = { projectId, referenceVideos: [] };
    saveLibrary(library);
  }
  return library;
}

// Strictly non-mutating counterpart for every read path — mirrors broll-
// library-service.js's own readLibrary exactly, including the same
// null-vs-empty distinction (null = project doesn't exist).
function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, referenceVideos: [] };
}

// Part 15 — the idempotency lookup: (projectId, source.platform,
// source.externalId) is the identity key, never the normalizedUrl string
// alone (two URL forms can normalize to the same video; platform+id is the
// actual stable identity a resolveSource() call already establishes).
function findByExternalId(projectId, platform, externalId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.referenceVideos.find((rv) => rv.source && rv.source.platform === platform && rv.source.externalId === externalId) || null;
}

function getReferenceVideo(projectId, referenceVideoId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.referenceVideos.find((rv) => rv.id === referenceVideoId) || null;
}

function listReferenceVideos(projectId) {
  const library = readLibrary(projectId);
  return library ? library.referenceVideos.slice() : null;
}

// Never mutates the caller's object — stores a plain-JSON round-tripped
// copy, same discipline every other store in this codebase already uses.
function addReferenceVideo(projectId, referenceVideo) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `No project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(referenceVideo));
  library.referenceVideos.push(stored);
  saveLibrary(library);
  return { ok: true, referenceVideo: stored };
}

module.exports = {
  REFERENCE_VIDEO_DATA_DIR,
  findByExternalId,
  getReferenceVideo,
  listReferenceVideos,
  addReferenceVideo,
};

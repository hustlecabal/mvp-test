// media-acquisition-store.js
//
// The Media Acquisition record library: registers a MediaAcquisitionResult
// (schemas/media-acquisition-schema.js) — provenance, cache key, and a
// reference to the already-stored Asset it produced. Mirrors
// services/broll-library-service.js's exact convention: one JSON file per
// project id, { projectId, records: [] }, never a second competing
// asset-management system.
//
// THIS FILE NEVER DOWNLOADS, FETCHES, OR CALLS A PROVIDER — see
// services/media-acquisition-service.js for the actual acquisition flow.
// It only persists/reads the RESULT of that flow. It never mutates the
// Asset record it references (services/timeline-store.js's getAsset is
// used read-only here, exactly like broll-library-service.js's own
// discipline).
//
// CACHING (this stage's own requirement #7 — "do not download the same
// external asset repeatedly"): findByProviderAsset() is the cache-hit
// lookup, keyed by (provider, providerAssetId) — the same pair a stock
// provider's own catalogue treats as a stable identity for one piece of
// media. A repeat request that resolves to the same provider + candidate
// reuses the already-downloaded Asset instead of downloading again (and,
// underneath, services/asset-storage.js's own downloadAsset() already
// never re-downloads an existing file for a given assetId — this cache
// only needs to supply that SAME assetId a second time, never invent a
// second one).

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');
const { createMediaAcquisitionResult } = require('../schemas/media-acquisition-schema');

const MEDIA_ACQUISITION_DATA_DIR = process.env.MEDIA_ACQUISITION_DATA_DIR
  ? path.resolve(process.env.MEDIA_ACQUISITION_DATA_DIR)
  : path.join(__dirname, '..', 'data', 'media-acquisition');

fs.mkdirSync(MEDIA_ACQUISITION_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(MEDIA_ACQUISITION_DATA_DIR, `${projectId}.json`);
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
// the project itself exists" rule as broll-library-service.js's
// ensureLibrary — used only by the one WRITE path below.
function ensureLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  let library = loadLibrary(projectId);
  if (!library) {
    library = { projectId, records: [] };
    saveLibrary(library);
  }
  return library;
}

// Strictly non-mutating counterpart, for every READ path — a read must
// never have the side effect of writing a new empty library file to disk.
function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, records: [] };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
//
// Records the OUTCOME of one acquisition attempt — called by
// services/media-acquisition-service.js after every attempt, whether it
// succeeded (status ACQUIRED) or not (any other ACQUISITION_STATUSES
// value), so a failed attempt's diagnostics are preserved exactly like a
// successful one's provenance is. Never mutates an existing record — each
// attempt is its own new entry, exactly like schemas/production-schema.js's
// own "never edit an asset in place" discipline for a NEXT version.
function recordAcquisition(projectId, overrides = {}) {
  const project = projectStore.getProject(projectId);
  if (!project) return { ok: false, reason: `No project found with id "${projectId}"` };

  const library = ensureLibrary(projectId);
  const record = createMediaAcquisitionResult({ ...overrides, projectId });
  library.records.push(record);
  saveLibrary(library);

  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function listAcquisitions(projectId, { beatId, sceneId, provider, mediaType, status } = {}) {
  const library = readLibrary(projectId);
  if (!library) return null;

  let records = library.records;
  if (beatId) records = records.filter((r) => r.beatId === beatId);
  if (sceneId) records = records.filter((r) => r.sceneId === sceneId);
  if (provider) records = records.filter((r) => r.provider === provider);
  if (mediaType) records = records.filter((r) => r.mediaType === mediaType);
  if (status) records = records.filter((r) => r.status === status);
  return records;
}

// Cache-hit lookup (requirement #7) — the most recent ACQUIRED record for
// this exact (provider, providerAssetId) pair, or null if this exact
// candidate has never been successfully acquired before.
function findByProviderAsset(projectId, provider, providerAssetId) {
  const records = listAcquisitions(projectId, { provider, status: 'ACQUIRED' });
  if (!records) return null;
  const matches = records.filter((r) => r.providerAssetId === providerAssetId);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

// The Material Execution consumption point — services/material-executors/
// stock-media-executor.js's read-only lookup for "has this beat already
// had stock media acquired for it?" (Material Execution's own contract is
// synchronous — see that executor's header for why it never triggers
// acquisition itself). The most recent ACQUIRED record for this beat +
// mediaType, or null.
function findAcquiredForBeat(projectId, beatId, mediaType) {
  const records = listAcquisitions(projectId, { beatId, mediaType, status: 'ACQUIRED' });
  if (!records || records.length === 0) return null;
  return records[records.length - 1];
}

// Provenance traceability (requirement #8) — every field an acquired
// asset must be traceable back to, keyed by the Asset id it produced.
function getProvenance(projectId, assetId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.records.find((r) => r.assetId === assetId) || null;
}

module.exports = {
  MEDIA_ACQUISITION_DATA_DIR,
  recordAcquisition,
  listAcquisitions,
  findByProviderAsset,
  findAcquiredForBeat,
  getProvenance,
};

// package-store.js
//
// PHASE 1 EDITORIAL SPINE, Part 3 — persistence for PackageSet records
// (schemas/package-schema.js). Same one-JSON-file-per-project convention
// as idea-store.js — `{ projectId, packageSets: [] }`, append-only.

const fs = require('fs');
const path = require('path');
const projectStore = require('./project-store');

const PACKAGE_DATA_DIR = process.env.PACKAGE_DATA_DIR ? path.resolve(process.env.PACKAGE_DATA_DIR) : path.join(__dirname, '..', 'data', 'packages');

fs.mkdirSync(PACKAGE_DATA_DIR, { recursive: true });

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function fileFor(projectId) {
  return path.join(PACKAGE_DATA_DIR, `${projectId}.json`);
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
    library = { projectId, packageSets: [] };
    saveLibrary(library);
  }
  return library;
}

function readLibrary(projectId) {
  if (!projectStore.getProject(projectId)) return null;
  return loadLibrary(projectId) || { projectId, packageSets: [] };
}

function getPackageSet(projectId, packageSetId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.packageSets.find((s) => s.id === packageSetId) || null;
}

function listPackageSets(projectId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  return library.packageSets.slice();
}

function getLatestPackageSetForIdea(projectId, ideaId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  const matches = library.packageSets.filter((s) => s.ideaId === ideaId);
  if (matches.length === 0) return null;
  return matches.reduce((latest, s) => (new Date(s.createdAt) > new Date(latest.createdAt) ? s : latest));
}

function addPackageSet(projectId, packageSet) {
  const library = ensureLibrary(projectId);
  if (!library) return { ok: false, reason: `no project found with id "${projectId}"` };
  const stored = JSON.parse(JSON.stringify(packageSet));
  library.packageSets.push(stored);
  saveLibrary(library);
  return { ok: true, packageSet: stored };
}

// Finds one package candidate by id, scanning every PackageSet for this
// project. Used by control-plane-service.js's editorial-spine readiness
// check and by creative-brain-service.js's package-authoritative Blueprint
// integration.
function findPackageCandidate(projectId, packageId) {
  const library = readLibrary(projectId);
  if (!library) return null;
  for (const packageSet of library.packageSets) {
    const candidate = packageSet.candidates.find((c) => c.packageId === packageId);
    if (candidate) return { packageSet, packageCandidate: candidate };
  }
  return null;
}

module.exports = {
  PACKAGE_DATA_DIR,
  getPackageSet,
  listPackageSets,
  getLatestPackageSetForIdea,
  addPackageSet,
  findPackageCandidate,
};
